import type { Migration } from './index'

/**
 * 0015 设备维护域迁移（P2-E / T19 点检、保养、维修、备件与复机——大部 [合同新造]）。
 *
 * 依据冻结合同 architecture/contracts/frozen/p2/maintenance.md（MT-S1~MT-S5）：
 * - maintenance_order：状态机列（MT-S1，六值封闭；关闭时结果＋责任人非空、
 *   取消时原因非空的 CHECK；合法迁移集封闭由应用层 MT-07 守卫承担）；
 * - downtime_event：同设备停机区间不重叠（MT-S2，btree_gist exclusion 约束，
 *   与应用层 MT-09 守卫双保险）；end_at 可空=在停机中；无负时长 CHECK；
 * - spare_part_usage：关联工单＋库存流水引用（MT-S3，stock_transaction_id NOT NULL
 *   ——不允许无流水消耗行；与工单关闭同事务写入 MT-11）；
 * - maintenance_plan 版本化（MT-S4：生效区间）＋inspection_round（引用计划版本快照
 *   ＋实际时间/业务班次双列 IT-37；fail 必填异常说明——不合格产生异常记录 MT-12）；
 * - equipment_start_record：(equipment, 业务日) 唯一（MT-S5，重复开工=更新开工时间）；
 *   设备状态流水沿用 0003 equipment_status_log（MD-S3 append-only，本域不重建）。
 *
 * 停机原因分类字典（GAP-F22）与计划周期细则（GAP-F19）未裁：reason 为必填文本、
 * cycle 为最小机制 jsonb，裁定后升级不破坏表形。
 *
 * 本文件不注册共享 registry（L0 整合步统一并入 migrations/registry.ts；
 * 测试侧以 migrateUp(pool, [...migrations, migration0015]) 程序式应用——
 * 独立库 cadenza_maintenance 每轮 DROP+CREATE）。迁移号 0015 与并行线互不冲突。
 */
