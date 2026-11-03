import type { Migration } from './index'

/**
 * 0006 采购主链迁移（L1-P1-SERVER / T08，WorkItem 指派；**不注册共享 registry**——
 * 本文件由 L0 整合步统一并入 migrations/registry.ts，测试侧以编程方式 migrateUp 单独应用）。
 *
 * 依据：规则底稿 architecture/contracts/prep/p1/04-supply-chain-rules-T08T12T13T14.md §A-T08
 * （A-1～A-11）+ 冻结合同 architecture/contracts/frozen/p1/interfaces.md IF-08/09/10。
 *
 * 表：
 * - purchase_order / purchase_order_line [A-1]：行状态 0–5 CHECK、计划/已收/上限列、
 *   erp_closed 商业关闭冻结标志（IF-08：ERP 已商业关闭的订单不被 MOM 数量重算重新打开）、
 *   外部五元组库级等价唯一 (source_system, org_code, order_no, line_no)
 *   （object_type 常量 'purchase_order_line'；入站命令路径同时落 0002 external_mapping
 *    五元组唯一行，IF-00.2/OA-32 双保险）；
 * - purchase_receipt_batch [A-4/A-6/A-9/A-10/A-11]：批次（同码多批合法——batch_no 系统生成，
 *   同一订单行多批次无唯一约束，PI S13）、6 态质检状态轴 + 入库/复核状态 + 价格快照列
 *   （unit_price/price_history/avg_price/deviation_ppm/price_flag）+ 合格/退货两路独立同步
 *   状态列（IF-00.5 业务与同步状态分存；'none'=未达回传条件尚无任务）；
 * - receipt_detail [A-3]：「二维码+厂家批号+牌号/线径」三元组唯一（空值规范化为空串）、
 *   数量>0、质量状态投影列（免检/待检/合格/不合格/待复检 5 态）、库存单元引用（谱系起点）；
 * - inspection_record [A-6/A-7/A-8/S14]：追加历史+生效结论版本化——
 *   (detail_id, inspection_type, version) 唯一 + partial unique 生效指针
 *   (detail_id, inspection_type) WHERE is_effective + 守卫触发器（UPDATE 仅允许翻转
 *   is_effective 指针列、DELETE 拒绝：判定/撤销不清历史，S14 目标口径）；
 * - batch_judgement [A-7]：整批判定记录版本化（同批次仅一条生效，新覆盖旧=追加版本行）。
 *
 * 外键：material（0003）/inventory_unit、command_receipt（0004/0001）已注册落地，直接 RESTRICT。
 * 守卫函数名独立（cadenza_purchase_history_guard），与 0004 的 cadenza_reject_mutation
 * 互不影响（0004 down 不误伤本块触发器）。
 */
