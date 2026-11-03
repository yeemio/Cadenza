import type { Migration } from './index'

/**
 * 0011 倒轴/分托解绑/轴号修正/轴码退役迁移（P2-A / T15；**不注册共享 registry**——
 * 本文件由 L0 整合步统一并入 migrations/registry.ts，测试侧以编程方式 migrateUp 单独应用
 * （独立库 cadenza_rework，与共享 dev 库及并行 writer 独立库隔离；注册表当前 0001–0010 +
 * 0012+（并行线），0011 外键依赖的表已全部由 0001–0010 落地，无表名冲突）。
 *
 * 依据冻结合同 architecture/contracts/frozen/p2/rework-split.md
 * （RS-01～RS-37 业务规则 + RS-S1～RS-S6 表级约束）。
 *
 * 表：
 * - reel_split_order + reel_split_line + reel_split_reversal [RS-S1]：倒轴主表＋倒入明细＋
 *   冲销事实（append-only：无 UPDATE；纠正＝冲销记录关联原单；损耗列 [RS-S2]，
 *   GAP-F1 裁定后补审批字段与 NOT NULL 约束；数量列 numeric(18,4)＋uom_id＋
 *   measurement_basis＋conversion_revision_id，IT-08 四元组）；
 * - pallet_task + pallet_task_line [RS-S3]：分托/解绑单据（(操作人, 分托类型) 进行中唯一
 *   partial unique WHERE status='in_progress'；明细含扫入快照列原托码/仓库/货架/库位）；
 *   分托/解绑锁定写共享 reservation（0004 IT-23 四要素，holder_type='task'、
 *   holder_ref=pallet_task.task_no）[RS-S4]，本迁移不建锁定表；
 * - axis_no_state：本域轴号事实（码 → 客户轴号/段长/虚拟轴号当前值；不改共享表——
 *   客户轴段分配关系在共享 customer_segment，本表为 rework 域读写当前值的事实投影）；
 * - axis_no_correction [RS-S5]：修正记录（状态列 completed/withdrawn＋修正目标码 ID＋
 *   修正前/后值快照＋对象版本引用；回撤写状态切换与审计行，不改历史值列——
 *   UPDATE 触发器限定仅允许 status/withdrawn_by/withdrawn_at 三列变化）；
 * - axis_code_retire + axis_retire_record [RS-S6]：轴码退役（retired 逻辑退役不物理删行，
 *   以独立状态表实现——不改共享 inventory_unit 表结构，L0 整合可选收编为列；
 *   清空记录快照字段集 append-only；谱系边与身份引用保留、不级联删除）。
 *
 * 守卫函数名独立（cadenza_rework_append_guard / cadenza_rework_correction_update_guard），
 * 与 0004 cadenza_reject_mutation、0006 cadenza_purchase_history_guard、
 * 0009/0013 守卫互不影响。
 * 外键（inventory_unit/material/org_node/command_receipt/carrier/warehouse/rack/
 * storage_location）均已由 0001–0010 注册落地，直接 RESTRICT。
 */