export const migration0015: Migration = {
  version: '0015',
  name: 'maintenance',
  up: /* sql */ `
    -- exclusion 约束依赖（MT-S2：同设备停机区间不重叠）
    CREATE EXTENSION IF NOT EXISTS btree_gist;

    -- ============ 维修工单（MT-07/08/13/14/MT-S1） ============
    CREATE TABLE maintenance_order (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      enterprise_id uuid NOT NULL REFERENCES org_node (id) ON DELETE RESTRICT,
      plant_id uuid NOT NULL REFERENCES org_node (id) ON DELETE RESTRICT,
      equipment_id uuid NOT NULL REFERENCES equipment (id) ON DELETE RESTRICT,
      order_no text NOT NULL CHECK (order_no <> ''),
      source text NOT NULL CHECK (source IN ('web_manual','anomaly_report')),
      status text NOT NULL DEFAULT 'reported'
        CHECK (status IN ('reported','dispatched','in_progress','pending_restart','closed','cancelled')),
      description text,
      reporter text NOT NULL CHECK (reporter <> ''),
      dispatcher text,
      assignee text,
      result text,
      responsible text,
      cancel_reason text,
      closed_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      created_by text,
      updated_at timestamptz NOT NULL DEFAULT now(),
      updated_by text,
      CONSTRAINT maintenance_order_no_unique UNIQUE (order_no),
      -- MT-S1/MT-07：关闭时结果与责任人非空（任一为空不可关闭）
      CONSTRAINT maintenance_order_close_fields CHECK (
        status <> 'closed' OR (result IS NOT NULL AND result <> '' AND responsible IS NOT NULL AND responsible <> '')
      ),
      -- MT-S1/MT-14：取消时原因非空
      CONSTRAINT maintenance_order_cancel_reason CHECK (
        status <> 'cancelled' OR (cancel_reason IS NOT NULL AND cancel_reason <> '')
      )
    );
    CREATE INDEX maintenance_order_equipment_idx ON maintenance_order (equipment_id, created_at DESC);
    CREATE INDEX maintenance_order_status_idx ON maintenance_order (status) WHERE status NOT IN ('closed','cancelled');
    CREATE INDEX maintenance_order_plant_idx ON maintenance_order (plant_id, created_at DESC);

    -- ============ 停机事件（MT-09/MT-S2：区间不重叠；end 可空=在停机中） ============
    CREATE TABLE downtime_event (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      enterprise_id uuid NOT NULL REFERENCES org_node (id) ON DELETE RESTRICT,
      plant_id uuid NOT NULL REFERENCES org_node (id) ON DELETE RESTRICT,
      equipment_id uuid NOT NULL REFERENCES equipment (id) ON DELETE RESTRICT,
      order_id uuid REFERENCES maintenance_order (id) ON DELETE SET NULL,
      start_at timestamptz NOT NULL,
      end_at timestamptz,
      reason text NOT NULL CHECK (reason <> ''),
      created_at timestamptz NOT NULL DEFAULT now(),
      created_by text,
      updated_at timestamptz NOT NULL DEFAULT now(),
      updated_by text,
      -- 无负时长（复机与排程竞态下可解释）
      CONSTRAINT downtime_event_no_negative CHECK (end_at IS NULL OR end_at >= start_at),
      -- 同设备停机区间不重叠（半开区间口径：前 end == 后 start 不算重叠）
      CONSTRAINT downtime_event_no_overlap EXCLUDE USING gist (
        equipment_id WITH =,
        tstzrange(start_at, COALESCE(end_at, 'infinity'), '[)') WITH &&
      )
    );
    CREATE INDEX downtime_event_equipment_idx ON downtime_event (equipment_id, start_at DESC);
    CREATE INDEX downtime_event_open_idx ON downtime_event (equipment_id) WHERE end_at IS NULL;
    CREATE INDEX downtime_event_order_idx ON downtime_event (order_id);

    -- ============ 备件消耗（MT-11/MT-S3：不允许无流水消耗行） ============
    CREATE TABLE spare_part_usage (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      enterprise_id uuid NOT NULL REFERENCES org_node (id) ON DELETE RESTRICT,
      plant_id uuid NOT NULL REFERENCES org_node (id) ON DELETE RESTRICT,
      order_id uuid NOT NULL REFERENCES maintenance_order (id) ON DELETE RESTRICT,
      unit_id uuid NOT NULL REFERENCES inventory_unit (id) ON DELETE RESTRICT,
      unit_no text,
      material_code text,
      balance_id uuid REFERENCES stock_balance (id) ON DELETE SET NULL,
      stock_transaction_id uuid NOT NULL REFERENCES stock_transaction (id) ON DELETE RESTRICT,
      quantity numeric(18,4) NOT NULL CHECK (quantity > 0),
      before_quantity numeric(18,4) NOT NULL CHECK (before_quantity >= 0),
      after_quantity numeric(18,4) NOT NULL CHECK (after_quantity >= 0),
      uom_id uuid NOT NULL,
      uom_code text NOT NULL CHECK (uom_code <> ''),
      created_at timestamptz NOT NULL DEFAULT now(),
      created_by text,
      CONSTRAINT spare_part_usage_tx_unique UNIQUE (order_id, stock_transaction_id)
    );
    CREATE INDEX spare_part_usage_order_idx ON spare_part_usage (order_id);
    CREATE INDEX spare_part_usage_unit_idx ON spare_part_usage (unit_id);

    -- ============ 点检/保养计划（MT-12/MT-S4：版本化＋生效区间） ============
    CREATE TABLE maintenance_plan (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      enterprise_id uuid NOT NULL REFERENCES org_node (id) ON DELETE RESTRICT,
      plant_id uuid NOT NULL REFERENCES org_node (id) ON DELETE RESTRICT,
      equipment_id uuid NOT NULL REFERENCES equipment (id) ON DELETE RESTRICT,
      plan_key text NOT NULL CHECK (plan_key <> ''),
      version integer NOT NULL CHECK (version >= 1),
      kind text NOT NULL CHECK (kind IN ('inspection','maintenance')),
      -- 最小周期机制（GAP-F19 待裁）：{"everyDays":n}
      cycle jsonb NOT NULL CHECK (jsonb_typeof(cycle) = 'object'),
      -- 检查项模板（字符串数组；round 引用版本快照，配置变更不回写已执行记录）
      check_items jsonb NOT NULL CHECK (jsonb_typeof(check_items) = 'array' AND jsonb_array_length(check_items) >= 1),
      effective_from date NOT NULL,
      effective_to date,
      status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','retired')),
      description text,
      created_at timestamptz NOT NULL DEFAULT now(),
      created_by text,
      updated_at timestamptz NOT NULL DEFAULT now(),
      updated_by text,
      CONSTRAINT maintenance_plan_key_version_unique UNIQUE (plan_key, version),
      CONSTRAINT maintenance_plan_effective_range CHECK (effective_to IS NULL OR effective_to > effective_from)
    );
    CREATE INDEX maintenance_plan_equipment_idx ON maintenance_plan (equipment_id) WHERE status = 'active';
    CREATE INDEX maintenance_plan_plant_idx ON maintenance_plan (plant_id) WHERE status = 'active';

    -- ============ 点检/保养执行轮次（MT-12/S4：计划版本快照＋双存） ============
    CREATE TABLE inspection_round (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      enterprise_id uuid NOT NULL REFERENCES org_node (id) ON DELETE RESTRICT,
      plant_id uuid NOT NULL REFERENCES org_node (id) ON DELETE RESTRICT,
      plan_id uuid NOT NULL REFERENCES maintenance_plan (id) ON DELETE RESTRICT,
      plan_key text NOT NULL,
      plan_version integer NOT NULL,
      equipment_id uuid NOT NULL REFERENCES equipment (id) ON DELETE RESTRICT,
      executed_at timestamptz NOT NULL,
      shift_date date NOT NULL,
      result text NOT NULL CHECK (result IN ('pass','fail')),
      anomaly_note text,
      performed_by text NOT NULL CHECK (performed_by <> ''),
      order_id uuid REFERENCES maintenance_order (id) ON DELETE SET NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      created_by text,
      -- MT-12：点检不合格产生异常记录（fail 必填异常说明）
      CONSTRAINT inspection_round_fail_note CHECK (
        result <> 'fail' OR (anomaly_note IS NOT NULL AND anomaly_note <> '')
      )
    );
    CREATE INDEX inspection_round_plan_idx ON inspection_round (plan_id, executed_at DESC);
    CREATE INDEX inspection_round_equipment_idx ON inspection_round (equipment_id, executed_at DESC);

    -- ============ 设备开工记录（MT-05/06/S5：(设备, 业务日) 唯一） ============
    CREATE TABLE equipment_start_record (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      enterprise_id uuid NOT NULL REFERENCES org_node (id) ON DELETE RESTRICT,
      plant_id uuid NOT NULL REFERENCES org_node (id) ON DELETE RESTRICT,
      equipment_id uuid NOT NULL REFERENCES equipment (id) ON DELETE RESTRICT,
      business_date date NOT NULL,
      started_at timestamptz NOT NULL,
      source text NOT NULL CHECK (source IN ('WEB','PDA')),
      actor text NOT NULL CHECK (actor <> ''),
      created_at timestamptz NOT NULL DEFAULT now(),
      created_by text,
      updated_at timestamptz NOT NULL DEFAULT now(),
      updated_by text,
      CONSTRAINT equipment_start_record_day_unique UNIQUE (equipment_id, business_date)
    );
    CREATE INDEX equipment_start_record_recent_idx ON equipment_start_record (equipment_id, business_date DESC);
  `,
  down: /* sql */ `
    DROP TABLE IF EXISTS equipment_start_record;
    DROP TABLE IF EXISTS inspection_round;
    DROP TABLE IF EXISTS maintenance_plan;
    DROP TABLE IF EXISTS spare_part_usage;
    DROP TABLE IF EXISTS downtime_event;
    DROP TABLE IF EXISTS maintenance_order;
  `,
}
