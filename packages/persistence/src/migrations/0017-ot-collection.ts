import type { Migration } from './index'

/**
 * 0017 OT 采集迁移（P3-A / T21，WorkItem 指派；**不注册共享 registry**——
 * 本文件由 L0 整合步统一并入 migrations/registry.ts，测试侧以编程方式 migrateUp 单独应用
 * （独立库 cadenza_p3a，与共享 dev 库及并行 writer 的 0011–0016 无表名/迁移号冲突）。
 *
 * 依据：冻结合同 architecture/contracts/frozen/p3/ot-collection.md（OT-01～OT-31 +
 * OT-S1～S5）。表结构：
 * - ot_gateway [OT-06/OT-S3]：网关注册表（标识唯一、协议配置、采样率、最后心跳、
 *   检查点序号、缓冲容量与积压上报）；
 * - ot_gateway_event [OT-06]：离线/恢复/注册/溢出事件留痕（append-only 守卫）；
 * - ot_device [OT-07]：采集侧持久设备序列号 → equipment 主档映射
 *   （未映射设备数据进隔离态，不悬空丢弃、不自动建档案——隔离态在 ot_sample 行
 *   is_quarantined 标记 + 0001 inbox QUARANTINED 行双承载）；
 * - ot_point [OT-08/OT-S2]：点位字典（(plant_id, point_code) active 唯一；语义/单位
 *   引 uom/采样率/量程/参与业务判定/校准引用；version 版本化）；
 * - ot_quality_code_map [OT-11]：设备质量码 → 三档映射（map_version 版本化）；
 * - ot_conversion [OT-10]：单位换算版本（(plant, from, to) 唯一；revision 版本化）；
 * - ot_sample [OT-09/OT-S1]：采集原始层（**独立采集存储层，OT-24：不写业务事件表**；
 *   (device_serial, event_id) 唯一=OT-16 去重键；事件时间/接收时间分列；质量码/校准
 *   引用/工序关联状态非空化处理；隔离态独立标记；原始事实列触发器保护、
 *   DELETE 拒〔OT-22 坏点与偏差样本保留可查、不物理删除〕）；
 * - ot_aggregate [OT-S4/OT-25]：分钟/班次汇总投影（窗口唯一；可从原始层重建；
 *   带更新时间与数据截至事件时间——延迟标注；班次行仅由显式重建命令生成，OT-19）；
 * - ot_stats [OT-S5]：溢出/去重统计（按网关/设备/日累计，可对账）；
 * - ot_business_mapping [OT-26]：采集值→业务事实显式映射配置（版本化 + 确认规则）；
 * - ot_business_fact [OT-26]：业务事实候选（(mapping, window) 幂等唯一；
 *   pending_confirm/dispatched；dispatched 行关联 outbox event——走正常命令链路）。
 *
 * 外键：equipment/uom（0003）、execution_session（0008）、org_node（0002）、
 * command_receipt（0001）均已注册落地，直接 RESTRICT。守卫函数名独立
 * cadenza_ot_append_guard / cadenza_ot_sample_fact_guard（与既有触发器互不误伤）。
 */