export const migration0006: Migration = {
  version: '0006',
  name: 'purchase-receipt-inspection-review',
  up: /* sql */ `
    -- ============ S14 守卫：质检/判定历史不可删、事实列不可改（仅允许翻转生效指针） ============
    CREATE FUNCTION cadenza_purchase_history_guard() RETURNS trigger AS $$
    DECLARE
      changed_fact boolean;
    BEGIN
      IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION '[A-S14] 表 % 禁止 DELETE：质检/判定历史不可物理删除（纠正走生效指针切换或新版本行）',
          TG_TABLE_NAME;
      END IF;
      IF TG_TABLE_NAME = 'inspection_record' THEN
        changed_fact := NEW.conclusion IS DISTINCT FROM OLD.conclusion
          OR NEW.inspector IS DISTINCT FROM OLD.inspector
          OR NEW.inspected_at IS DISTINCT FROM OLD.inspected_at
          OR NEW.attachments IS DISTINCT FROM OLD.attachments
          OR NEW.command_receipt_id IS DISTINCT FROM OLD.command_receipt_id
          OR NEW.source IS DISTINCT FROM OLD.source
          OR NEW.version IS DISTINCT FROM OLD.version
          OR NEW.detail_id IS DISTINCT FROM OLD.detail_id
          OR NEW.inspection_type IS DISTINCT FROM OLD.inspection_type;
      ELSE
        changed_fact := NEW.conclusion IS DISTINCT FROM OLD.conclusion
          OR NEW.judge_by IS DISTINCT FROM OLD.judge_by
          OR NEW.judged_at IS DISTINCT FROM OLD.judged_at
          OR NEW.note IS DISTINCT FROM OLD.note
          OR NEW.attachments IS DISTINCT FROM OLD.attachments
          OR NEW.version IS DISTINCT FROM OLD.version
          OR NEW.batch_id IS DISTINCT FROM OLD.batch_id;
      END IF;
      IF changed_fact THEN
        RAISE EXCEPTION '[A-S14] 表 % 仅允许翻转生效指针列（is_effective）：结论事实不可修改，新结论走追加版本行',
          TG_TABLE_NAME;
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;

    -- ============ 采购订单头（IF-08 入站；MES 零增删改） ============
    CREATE TABLE purchase_order (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      order_no text NOT NULL CHECK (order_no <> ''),
      org_code text NOT NULL CHECK (org_code <> ''),
      source_system text NOT NULL DEFAULT 'ERP',
      plant_id uuid NOT NULL REFERENCES org_node (id) ON DELETE RESTRICT,
      enterprise_id uuid NOT NULL REFERENCES org_node (id) ON DELETE RESTRICT,
      supplier_name text,
      contract_no text,
      external_revision integer,
      created_at timestamptz NOT NULL DEFAULT now(),
      created_by text,
      updated_at timestamptz NOT NULL DEFAULT now(),
      updated_by text,
      CONSTRAINT purchase_order_key_unique UNIQUE (source_system, org_code, order_no)
    );
    CREATE INDEX purchase_order_plant_idx ON purchase_order (plant_id);
    CREATE INDEX purchase_order_no_idx ON purchase_order (order_no);

    -- ============ 采购订单行（A-1：状态 0–5、计划/已收/上限、ERP 关闭冻结、五元组唯一） ============
    CREATE TABLE purchase_order_line (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      purchase_order_id uuid NOT NULL REFERENCES purchase_order (id) ON DELETE RESTRICT,
      line_no integer NOT NULL CHECK (line_no >= 1),
      order_no text NOT NULL,
      org_code text NOT NULL,
      source_system text NOT NULL,
      material_id uuid NOT NULL REFERENCES material (id) ON DELETE RESTRICT,
      material_code text NOT NULL CHECK (material_code <> ''),
      material_name text,
      material_type smallint,
      spec text,
      model text,
      color text,
      requisition_spec text,
      sales_order_no text,
      sales_line_no text,
      uom_code text NOT NULL CHECK (uom_code <> ''),
      planned_qty numeric(18,4) NOT NULL CHECK (planned_qty >= 0),
      received_qty numeric(18,4) NOT NULL DEFAULT 0 CHECK (received_qty >= 0),
      over_receipt_limit numeric(18,4) NOT NULL CHECK (over_receipt_limit >= 0),
      status smallint NOT NULL DEFAULT 0 CHECK (status BETWEEN 0 AND 5),
      erp_closed boolean NOT NULL DEFAULT false,
      planned_receipt_date date,
      first_arrival_date date,
      last_arrival_date date,
      external_revision integer,
      plant_id uuid NOT NULL REFERENCES org_node (id) ON DELETE RESTRICT,
      enterprise_id uuid NOT NULL REFERENCES org_node (id) ON DELETE RESTRICT,
      business_time timestamptz NOT NULL DEFAULT now(),
      created_at timestamptz NOT NULL DEFAULT now(),
      created_by text,
      updated_at timestamptz NOT NULL DEFAULT now(),
      updated_by text,
      -- A-1/IF-08：外部五元组库级等价唯一（object_type 常量 'purchase_order_line'）
      CONSTRAINT purchase_order_line_key_unique UNIQUE (source_system, org_code, order_no, line_no),
      CONSTRAINT purchase_order_line_no_unique UNIQUE (purchase_order_id, line_no)
    );
    CREATE INDEX purchase_order_line_order_no_idx ON purchase_order_line (order_no);
    CREATE INDEX purchase_order_line_plant_idx ON purchase_order_line (plant_id);
    CREATE INDEX purchase_order_line_status_idx ON purchase_order_line (status);

    -- ============ 采购收货批次（A-4/A-6/A-9/A-10/A-11） ============
    CREATE TABLE purchase_receipt_batch (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      batch_no text NOT NULL CHECK (batch_no <> ''),
      purchase_line_id uuid NOT NULL REFERENCES purchase_order_line (id) ON DELETE RESTRICT,
      order_no text NOT NULL,
      line_no integer NOT NULL,
      material_id uuid NOT NULL REFERENCES material (id) ON DELETE RESTRICT,
      material_code text NOT NULL,
      material_name text,
      material_type smallint,
      plant_id uuid NOT NULL REFERENCES org_node (id) ON DELETE RESTRICT,
      enterprise_id uuid NOT NULL REFERENCES org_node (id) ON DELETE RESTRICT,
      warehouse_id uuid NOT NULL,
      warehouse_code text,
      location_id uuid,
      location_code text,
      uom_id uuid NOT NULL,
      uom_code text NOT NULL CHECK (uom_code <> ''),
      measurement_basis text NOT NULL DEFAULT 'nominal',
      inspection_status text NOT NULL DEFAULT 'pending'
        CHECK (inspection_status IN (
          'exempt', 'pending', 'in_progress', 'all_qualified', 'all_unqualified', 'partially_qualified'
        )),
      storage_status text NOT NULL DEFAULT 'stored' CHECK (storage_status IN ('stored', 'returned')),
      received_qty numeric(18,4) NOT NULL DEFAULT 0 CHECK (received_qty >= 0),
      unit_price numeric(18,4),
      price_history jsonb,
      avg_price numeric(18,4),
      deviation_ppm integer,
      price_flag text CHECK (price_flag IN ('up', 'down')),
      review_status text NOT NULL DEFAULT 'pending' CHECK (review_status IN ('pending', 'reviewed')),
      reviewed_by text,
      reviewed_at timestamptz,
      qualified_sync_status text NOT NULL DEFAULT 'none'
        CHECK (qualified_sync_status IN ('none', 'pending', 'failed', 'synced')),
      return_sync_status text NOT NULL DEFAULT 'none'
        CHECK (return_sync_status IN ('none', 'pending', 'failed', 'synced')),
      arrival_time timestamptz NOT NULL,
      confirm_time timestamptz NOT NULL,
      received_by text NOT NULL,
      returned_at timestamptz,
      return_reason text,
      business_time timestamptz NOT NULL DEFAULT now(),
      created_at timestamptz NOT NULL DEFAULT now(),
      created_by text,
      updated_at timestamptz NOT NULL DEFAULT now(),
      updated_by text,
      CONSTRAINT purchase_receipt_batch_no_unique UNIQUE (batch_no)
    );
    CREATE INDEX purchase_receipt_batch_line_idx ON purchase_receipt_batch (purchase_line_id);
    CREATE INDEX purchase_receipt_batch_plant_idx ON purchase_receipt_batch (plant_id);
    -- A-10 价格历史口径：物料+企业下已入库（非退货）有单价批次，按确认时间倒序取近 5 次
    CREATE INDEX purchase_receipt_batch_price_history_idx
      ON purchase_receipt_batch (material_id, enterprise_id, confirm_time DESC)
      WHERE storage_status = 'stored' AND unit_price IS NOT NULL;

    -- ============ 收货明细（A-3：三元组唯一；质量状态投影列；谱系起点） ============
    CREATE TABLE receipt_detail (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      batch_id uuid NOT NULL REFERENCES purchase_receipt_batch (id) ON DELETE RESTRICT,
      barcode_value text NOT NULL CHECK (barcode_value <> ''),
      supplier_lot_no text NOT NULL DEFAULT '',
      grade text NOT NULL DEFAULT '',
      production_date date,
      quantity numeric(18,4) NOT NULL CHECK (quantity > 0),
      package_qty numeric(18,4),
      code_count integer,
      conversion_revision_id uuid,
      uom_id uuid NOT NULL,
      uom_code text NOT NULL CHECK (uom_code <> ''),
      quality_status text NOT NULL DEFAULT 'pending_inspection'
        CHECK (quality_status IN ('exempt', 'pending_inspection', 'qualified', 'unqualified', 're_inspection')),
      inventory_unit_id uuid REFERENCES inventory_unit (id) ON DELETE RESTRICT,
      location_id uuid,
      location_code text,
      note text,
      business_time timestamptz NOT NULL DEFAULT now(),
      created_at timestamptz NOT NULL DEFAULT now(),
      created_by text,
      updated_at timestamptz NOT NULL DEFAULT now(),
      updated_by text,
      -- A-3：同一收货单内「二维码+厂家批号+牌号/线径」三元组唯一（空值规范化为空串）
      CONSTRAINT receipt_detail_triple_unique UNIQUE (batch_id, barcode_value, supplier_lot_no, grade)
    );
    CREATE INDEX receipt_detail_batch_idx ON receipt_detail (batch_id);
    CREATE INDEX receipt_detail_barcode_idx ON receipt_detail (barcode_value);
    CREATE INDEX receipt_detail_unit_idx ON receipt_detail (inventory_unit_id);

    -- ============ 质检记录（A-6/A-7/A-8/S14：追加历史 + 生效结论版本化） ============
    -- 每行 = 一次结论事实（含收货首记录）；结论变更 = 追加新版本行 + 翻转生效指针；
    -- 撤销 = 指针切回首检初始行（历史保留）。守卫触发器拒事实列 UPDATE 与一切 DELETE。
    CREATE TABLE inspection_record (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      batch_id uuid NOT NULL REFERENCES purchase_receipt_batch (id) ON DELETE RESTRICT,
      detail_id uuid NOT NULL REFERENCES receipt_detail (id) ON DELETE RESTRICT,
      barcode_value text NOT NULL,
      inspection_type text NOT NULL CHECK (inspection_type IN ('first', 're')),
      version integer NOT NULL CHECK (version >= 1),
      conclusion text NOT NULL CHECK (conclusion IN ('exempt', 'pending', 'qualified', 'unqualified')),
      is_effective boolean NOT NULL DEFAULT false,
      source text NOT NULL CHECK (source IN ('receive', 'pda', 'web', 'judge', 'reinspection_start')),
      inspector text,
      inspected_at timestamptz,
      attachments jsonb,
      command_receipt_id uuid REFERENCES command_receipt (id) ON DELETE RESTRICT,
      business_time timestamptz NOT NULL DEFAULT now(),
      created_at timestamptz NOT NULL DEFAULT now(),
      created_by text,
      updated_at timestamptz NOT NULL DEFAULT now(),
      updated_by text,
      CONSTRAINT inspection_record_version_unique UNIQUE (detail_id, inspection_type, version)
    );
    -- S14 生效指针：同链（detail+type）至多一条生效行
    CREATE UNIQUE INDEX inspection_record_effective_uidx
      ON inspection_record (detail_id, inspection_type) WHERE is_effective;
    CREATE INDEX inspection_record_batch_idx ON inspection_record (batch_id);
    CREATE INDEX inspection_record_detail_idx ON inspection_record (detail_id);
    CREATE TRIGGER inspection_record_history_guard
      BEFORE UPDATE OR DELETE ON inspection_record
      FOR EACH ROW EXECUTE FUNCTION cadenza_purchase_history_guard();

    -- ============ 整批判定记录（A-7：同批次仅一条生效，新覆盖旧=版本追加，S14） ============
    CREATE TABLE batch_judgement (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      batch_id uuid NOT NULL REFERENCES purchase_receipt_batch (id) ON DELETE RESTRICT,
      version integer NOT NULL CHECK (version >= 1),
      conclusion text NOT NULL CHECK (conclusion IN ('qualified', 'unqualified')),
      judge_by text NOT NULL,
      judged_at timestamptz NOT NULL,
      note text,
      attachments jsonb,
      is_effective boolean NOT NULL DEFAULT true,
      command_receipt_id uuid REFERENCES command_receipt (id) ON DELETE RESTRICT,
      created_at timestamptz NOT NULL DEFAULT now(),
      created_by text,
      updated_at timestamptz NOT NULL DEFAULT now(),
      updated_by text,
      CONSTRAINT batch_judgement_version_unique UNIQUE (batch_id, version)
    );
    CREATE UNIQUE INDEX batch_judgement_effective_uidx
      ON batch_judgement (batch_id) WHERE is_effective;
    CREATE TRIGGER batch_judgement_history_guard
      BEFORE UPDATE OR DELETE ON batch_judgement
      FOR EACH ROW EXECUTE FUNCTION cadenza_purchase_history_guard();
  `,
  down: /* sql */ `
    DROP TABLE IF EXISTS batch_judgement;
    DROP TABLE IF EXISTS inspection_record;
    DROP TABLE IF EXISTS receipt_detail;
    DROP TABLE IF EXISTS purchase_receipt_batch;
    DROP TABLE IF EXISTS purchase_order_line;
    DROP TABLE IF EXISTS purchase_order;
    DROP FUNCTION IF EXISTS cadenza_purchase_history_guard();
  `,
}
