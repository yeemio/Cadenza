import type { Migration } from './index'

/**
 * 0013 仓储异常与逆向迁移（P2-C / T17，WorkItem 指派；**不注册共享 registry**——
 * 本文件由 L0 整合步统一并入 migrations/registry.ts，测试侧以编程方式 migrateUp 单独应用
 * （独立库 cadenza_rev，与共享 dev 库及并行 writer 的 0011/0012 无表名/迁移号冲突）。
 *
 * 依据冻结合同 architecture/contracts/frozen/p2/warehouse-reverse.md
 * （WR-01～WR-28 业务规则 + WR-S1～WR-S6 表级约束）。
 *
 * 表（P1 已建 warehouse_move/transfer_order 为最小子集，本迁移为 P2 全量行为独立表集，
 * 与 0009 表名不冲突）：
 * - stock_move_record + stock_move_record_line [WR-S1]：移库台账（表头＋逐码原/现库位快照，append-only）；
 * - transfer_outbound_order + transfer_outbound_plan_line + transfer_outbound_scan [WR-S2]：
 *   调拨出库单（状态机列＋调出明细：码、原库位、数量、调出数量；
 *   无任务调拨 (created_by) 进行中唯一 partial unique）；
 * - transfer_inbound_order + transfer_inbound_line [WR-S3]：调拨入库单（入库方式列＋码入库状态列；
 *   固定库位完成单生成即已完成并含出库方身份快照列）；
 * - stocktake_order + stocktake_count_line + stock_adjustment + stock_adjustment_line [WR-S4]：
 *   盘点（**[合同新造·最小语义]**；仓库范围锁定标志——同仓至多一条盘点中 partial unique；
 *   差异调整单原因必填＋去向；调整流水写 stock_transaction，movement_kind='adjust'）；
 * - carrier_loan [WR-S5]：载具借出/回收/损坏/报废事件（append-only，引用 carrier，
 *   不与产品退货表关联——无 purchase/shipment 外键）；
 * - receipt_correction [WR-S6]：采购批次纠正事实（作废/冲销/退货三类，关联原批次与流水，
 *   含批次快照 jsonb；退货备注≤200/附件≤3 库级 CHECK）。
 *
 * 守卫函数名独立（cadenza_reverse_append_guard），与 0004 cadenza_reject_mutation、
 * 0006 cadenza_purchase_history_guard、0009 两守卫互不影响。
 * 外键（warehouse/storage_location/material/inventory_unit/carrier/org_node/command_receipt/
 * purchase_receipt_batch/stock_transaction）均已由 0001–0010 注册落地，直接 RESTRICT。
 */
