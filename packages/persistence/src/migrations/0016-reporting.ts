import type { Migration } from './index'

/**
 * 0016 报表与指标投影域迁移（P2-F / T20 全量业务查询、班次报表与核心指标——只读投影）。
 *
 * 依据冻结合同 architecture/contracts/frozen/p2/reporting.md（RP-S1~RP-S4）：
 * - stock_stat_projection：库存统计投影表（RP-S1）——可由事件源（stock_transaction＋各域业务
 *   事实）全量重建、重建任务幂等（重算范围 DELETE+INSERT 同事务）、数量列含 measurement_basis；
 *   RP-01 两类汇总键（采购收货码/其余码）以表达式唯一索引承载幂等键；
 * - metric_definition_revision：指标定义版本表（RP-S3）——分子/分母事实集（声明性 jsonb）、
 *   单位、口径版本、生效区间；referenced 行 immutable（守卫函数，MD-S2 同则）；
 * - shift_snapshot：班次快照表（RP-S2）——(工厂, 班次日期, 指标, 指标版本) 幂等键，
 *   重算覆盖同键不产生重复行；失败与缺失分母保留标记与原因（RP-21）。
 *
 * 导出审计（RP-S4）不建新表：与查询共用同一范围校验路径，导出记 0001 audit_entry 审计行。
 * 本域只读业务事实：三表均无业务表 FK 写路径，仅 uuid 引用（组织 FK 保留 RESTRICT）。
 *
 * 本文件不注册共享 registry（L0 整合步统一并入 migrations/registry.ts；
 * 测试侧以 migrateUp(pool, [...migrations, migration0016]) 程序式应用——
 * 独立库 cadenza_reporting 每轮 DROP+CREATE）。迁移号 0016 与并行线 0011~0015 互不冲突。
 */
