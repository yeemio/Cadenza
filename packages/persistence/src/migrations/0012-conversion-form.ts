import type { Migration } from './index'

/**
 * 0012 形态转换迁移（P2-B / T16，WorkItem 指派；**不注册共享 registry**——
 * 本文件由 L0 整合步统一并入 migrations/registry.ts，测试侧以编程方式 migrateUp 单独应用
 * （独立库 cadenza_conversion，与共享 dev 库及并行 writer 的 0011/0013…无表名/迁移号冲突）。
 *
 * 依据：冻结合同 architecture/contracts/frozen/p2/form-conversion.md（FC-01～FC-21、
 * FC-S1～FC-S5）；DM §7.2；原件 形态转换/{01-订单形态转换,02-库存形态转换}.md。
 *
 * 表（两协议分立 FC-01）：
 * - conversion_order [FC-S1/FC-12]：订单转换单头——转换状态 2 值与同步状态 3 值**分列**；
 * - conversion_order_line [FC-S1]：明细 `(转换单, 转换前销售单号, 行号)` 唯一；
 *   实扫数量/已扫轴数列（FC-07 回写）；
 * - conversion_order_scan [FC-S2]：码＋明细引用＋**锁定引用 reservation**＋实扫数量；
 *   删码=deleted 标记留痕（事实列 UPDATE 拒触发器 + DELETE 拒）；
 * - conversion_code_assignment [FC-08]：二维码归属变更（完成后归属→转换后订单），
 *   append-only（FC-04 不得重复改码）；
 * - conversion_stock_order [FC-S3/FC-02/FC-14]：库存转换单头——内部六态＋对外三态投影＋
 *   外部接口状态＋库存投影状态**四列分立** + FC-S4 u9_success 幂等标记列（重新同步不再推
 *   U9 的判定依据）+ 提交时点快照 jsonb（FC-S5）；
 * - conversion_stock_line [FC-S3/FC-18/FC-21]：一轴一行明细；`(二维码, 物料)` 未完成唯一
 *   （partial, WHERE NOT released——内部状态 ∈ 未完成集的物化口径）；段长必填 CHECK；
 * - conversion_code_rewrite [FC-16]：MES 改码记录——回写销售单号/行号/批次号/段长/客户轴号、
 *   清空虚拟轴号；**表内无 new_project_no 列（结构保证不改项目号——码上项目号不变）**；
 *   append-only。
 *
 * 外键：production_order（0005）、inventory_unit/reservation（0004）、material（0003）、
 * org_node（0002）、command_receipt（0001）均已注册落地，直接 RESTRICT。
 * 守卫函数名独立 cadenza_conversion_*（与 0004/0006/0009/0010 触发器互不误伤）。
 *
 * Outbox 任务身份（FC-S4，0001 表复合身份）：form_conversion_push（两协议推 U9，
 * 聚合类型 conversion_order / conversion_stock_order 分立）与 form_conversion.inventory-stats
 * （库存统计事件）；form_conversion_reversal（冲销）无生产者——FC-11 裁定前不提供
 * 已完成转换的撤销入口（GAP-F2），任务种类保留于合同枚举。
 */