export const migration0013: Migration = {
  version: '0013',
  name: 'warehouse-reverse',
  up: /* sql */ `
    -- ============ T17 守卫：移库台账/载具借还事件/纠正事实 append-only ============
    CREATE FUNCTION cadenza_reverse_append_guard() RETURNS trigger AS $$
    BEGIN
      RAISE EXCEPTION '[WR-S1/WR-S5/WR-S6] 表 % 为 append-only 事实：禁止 %（纠正走反向事实行或新事件）',
        TG_TABLE_NAME, TG_OP;
    END;
    $$ LANGUAGE plpgsql;

    -- ============ 移库台账（WR-S1/WR-01～05：表头＋逐码原/现库位快照） ============
    CREATE TABLE stock_move_record (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      move_no text NOT NULL CHECK (move_no <> ''),
      warehouse_id uuid NOT NULL REFERENCES warehouse (id) ON DELETE RESTRICT,
      warehouse_code text,
      to_location_id uuid NOT NULL REFERENCES storage_location (id) ON DELETE RESTRICT,
      to_location_code text NOT NULL CHECK (to_location_code <> ''),
      location_kind text,
      material_codes_joined text NOT NULL CHECK (material_codes_joined <> ''),
      total_qty numeric(18,4) NOT NULL CHECK (total_qty > 0),
      moved_by text NOT NULL CHECK (moved_by <> ''),
      moved_at timestamptz NOT NULL,
      reason text,
      command_receipt_id uuid REFERENCES command_receipt (id) ON DELETE RESTRICT,
      plant_id uuid NOT NULL REFERENCES org_node (id) ON DELETE RESTRICT,
      enterprise_id uuid NOT NULL REFERENCES org_node (id) ON DELETE RESTRICT,
      business_time timestamptz NOT NULL DEFAULT now(),
      created_at timestamptz NOT NULL DEFAULT now(),
      created_by text,
      CONSTRAINT stock_move_record_no_unique UNIQUE (move_no)
    );
    CREATE INDEX stock_move_record_plant_idx ON stock_move_record (plant_id);
    CREATE INDEX stock_move_record_moved_at_idx ON stock_move_record (moved_at DESC);
    CREATE TRIGGER stock_move_record_append_guard
      BEFORE UPDATE OR DELETE ON stock_move_record
      FOR EACH ROW EXECUTE FUNCTION cadenza_reverse_append_guard();

    CREATE TABLE stock_move_record_line (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      record_id uuid NOT NULL REFERENCES stock_move_record (id) ON DELETE RESTRICT,
      line_no integer NOT NULL CHECK (line_no >= 1),
      inventory_unit_id uuid NOT NULL REFERENCES inventory_unit (id) ON DELETE RESTRICT,
      unit_no text NOT NULL CHECK (unit_no <> ''),
      material_id uuid NOT NULL REFERENCES material (id) ON DELETE RESTRICT,
      material_code text NOT NULL CHECK (material_code <> ''),
      from_location_id uuid REFERENCES storage_location (id) ON DELETE RESTRICT,
      from_location_code text,
      to_location_id uuid NOT NULL REFERENCES storage_location (id) ON DELETE RESTRICT,
      to_location_code text NOT NULL CHECK (to_location_code <> ''),
      quantity numeric(18,4) NOT NULL CHECK (quantity > 0),
      uom_id uuid NOT NULL,
      uom_code text NOT NULL CHECK (uom_code <> ''),
      CONSTRAINT stock_move_record_line_no_unique UNIQUE (record_id, line_no)
    );
    CREATE INDEX stock_move_record_line_record_idx ON stock_move_record_line (record_id);
    CREATE INDEX stock_move_record_line_unit_idx ON stock_move_record_line (inventory_unit_id);
    CREATE TRIGGER stock_move_record_line_append_guard
      BEFORE UPDATE OR DELETE ON stock_move_record_line
      FOR EACH ROW EXECUTE FUNCTION cadenza_reverse_append_guard();

    -- ============ 调拨出库单（WR-S2/WR-06～13：状态机＋三来源＋无任务进行中唯一） ============
    CREATE TABLE transfer_outbound_order (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      order_no text NOT NULL CHECK (order_no <> ''),
      source_kind text NOT NULL CHECK (source_kind IN ('web_task', 'pda_taskless', 'auto')),
      transfer_kind text NOT NULL CHECK (transfer_kind IN ('production', 'warehouse')),
      related_order_no text,
      from_warehouse_id uuid NOT NULL REFERENCES warehouse (id) ON DELETE RESTRICT,
      to_warehouse_id uuid NOT NULL REFERENCES warehouse (id) ON DELETE RESTRICT,
      from_warehouse_code text,
      to_warehouse_code text,
      from_warehouse_type text,
      to_warehouse_type text,
      status text NOT NULL DEFAULT 'pending_out'
        CHECK (status IN ('pending_out', 'outbounding', 'outbounded', 'cancelled')),
      to_location_id uuid REFERENCES storage_location (id) ON DELETE RESTRICT,
      to_location_code text,
      to_location_kind text,
      transit_location_id uuid REFERENCES storage_location (id) ON DELETE RESTRICT,
      transit_location_code text,
      shipped_by text,
      shipped_at timestamptz,
      note text,
      plant_id uuid NOT NULL REFERENCES org_node (id) ON DELETE RESTRICT,
      enterprise_id uuid NOT NULL REFERENCES org_node (id) ON DELETE RESTRICT,
      business_time timestamptz NOT NULL DEFAULT now(),
      created_at timestamptz NOT NULL DEFAULT now(),
      created_by text,
      updated_at timestamptz NOT NULL DEFAULT now(),
      updated_by text,
      CONSTRAINT transfer_outbound_order_no_unique UNIQUE (order_no),
      CONSTRAINT transfer_outbound_warehouses_differ CHECK (from_warehouse_id <> to_warehouse_id)
    );
    CREATE INDEX transfer_outbound_order_plant_idx ON transfer_outbound_order (plant_id);
    CREATE INDEX transfer_outbound_order_status_idx ON transfer_outbound_order (status);
    -- WR-S2：无任务调拨 (操作人) 进行中唯一（partial，where 状态 ∈ {待出库, 出库中}）
    CREATE UNIQUE INDEX transfer_outbound_taskless_progress_uidx
      ON transfer_outbound_order (created_by)
      WHERE source_kind = 'pda_taskless' AND status IN ('pending_out', 'outbounding');

    -- 调拨出库计划明细（WR-07①：有任务单明细有计划调出数量，按料品）
    CREATE TABLE transfer_outbound_plan_line (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      order_id uuid NOT NULL REFERENCES transfer_outbound_order (id) ON DELETE RESTRICT,
      line_no integer NOT NULL CHECK (line_no >= 1),
      material_id uuid NOT NULL REFERENCES material (id) ON DELETE RESTRICT,
      material_code text NOT NULL CHECK (material_code <> ''),
      material_type smallint,
      planned_qty numeric(18,4) NOT NULL CHECK (planned_qty > 0),
      out_qty numeric(18,4) NOT NULL DEFAULT 0 CHECK (out_qty >= 0),
      created_at timestamptz NOT NULL DEFAULT now(),
      created_by text,
      updated_at timestamptz NOT NULL DEFAULT now(),
      updated_by text,
      CONSTRAINT transfer_outbound_plan_line_no_unique UNIQUE (order_id, line_no)
    );
    CREATE INDEX transfer_outbound_plan_line_order_idx ON transfer_outbound_plan_line (order_id);

    -- 调出明细（WR-S2/WR-09：码、原库位、数量、调出数量；装入即锁定=作业预留引用）
    CREATE TABLE transfer_outbound_scan (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      order_id uuid NOT NULL REFERENCES transfer_outbound_order (id) ON DELETE RESTRICT,
      line_no integer NOT NULL CHECK (line_no >= 1),
      inventory_unit_id uuid NOT NULL REFERENCES inventory_unit (id) ON DELETE RESTRICT,
      unit_no text NOT NULL CHECK (unit_no <> ''),
      material_id uuid REFERENCES material (id) ON DELETE RESTRICT,
      material_code text,
      material_type smallint,
      from_location_id uuid REFERENCES storage_location (id) ON DELETE RESTRICT,
      from_location_code text,
      quantity numeric(18,4) NOT NULL CHECK (quantity > 0),
      out_qty numeric(18,4) NOT NULL CHECK (out_qty > 0),
      reservation_id uuid,
      status text NOT NULL DEFAULT 'loaded' CHECK (status IN ('loaded', 'removed')),
      scanned_by text NOT NULL CHECK (scanned_by <> ''),
      scanned_at timestamptz NOT NULL,
      removed_by text,
      removed_at timestamptz,
      command_receipt_id uuid REFERENCES command_receipt (id) ON DELETE RESTRICT,
      created_at timestamptz NOT NULL DEFAULT now(),
      created_by text,
      updated_at timestamptz NOT NULL DEFAULT now(),
      updated_by text
    );
    CREATE INDEX transfer_outbound_scan_order_idx ON transfer_outbound_scan (order_id);
    CREATE INDEX transfer_outbound_scan_unit_idx ON transfer_outbound_scan (inventory_unit_id);
    -- 同单同码至多一条活动装入（删码后可重装——状态 removed 不受限）
    CREATE UNIQUE INDEX transfer_outbound_scan_loaded_uidx
      ON transfer_outbound_scan (order_id, inventory_unit_id) WHERE status = 'loaded';

    -- ============ 调拨入库单（WR-S3/WR-14～17：入库方式列＋码入库状态列＋出库方身份快照） ============
    CREATE TABLE transfer_inbound_order (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      order_no text NOT NULL CHECK (order_no <> ''),
      outbound_order_id uuid NOT NULL REFERENCES transfer_outbound_order (id) ON DELETE RESTRICT,
      inbound_mode text NOT NULL CHECK (inbound_mode IN ('fixed_location', 'scan_putaway')),
      status text NOT NULL DEFAULT 'pending_in'
        CHECK (status IN ('pending_in', 'inbounding', 'completed')),
      from_warehouse_id uuid NOT NULL REFERENCES warehouse (id) ON DELETE RESTRICT,
      to_warehouse_id uuid NOT NULL REFERENCES warehouse (id) ON DELETE RESTRICT,
      from_warehouse_code text,
      to_warehouse_code text,
      suggested_location_id uuid REFERENCES storage_location (id) ON DELETE RESTRICT,
      suggested_location_code text,
      -- WR-S3/WR-14：固定库位完成单生成即已完成并含出库方身份快照（入库人/时间=出库方）
      shipper_snapshot_by text,
      shipper_snapshot_at timestamptz,
      -- 独立接收事实（跨厂签收：接收方身份，WR-14）
      received_by text,
      received_at timestamptz,
      completed_at timestamptz,
      command_receipt_id uuid REFERENCES command_receipt (id) ON DELETE RESTRICT,
      plant_id uuid NOT NULL REFERENCES org_node (id) ON DELETE RESTRICT,
      enterprise_id uuid NOT NULL REFERENCES org_node (id) ON DELETE RESTRICT,
      business_time timestamptz NOT NULL DEFAULT now(),
      created_at timestamptz NOT NULL DEFAULT now(),
      created_by text,
      updated_at timestamptz NOT NULL DEFAULT now(),
      updated_by text,
      CONSTRAINT transfer_inbound_order_no_unique UNIQUE (order_no)
    );
    CREATE INDEX transfer_inbound_order_plant_idx ON transfer_inbound_order (plant_id);
    CREATE INDEX transfer_inbound_order_status_idx ON transfer_inbound_order (status);
    CREATE INDEX transfer_inbound_order_outbound_idx ON transfer_inbound_order (outbound_order_id);

    CREATE TABLE transfer_inbound_line (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      order_id uuid NOT NULL REFERENCES transfer_inbound_order (id) ON DELETE RESTRICT,
      line_no integer NOT NULL CHECK (line_no >= 1),
      inventory_unit_id uuid NOT NULL REFERENCES inventory_unit (id) ON DELETE RESTRICT,
      unit_no text NOT NULL CHECK (unit_no <> ''),
      material_id uuid REFERENCES material (id) ON DELETE RESTRICT,
      material_code text,
      quantity numeric(18,4) NOT NULL CHECK (quantity > 0),
      line_status text NOT NULL DEFAULT 'pending' CHECK (line_status IN ('pending', 'inbound')),
      is_pallet_child boolean NOT NULL DEFAULT false,
      location_id uuid REFERENCES storage_location (id) ON DELETE RESTRICT,
      location_code text,
      reservation_id uuid,
      inbound_at timestamptz,
      removed_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      created_by text,
      updated_at timestamptz NOT NULL DEFAULT now(),
      updated_by text,
      CONSTRAINT transfer_inbound_line_no_unique UNIQUE (order_id, line_no)
    );
    CREATE INDEX transfer_inbound_line_order_idx ON transfer_inbound_line (order_id);
    CREATE INDEX transfer_inbound_line_unit_idx ON transfer_inbound_line (inventory_unit_id);

    -- ============ 盘点（WR-S4，[合同新造·最小语义]；全流程 GAP-F10 待裁） ============
    CREATE TABLE stocktake_order (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      order_no text NOT NULL CHECK (order_no <> ''),
      warehouse_id uuid NOT NULL REFERENCES warehouse (id) ON DELETE RESTRICT,
      warehouse_code text,
      locked boolean NOT NULL DEFAULT true,
      status text NOT NULL DEFAULT 'counting' CHECK (status IN ('counting', 'completed', 'cancelled')),
      note text,
      started_by text NOT NULL CHECK (started_by <> ''),
      started_at timestamptz NOT NULL,
      closed_by text,
      closed_at timestamptz,
      plant_id uuid NOT NULL REFERENCES org_node (id) ON DELETE RESTRICT,
      enterprise_id uuid NOT NULL REFERENCES org_node (id) ON DELETE RESTRICT,
      business_time timestamptz NOT NULL DEFAULT now(),
      created_at timestamptz NOT NULL DEFAULT now(),
      created_by text,
      updated_at timestamptz NOT NULL DEFAULT now(),
      updated_by text,
      CONSTRAINT stocktake_order_no_unique UNIQUE (order_no)
    );
    CREATE INDEX stocktake_order_plant_idx ON stocktake_order (plant_id);
    -- WR-24①：锁定标志单源——同仓库至多一条盘点中（盘点期间拦截窗口唯一）
    CREATE UNIQUE INDEX stocktake_order_counting_uidx ON stocktake_order (warehouse_id) WHERE status = 'counting';

    CREATE TABLE stocktake_count_line (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      order_id uuid NOT NULL REFERENCES stocktake_order (id) ON DELETE RESTRICT,
      inventory_unit_id uuid NOT NULL REFERENCES inventory_unit (id) ON DELETE RESTRICT,
      unit_no text NOT NULL CHECK (unit_no <> ''),
      material_code text,
      location_id uuid REFERENCES storage_location (id) ON DELETE RESTRICT,
      location_code text,
      book_qty numeric(18,4) NOT NULL CHECK (book_qty >= 0),
      counted_qty numeric(18,4) NOT NULL CHECK (counted_qty >= 0),
      diff_qty numeric(18,4) NOT NULL,
      counted_by text NOT NULL CHECK (counted_by <> ''),
      counted_at timestamptz NOT NULL,
      command_receipt_id uuid REFERENCES command_receipt (id) ON DELETE RESTRICT,
      created_at timestamptz NOT NULL DEFAULT now(),
      created_by text
    );
    CREATE INDEX stocktake_count_line_order_idx ON stocktake_count_line (order_id);
    CREATE INDEX stocktake_count_line_unit_idx ON stocktake_count_line (inventory_unit_id);

    -- 差异调整单（WR-24②/③：原因必填＋去向；高影响 OA-29；调整流水写 stock_transaction）
    CREATE TABLE stock_adjustment (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      adjustment_no text NOT NULL CHECK (adjustment_no <> ''),
      stocktake_order_id uuid REFERENCES stocktake_order (id) ON DELETE RESTRICT,
      reason text NOT NULL CHECK (reason <> ''),
      destination text NOT NULL CHECK (destination <> ''),
      total_qty numeric(18,4) NOT NULL,
      adjusted_by text NOT NULL CHECK (adjusted_by <> ''),
      adjusted_at timestamptz NOT NULL,
      command_receipt_id uuid REFERENCES command_receipt (id) ON DELETE RESTRICT,
      plant_id uuid NOT NULL REFERENCES org_node (id) ON DELETE RESTRICT,
      enterprise_id uuid NOT NULL REFERENCES org_node (id) ON DELETE RESTRICT,
      business_time timestamptz NOT NULL DEFAULT now(),
      created_at timestamptz NOT NULL DEFAULT now(),
      created_by text,
      CONSTRAINT stock_adjustment_no_unique UNIQUE (adjustment_no)
    );
    CREATE INDEX stock_adjustment_plant_idx ON stock_adjustment (plant_id);
    CREATE INDEX stock_adjustment_stocktake_idx ON stock_adjustment (stocktake_order_id);

    CREATE TABLE stock_adjustment_line (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      adjustment_id uuid NOT NULL REFERENCES stock_adjustment (id) ON DELETE RESTRICT,
      line_no integer NOT NULL CHECK (line_no >= 1),
      inventory_unit_id uuid NOT NULL REFERENCES inventory_unit (id) ON DELETE RESTRICT,
      unit_no text NOT NULL CHECK (unit_no <> ''),
      location_id uuid NOT NULL,
      location_code text NOT NULL,
      owner_id uuid NOT NULL,
      owner_name text NOT NULL,
      adjust_qty numeric(18,4) NOT NULL CHECK (adjust_qty <> 0),
      before_qty numeric(18,4) NOT NULL CHECK (before_qty >= 0),
      after_qty numeric(18,4) NOT NULL CHECK (after_qty >= 0),
      transaction_id uuid REFERENCES stock_transaction (id) ON DELETE RESTRICT,
      balance_id uuid NOT NULL,
      CONSTRAINT stock_adjustment_line_no_unique UNIQUE (adjustment_id, line_no)
    );
    CREATE INDEX stock_adjustment_line_adjustment_idx ON stock_adjustment_line (adjustment_id);
    CREATE INDEX stock_adjustment_line_unit_idx ON stock_adjustment_line (inventory_unit_id);

    -- ============ 载具借还（WR-S5/WR-27：append-only 事件，引用 carrier，不与产品退货表关联） ============
    CREATE TABLE carrier_loan (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      carrier_id uuid NOT NULL REFERENCES carrier (id) ON DELETE RESTRICT,
      carrier_code text NOT NULL CHECK (carrier_code <> ''),
      carrier_kind text NOT NULL CHECK (carrier_kind IN ('spool', 'drum', 'tray', 'box')),
      event_kind text NOT NULL CHECK (event_kind IN ('lend', 'take_back', 'damage', 'scrap')),
      counterparty text,
      note text,
      occurred_by text NOT NULL CHECK (occurred_by <> ''),
      occurred_at timestamptz NOT NULL,
      command_receipt_id uuid REFERENCES command_receipt (id) ON DELETE RESTRICT,
      plant_id uuid NOT NULL REFERENCES org_node (id) ON DELETE RESTRICT,
      enterprise_id uuid NOT NULL REFERENCES org_node (id) ON DELETE RESTRICT,
      business_time timestamptz NOT NULL DEFAULT now(),
      created_at timestamptz NOT NULL DEFAULT now(),
      created_by text
    );
    CREATE INDEX carrier_loan_carrier_idx ON carrier_loan (carrier_id);
    CREATE INDEX carrier_loan_plant_idx ON carrier_loan (plant_id);
    CREATE TRIGGER carrier_loan_append_guard
      BEFORE UPDATE OR DELETE ON carrier_loan
      FOR EACH ROW EXECUTE FUNCTION cadenza_reverse_append_guard();

    -- ============ 采购批次纠正事实（WR-S6/WR-18～23：作废/冲销/退货三类） ============
    CREATE TABLE receipt_correction (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      correction_no text NOT NULL CHECK (correction_no <> ''),
      batch_id uuid NOT NULL REFERENCES purchase_receipt_batch (id) ON DELETE RESTRICT,
      batch_no text NOT NULL CHECK (batch_no <> ''),
      correction_kind text NOT NULL CHECK (correction_kind IN ('void', 'reverse', 'return')),
      quantity numeric(18,4) NOT NULL CHECK (quantity > 0),
      deducted_order_line_qty numeric(18,4) NOT NULL DEFAULT 0 CHECK (deducted_order_line_qty >= 0),
      reason text NOT NULL CHECK (reason <> ''),
      remark text CHECK (char_length(coalesce(remark, '')) <= 200),
      attachments jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_array_length(attachments) <= 3),
      return_sync_status text NOT NULL DEFAULT 'none'
        CHECK (return_sync_status IN ('none', 'pending', 'failed', 'synced')),
      snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
      operated_by text NOT NULL CHECK (operated_by <> ''),
      operated_at timestamptz NOT NULL,
      command_receipt_id uuid REFERENCES command_receipt (id) ON DELETE RESTRICT,
      plant_id uuid NOT NULL REFERENCES org_node (id) ON DELETE RESTRICT,
      enterprise_id uuid NOT NULL REFERENCES org_node (id) ON DELETE RESTRICT,
      business_time timestamptz NOT NULL DEFAULT now(),
      created_at timestamptz NOT NULL DEFAULT now(),
      created_by text,
      CONSTRAINT receipt_correction_no_unique UNIQUE (correction_no)
    );
    CREATE INDEX receipt_correction_batch_idx ON receipt_correction (batch_id);
    CREATE INDEX receipt_correction_plant_idx ON receipt_correction (plant_id);
    CREATE TRIGGER receipt_correction_append_guard
      BEFORE UPDATE OR DELETE ON receipt_correction
      FOR EACH ROW EXECUTE FUNCTION cadenza_reverse_append_guard();
  `,
  down: /* sql */ `
    DROP TRIGGER IF EXISTS receipt_correction_append_guard ON receipt_correction;
    DROP TABLE IF EXISTS receipt_correction;
    DROP TRIGGER IF EXISTS carrier_loan_append_guard ON carrier_loan;
    DROP TABLE IF EXISTS carrier_loan;
    DROP TABLE IF EXISTS stock_adjustment_line;
    DROP TABLE IF EXISTS stock_adjustment;
    DROP TABLE IF EXISTS stocktake_count_line;
    DROP TABLE IF EXISTS stocktake_order;
    DROP TABLE IF EXISTS transfer_inbound_line;
    DROP TABLE IF EXISTS transfer_inbound_order;
    DROP TABLE IF EXISTS transfer_outbound_scan;
    DROP TABLE IF EXISTS transfer_outbound_plan_line;
    DROP TABLE IF EXISTS transfer_outbound_order;
    DROP TRIGGER IF EXISTS stock_move_record_line_append_guard ON stock_move_record_line;
    DROP TABLE IF EXISTS stock_move_record_line;
    DROP TRIGGER IF EXISTS stock_move_record_append_guard ON stock_move_record;
    DROP TABLE IF EXISTS stock_move_record;
    DROP FUNCTION IF EXISTS cadenza_reverse_append_guard();
  `,
}