export const migration0016: Migration = {
  version: '0016',
  name: 'reporting',
  up: /* sql */ `
    -- ============ 指标定义版本（RP-19/RP-S3；referenced 行 immutable 守卫） ============
    CREATE TABLE metric_definition_revision (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      metric_key text NOT NULL CHECK (metric_key <> ''),
      family text NOT NULL CHECK (family IN ('wip','delivery','yield','loss')),
      version integer NOT NULL CHECK (version >= 1),
      caliber_version text NOT NULL CHECK (caliber_version <> ''),
      -- 分子/分母事实集：声明性引用（{"kind":"<引擎内置事实集键>"}），不存 SQL（防注入）
      numerator_fact_set jsonb NOT NULL CHECK (jsonb_typeof(numerator_fact_set) = 'object'),
      denominator_fact_set jsonb CHECK (denominator_fact_set IS NULL OR jsonb_typeof(denominator_fact_set) = 'object'),
      uom_code text NOT NULL CHECK (uom_code <> ''),
      uom_mode text NOT NULL DEFAULT 'plain' CHECK (uom_mode IN ('plain','percent')),
      effective_from date NOT NULL,
      effective_to date,
      status text NOT NULL DEFAULT 'active' CHECK (status IN ('draft','active','retired')),
      -- RP-S3：已被快照引用的定义行 immutable（置位后不可回退，单向闩锁同 MD-S2）
      referenced boolean NOT NULL DEFAULT false,
      description text,
      plant_id uuid REFERENCES org_node (id) ON DELETE RESTRICT,
      enterprise_id uuid REFERENCES org_node (id) ON DELETE RESTRICT,
      created_at timestamptz NOT NULL DEFAULT now(),
      created_by text,
      updated_at timestamptz NOT NULL DEFAULT now(),
      updated_by text,
      CONSTRAINT metric_definition_revision_key_version_unique UNIQUE (metric_key, version)
    );
    CREATE INDEX metric_definition_revision_key_idx ON metric_definition_revision (metric_key, status);
    CREATE INDEX metric_definition_revision_family_idx ON metric_definition_revision (family) WHERE status = 'active';

    CREATE FUNCTION cadenza_reporting_metric_referenced_guard() RETURNS trigger AS $$
    BEGIN
      IF OLD.referenced THEN
        IF TG_OP = 'DELETE' THEN
          RAISE EXCEPTION 'RP-S3: 指标定义已被快照引用，禁止删除（定义变更走新版本行）';
        END IF;
        IF NEW.metric_key IS DISTINCT FROM OLD.metric_key
          OR NEW.family IS DISTINCT FROM OLD.family
          OR NEW.version IS DISTINCT FROM OLD.version
          OR NEW.caliber_version IS DISTINCT FROM OLD.caliber_version
          OR NEW.numerator_fact_set IS DISTINCT FROM OLD.numerator_fact_set
          OR NEW.denominator_fact_set IS DISTINCT FROM OLD.denominator_fact_set
          OR NEW.uom_code IS DISTINCT FROM OLD.uom_code
          OR NEW.uom_mode IS DISTINCT FROM OLD.uom_mode
          OR NEW.effective_from IS DISTINCT FROM OLD.effective_from
          OR NEW.effective_to IS DISTINCT FROM OLD.effective_to THEN
          RAISE EXCEPTION 'RP-S3: 指标定义已被快照引用，禁止修改核心列（定义变更走新版本行，历史快照不回写）';
        END IF;
      END IF;
      IF NEW.referenced IS DISTINCT FROM OLD.referenced
        AND NOT (OLD.referenced = false AND NEW.referenced = true) THEN
        RAISE EXCEPTION 'RP-S3: referenced 标志单向闩锁，置位后不可回退';
      END IF;
      RETURN COALESCE(NEW, OLD);
    END;
    $$ LANGUAGE plpgsql;
    CREATE TRIGGER metric_definition_referenced_guard
      BEFORE UPDATE OR DELETE ON metric_definition_revision
      FOR EACH ROW EXECUTE FUNCTION cadenza_reporting_metric_referenced_guard();

    -- ============ 班次快照（RP-18/RP-S2；(工厂, 班次日期, 指标, 指标版本) 幂等键） ============
    CREATE TABLE shift_snapshot (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      plant_id uuid NOT NULL REFERENCES org_node (id) ON DELETE RESTRICT,
      shift_date date NOT NULL,
      metric_key text NOT NULL CHECK (metric_key <> ''),
      metric_version integer NOT NULL CHECK (metric_version >= 1),
      caliber_version text NOT NULL CHECK (caliber_version <> ''),
      numerator_value numeric(18,4),
      denominator_value numeric(18,4),
      -- RP-21：失败/缺失分母时 value 为空，不以 0 冒充
      value numeric(18,4),
      uom_code text NOT NULL CHECK (uom_code <> ''),
      status text NOT NULL CHECK (status IN ('ok','denominator_missing','projection_failed')),
      missing_reason text,
      -- RP-22：参与聚合的事实行数（逐笔对账锚点）
      source_rows integer NOT NULL DEFAULT 0,
      computed_at timestamptz NOT NULL DEFAULT now(),
      computed_by text NOT NULL CHECK (computed_by <> ''),
      command_receipt_id uuid REFERENCES command_receipt (id) ON DELETE SET NULL,
      enterprise_id uuid NOT NULL REFERENCES org_node (id) ON DELETE RESTRICT,
      created_at timestamptz NOT NULL DEFAULT now(),
      created_by text,
      updated_at timestamptz NOT NULL DEFAULT now(),
      updated_by text,
      -- RP-S2：幂等键——重算覆盖同键不产生重复行（应用层 ON CONFLICT DO UPDATE）
      CONSTRAINT shift_snapshot_key_unique UNIQUE (plant_id, shift_date, metric_key, metric_version)
    );
    CREATE INDEX shift_snapshot_plant_date_idx ON shift_snapshot (plant_id, shift_date DESC);
    CREATE INDEX shift_snapshot_status_idx ON shift_snapshot (status) WHERE status <> 'ok';

    -- ============ 库存统计投影（RP-01~RP-07/RP-S1；重算 DELETE+INSERT 同事务，可全量重建） ============
    CREATE TABLE stock_stat_projection (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      -- RP-01 两类汇总键
      stat_kind text NOT NULL CHECK (stat_kind IN ('purchase_receive','production')),
      unit_no text NOT NULL CHECK (unit_no <> ''),
      lot_no text,
      supplier_lot_no text,
      material_id uuid,
      material_code text NOT NULL CHECK (material_code <> ''),
      material_name text,
      material_type smallint CHECK (material_type IN (1,2,3)),
      color text,
      spec text,
      voltage text,
      standard text,
      order_no text,
      operation_seq integer,
      operation_name text,
      -- 数量（RP-S1：含 measurement_basis）
      quantity numeric(18,4) NOT NULL CHECK (quantity >= 0),
      uom_id uuid,
      uom_code text NOT NULL CHECK (uom_code <> ''),
      measurement_basis text NOT NULL,
      -- 状态两套口径并存标注（RP-02/IT-16；legacy 可空，GAP-A7 映射未裁）
      stock_status text,
      axis_status text NOT NULL CHECK (axis_status IN ('in_stock','in_production','in_transit','shipped','exhausted')),
      report_warehouse_kind text CHECK (report_warehouse_kind IN ('WAREHOUSE','LINE_SIDE')),
      finished_entry_status text CHECK (finished_entry_status IN ('entered_warehouse','not_entered')),
      customer_axis_nos text[] NOT NULL DEFAULT '{}',
      warehouse_code text,
      warehouse_name text,
      location_code text,
      owner_name text,
      inbound_date timestamptz,
      outbound_date timestamptz,
      plant_id uuid NOT NULL REFERENCES org_node (id) ON DELETE RESTRICT,
      enterprise_id uuid NOT NULL REFERENCES org_node (id) ON DELETE RESTRICT,
      created_at timestamptz NOT NULL DEFAULT now(),
      created_by text,
      updated_at timestamptz NOT NULL DEFAULT now(),
      updated_by text
    );
    -- RP-01 幂等键：采购收货码（轴号+批次+厂家批次+牌号/线径）/ 其余码（轴号+订单+（有则）工序）；
    -- 可空列以 COALESCE 归一（空批次与无工序各自归一组）
    CREATE UNIQUE INDEX stock_stat_projection_key_uidx ON stock_stat_projection (
      plant_id, stat_kind, unit_no, lot_no, COALESCE(supplier_lot_no, ''),
      COALESCE(material_code, ''), COALESCE(order_no, ''), COALESCE(operation_seq, 0)
    );
    CREATE INDEX stock_stat_projection_plant_idx ON stock_stat_projection (plant_id, created_at DESC);
    CREATE INDEX stock_stat_projection_unit_idx ON stock_stat_projection (unit_no);
    CREATE INDEX stock_stat_projection_status_idx ON stock_stat_projection (stock_status) WHERE stock_status IS NOT NULL;
  `,
  down: /* sql */ `
    DROP TABLE IF EXISTS stock_stat_projection;
    DROP TABLE IF EXISTS shift_snapshot;
    DROP TRIGGER IF EXISTS metric_definition_referenced_guard ON metric_definition_revision;
    DROP FUNCTION IF EXISTS cadenza_reporting_metric_referenced_guard();
    DROP TABLE IF EXISTS metric_definition_revision;
  `,
}
