import type { Migration } from './index'

/**
 * 0018 受约束排程与外协迁移（P3-B / T22 csw 块）。
 *
 * 冻结合同 architecture/contracts/frozen/p3/constrained-scheduling.md
 * （CS-01～CS-27 + CS-S1～CS-S5；逐条对照见 delivery/P3/csw/DELIVERY.md §6）。
 * 本域在 T09 scheduling（0007）之上叠加，不改其表；承接基线 CS-01～03 由 T09 主闭合。
 *
 * 表清单（九表 + 守卫函数独立命名，避免依赖其它迁移的函数）：
 * - csw_freeze_record 冻结记录（[CS-11/CS-S2]：设备×生产日期区间或单槽位；活动行区间
 *   不重叠（应用层断言 + slot 粒度 partial unique 库级双保险）；解冻行含 操作者/时间/理由）；
 * - csw_changeover_matrix 换型矩阵版本（[CS-16/CS-S3]：版本行 append-only（守卫拒
 *   UPDATE/DELETE——被引用版本 immutable），活动版本＝同厂最大 version_no；维度键→时长
 *   存 entries jsonb）；
 * - csw_schedule_version 排程版本（[CS-13/CS-27]：版本链 parent_version_id、权重与
 *   求解窗口随版本留存；仅 status/committed/superseded 列可更新，其余列守卫拒改
 *   ——历史版本不被静默改写）；
 * - csw_schedule_version_item 版本条目（[CS-12/CS-14/CS-15]：逐任务命中约束清单与
 *   被拒原因 explanation jsonb、软违反、冲突建议、冻结/已开工标志；append-only）；
 * - csw_override_audit 人工覆盖审计（[CS-26/CS-S5]：覆盖类型、理由非空、影响清单；append-only）；
 * - csw_equipment_calibration_state 校准状态投影（[CS-05③/CS-10] 等价服务——
 *   收编请求：T23 spc（0019）calibration_record 整合后由 L0 切换数据源）；
 * - csw_equipment_downtime 维护停机窗口（[CS-09] 等价服务——收编请求：T19 maintenance
 *   （0015）downtime_event 整合后切数据源；关闭行含受影响槽位清单 jsonb）；
 * - csw_outsourcing_task 外协任务（[CS-19/CS-S4]：状态机列 + 供应方 + 数量事实 +
 *   回厂检验引用；状态 CHECK 与转移留痕列）；
 * - csw_outsourcing_unit 外协单元链接（[CS-20/CS-21/CS-23]：外协在途＝in_transit 的
 *   具名细分承载行（单元→任务→发送/回厂批次）；(task,unit) 唯一）。
 *
 * 注意：本迁移文件在 L0 整合步统一注册进 registry.ts 前不随 `pnpm db:migrate:up` 应用；
 * 本块测试以 migrateUp(pool, [...migrations, migration0018]) 在独立库（cadenza_p3b）应用
 * （模式照 shipping/spc 测试环境，每轮 DROP+CREATE）；迁移号 0018 与并行 writer 的
 * 0011–0017/0019+ 互不冲突（未注册状态互不可见）。
 */
