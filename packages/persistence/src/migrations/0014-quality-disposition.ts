import type { Migration } from './index'

/**
 * 0014 质量处置迁移（P2-D / T18，WorkItem 指派；**不注册共享 registry**——
 * 本文件由 L0 整合步统一并入 migrations/registry.ts，测试侧以编程方式 migrateUp 单独应用
 * （独立库 cadenza_disposition，与共享 dev 库及并行 writer 的 0011/0012/0013/0015/0016 无表名/迁移号冲突）。
 *
 * 依据冻结合同 architecture/contracts/frozen/p2/quality-disposition.md
 * （QD-01～QD-25 业务规则 + QD-S1～QD-S5 表级约束）。
 *
 * 表（采购质检结论版本化的存储模型已由 0006 落地——inspection_record（首检/复检链，
 * 追加历史＋生效指针，S14）与 batch_judgement（判定版本链，同批次仅一条生效）；
 * 本域 QD-11～QD-18 命令直接消费 0006 既有表（先例：0013 receipt_correction FK
 * purchase_receipt_batch 并在命令中更新其 storage_status），不建平行事实表，避免双事实源）：
 * - qd_suspect_record [QD-S1]：质量存疑记录（append-only；存疑前质量状态列供 QD-03 恢复回落；
 *   恢复写新处置记录、不覆盖原行——与 0009 quality_hold 独立，P1 表不受影响）；
 * - qd_disposition_record [QD-S3]：处置记录（首期四类 返工/报废/让步/放行＋存疑恢复处置；
 *   放行/报废 reason 非空库级 CHECK；报废去向指针=扣减流水 ref 回指处置记录）；
 * - finished_goods_defect [QD-S4]：成品异常记录（审核状态 3 值＋不合格类型 2 值＋扣数去向列；
 *   approved → 去向枚举＋说明非空库级 CHECK）；
 * - qd_rework_task [QD-21]：返工任务（关联处置记录＋原工序/订单/码；单据形态随 GAP-F16，
 *   状态列最小三值）。
 *
 * certificate / customer_complaint / recall 三对象随 GAP-F16 裁定，裁定前不建（QD-S5）。
 * 守卫函数名独立（cadenza_qd_append_guard），与 0004/0006/0009/0013 既有守卫互不影响；
 * 版本链守卫复用 0006 cadenza_purchase_history_guard（本迁移不新增版本链表）。
 * 外键（inventory_unit/material/stock_transaction/command_receipt/org_node）均已由
 * 0001–0010 注册落地，直接 RESTRICT。
 */