export const migration0017: Migration = {
  version: '0017',
  name: 'ot-collection',
  up: /* sql */ `
    -- ============ OT 留痕守卫：网关事件 append-only、样本禁物理删（OT-06/OT-22） ============
    CREATE FUNCTION cadenza_ot_append_guard() RETURNS trigger AS $$
    BEGIN
      RAISE EXCEPTION '[OT-22] 表 % 为留痕事实：禁止 %（坏点/偏差/隔离样本保留可查，纠正走再处理命令与新记录）',
        TG_TABLE_NAME, TG_OP;
    END;
    $$ LANGUAGE plpgsql;

    -- ============ 网关注册表（OT-06/OT-S3） ============
    CREATE TABLE ot_gateway (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      enterprise_id uuid NOT NULL REFERENCES org_node (id) ON DELETE RESTRICT,
      plant_id uuid NOT NULL REFERENCES org_node (id) ON DELETE RESTRICT,
      gateway_code text NOT NULL CHECK (gateway_code <> '' AND length(gateway_code) <= 64),
      protocol_config jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(protocol_config) = 'object'),
      sample_rate_hz integer NOT NULL DEFAULT 1 CHECK (sample_rate_hz >= 1),
      buffer_capacity integer NOT NULL DEFAULT 10000 CHECK (buffer_capacity >= 1),
      heartbeat_timeout_seconds integer NOT NULL DEFAULT 60 CHECK (heartbeat_timeout_seconds >= 5),
      last_heartbeat_at timestamptz,
      status text NOT NULL DEFAULT 'offline' CHECK (status IN ('online','offline')),
      last_status_changed_at timestamptz,
      checkpoint_seq bigint NOT NULL DEFAULT 0 CHECK (checkpoint_seq >= 0),
      last_backlog_count integer NOT NULL DEFAULT 0 CHECK (last_backlog_count >= 0),
      command_receipt_id uuid REFERENCES command_receipt (id) ON DELETE RESTRICT,
      business_time timestamptz NOT NULL DEFAULT now(),
      created_at timestamptz NOT NULL DEFAULT now(),
      created_by text,
      updated_at timestamptz NOT NULL DEFAULT now(),
      updated_by text,
      -- OT-06/OT-S3：网关标识唯一
      CONSTRAINT ot_gateway_code_unique UNIQUE (gateway_code)
    );
    CREATE INDEX ot_gateway_plant_idx ON ot_gateway (plant_id);

    -- ============ 网关事件留痕（OT-06：离线/恢复事件留痕并告警；append-only） ============
    CREATE TABLE ot_gateway_event (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      gateway_code text NOT NULL,
      plant_id uuid NOT NULL REFERENCES org_node (id) ON DELETE RESTRICT,
      enterprise_id uuid NOT NULL REFERENCES org_node (id) ON DELETE RESTRICT,
      event_kind text NOT NULL CHECK (event_kind IN ('registered','heartbeat_restored','offline','overflow')),
      detail jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(detail) = 'object'),
      occurred_at timestamptz NOT NULL,
      created_by text
    );
    CREATE INDEX ot_gateway_event_gateway_idx ON ot_gateway_event (gateway_code, occurred_at DESC);
    CREATE INDEX ot_gateway_event_plant_idx ON ot_gateway_event (plant_id, occurred_at DESC);
    CREATE TRIGGER ot_gateway_event_append_guard
      BEFORE UPDATE OR DELETE ON ot_gateway_event
      FOR EACH ROW EXECUTE FUNCTION cadenza_ot_append_guard();

    -- ============ 设备映射（OT-07：序列号 → equipment 主档；未映射=隔离态） ============
    CREATE TABLE ot_device (
      device_serial text PRIMARY KEY CHECK (device_serial <> '' AND length(device_serial) <= 64),
      enterprise_id uuid NOT NULL REFERENCES org_node (id) ON DELETE RESTRICT,
      plant_id uuid NOT NULL REFERENCES org_node (id) ON DELETE RESTRICT,
      gateway_code text REFERENCES ot_gateway (gateway_code) ON DELETE RESTRICT,
      equipment_id uuid REFERENCES equipment (id) ON DELETE RESTRICT,
      bound_by text,
      bound_at timestamptz,
      clock_skew_threshold_seconds integer NOT NULL DEFAULT 120 CHECK (clock_skew_threshold_seconds >= 1),
      command_receipt_id uuid REFERENCES command_receipt (id) ON DELETE RESTRICT,
      business_time timestamptz NOT NULL DEFAULT now(),
      created_at timestamptz NOT NULL DEFAULT now(),
      created_by text,
      updated_at timestamptz NOT NULL DEFAULT now(),
      updated_by text
    );
    CREATE INDEX ot_device_plant_idx ON ot_device (plant_id);
    CREATE INDEX ot_device_equipment_idx ON ot_device (equipment_id);

    -- ============ 点位字典（OT-08/OT-S2：(plant, code) 唯一；版本化） ============
    CREATE TABLE ot_point (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      enterprise_id uuid NOT NULL REFERENCES org_node (id) ON DELETE RESTRICT,
      plant_id uuid NOT NULL REFERENCES org_node (id) ON DELETE RESTRICT,
      device_serial text NOT NULL REFERENCES ot_device (device_serial) ON DELETE RESTRICT,
      point_code text NOT NULL CHECK (point_code <> '' AND length(point_code) <= 64),
      semantic text NOT NULL CHECK (semantic IN
        ('meter_length','speed','temperature','weight','stop_signal','inspection_result','other')),
      uom_id uuid REFERENCES uom (id) ON DELETE RESTRICT,
      uom_code text NOT NULL CHECK (uom_code <> '' AND length(uom_code) <= 16),
      sample_rate_seconds integer NOT NULL CHECK (sample_rate_seconds >= 1),
      range_min numeric(18,6),
      range_max numeric(18,6),
      participates_in_business boolean NOT NULL DEFAULT false,
      calibration_record_no text,
      calibration_valid_until timestamptz,
      version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
      status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','retired')),
      created_at timestamptz NOT NULL DEFAULT now(),
      created_by text,
      updated_at timestamptz NOT NULL DEFAULT now(),
      updated_by text,
      -- OT-08：量程成对且下限<上限
      CONSTRAINT ot_point_range_shape CHECK (
        (range_min IS NULL AND range_max IS NULL)
        OR (range_min IS NOT NULL AND range_max IS NOT NULL AND range_min < range_max)
      ),
      -- OT-12：登记校准有效期必须同时引用校准记录版本号
      CONSTRAINT ot_point_calibration_shape CHECK (
        calibration_valid_until IS NULL OR calibration_record_no IS NOT NULL
      )
    );
    CREATE UNIQUE INDEX ot_point_plant_code_active_uidx ON ot_point (plant_id, point_code) WHERE status = 'active';
    CREATE INDEX ot_point_device_idx ON ot_point (device_serial);

    -- ============ 设备质量码映射（OT-11：三档；map_version 版本化） ============
    CREATE TABLE ot_quality_code_map (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      device_serial text NOT NULL REFERENCES ot_device (device_serial) ON DELETE RESTRICT,
      device_quality_code text NOT NULL CHECK (device_quality_code <> '' AND length(device_quality_code) <= 32),
      quality_level text NOT NULL CHECK (quality_level IN ('good','uncertain','bad')),
      map_version integer NOT NULL DEFAULT 1 CHECK (map_version >= 1),
      created_at timestamptz NOT NULL DEFAULT now(),
      created_by text,
      updated_at timestamptz NOT NULL DEFAULT now(),
      updated_by text,
      CONSTRAINT ot_quality_code_map_unique UNIQUE (device_serial, device_quality_code)
    );

    -- ============ 单位换算版本（OT-10：归一按换算版本；revision 版本化） ============
    CREATE TABLE ot_conversion (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      enterprise_id uuid NOT NULL REFERENCES org_node (id) ON DELETE RESTRICT,
      plant_id uuid NOT NULL REFERENCES org_node (id) ON DELETE RESTRICT,
      from_uom_code text NOT NULL CHECK (from_uom_code <> '' AND length(from_uom_code) <= 16),
      to_uom_code text NOT NULL CHECK (to_uom_code <> '' AND length(to_uom_code) <= 16),
      factor numeric(18,8) NOT NULL CHECK (factor > 0),
      revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
      created_at timestamptz NOT NULL DEFAULT now(),
      created_by text,
      updated_at timestamptz NOT NULL DEFAULT now(),
      updated_by text,
      CONSTRAINT ot_conversion_unique UNIQUE (plant_id, from_uom_code, to_uom_code),
      CONSTRAINT ot_conversion_not_self CHECK (from_uom_code <> to_uom_code)
    );

    -- ============ 采集原始层（OT-09/OT-S1/OT-24：独立采集存储层，不写业务事件表） ============
    -- device_serial/point_code 无 FK：隔离态样本（设备未映射/点位未登记）也必须落库
    -- 保留（OT-07 不悬空丢弃）；一致性由入池管线与再处理命令维护。
    CREATE TABLE ot_sample (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      device_serial text NOT NULL,
      point_code text NOT NULL,
      event_id text NOT NULL CHECK (event_id <> ''),
      gateway_seq bigint NOT NULL CHECK (gateway_seq >= 1),
      event_time timestamptz NOT NULL,
      received_at timestamptz NOT NULL,
      gateway_code text NOT NULL CHECK (gateway_code <> ''),
      raw_value numeric(18,6) NOT NULL,
      raw_unit text NOT NULL CHECK (raw_unit <> ''),
      normalized_value numeric(18,6),
      conversion_revision integer,
      conversion_missing boolean NOT NULL DEFAULT false,
      quality_level text NOT NULL CHECK (quality_level IN ('good','uncertain','bad')),
      device_quality_code text,
      is_bad boolean NOT NULL DEFAULT false,
      bad_reasons text[] NOT NULL DEFAULT '{}',
      is_clock_skew boolean NOT NULL DEFAULT false,
      clock_skew_kind text CHECK (clock_skew_kind IN ('offset','backward','ahead')),
      is_late boolean NOT NULL DEFAULT false,
      calibration_suspect boolean NOT NULL DEFAULT false,
      session_id uuid REFERENCES execution_session (id) ON DELETE RESTRICT,
      session_link_status text NOT NULL DEFAULT 'unlinked'
        CHECK (session_link_status IN ('auto_bound','pending_confirm','unlinked','manual_bound')),
      is_quarantined boolean NOT NULL DEFAULT false,
      quarantine_reason text,
      command_receipt_id uuid REFERENCES command_receipt (id) ON DELETE RESTRICT,
      enterprise_id uuid NOT NULL REFERENCES org_node (id) ON DELETE RESTRICT,
      plant_id uuid NOT NULL REFERENCES org_node (id) ON DELETE RESTRICT,
      business_time timestamptz NOT NULL DEFAULT now(),
      created_at timestamptz NOT NULL DEFAULT now(),
      created_by text,
      -- OT-16/OT-S1：重传去重唯一键 (设备序列号, 唯一事件 ID)
      CONSTRAINT ot_sample_event_unique UNIQUE (device_serial, event_id)
    );
    CREATE INDEX ot_sample_device_time_idx ON ot_sample (device_serial, event_time DESC);
    CREATE INDEX ot_sample_device_point_time_idx ON ot_sample (device_serial, point_code, event_time DESC);
    CREATE INDEX ot_sample_plant_received_idx ON ot_sample (plant_id, received_at DESC);
    CREATE INDEX ot_sample_device_quarantine_idx ON ot_sample (device_serial) WHERE is_quarantined;
    -- OT-22：原始事实列（身份/时间/数值/单位/网关）不可修改——分类列仅可经再处理命令更新；
    -- DELETE 拒（坏点与偏差样本保留可查，不物理删除）。
    CREATE FUNCTION cadenza_ot_sample_fact_guard() RETURNS trigger AS $$
    BEGIN
      IF NEW.device_serial IS DISTINCT FROM OLD.device_serial
        OR NEW.event_id IS DISTINCT FROM OLD.event_id
        OR NEW.point_code IS DISTINCT FROM OLD.point_code
        OR NEW.event_time IS DISTINCT FROM OLD.event_time
        OR NEW.received_at IS DISTINCT FROM OLD.received_at
        OR NEW.gateway_code IS DISTINCT FROM OLD.gateway_code
        OR NEW.gateway_seq IS DISTINCT FROM OLD.gateway_seq
        OR NEW.raw_value IS DISTINCT FROM OLD.raw_value
        OR NEW.raw_unit IS DISTINCT FROM OLD.raw_unit
        OR NEW.device_quality_code IS DISTINCT FROM OLD.device_quality_code
        OR NEW.command_receipt_id IS DISTINCT FROM OLD.command_receipt_id
        OR NEW.plant_id IS DISTINCT FROM OLD.plant_id
        OR NEW.enterprise_id IS DISTINCT FROM OLD.enterprise_id THEN
        RAISE EXCEPTION '[OT-22] ot_sample 原始事实列不可修改（坏点/偏差/隔离样本保留可查；分类列仅可经补绑再处理命令更新）';
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
    CREATE TRIGGER ot_sample_fact_guard
      BEFORE UPDATE ON ot_sample
      FOR EACH ROW EXECUTE FUNCTION cadenza_ot_sample_fact_guard();
    CREATE TRIGGER ot_sample_delete_reject
      BEFORE DELETE ON ot_sample
      FOR EACH ROW EXECUTE FUNCTION cadenza_ot_append_guard();

    -- ============ 汇总投影（OT-S4/OT-25：分钟/班次；带更新时间与数据截至） ============
    CREATE TABLE ot_aggregate (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      device_serial text NOT NULL,
      point_code text NOT NULL,
      granularity text NOT NULL CHECK (granularity IN ('minute','shift')),
      window_start timestamptz NOT NULL,
      sample_count integer NOT NULL DEFAULT 0 CHECK (sample_count >= 0),
      good_count integer NOT NULL DEFAULT 0 CHECK (good_count >= 0),
      bad_count integer NOT NULL DEFAULT 0 CHECK (bad_count >= 0),
      skew_count integer NOT NULL DEFAULT 0 CHECK (skew_count >= 0),
      sum_value numeric(24,6) NOT NULL DEFAULT 0,
      min_value numeric(24,6),
      max_value numeric(24,6),
      first_event_time timestamptz NOT NULL,
      last_event_time timestamptz NOT NULL,
      enterprise_id uuid NOT NULL REFERENCES org_node (id) ON DELETE RESTRICT,
      plant_id uuid NOT NULL REFERENCES org_node (id) ON DELETE RESTRICT,
      updated_at timestamptz NOT NULL DEFAULT now(),
      updated_by text,
      CONSTRAINT ot_aggregate_window_unique UNIQUE (device_serial, point_code, granularity, window_start)
    );
    CREATE INDEX ot_aggregate_plant_idx ON ot_aggregate (plant_id, granularity, window_start DESC);
    CREATE INDEX ot_aggregate_device_idx ON ot_aggregate (device_serial, granularity, window_start DESC);

    -- ============ 溢出/去重统计（OT-S5：按网关/设备/日累计，可对账） ============
    CREATE TABLE ot_stats (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      stat_date date NOT NULL,
      gateway_code text NOT NULL CHECK (gateway_code <> ''),
      device_serial text NOT NULL CHECK (device_serial <> ''),
      enterprise_id uuid NOT NULL REFERENCES org_node (id) ON DELETE RESTRICT,
      plant_id uuid NOT NULL REFERENCES org_node (id) ON DELETE RESTRICT,
      dedup_count integer NOT NULL DEFAULT 0 CHECK (dedup_count >= 0),
      overflow_count integer NOT NULL DEFAULT 0 CHECK (overflow_count >= 0),
      overflow_first_at timestamptz,
      overflow_last_at timestamptz,
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT ot_stats_unique UNIQUE (stat_date, gateway_code, device_serial)
    );
    CREATE INDEX ot_stats_plant_idx ON ot_stats (plant_id, stat_date DESC);

    -- ============ 业务事实映射配置（OT-26：版本化显式映射 + 确认规则） ============
    CREATE TABLE ot_business_mapping (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      enterprise_id uuid NOT NULL REFERENCES org_node (id) ON DELETE RESTRICT,
      plant_id uuid NOT NULL REFERENCES org_node (id) ON DELETE RESTRICT,
      device_serial text NOT NULL,
      point_code text NOT NULL,
      fact_kind text NOT NULL CHECK (fact_kind IN ('meter_to_quantity','stop_to_downtime')),
      confirm_mode text NOT NULL CHECK (confirm_mode IN ('auto','manual')),
      params jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(params) = 'object'),
      version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
      status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','retired')),
      created_at timestamptz NOT NULL DEFAULT now(),
      created_by text,
      updated_at timestamptz NOT NULL DEFAULT now(),
      updated_by text
    );
    CREATE UNIQUE INDEX ot_business_mapping_active_uidx
      ON ot_business_mapping (plant_id, device_serial, point_code) WHERE status = 'active';
    CREATE INDEX ot_business_mapping_plant_idx ON ot_business_mapping (plant_id);

    -- ============ 业务事实候选（OT-26：(mapping, window) 幂等；走正常命令链路） ============
    CREATE TABLE ot_business_fact (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      mapping_id uuid NOT NULL REFERENCES ot_business_mapping (id) ON DELETE RESTRICT,
      mapping_version integer NOT NULL CHECK (mapping_version >= 1),
      fact_kind text NOT NULL CHECK (fact_kind IN ('meter_to_quantity','stop_to_downtime')),
      device_serial text NOT NULL,
      point_code text NOT NULL,
      window_start timestamptz NOT NULL,
      window_end timestamptz NOT NULL,
      value numeric(18,4),
      payload jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(payload) = 'object'),
      status text NOT NULL CHECK (status IN ('pending_confirm','dispatched')),
      confirmed_by text,
      confirmed_at timestamptz,
      outbox_event_id uuid,
      command_receipt_id uuid REFERENCES command_receipt (id) ON DELETE RESTRICT,
      enterprise_id uuid NOT NULL REFERENCES org_node (id) ON DELETE RESTRICT,
      plant_id uuid NOT NULL REFERENCES org_node (id) ON DELETE RESTRICT,
      business_time timestamptz NOT NULL DEFAULT now(),
      created_at timestamptz NOT NULL DEFAULT now(),
      created_by text,
      updated_at timestamptz NOT NULL DEFAULT now(),
      updated_by text,
      CONSTRAINT ot_business_fact_window_unique UNIQUE (mapping_id, window_start, window_end)
    );
    CREATE INDEX ot_business_fact_plant_idx ON ot_business_fact (plant_id, created_at DESC);
    CREATE INDEX ot_business_fact_mapping_idx ON ot_business_fact (mapping_id, window_start);
  `,
  down: /* sql */ `
    DROP TABLE IF EXISTS ot_business_fact;
    DROP TABLE IF EXISTS ot_business_mapping;
    DROP TABLE IF EXISTS ot_stats;
    DROP TABLE IF EXISTS ot_aggregate;
    DROP TRIGGER IF EXISTS ot_sample_delete_reject ON ot_sample;
    DROP TRIGGER IF EXISTS ot_sample_fact_guard ON ot_sample;
    DROP FUNCTION IF EXISTS cadenza_ot_sample_fact_guard();
    DROP TABLE IF EXISTS ot_sample;
    DROP TABLE IF EXISTS ot_conversion;
    DROP TABLE IF EXISTS ot_quality_code_map;
    DROP TABLE IF EXISTS ot_point;
    DROP TABLE IF EXISTS ot_device;
    DROP TRIGGER IF EXISTS ot_gateway_event_append_guard ON ot_gateway_event;
    DROP TABLE IF EXISTS ot_gateway_event;
    DROP TABLE IF EXISTS ot_gateway;
    DROP FUNCTION IF EXISTS cadenza_ot_append_guard();
  `,
}