export const migration0018: Migration = {
  version: '0018',
  name: 'constrained-scheduling',
  up: /* sql */ `
    -- ============ csw 守卫函数（独立命名，不依赖 0004 cadenza_reject_mutation） ============
    CREATE FUNCTION cadenza_csw_append_guard() RETURNS trigger AS $$
    BEGIN
      RAISE EXCEPTION 'CS-S3/CS-S5/CS-27 append-only 违反：表 % 不允许 %（版本/审计/条目为事实行，改走新行）',
        TG_TABLE_NAME, TG_OP;
    END;
    $$ LANGUAGE plpgsql;

    -- 排程版本头：仅允许推进状态列（committed/superseded），事实列（权重/窗口/父版本）拒改
    CREATE FUNCTION cadenza_csw_version_guard() RETURNS trigger AS $$
    BEGIN
      IF NEW.id <> OLD.id OR NEW.version_no <> OLD.version_no
         OR NEW.plant_id <> OLD.plant_id
         OR NEW.enterprise_id <> OLD.enterprise_id
         OR NEW.source IS DISTINCT FROM OLD.source
         OR NEW.parent_version_id IS DISTINCT FROM OLD.parent_version_id
         OR NEW.matrix_version_id IS DISTINCT FROM OLD.matrix_version_id
         OR NEW.weights_json IS DISTINCT FROM OLD.weights_json
         OR NEW.horizon_days <> OLD.horizon_days
         OR NEW.horizon_from <> OLD.horizon_from
         OR NEW.proposed_by IS DISTINCT FROM OLD.proposed_by THEN
        RAISE EXCEPTION 'CS-27 历史版本不被静默改写：排程版本事实列不可更新（仅状态可推进）';
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;

    -- ============ 冻结记录（CS-11/CS-S2） ============
    CREATE TABLE csw_freeze_record (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      enterprise_id uuid NOT NULL REFERENCES org_node (id) ON DELETE RESTRICT,
      plant_id uuid NOT NULL REFERENCES org_node (id) ON DELETE RESTRICT,
      scope text NOT NULL CHECK (scope IN ('equipment_date_range', 'slot')),
      equipment_id uuid NOT NULL REFERENCES equipment (id) ON DELETE RESTRICT,
      production_date_from date NOT NULL,
      production_date_to date NOT NULL,
      -- slot 引用为快照引用（无 FK）：T09 删槽＝物理删除（计划量改 0），冻结留痕自持事实（0004 快照引用先例）
      slot_id uuid,
      status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'ended')),
      reason text,
      frozen_by text,
      frozen_at timestamptz NOT NULL DEFAULT now(),
      unfrozen_by text,
      unfrozen_at timestamptz,
      unfreeze_reason text,
      created_at timestamptz NOT NULL DEFAULT now(),
      created_by text,
      updated_at timestamptz NOT NULL DEFAULT now(),
      updated_by text,
      CHECK (production_date_from <= production_date_to),
      CHECK (scope <> 'slot' OR slot_id IS NOT NULL)
    );
    CREATE INDEX csw_freeze_plant_idx ON csw_freeze_record (plant_id);
    CREATE INDEX csw_freeze_equipment_idx ON csw_freeze_record (equipment_id, status);
    -- [CS-S2] 同槽位至多一条活动冻结（库级双保险；设备区间重叠由应用层断言）
    CREATE UNIQUE INDEX csw_freeze_slot_active_unique
      ON csw_freeze_record (slot_id) WHERE (status = 'active' AND slot_id IS NOT NULL);

    -- ============ 换型矩阵版本（CS-16/CS-S3，append-only） ============
    CREATE TABLE csw_changeover_matrix (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      enterprise_id uuid NOT NULL REFERENCES org_node (id) ON DELETE RESTRICT,
      plant_id uuid NOT NULL REFERENCES org_node (id) ON DELETE RESTRICT,
      version_no integer NOT NULL CHECK (version_no >= 1),
      dimension_kind text NOT NULL CHECK (dimension_kind IN ('operation', 'product_attribute')),
      default_minutes integer NOT NULL CHECK (default_minutes >= 0 AND default_minutes <= 1440),
      entries jsonb NOT NULL CHECK (jsonb_typeof(entries) = 'array'),
      note text,
      created_at timestamptz NOT NULL DEFAULT now(),
      created_by text,
      updated_at timestamptz NOT NULL DEFAULT now(),
      updated_by text,
      CONSTRAINT csw_changeover_plant_version_unique UNIQUE (plant_id, version_no)
    );
    CREATE INDEX csw_changeover_plant_idx ON csw_changeover_matrix (plant_id, version_no DESC);
    CREATE TRIGGER csw_changeover_matrix_append_only
      BEFORE UPDATE OR DELETE ON csw_changeover_matrix
      FOR EACH ROW EXECUTE FUNCTION cadenza_csw_append_guard();

    -- ============ 排程版本（CS-13/CS-27） ============
    CREATE TABLE csw_schedule_version (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      enterprise_id uuid NOT NULL REFERENCES org_node (id) ON DELETE RESTRICT,
      plant_id uuid NOT NULL REFERENCES org_node (id) ON DELETE RESTRICT,
      version_no integer NOT NULL CHECK (version_no >= 1),
      source text NOT NULL CHECK (source IN ('system_suggestion', 'manual_commit')),
      parent_version_id uuid REFERENCES csw_schedule_version (id) ON DELETE RESTRICT,
      matrix_version_id uuid REFERENCES csw_changeover_matrix (id) ON DELETE RESTRICT,
      weights_json jsonb NOT NULL,
      horizon_days integer NOT NULL CHECK (horizon_days >= 1 AND horizon_days <= 90),
      horizon_from date NOT NULL,
      status text NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed', 'committed', 'superseded')),
      proposed_by text,
      committed_by text,
      committed_at timestamptz,
      superseded_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      created_by text,
      updated_at timestamptz NOT NULL DEFAULT now(),
      updated_by text,
      CONSTRAINT csw_schedule_version_plant_no_unique UNIQUE (plant_id, version_no)
    );
    CREATE INDEX csw_schedule_version_plant_idx ON csw_schedule_version (plant_id, version_no DESC);
    CREATE INDEX csw_schedule_version_status_idx ON csw_schedule_version (plant_id, status);
    CREATE TRIGGER csw_schedule_version_facts_immutable
      BEFORE UPDATE ON csw_schedule_version
      FOR EACH ROW EXECUTE FUNCTION cadenza_csw_version_guard();

    -- ============ 版本条目（CS-12/CS-14/CS-15，append-only） ============
    CREATE TABLE csw_schedule_version_item (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      version_id uuid NOT NULL REFERENCES csw_schedule_version (id) ON DELETE RESTRICT,
      item_no integer NOT NULL CHECK (item_no >= 1),
      action text NOT NULL CHECK (action IN ('keep', 'move', 'new', 'remove', 'conflict', 'outside_horizon')),
      order_operation_id uuid NOT NULL REFERENCES order_operation (id) ON DELETE RESTRICT,
      order_id uuid NOT NULL REFERENCES production_order (id) ON DELETE RESTRICT,
      order_no text NOT NULL CHECK (order_no <> ''),
      operation_name text NOT NULL CHECK (operation_name <> ''),
      operation_definition_id uuid NOT NULL REFERENCES operation_definition (id) ON DELETE RESTRICT,
      equipment_id uuid REFERENCES equipment (id) ON DELETE RESTRICT,
      production_date date,
      planned_qty numeric(14,4) CHECK (planned_qty IS NULL OR planned_qty > 0),
      -- slot 引用为快照引用（无 FK）：重排移动/删除槽位不因历史版本条目受阻；条目自身为不可变事实快照
      slot_id uuid,
      frozen boolean NOT NULL DEFAULT false,
      started boolean NOT NULL DEFAULT false,
      need_manual boolean NOT NULL DEFAULT false,
      soft_violations jsonb NOT NULL DEFAULT '[]'::jsonb,
      explanation jsonb NOT NULL DEFAULT '{}'::jsonb,
      suggestions jsonb NOT NULL DEFAULT '[]'::jsonb,
      created_at timestamptz NOT NULL DEFAULT now(),
      created_by text,
      updated_at timestamptz NOT NULL DEFAULT now(),
      updated_by text,
      CONSTRAINT csw_version_item_no_unique UNIQUE (version_id, item_no)
    );
    CREATE INDEX csw_version_item_version_idx ON csw_schedule_version_item (version_id);
    CREATE TRIGGER csw_schedule_version_item_append_only
      BEFORE UPDATE OR DELETE ON csw_schedule_version_item
      FOR EACH ROW EXECUTE FUNCTION cadenza_csw_append_guard();

    -- ============ 人工覆盖审计（CS-26/CS-S5，append-only；理由非空） ============
    CREATE TABLE csw_override_audit (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      enterprise_id uuid NOT NULL REFERENCES org_node (id) ON DELETE RESTRICT,
      plant_id uuid NOT NULL REFERENCES org_node (id) ON DELETE RESTRICT,
      override_type text NOT NULL CHECK (override_type IN (
        'soft_constraint_confirm', 'unfreeze', 'weight_change', 'manual_over_suggestion'
      )),
      operator text NOT NULL CHECK (operator <> ''),
      reason text NOT NULL CHECK (reason <> ''),
      affected_tasks jsonb NOT NULL DEFAULT '[]'::jsonb,
      schedule_version_id uuid REFERENCES csw_schedule_version (id) ON DELETE RESTRICT,
      created_at timestamptz NOT NULL DEFAULT now(),
      created_by text,
      updated_at timestamptz NOT NULL DEFAULT now(),
      updated_by text
    );
    CREATE INDEX csw_override_audit_plant_idx ON csw_override_audit (plant_id, override_type);
    CREATE TRIGGER csw_override_audit_append_only
      BEFORE UPDATE OR DELETE ON csw_override_audit
      FOR EACH ROW EXECUTE FUNCTION cadenza_csw_append_guard();

    -- ============ 校准状态投影（CS-05③/CS-10 等价服务；收编请求→T23 spc） ============
    CREATE TABLE csw_equipment_calibration_state (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      enterprise_id uuid NOT NULL REFERENCES org_node (id) ON DELETE RESTRICT,
      plant_id uuid NOT NULL REFERENCES org_node (id) ON DELETE RESTRICT,
      equipment_id uuid NOT NULL REFERENCES equipment (id) ON DELETE RESTRICT,
      calibration_result text NOT NULL CHECK (calibration_result IN ('qualified', 'limited', 'invalid')),
      valid_until date,
      certificate_no text,
      affected_slot_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
      created_at timestamptz NOT NULL DEFAULT now(),
      created_by text,
      updated_at timestamptz NOT NULL DEFAULT now(),
      updated_by text,
      CONSTRAINT csw_calibration_equipment_unique UNIQUE (equipment_id)
    );
    CREATE INDEX csw_calibration_plant_idx ON csw_equipment_calibration_state (plant_id);

    -- ============ 维护停机窗口（CS-09 等价服务；收编请求→T19 downtime_event） ============
    CREATE TABLE csw_equipment_downtime (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      enterprise_id uuid NOT NULL REFERENCES org_node (id) ON DELETE RESTRICT,
      plant_id uuid NOT NULL REFERENCES org_node (id) ON DELETE RESTRICT,
      equipment_id uuid NOT NULL REFERENCES equipment (id) ON DELETE RESTRICT,
      kind text NOT NULL CHECK (kind IN ('planned_maintenance', 'repair', 'other')),
      from_at text NOT NULL CHECK (from_at <> ''),
      to_at text NOT NULL CHECK (to_at <> ''),
      status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'closed')),
      note text,
      impact_slot_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
      closed_by text,
      closed_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      created_by text,
      updated_at timestamptz NOT NULL DEFAULT now(),
      updated_by text,
      CHECK (from_at <= to_at)
    );
    CREATE INDEX csw_downtime_equipment_idx ON csw_equipment_downtime (equipment_id, status);
    CREATE INDEX csw_downtime_plant_idx ON csw_equipment_downtime (plant_id);

    -- ============ 外协任务（CS-19～CS-25/CS-S4） ============
    CREATE TABLE csw_outsourcing_task (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      task_no text NOT NULL CHECK (task_no <> ''),
      enterprise_id uuid NOT NULL REFERENCES org_node (id) ON DELETE RESTRICT,
      plant_id uuid NOT NULL REFERENCES org_node (id) ON DELETE RESTRICT,
      order_id uuid NOT NULL REFERENCES production_order (id) ON DELETE RESTRICT,
      order_operation_id uuid NOT NULL REFERENCES order_operation (id) ON DELETE RESTRICT,
      order_no text NOT NULL CHECK (order_no <> ''),
      operation_name text NOT NULL CHECK (operation_name <> ''),
      supplier_code text,
      supplier_name text NOT NULL CHECK (supplier_name <> ''),
      qty numeric(14,4) NOT NULL CHECK (qty > 0),
      uom text NOT NULL CHECK (uom <> ''),
      transit_location_id uuid NOT NULL REFERENCES storage_location (id) ON DELETE RESTRICT,
      transit_location_code text NOT NULL CHECK (transit_location_code <> ''),
      return_location_id uuid REFERENCES storage_location (id) ON DELETE RESTRICT,
      return_location_code text,
      status text NOT NULL DEFAULT 'draft' CHECK (status IN (
        'draft', 'pending_send', 'sent', 'return_received', 'inspecting', 'closed', 'recalled', 'return_disposed'
      )),
      inspection_result text CHECK (inspection_result IN ('pending', 'passed', 'rejected')),
      sent_qty numeric(14,4) NOT NULL DEFAULT 0 CHECK (sent_qty >= 0),
      returned_qty numeric(14,4) NOT NULL DEFAULT 0 CHECK (returned_qty >= 0),
      sent_by text,
      sent_at timestamptz,
      received_by text,
      received_at timestamptz,
      inspected_by text,
      inspected_at timestamptz,
      closed_by text,
      closed_at timestamptz,
      recall_reason text,
      recalled_by text,
      recalled_at timestamptz,
      dispose_reason text,
      disposed_by text,
      disposed_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      created_by text,
      updated_at timestamptz NOT NULL DEFAULT now(),
      updated_by text,
      CHECK (returned_qty <= sent_qty),
      CONSTRAINT csw_outsourcing_task_no_unique UNIQUE (plant_id, task_no)
    );
    CREATE INDEX csw_outsourcing_plant_idx ON csw_outsourcing_task (plant_id, status);
    CREATE INDEX csw_outsourcing_op_idx ON csw_outsourcing_task (order_operation_id, status);

    -- ============ 外协单元链接（CS-20/21/23：外协在途具名细分 + 谱系父子边） ============
    CREATE TABLE csw_outsourcing_unit (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      task_id uuid NOT NULL REFERENCES csw_outsourcing_task (id) ON DELETE RESTRICT,
      unit_id uuid NOT NULL REFERENCES inventory_unit (id) ON DELETE RESTRICT,
      unit_no text NOT NULL CHECK (unit_no <> ''),
      send_lot_id uuid REFERENCES material_lot (id) ON DELETE RESTRICT,
      sent_qty numeric(18,4) NOT NULL CHECK (sent_qty > 0),
      returned_qty numeric(18,4) NOT NULL DEFAULT 0 CHECK (returned_qty >= 0),
      return_lot_id uuid REFERENCES material_lot (id) ON DELETE RESTRICT,
      status text NOT NULL DEFAULT 'sent' CHECK (status IN ('sent', 'returned')),
      created_at timestamptz NOT NULL DEFAULT now(),
      created_by text,
      updated_at timestamptz NOT NULL DEFAULT now(),
      updated_by text,
      CHECK (returned_qty <= sent_qty),
      CONSTRAINT csw_outsourcing_unit_unique UNIQUE (task_id, unit_id)
    );
    CREATE INDEX csw_outsourcing_unit_task_idx ON csw_outsourcing_unit (task_id);
  `,
  down: /* sql */ `
    DROP TABLE IF EXISTS csw_outsourcing_unit;
    DROP TABLE IF EXISTS csw_outsourcing_task;
    DROP TABLE IF EXISTS csw_equipment_downtime;
    DROP TABLE IF EXISTS csw_equipment_calibration_state;
    DROP TABLE IF EXISTS csw_override_audit;
    DROP TABLE IF EXISTS csw_schedule_version_item;
    DROP TABLE IF EXISTS csw_schedule_version;
    DROP TABLE IF EXISTS csw_changeover_matrix;
    DROP TABLE IF EXISTS csw_freeze_record;
    DROP FUNCTION IF EXISTS cadenza_csw_version_guard();
    DROP FUNCTION IF EXISTS cadenza_csw_append_guard();
  `,
}