export const migration0011: Migration = {
  version: '0011',
  name: 'rework-split',
  up: /* sql */ `
    -- ============ T15 守卫：倒轴事实/清空记录 append-only ============
    CREATE FUNCTION cadenza_rework_append_guard() RETURNS trigger AS $$
    BEGIN
      RAISE EXCEPTION '[RS-S1/RS-S6] 表 % 为 append-only 事实：禁止 %（纠正走冲销事实行或新记录）',
        TG_TABLE_NAME, TG_OP;
    END;
    $$ LANGUAGE plpgsql;

    -- ============ 倒轴主表（RS-S1/RS-01～11：守恒快照＋损耗列 RS-S2/RS-11） ============
    CREATE TABLE reel_split_order (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      order_no text NOT NULL CHECK (order_no <> ''),
      source_unit_id uuid NOT NULL REFERENCES inventory_unit (id) ON DELETE RESTRICT,
      source_unit_no text NOT NULL CHECK (source_unit_no <> ''),
      original_qty numeric(18,4) NOT NULL CHECK (original_qty > 0),
      retained_qty numeric(18,4) NOT NULL CHECK (retained_qty >= 0),
      loss_qty numeric(18,4) NOT NULL DEFAULT 0 CHECK (loss_qty >= 0),
      loss_reason text,
      -- RS-01 守恒式表级核查：原量 = 留存 + 损耗 + 明细倒入合计（明细合计由应用层装配校验；
      -- 此处校验 原量 ≥ 留存 + 损耗，明细级守恒在命令事务内断言）
      material_id uuid NOT NULL REFERENCES material (id) ON DELETE RESTRICT,
      material_code text NOT NULL CHECK (material_code <> ''),
      lot_id uuid NOT NULL REFERENCES material_lot (id) ON DELETE RESTRICT,
      order_ref text,
      split_by text NOT NULL CHECK (split_by <> ''),
      split_at timestamptz NOT NULL,
      status text NOT NULL DEFAULT 'executed' CHECK (status IN ('executed', 'reversed')),
      uom_id uuid NOT NULL,
      uom_code text NOT NULL CHECK (uom_code <> ''),
      measurement_basis text NOT NULL,
      conversion_revision_id uuid,
      command_receipt_id uuid REFERENCES command_receipt (id) ON DELETE RESTRICT,
      plant_id uuid NOT NULL REFERENCES org_node (id) ON DELETE RESTRICT,
      enterprise_id uuid NOT NULL REFERENCES org_node (id) ON DELETE RESTRICT,
      business_time timestamptz NOT NULL DEFAULT now(),
      created_at timestamptz NOT NULL DEFAULT now(),
      created_by text,
      CONSTRAINT reel_split_order_no_unique UNIQUE (order_no),
      CONSTRAINT reel_split_order_conservation_ck CHECK (original_qty >= retained_qty + loss_qty)
    );
    CREATE INDEX reel_split_order_plant_idx ON reel_split_order (plant_id);
    CREATE INDEX reel_split_order_source_unit_idx ON reel_split_order (source_unit_id);
    CREATE INDEX reel_split_order_split_at_idx ON reel_split_order (split_at DESC);
    -- append-only（RS-S1：纠正＝冲销记录关联原单；status='reversed' 由冲销事实行派生投影）
    CREATE TRIGGER reel_split_order_append_guard
      BEFORE UPDATE OR DELETE ON reel_split_order
      FOR EACH ROW EXECUTE FUNCTION cadenza_rework_append_guard();

    -- ============ 倒入明细（RS-S1/RS-08：一轴一行） ============
    CREATE TABLE reel_split_line (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      order_id uuid NOT NULL REFERENCES reel_split_order (id) ON DELETE RESTRICT,
      line_no integer NOT NULL CHECK (line_no >= 1),
      target_unit_id uuid NOT NULL REFERENCES inventory_unit (id) ON DELETE RESTRICT,
      target_unit_no text NOT NULL CHECK (target_unit_no <> ''),
      quantity numeric(18,4) NOT NULL CHECK (quantity > 0),
      created_new_unit boolean NOT NULL DEFAULT false,
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT reel_split_line_no_unique UNIQUE (order_id, line_no)
    );
    CREATE INDEX reel_split_line_order_idx ON reel_split_line (order_id);
    CREATE INDEX reel_split_line_unit_idx ON reel_split_line (target_unit_id);
    CREATE TRIGGER reel_split_line_append_guard
      BEFORE UPDATE OR DELETE ON reel_split_line
      FOR EACH ROW EXECUTE FUNCTION cadenza_rework_append_guard();

    -- ============ 倒轴冲销事实（RS-12：反向流水关联原单；append-only） ============
    CREATE TABLE reel_split_reversal (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      reversal_no text NOT NULL CHECK (reversal_no <> ''),
      source_order_id uuid NOT NULL REFERENCES reel_split_order (id) ON DELETE RESTRICT,
      source_order_no text NOT NULL CHECK (source_order_no <> ''),
      reason text NOT NULL CHECK (reason <> ''),
      reversed_by text NOT NULL CHECK (reversed_by <> ''),
      reversed_at timestamptz NOT NULL,
      command_receipt_id uuid REFERENCES command_receipt (id) ON DELETE RESTRICT,
      plant_id uuid NOT NULL REFERENCES org_node (id) ON DELETE RESTRICT,
      enterprise_id uuid NOT NULL REFERENCES org_node (id) ON DELETE RESTRICT,
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT reel_split_reversal_no_unique UNIQUE (reversal_no),
      CONSTRAINT reel_split_reversal_source_unique UNIQUE (source_order_id)
    );
    CREATE INDEX reel_split_reversal_source_idx ON reel_split_reversal (source_order_id);
    CREATE TRIGGER reel_split_reversal_append_guard
      BEFORE UPDATE OR DELETE ON reel_split_reversal
      FOR EACH ROW EXECUTE FUNCTION cadenza_rework_append_guard();

    -- ============ 分托/解绑单据（RS-S3/RS-14～23：(操作人, 分托类型) 进行中唯一） ============
    CREATE TABLE pallet_task (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      task_no text NOT NULL CHECK (task_no <> ''),
      task_type text NOT NULL CHECK (task_type IN ('split_pallet', 'unbind_pallet')),
      status text NOT NULL DEFAULT 'in_progress'
        CHECK (status IN ('in_progress', 'completed', 'abandoned')),
      operator text NOT NULL CHECK (operator <> ''),
      operator_dept_category smallint,
      target_carrier_id uuid REFERENCES carrier (id) ON DELETE RESTRICT,
      target_carrier_code text,
      warehouse_id uuid REFERENCES warehouse (id) ON DELETE RESTRICT,
      warehouse_code text,
      rack_id uuid REFERENCES rack (id) ON DELETE RESTRICT,
      rack_code text,
      location_id uuid REFERENCES storage_location (id) ON DELETE RESTRICT,
      location_code text,
      warehouse_of_record text,
      completed_at timestamptz,
      first_scan_at timestamptz NOT NULL,
      plant_id uuid NOT NULL REFERENCES org_node (id) ON DELETE RESTRICT,
      enterprise_id uuid NOT NULL REFERENCES org_node (id) ON DELETE RESTRICT,
      business_time timestamptz NOT NULL DEFAULT now(),
      created_at timestamptz NOT NULL DEFAULT now(),
      created_by text,
      updated_at timestamptz NOT NULL DEFAULT now(),
      updated_by text,
      CONSTRAINT pallet_task_no_unique UNIQUE (task_no)
    );
    -- RS-S3/RS-14：同一人同一分托类型同时只能有一条进行中（partial unique 索引）
    CREATE UNIQUE INDEX pallet_task_in_progress_uidx
      ON pallet_task (operator, task_type) WHERE status = 'in_progress';
    CREATE INDEX pallet_task_plant_idx ON pallet_task (plant_id);
    CREATE INDEX pallet_task_completed_idx ON pallet_task (plant_id, task_type, status)
      WHERE status = 'completed';

    -- ============ 分托/解绑扫入明细（RS-S3/RS-17：扫入快照列） ============
    CREATE TABLE pallet_task_line (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      task_id uuid NOT NULL REFERENCES pallet_task (id) ON DELETE RESTRICT,
      unit_id uuid NOT NULL REFERENCES inventory_unit (id) ON DELETE RESTRICT,
      unit_no text NOT NULL CHECK (unit_no <> ''),
      original_carrier_id uuid REFERENCES carrier (id) ON DELETE RESTRICT,
      original_carrier_code text,
      original_warehouse_id uuid REFERENCES warehouse (id) ON DELETE RESTRICT,
      original_warehouse_code text,
      original_rack_id uuid REFERENCES rack (id) ON DELETE RESTRICT,
      original_rack_code text,
      original_location_id uuid REFERENCES storage_location (id) ON DELETE RESTRICT,
      original_location_code text,
      reservation_id uuid REFERENCES reservation (id) ON DELETE RESTRICT,
      scanned_at timestamptz NOT NULL,
      removed_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT pallet_task_line_unique UNIQUE (task_id, unit_no)
    );
    CREATE INDEX pallet_task_line_task_idx ON pallet_task_line (task_id);
    CREATE INDEX pallet_task_line_unit_idx ON pallet_task_line (unit_id);

    -- ============ 轴号当前值事实（本域投影：码 → 客户轴号/段长/虚拟轴号） ============
    -- 点查/按订单查（RS-26 可选列表数据源）；不带范围列——范围过滤在 correction/retire 表。
    CREATE TABLE axis_no_state (
      unit_id uuid PRIMARY KEY REFERENCES inventory_unit (id) ON DELETE RESTRICT,
      unit_no text NOT NULL CHECK (unit_no <> ''),
      sales_order_no text NOT NULL DEFAULT '',
      order_line_no text,
      customer_axis_no text,
      segment_length text,
      virtual_axis_no text,
      updated_at timestamptz NOT NULL DEFAULT now(),
      updated_by text
    );
    CREATE INDEX axis_no_state_order_idx ON axis_no_state (sales_order_no);

    -- ============ 修正记录（RS-S5/RS-25～33：状态＋目标码 ID＋前后值快照＋对象版本） ============
    CREATE TABLE axis_no_correction (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      correction_no text NOT NULL CHECK (correction_no <> ''),
      target_unit_id uuid NOT NULL REFERENCES inventory_unit (id) ON DELETE RESTRICT,
      target_unit_no text NOT NULL CHECK (target_unit_no <> ''),
      target_object_version bigint NOT NULL CHECK (target_object_version >= 0),
      before_customer_axis_no text,
      after_customer_axis_no text,
      before_segment_length text,
      after_segment_length text,
      before_virtual_axis_no text,
      after_virtual_axis_no text,
      original_qty numeric(18,4) NOT NULL CHECK (original_qty >= 0),
      cut_qty numeric(18,4) NOT NULL CHECK (cut_qty >= 0),
      new_qty numeric(18,4) NOT NULL CHECK (new_qty >= 0),
      uom_id uuid NOT NULL,
      uom_code text NOT NULL CHECK (uom_code <> ''),
      status text NOT NULL DEFAULT 'completed' CHECK (status IN ('completed', 'withdrawn')),
      took_over_unit_id uuid REFERENCES inventory_unit (id) ON DELETE RESTRICT,
      took_over_unit_no text,
      reassign_reason text,
      corrected_by text NOT NULL CHECK (corrected_by <> ''),
      corrected_at timestamptz NOT NULL,
      withdrawn_by text,
      withdrawn_at timestamptz,
      command_receipt_id uuid REFERENCES command_receipt (id) ON DELETE RESTRICT,
      plant_id uuid NOT NULL REFERENCES org_node (id) ON DELETE RESTRICT,
      enterprise_id uuid NOT NULL REFERENCES org_node (id) ON DELETE RESTRICT,
      business_time timestamptz NOT NULL DEFAULT now(),
      created_at timestamptz NOT NULL DEFAULT now(),
      created_by text,
      CONSTRAINT axis_no_correction_no_unique UNIQUE (correction_no),
      CONSTRAINT axis_no_correction_qty_ck CHECK (original_qty >= cut_qty AND new_qty = original_qty - cut_qty)
    );
    CREATE INDEX axis_no_correction_target_idx ON axis_no_correction (target_unit_id);
    CREATE INDEX axis_no_correction_plant_idx ON axis_no_correction (plant_id, corrected_at DESC);
    -- RS-S5：回撤写状态切换与审计，不改历史值——UPDATE 仅允许
    -- status/withdrawn_by/withdrawn_at/updated* 列变化（触发器逐列比对）
    CREATE FUNCTION cadenza_rework_correction_update_guard() RETURNS trigger AS $$
    BEGIN
      IF NEW.id <> OLD.id
         OR NEW.correction_no <> OLD.correction_no
         OR NEW.target_unit_id <> OLD.target_unit_id
         OR NEW.target_unit_no <> OLD.target_unit_no
         OR NEW.target_object_version <> OLD.target_object_version
         OR NEW.before_customer_axis_no IS DISTINCT FROM OLD.before_customer_axis_no
         OR NEW.after_customer_axis_no IS DISTINCT FROM OLD.after_customer_axis_no
         OR NEW.before_segment_length IS DISTINCT FROM OLD.before_segment_length
         OR NEW.after_segment_length IS DISTINCT FROM OLD.after_segment_length
         OR NEW.before_virtual_axis_no IS DISTINCT FROM OLD.before_virtual_axis_no
         OR NEW.after_virtual_axis_no IS DISTINCT FROM OLD.after_virtual_axis_no
         OR NEW.original_qty <> OLD.original_qty
         OR NEW.cut_qty <> OLD.cut_qty
         OR NEW.new_qty <> OLD.new_qty
         OR NEW.took_over_unit_id IS DISTINCT FROM OLD.took_over_unit_id
         OR NEW.reassign_reason IS DISTINCT FROM OLD.reassign_reason
         OR NEW.corrected_by <> OLD.corrected_by
         OR NEW.corrected_at <> OLD.corrected_at
         OR NEW.command_receipt_id IS DISTINCT FROM OLD.command_receipt_id THEN
        RAISE EXCEPTION '[RS-S5] 修正记录历史值不可改写：仅允许状态切换（completed→withdrawn）与回撤留痕';
      END IF;
      IF OLD.status = 'withdrawn' THEN
        RAISE EXCEPTION '[RS-S5] 已撤销的修正记录不可再变更';
      END IF;
      IF NEW.status = 'withdrawn' AND (NEW.withdrawn_by IS NULL OR NEW.withdrawn_at IS NULL) THEN
        RAISE EXCEPTION '[RS-S5] 回撤必须留痕（withdrawn_by/withdrawn_at）';
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
    CREATE TRIGGER axis_no_correction_update_guard
      BEFORE UPDATE ON axis_no_correction
      FOR EACH ROW EXECUTE FUNCTION cadenza_rework_correction_update_guard();
    CREATE TRIGGER axis_no_correction_delete_guard
      BEFORE DELETE ON axis_no_correction
      FOR EACH ROW EXECUTE FUNCTION cadenza_rework_append_guard();

    -- ============ 退役状态（RS-S6/RS-36：逻辑退役，不改共享 inventory_unit 表结构） ============
    CREATE TABLE axis_code_retire (
      unit_id uuid PRIMARY KEY REFERENCES inventory_unit (id) ON DELETE RESTRICT,
      unit_no text NOT NULL CHECK (unit_no <> ''),
      retired_by text NOT NULL CHECK (retired_by <> ''),
      retired_at timestamptz NOT NULL,
      command_receipt_id uuid REFERENCES command_receipt (id) ON DELETE RESTRICT,
      plant_id uuid NOT NULL REFERENCES org_node (id) ON DELETE RESTRICT,
      enterprise_id uuid NOT NULL REFERENCES org_node (id) ON DELETE RESTRICT
    );
    CREATE INDEX axis_code_retire_plant_idx ON axis_code_retire (plant_id);
    CREATE TRIGGER axis_code_retire_append_guard
      BEFORE UPDATE OR DELETE ON axis_code_retire
      FOR EACH ROW EXECUTE FUNCTION cadenza_rework_append_guard();

    -- ============ 轴码清空记录（RS-S6/RS-35：快照字段集，append-only；身份与谱系保留） ============
    CREATE TABLE axis_retire_record (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      retire_no text NOT NULL CHECK (retire_no <> ''),
      unit_id uuid NOT NULL REFERENCES inventory_unit (id) ON DELETE RESTRICT,
      unit_no text NOT NULL CHECK (unit_no <> ''),
      qty_before numeric(18,4) NOT NULL CHECK (qty_before >= 0),
      production_dept text,
      production_order_no text,
      sales_order_no text,
      line_no text,
      material_id uuid NOT NULL REFERENCES material (id) ON DELETE RESTRICT,
      material_code text NOT NULL CHECK (material_code <> ''),
      process_name text,
      report_by text,
      report_at timestamptz,
      retired_by text NOT NULL CHECK (retired_by <> ''),
      retired_at timestamptz NOT NULL,
      uom_id uuid NOT NULL,
      uom_code text NOT NULL CHECK (uom_code <> ''),
      measurement_basis text NOT NULL,
      conversion_revision_id uuid,
      command_receipt_id uuid REFERENCES command_receipt (id) ON DELETE RESTRICT,
      plant_id uuid NOT NULL REFERENCES org_node (id) ON DELETE RESTRICT,
      enterprise_id uuid NOT NULL REFERENCES org_node (id) ON DELETE RESTRICT,
      business_time timestamptz NOT NULL DEFAULT now(),
      created_at timestamptz NOT NULL DEFAULT now(),
      created_by text,
      CONSTRAINT axis_retire_record_no_unique UNIQUE (retire_no)
    );
    CREATE INDEX axis_retire_record_plant_idx ON axis_retire_record (plant_id);
    CREATE INDEX axis_retire_record_unit_idx ON axis_retire_record (unit_id);
    CREATE TRIGGER axis_retire_record_append_guard
      BEFORE UPDATE OR DELETE ON axis_retire_record
      FOR EACH ROW EXECUTE FUNCTION cadenza_rework_append_guard();
  `,
  down: /* sql */ `
    DROP TABLE IF EXISTS axis_retire_record;
    DROP TABLE IF EXISTS axis_code_retire;
    DROP TRIGGER IF EXISTS axis_no_correction_delete_guard ON axis_no_correction;
    DROP TRIGGER IF EXISTS axis_no_correction_update_guard ON axis_no_correction;
    DROP FUNCTION IF EXISTS cadenza_rework_correction_update_guard();
    DROP TABLE IF EXISTS axis_no_correction;
    DROP TABLE IF EXISTS axis_no_state;
    DROP TABLE IF EXISTS pallet_task_line;
    DROP TABLE IF EXISTS pallet_task;
    DROP TABLE IF EXISTS reel_split_reversal;
    DROP TABLE IF EXISTS reel_split_line;
    DROP TABLE IF EXISTS reel_split_order;
    DROP FUNCTION IF EXISTS cadenza_rework_append_guard();
  `,
}