export const migration0012: Migration = {
  version: '0012',
  name: 'conversion-form',
  up: /* sql */ `
    -- ============ T16 守卫：扫码事实 append-only（删码走标记列；归属/改码事实不可改删 FC-04） ============
    CREATE FUNCTION cadenza_conversion_append_guard() RETURNS trigger AS $$
    BEGIN
      RAISE EXCEPTION '[FC-04] 表 % 为 append-only 形态转换事实：禁止 %（重复恢复/重试不得重复改码，纠正走冲销命令〔GAP-F2 裁定前无入口〕）',
        TG_TABLE_NAME, TG_OP;
    END;
    $$ LANGUAGE plpgsql;

    CREATE FUNCTION cadenza_conversion_scan_guard() RETURNS trigger AS $$
    BEGIN
      IF NEW.unit_no IS DISTINCT FROM OLD.unit_no
        OR NEW.conversion_line_id IS DISTINCT FROM OLD.conversion_line_id
        OR NEW.conversion_order_id IS DISTINCT FROM OLD.conversion_order_id
        OR NEW.inventory_unit_id IS DISTINCT FROM OLD.inventory_unit_id
        OR NEW.segment_length IS DISTINCT FROM OLD.segment_length
        OR NEW.customer_axis_no IS DISTINCT FROM OLD.customer_axis_no
        OR NEW.quantity IS DISTINCT FROM OLD.quantity
        OR NEW.reservation_id IS DISTINCT FROM OLD.reservation_id
        OR NEW.scanned_by IS DISTINCT FROM OLD.scanned_by
        OR NEW.scanned_at IS DISTINCT FROM OLD.scanned_at THEN
        RAISE EXCEPTION '[FC-07] conversion_order_scan 仅允许删码标记列（deleted/deleted_by/deleted_at）：扫码事实不可修改';
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;

    -- ============ 协议A：订单转换单头（FC-S1/FC-12：转换状态与同步状态分列） ============
    CREATE TABLE conversion_order (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      conversion_no text NOT NULL CHECK (conversion_no <> ''),
      status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'completed')),
      sync_status text NOT NULL DEFAULT 'pending' CHECK (sync_status IN ('pending', 'sync_failed', 'synced')),
      completed_by text,
      completed_at timestamptz,
      completion_snapshot jsonb,
      command_receipt_id uuid REFERENCES command_receipt (id) ON DELETE RESTRICT,
      plant_id uuid NOT NULL REFERENCES org_node (id) ON DELETE RESTRICT,
      enterprise_id uuid NOT NULL REFERENCES org_node (id) ON DELETE RESTRICT,
      business_time timestamptz NOT NULL DEFAULT now(),
      created_at timestamptz NOT NULL DEFAULT now(),
      created_by text,
      updated_at timestamptz NOT NULL DEFAULT now(),
      updated_by text,
      CONSTRAINT conversion_order_no_unique UNIQUE (conversion_no)
    );
    CREATE INDEX conversion_order_plant_idx ON conversion_order (plant_id);
    CREATE INDEX conversion_order_status_idx ON conversion_order (status);
    CREATE INDEX conversion_order_sync_status_idx ON conversion_order (sync_status);

    -- ============ 协议A：明细（FC-S1：转换单+转换前销售单号+行号 唯一） ============
    CREATE TABLE conversion_order_line (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      conversion_order_id uuid NOT NULL REFERENCES conversion_order (id) ON DELETE RESTRICT,
      line_no integer NOT NULL CHECK (line_no >= 1),
      source_order_id uuid NOT NULL REFERENCES production_order (id) ON DELETE RESTRICT,
      source_sales_order_no text NOT NULL CHECK (source_sales_order_no <> ''),
      source_line_no text NOT NULL CHECK (source_line_no <> ''),
      source_project_no text,
      target_order_id uuid NOT NULL REFERENCES production_order (id) ON DELETE RESTRICT,
      target_sales_order_no text NOT NULL CHECK (target_sales_order_no <> ''),
      target_project_no text NOT NULL CHECK (target_project_no <> ''),
      material_id uuid NOT NULL REFERENCES material (id) ON DELETE RESTRICT,
      material_code text NOT NULL CHECK (material_code <> ''),
      planned_qty numeric(18,4) NOT NULL
        CHECK (planned_qty >= 0.0001 AND planned_qty <= 999999999.9999),
      uom text NOT NULL CHECK (uom <> ''),
      scanned_qty numeric(18,4) NOT NULL DEFAULT 0 CHECK (scanned_qty >= 0),
      scanned_axes integer NOT NULL DEFAULT 0 CHECK (scanned_axes >= 0),
      created_at timestamptz NOT NULL DEFAULT now(),
      created_by text,
      updated_at timestamptz NOT NULL DEFAULT now(),
      updated_by text,
      CONSTRAINT conversion_order_line_sales_unique UNIQUE (conversion_order_id, source_sales_order_no, source_line_no),
      CONSTRAINT conversion_order_line_orders_distinct CHECK (source_order_id <> target_order_id)
    );
    CREATE INDEX conversion_order_line_order_idx ON conversion_order_line (conversion_order_id);
    CREATE INDEX conversion_order_line_source_order_idx ON conversion_order_line (source_order_id);
    CREATE INDEX conversion_order_line_target_order_idx ON conversion_order_line (target_order_id);

    -- ============ 协议A：扫码记录（FC-S2：码+明细引用+锁定引用 reservation+实扫数量/已扫轴数） ============
    CREATE TABLE conversion_order_scan (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      conversion_order_id uuid NOT NULL REFERENCES conversion_order (id) ON DELETE RESTRICT,
      conversion_line_id uuid NOT NULL REFERENCES conversion_order_line (id) ON DELETE RESTRICT,
      inventory_unit_id uuid NOT NULL REFERENCES inventory_unit (id) ON DELETE RESTRICT,
      unit_no text NOT NULL CHECK (unit_no <> ''),
      segment_length numeric(18,4),
      customer_axis_no text,
      quantity numeric(18,4) NOT NULL CHECK (quantity > 0),
      reservation_id uuid NOT NULL REFERENCES reservation (id) ON DELETE RESTRICT,
      scanned_by text NOT NULL CHECK (scanned_by <> ''),
      scanned_at timestamptz NOT NULL,
      deleted boolean NOT NULL DEFAULT false,
      deleted_by text,
      deleted_at timestamptz,
      command_receipt_id uuid REFERENCES command_receipt (id) ON DELETE RESTRICT,
      plant_id uuid NOT NULL REFERENCES org_node (id) ON DELETE RESTRICT,
      enterprise_id uuid NOT NULL REFERENCES org_node (id) ON DELETE RESTRICT,
      business_time timestamptz NOT NULL DEFAULT now(),
      created_at timestamptz NOT NULL DEFAULT now(),
      created_by text
    );
    -- FC-07：同码本单未删唯一（删码后可重扫）
    CREATE UNIQUE INDEX conversion_order_scan_active_unit_uidx
      ON conversion_order_scan (conversion_order_id, unit_no) WHERE NOT deleted;
    CREATE INDEX conversion_order_scan_line_idx ON conversion_order_scan (conversion_line_id);
    CREATE INDEX conversion_order_scan_unit_idx ON conversion_order_scan (unit_no);
    CREATE TRIGGER conversion_order_scan_fact_guard
      BEFORE UPDATE ON conversion_order_scan
      FOR EACH ROW EXECUTE FUNCTION cadenza_conversion_scan_guard();
    CREATE TRIGGER conversion_order_scan_delete_reject
      BEFORE DELETE ON conversion_order_scan
      FOR EACH ROW EXECUTE FUNCTION cadenza_conversion_append_guard();

    -- ============ 协议A：二维码归属变更（FC-08 本地先执行；append-only） ============
    CREATE TABLE conversion_code_assignment (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      conversion_order_id uuid NOT NULL REFERENCES conversion_order (id) ON DELETE RESTRICT,
      conversion_line_id uuid NOT NULL REFERENCES conversion_order_line (id) ON DELETE RESTRICT,
      scan_id uuid NOT NULL REFERENCES conversion_order_scan (id) ON DELETE RESTRICT,
      inventory_unit_id uuid NOT NULL REFERENCES inventory_unit (id) ON DELETE RESTRICT,
      unit_no text NOT NULL CHECK (unit_no <> ''),
      from_order_id uuid NOT NULL REFERENCES production_order (id) ON DELETE RESTRICT,
      to_order_id uuid NOT NULL REFERENCES production_order (id) ON DELETE RESTRICT,
      assigned_by text NOT NULL CHECK (assigned_by <> ''),
      assigned_at timestamptz NOT NULL,
      command_receipt_id uuid REFERENCES command_receipt (id) ON DELETE RESTRICT,
      plant_id uuid NOT NULL REFERENCES org_node (id) ON DELETE RESTRICT,
      enterprise_id uuid NOT NULL REFERENCES org_node (id) ON DELETE RESTRICT,
      business_time timestamptz NOT NULL DEFAULT now(),
      created_at timestamptz NOT NULL DEFAULT now(),
      created_by text,
      CONSTRAINT conversion_code_assignment_unique UNIQUE (conversion_order_id, unit_no),
      CONSTRAINT conversion_code_assignment_orders_distinct CHECK (from_order_id <> to_order_id)
    );
    CREATE INDEX conversion_code_assignment_order_idx ON conversion_code_assignment (conversion_order_id);
    CREATE INDEX conversion_code_assignment_unit_idx ON conversion_code_assignment (unit_no);
    CREATE TRIGGER conversion_code_assignment_append_guard
      BEFORE UPDATE OR DELETE ON conversion_code_assignment
      FOR EACH ROW EXECUTE FUNCTION cadenza_conversion_append_guard();

    -- ============ 协议B：库存转换单头（FC-S3/FC-02/FC-14：四状态列分立 + u9_success 标记） ============
    CREATE TABLE conversion_stock_order (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      conversion_no text NOT NULL CHECK (conversion_no <> ''),
      internal_status text NOT NULL DEFAULT 'pending_execute'
        CHECK (internal_status IN ('pending_execute', 'external_processing', 'local_processing', 'completed', 'pending_recovery', 'manual_processing')),
      display_status text NOT NULL DEFAULT 'convert_failed'
        CHECK (display_status IN ('convert_failed', 'sync_failed', 'convert_success')),
      external_push_status text NOT NULL DEFAULT 'pending'
        CHECK (external_push_status IN ('pending', 'unknown', 'succeeded', 'failed')),
      local_apply_status text NOT NULL DEFAULT 'not_applied'
        CHECK (local_apply_status IN ('not_applied', 'applied', 'failed')),
      u9_success boolean NOT NULL DEFAULT false,
      material_id uuid NOT NULL REFERENCES material (id) ON DELETE RESTRICT,
      material_code text NOT NULL CHECK (material_code <> ''),
      material_name text,
      spec text,
      color text,
      uom text,
      target_project_no text,
      target_sales_order_no text NOT NULL CHECK (target_sales_order_no <> ''),
      target_line_no text NOT NULL CHECK (target_line_no <> ''),
      target_batch_no text NOT NULL CHECK (target_batch_no <> ''),
      external_doc_no text,
      external_failure_reason text,
      submit_snapshot jsonb,
      completed_at timestamptz,
      command_receipt_id uuid REFERENCES command_receipt (id) ON DELETE RESTRICT,
      plant_id uuid NOT NULL REFERENCES org_node (id) ON DELETE RESTRICT,
      enterprise_id uuid NOT NULL REFERENCES org_node (id) ON DELETE RESTRICT,
      business_time timestamptz NOT NULL DEFAULT now(),
      created_at timestamptz NOT NULL DEFAULT now(),
      created_by text,
      updated_at timestamptz NOT NULL DEFAULT now(),
      updated_by text,
      CONSTRAINT conversion_stock_order_no_unique UNIQUE (conversion_no),
      CONSTRAINT conversion_stock_order_target_len CHECK (
        char_length(target_sales_order_no) <= 50 AND char_length(target_line_no) <= 50
        AND char_length(target_batch_no) <= 50
        AND (target_project_no IS NULL OR char_length(target_project_no) <= 50)
      )
    );
    CREATE INDEX conversion_stock_order_plant_idx ON conversion_stock_order (plant_id);
    CREATE INDEX conversion_stock_order_display_idx ON conversion_stock_order (display_status);
    CREATE INDEX conversion_stock_order_internal_idx ON conversion_stock_order (internal_status);
    CREATE INDEX conversion_stock_order_material_idx ON conversion_stock_order (material_code);

    -- ============ 协议B：明细（FC-S3：(二维码,物料) 未完成唯一；FC-18 段长必填；FC-21 一轴一行） ============
    CREATE TABLE conversion_stock_line (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      conversion_stock_order_id uuid NOT NULL REFERENCES conversion_stock_order (id) ON DELETE RESTRICT,
      unit_no text NOT NULL CHECK (unit_no <> ''),
      inventory_unit_id uuid NOT NULL REFERENCES inventory_unit (id) ON DELETE RESTRICT,
      pallet_code text,
      quantity numeric(18,4) NOT NULL CHECK (quantity > 0),
      uom text NOT NULL CHECK (uom <> ''),
      segment_length numeric(18,4) NOT NULL CHECK (segment_length >= 0.0001),
      customer_axis_no text CHECK (customer_axis_no IS NULL OR char_length(customer_axis_no) <= 50),
      material_id uuid NOT NULL REFERENCES material (id) ON DELETE RESTRICT,
      material_code text NOT NULL CHECK (material_code <> ''),
      source_project_no text,
      source_sales_order_no text,
      source_line_no text,
      source_batch_no text,
      source_virtual_axis_no text,
      warehouse_id uuid REFERENCES warehouse (id) ON DELETE RESTRICT,
      warehouse_code text,
      location_id uuid REFERENCES storage_location (id) ON DELETE RESTRICT,
      location_code text,
      released boolean NOT NULL DEFAULT false,
      command_receipt_id uuid REFERENCES command_receipt (id) ON DELETE RESTRICT,
      plant_id uuid NOT NULL REFERENCES org_node (id) ON DELETE RESTRICT,
      enterprise_id uuid NOT NULL REFERENCES org_node (id) ON DELETE RESTRICT,
      business_time timestamptz NOT NULL DEFAULT now(),
      created_at timestamptz NOT NULL DEFAULT now(),
      created_by text
    );
    -- FC-S3：同一 (二维码, 物料) 未完成唯一（partial；released=false ⇔ 所属单内部状态 ∈ 未完成集）
    CREATE UNIQUE INDEX conversion_stock_line_unfinished_uidx
      ON conversion_stock_line (unit_no, material_id) WHERE NOT released;
    CREATE INDEX conversion_stock_line_order_idx ON conversion_stock_line (conversion_stock_order_id);
    CREATE INDEX conversion_stock_line_unit_idx ON conversion_stock_line (unit_no);

    -- ============ 协议B：MES 改码记录（FC-16；append-only；无 new_project_no 列=不改项目号） ============
    CREATE TABLE conversion_code_rewrite (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      conversion_stock_order_id uuid NOT NULL REFERENCES conversion_stock_order (id) ON DELETE RESTRICT,
      conversion_line_id uuid NOT NULL REFERENCES conversion_stock_line (id) ON DELETE RESTRICT,
      inventory_unit_id uuid NOT NULL REFERENCES inventory_unit (id) ON DELETE RESTRICT,
      unit_no text NOT NULL CHECK (unit_no <> ''),
      old_sales_order_no text,
      old_line_no text,
      old_batch_no text,
      old_virtual_axis_no text,
      new_sales_order_no text NOT NULL CHECK (new_sales_order_no <> ''),
      new_line_no text NOT NULL CHECK (new_line_no <> ''),
      new_batch_no text NOT NULL CHECK (new_batch_no <> ''),
      new_segment_length numeric(18,4) NOT NULL CHECK (new_segment_length >= 0.0001),
      new_customer_axis_no text,
      virtual_axis_cleared boolean NOT NULL DEFAULT false,
      applied_by text NOT NULL CHECK (applied_by <> ''),
      applied_at timestamptz NOT NULL,
      command_receipt_id uuid REFERENCES command_receipt (id) ON DELETE RESTRICT,
      plant_id uuid NOT NULL REFERENCES org_node (id) ON DELETE RESTRICT,
      enterprise_id uuid NOT NULL REFERENCES org_node (id) ON DELETE RESTRICT,
      business_time timestamptz NOT NULL DEFAULT now(),
      created_at timestamptz NOT NULL DEFAULT now(),
      created_by text,
      CONSTRAINT conversion_code_rewrite_unique UNIQUE (conversion_stock_order_id, unit_no)
    );
    CREATE INDEX conversion_code_rewrite_order_idx ON conversion_code_rewrite (conversion_stock_order_id);
    CREATE INDEX conversion_code_rewrite_unit_idx ON conversion_code_rewrite (unit_no);
    CREATE TRIGGER conversion_code_rewrite_append_guard
      BEFORE UPDATE OR DELETE ON conversion_code_rewrite
      FOR EACH ROW EXECUTE FUNCTION cadenza_conversion_append_guard();
  `,
  down: /* sql */ `
    DROP TRIGGER IF EXISTS conversion_code_rewrite_append_guard ON conversion_code_rewrite;
    DROP TABLE IF EXISTS conversion_code_rewrite;
    DROP TABLE IF EXISTS conversion_stock_line;
    DROP TABLE IF EXISTS conversion_stock_order;
    DROP TRIGGER IF EXISTS conversion_code_assignment_append_guard ON conversion_code_assignment;
    DROP TABLE IF EXISTS conversion_code_assignment;
    DROP TRIGGER IF EXISTS conversion_order_scan_delete_reject ON conversion_order_scan;
    DROP TRIGGER IF EXISTS conversion_order_scan_fact_guard ON conversion_order_scan;
    DROP TABLE IF EXISTS conversion_order_scan;
    DROP TABLE IF EXISTS conversion_order_line;
    DROP TABLE IF EXISTS conversion_order;
    DROP FUNCTION IF EXISTS cadenza_conversion_scan_guard();
    DROP FUNCTION IF EXISTS cadenza_conversion_append_guard();
  `,
}