export const migration0014: Migration = {
  version: '0014',
  name: 'quality-disposition',
  up: /* sql */ `
    -- ============ T18 守卫：处置/存疑事实 append-only（QD-S1/QD-S3） ============
    CREATE FUNCTION cadenza_qd_append_guard() RETURNS trigger AS $$
    BEGIN
      RAISE EXCEPTION '[QD-S1/QD-S3] 表 % 为 append-only 处置事实：禁止 %（纠正/恢复写新记录）',
        TG_TABLE_NAME, TG_OP;
    END;
    $$ LANGUAGE plpgsql;

    -- ============ 存疑记录（QD-S1/QD-01~03） ============
    CREATE TABLE qd_suspect_record (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      inventory_unit_id uuid NOT NULL REFERENCES inventory_unit (id) ON DELETE RESTRICT,
      unit_no text NOT NULL CHECK (unit_no <> ''),
      material_key_joined text NOT NULL CHECK (material_key_joined <> ''),
      current_status text NOT NULL DEFAULT 'suspect' CHECK (current_status = 'suspect'),
      previous_quality_status text CHECK (previous_quality_status IN ('qualified', 'pending_inspection', 'unqualified')),
      production_dept_id uuid,
      production_dept_name text,
      raised_by text NOT NULL CHECK (raised_by <> ''),
      raised_at timestamptz NOT NULL,
      command_receipt_id uuid REFERENCES command_receipt (id) ON DELETE RESTRICT,
      plant_id uuid NOT NULL REFERENCES org_node (id) ON DELETE RESTRICT,
      enterprise_id uuid NOT NULL REFERENCES org_node (id) ON DELETE RESTRICT,
      business_time timestamptz NOT NULL DEFAULT now(),
      created_at timestamptz NOT NULL DEFAULT now(),
      created_by text
    );
    CREATE INDEX qd_suspect_record_unit_idx ON qd_suspect_record (inventory_unit_id);
    CREATE INDEX qd_suspect_record_plant_idx ON qd_suspect_record (plant_id);
    CREATE TRIGGER qd_suspect_record_append_guard
      BEFORE UPDATE OR DELETE ON qd_suspect_record
      FOR EACH ROW EXECUTE FUNCTION cadenza_qd_append_guard();

    -- ============ 处置记录（QD-S3/QD-03/19/20/21/22/23） ============
    CREATE TABLE qd_disposition_record (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      disposition_no text NOT NULL CHECK (disposition_no <> ''),
      disposition_kind text NOT NULL CHECK (disposition_kind IN ('rework', 'scrap', 'concession', 'release', 'hold_release')),
      target_type text NOT NULL CHECK (target_type <> ''),
      target_id uuid NOT NULL,
      decided_by text NOT NULL CHECK (decided_by <> ''),
      decided_at timestamptz NOT NULL,
      basis text,
      reason text,
      destination_kind text CHECK (destination_kind IN ('scrap', 'rework', 'other')),
      destination_note text,
      quantity numeric(18,4) CHECK (quantity IS NULL OR quantity > 0),
      uom_code text,
      transaction_id uuid REFERENCES stock_transaction (id) ON DELETE RESTRICT,
      rework_task_id uuid,
      concession_scope jsonb,
      approver text,
      command_receipt_id uuid REFERENCES command_receipt (id) ON DELETE RESTRICT,
      plant_id uuid NOT NULL REFERENCES org_node (id) ON DELETE RESTRICT,
      enterprise_id uuid NOT NULL REFERENCES org_node (id) ON DELETE RESTRICT,
      business_time timestamptz NOT NULL DEFAULT now(),
      created_at timestamptz NOT NULL DEFAULT now(),
      created_by text,
      CONSTRAINT qd_disposition_no_unique UNIQUE (disposition_no),
      -- QD-S3/OA-S5 同则：放行、报废 reason 非空（高影响操作强制理由）
      CONSTRAINT qd_disposition_high_impact_reason CHECK (
        disposition_kind NOT IN ('release', 'scrap')
        OR (reason IS NOT NULL AND btrim(reason) <> '')
      )
    );
    CREATE INDEX qd_disposition_target_idx ON qd_disposition_record (target_type, target_id);
    CREATE INDEX qd_disposition_plant_idx ON qd_disposition_record (plant_id);
    CREATE TRIGGER qd_disposition_record_append_guard
      BEFORE UPDATE OR DELETE ON qd_disposition_record
      FOR EACH ROW EXECUTE FUNCTION cadenza_qd_append_guard();

    -- ============ 成品异常记录（QD-S4/QD-05~10） ============
    CREATE TABLE finished_goods_defect (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      defect_no text NOT NULL CHECK (defect_no <> ''),
      inventory_unit_id uuid NOT NULL REFERENCES inventory_unit (id) ON DELETE RESTRICT,
      unit_no text NOT NULL CHECK (unit_no <> ''),
      material_id uuid NOT NULL REFERENCES material (id) ON DELETE RESTRICT,
      material_code text NOT NULL CHECK (material_code <> ''),
      defect_type text NOT NULL CHECK (defect_type IN ('rework', 'scrap')),
      defect_qty numeric(18,4) NOT NULL CHECK (defect_qty > 0),
      uom_code text NOT NULL CHECK (uom_code <> ''),
      review_status text NOT NULL DEFAULT 'unreviewed' CHECK (review_status IN ('unreviewed', 'approved', 'rejected')),
      submitted_by text NOT NULL CHECK (submitted_by <> ''),
      submitted_at timestamptz NOT NULL,
      reviewed_by text,
      reviewed_at timestamptz,
      destination_kind text CHECK (destination_kind IN ('scrap', 'rework', 'other')),
      destination_note text,
      adjust_reason text,
      deduction_transaction_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
      command_receipt_id uuid REFERENCES command_receipt (id) ON DELETE RESTRICT,
      production_dept_id uuid,
      production_dept_name text,
      plant_id uuid NOT NULL REFERENCES org_node (id) ON DELETE RESTRICT,
      enterprise_id uuid NOT NULL REFERENCES org_node (id) ON DELETE RESTRICT,
      business_time timestamptz NOT NULL DEFAULT now(),
      created_at timestamptz NOT NULL DEFAULT now(),
      created_by text,
      updated_at timestamptz NOT NULL DEFAULT now(),
      updated_by text,
      CONSTRAINT finished_goods_defect_no_unique UNIQUE (defect_no),
      -- QD-S4：审核通过 → 扣数去向（枚举＋说明）必填
      CONSTRAINT finished_goods_defect_destination_ck CHECK (
        review_status <> 'approved'
        OR (destination_kind IS NOT NULL AND destination_note IS NOT NULL AND btrim(destination_note) <> '')
      )
    );
    CREATE INDEX finished_goods_defect_unit_idx ON finished_goods_defect (inventory_unit_id);
    CREATE INDEX finished_goods_defect_open_uidx ON finished_goods_defect (inventory_unit_id, material_id) WHERE review_status = 'unreviewed';
    CREATE INDEX finished_goods_defect_plant_idx ON finished_goods_defect (plant_id);

    -- ============ 返工任务（QD-21：[合同新造] 最小；单据形态随 GAP-F16） ============
    CREATE TABLE qd_rework_task (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      task_no text NOT NULL CHECK (task_no <> ''),
      disposition_id uuid NOT NULL REFERENCES qd_disposition_record (id) ON DELETE RESTRICT,
      origin_unit_id uuid NOT NULL REFERENCES inventory_unit (id) ON DELETE RESTRICT,
      origin_unit_no text NOT NULL CHECK (origin_unit_no <> ''),
      origin_process_order_no text NOT NULL CHECK (origin_process_order_no <> ''),
      origin_operation text,
      status text NOT NULL DEFAULT 'created' CHECK (status IN ('created', 'in_progress', 'done')),
      note text,
      plant_id uuid NOT NULL REFERENCES org_node (id) ON DELETE RESTRICT,
      enterprise_id uuid NOT NULL REFERENCES org_node (id) ON DELETE RESTRICT,
      business_time timestamptz NOT NULL DEFAULT now(),
      created_at timestamptz NOT NULL DEFAULT now(),
      created_by text,
      updated_at timestamptz NOT NULL DEFAULT now(),
      updated_by text,
      CONSTRAINT qd_rework_task_no_unique UNIQUE (task_no)
    );
    CREATE INDEX qd_rework_task_unit_idx ON qd_rework_task (origin_unit_id);
    CREATE INDEX qd_rework_task_plant_idx ON qd_rework_task (plant_id);
  `,
  down: /* sql */ `
    DROP TABLE IF EXISTS qd_rework_task;
    DROP TABLE IF EXISTS finished_goods_defect;
    DROP TRIGGER IF EXISTS qd_disposition_record_append_guard ON qd_disposition_record;
    DROP TABLE IF EXISTS qd_disposition_record;
    DROP TRIGGER IF EXISTS qd_suspect_record_append_guard ON qd_suspect_record;
    DROP TABLE IF EXISTS qd_suspect_record;
    DROP FUNCTION IF EXISTS cadenza_qd_append_guard();
  `,
}
