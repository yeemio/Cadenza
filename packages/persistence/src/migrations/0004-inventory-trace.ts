import type { Migration } from './index'

/**
 * 0004 库存记账与追溯内核迁移（L1-P1-SERVER / T06，WorkItem 指派；**不注册共享 registry**——
 * 本文件由 L0 整合步统一并入 migrations/registry.ts，测试侧以编程方式 migrateUp 单独应用）。
 *
 * 依据冻结合同 architecture/contracts/frozen/p1/inventory-trace-core.md：
 * - IT-S1 组织隔离：业务表 plant_id 非空 + enterprise_id 冗余（RLS/账号分离属后续 WorkItem，同 S2 风险记录）；
 * - IT-S2 组织快照：material_code/owner_name/location_code 等快照列，组织变更不回写历史；
 * - IT-S6 六层身份：material_lot / material_segment / genealogy_edge append-only（触发器拒 UPDATE/DELETE）；
 *   inventory_unit 活动余额关闭状态列；carrier_binding 生效时间区间 exclusion 不重叠；
 *   customer_segment 原分配指针；barcode_label 补打引用原 label_id、作废/重印独立记录；
 * - IT-S7 条码：barcode_binding (barcode_value) WHERE active 唯一；格式校验按版本化配置表
 *   barcode_format（码值不作数据库主键，IT-05）；
 * - IT-S8 库存记账：stock_transaction (command_receipt_id, line_no) 唯一；数量列 numeric(18,4) +
 *   uom_id + measurement_basis + conversion_revision_id 四元组；stock_balance (unit, location, owner)
 *   唯一且 CHECK quantity >= 0（无负库存）；reservation 含所有者/占用对象/valid_until/释放记录；
 * - IT-S10 时间审计：business_time（业务时间）与 created_at（系统时间）分列；shift_date 单存（GAP-A3
 *   未裁，可空占位）；created/updated(_at,_by) 全套（append-only 表 updated 恒等于 created，触发器
 *   保证永不变化，列位保留以统一口径）。
 *
 * 主数据外键（material/uom/location 归 0003 主数据迁移，并行未注册）：本迁移以 uuid + 快照编码列
 * 引用、**不加 FK**，L0 整合后如需收紧由后续迁移补；组织外键（org_node/command_receipt）已存在，
 * 直接 RESTRICT。
 *
 * 迁移号 0004 与并行 writer 的 0003 主数据迁移互不冲突（表名/版本号均不重叠）。
 */
export const migration0004: Migration = {
  version: '0004',
  name: 'inventory-trace-core',
  up: /* sql */ `
    -- carrier_binding 生效时间区间 exclusion 需要 btree_gist（dev 库为超级用户，可用；
    -- 受限账号环境由 DBA 预装扩展，见交付记录风险节）
    CREATE EXTENSION IF NOT EXISTS btree_gist;

    -- ============ append-only 守卫函数（IT-S6：lot/segment/genealogy_edge 无 UPDATE）============
    -- IT-33：生效事实不得以数量改 0 隐式删除；流水/分录同为账面事实，一并拒绝 UPDATE/DELETE。
    CREATE FUNCTION cadenza_reject_mutation() RETURNS trigger AS $$
    BEGIN
      RAISE EXCEPTION 'IT-S6/IT-33 append-only 违反：表 % 不允许 %（纠正走逆序冲销或新事实行）',
        TG_TABLE_NAME, TG_OP;
    END;
    $$ LANGUAGE plpgsql;

    -- ============ 物料批次（六层身份 1/6；append-only，IT-01/03/S6） ============
    -- 生产形成新批次保留输入边：输入边由 genealogy_edge 承载，本表行本身不可覆盖历史。
    CREATE TABLE material_lot (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      lot_no text NOT NULL,
      kind text NOT NULL CHECK (kind IN ('purchase', 'production')),
      material_id uuid NOT NULL,
      material_code text NOT NULL CHECK (material_code <> ''),
      supplier_lot_no text,
      supplier_id uuid,
      external_doc_no text,
      plant_id uuid NOT NULL REFERENCES org_node (id) ON DELETE RESTRICT,
      enterprise_id uuid NOT NULL REFERENCES org_node (id) ON DELETE RESTRICT,
      business_time timestamptz NOT NULL DEFAULT now(),
      note text,
      created_at timestamptz NOT NULL DEFAULT now(),
      created_by text,
      updated_at timestamptz NOT NULL DEFAULT now(),
      updated_by text,
      CONSTRAINT material_lot_no_unique UNIQUE (plant_id, lot_no)
    );
    CREATE INDEX material_lot_material_idx ON material_lot (material_id);
    CREATE INDEX material_lot_plant_idx ON material_lot (plant_id);
    CREATE TRIGGER material_lot_append_only
      BEFORE UPDATE OR DELETE ON material_lot
      FOR EACH ROW EXECUTE FUNCTION cadenza_reject_mutation();

    -- ============ 库存单元（六层身份 2/6；IT-01/02/03/13/29） ============
    -- 可拆分/消耗/转移，保留内部唯一 ID（unit_no）；五状态轴 IT-13；活动余额关闭列 IT-29。
    CREATE TABLE inventory_unit (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      unit_no text NOT NULL,
      material_id uuid NOT NULL,
      material_code text NOT NULL CHECK (material_code <> ''),
      lot_id uuid NOT NULL REFERENCES material_lot (id) ON DELETE RESTRICT,
      uom_id uuid NOT NULL,
      uom_code text NOT NULL CHECK (uom_code <> ''),
      trace_mode text NOT NULL DEFAULT 'quantity'
        CHECK (trace_mode IN ('segment', 'quantity')),
      status text NOT NULL DEFAULT 'in_stock'
        CHECK (status IN ('in_stock', 'in_production', 'in_transit', 'shipped', 'exhausted')),
      balance_open boolean NOT NULL DEFAULT true,
      balance_closed_at timestamptz,
      plant_id uuid NOT NULL REFERENCES org_node (id) ON DELETE RESTRICT,
      enterprise_id uuid NOT NULL REFERENCES org_node (id) ON DELETE RESTRICT,
      business_time timestamptz NOT NULL DEFAULT now(),
      created_at timestamptz NOT NULL DEFAULT now(),
      created_by text,
      updated_at timestamptz NOT NULL DEFAULT now(),
      updated_by text,
      CONSTRAINT inventory_unit_no_unique UNIQUE (plant_id, unit_no)
    );
    CREATE INDEX inventory_unit_lot_idx ON inventory_unit (lot_id);
    CREATE INDEX inventory_unit_material_idx ON inventory_unit (material_id);
    CREATE INDEX inventory_unit_plant_status_idx ON inventory_unit (plant_id, status);

    -- ============ 轴段（六层身份 3/6；append-only，IT-01/03/S6） ============
    -- 连续区间或独立段；测不到区间（length_start/end 为 NULL）时 trace_mode=quantity，不承诺米级。
    CREATE TABLE material_segment (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      unit_id uuid NOT NULL REFERENCES inventory_unit (id) ON DELETE RESTRICT,
      seq_no integer NOT NULL CHECK (seq_no >= 1),
      kind text NOT NULL DEFAULT 'independent' CHECK (kind IN ('continuous', 'independent')),
      length_start numeric(18,4),
      length_end numeric(18,4),
      quantity numeric(18,4) NOT NULL CHECK (quantity > 0),
      uom_id uuid NOT NULL,
      uom_code text NOT NULL CHECK (uom_code <> ''),
      measurement_basis text NOT NULL,
      conversion_revision_id uuid,
      note text,
      plant_id uuid NOT NULL REFERENCES org_node (id) ON DELETE RESTRICT,
      enterprise_id uuid NOT NULL REFERENCES org_node (id) ON DELETE RESTRICT,
      business_time timestamptz NOT NULL DEFAULT now(),
      created_at timestamptz NOT NULL DEFAULT now(),
      created_by text,
      updated_at timestamptz NOT NULL DEFAULT now(),
      updated_by text,
      CONSTRAINT material_segment_seq_unique UNIQUE (unit_id, seq_no),
      CONSTRAINT material_segment_range_ck CHECK (
        (length_start IS NULL AND length_end IS NULL)
        OR (length_start IS NOT NULL AND length_end IS NOT NULL AND length_end >= length_start)
      )
    );
    CREATE INDEX material_segment_unit_idx ON material_segment (unit_id);
    CREATE TRIGGER material_segment_append_only
      BEFORE UPDATE OR DELETE ON material_segment
      FOR EACH ROW EXECUTE FUNCTION cadenza_reject_mutation();

    -- ============ 实物载具（六层身份 4/6；IT-01/02） ============
    -- 借出/回收/损坏/报废独立记录（状态流转经审计 before/after 留痕），不作产品退货处理（IT-02）。
    CREATE TABLE carrier (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      carrier_code text NOT NULL,
      carrier_kind text NOT NULL CHECK (carrier_kind IN ('spool', 'drum', 'tray', 'box')),
      status text NOT NULL DEFAULT 'in_service'
        CHECK (status IN ('in_service', 'lent_out', 'returned', 'damaged', 'scrapped')),
      capacity numeric(18,4),
      plant_id uuid NOT NULL REFERENCES org_node (id) ON DELETE RESTRICT,
      enterprise_id uuid NOT NULL REFERENCES org_node (id) ON DELETE RESTRICT,
      created_at timestamptz NOT NULL DEFAULT now(),
      created_by text,
      updated_at timestamptz NOT NULL DEFAULT now(),
      updated_by text,
      CONSTRAINT carrier_code_unique UNIQUE (plant_id, carrier_code)
    );
    CREATE INDEX carrier_plant_idx ON carrier (plant_id);

    -- ============ 载具装载绑定（IT-01/03/S6：生效时间区间不重叠） ============
    -- 带生效时间的绑定关系；清空仅解除当前装载（unbind 当前行，历史区间保留）。
    CREATE TABLE carrier_binding (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      carrier_id uuid NOT NULL REFERENCES carrier (id) ON DELETE RESTRICT,
      unit_id uuid NOT NULL REFERENCES inventory_unit (id) ON DELETE RESTRICT,
      effective_from timestamptz NOT NULL,
      effective_to timestamptz,
      loaded_by text,
      unloaded_by text,
      unload_reason text,
      plant_id uuid NOT NULL REFERENCES org_node (id) ON DELETE RESTRICT,
      enterprise_id uuid NOT NULL REFERENCES org_node (id) ON DELETE RESTRICT,
      created_at timestamptz NOT NULL DEFAULT now(),
      created_by text,
      updated_at timestamptz NOT NULL DEFAULT now(),
      updated_by text,
      CONSTRAINT carrier_binding_interval_ck CHECK (effective_to IS NULL OR effective_to > effective_from),
      CONSTRAINT carrier_binding_no_overlap_excl EXCLUDE USING gist (
        carrier_id WITH =,
        tstzrange(effective_from, COALESCE(effective_to, 'infinity'::timestamptz)) WITH &&
      ),
      CONSTRAINT carrier_binding_unit_no_overlap_excl EXCLUDE USING gist (
        unit_id WITH =,
        tstzrange(effective_from, COALESCE(effective_to, 'infinity'::timestamptz)) WITH &&
      )
    );
    CREATE INDEX carrier_binding_carrier_idx ON carrier_binding (carrier_id) WHERE effective_to IS NULL;
    CREATE INDEX carrier_binding_unit_idx ON carrier_binding (unit_id) WHERE effective_to IS NULL;

    -- ============ 客户轴段（六层身份 5/6；IT-01/02/03/36） ============
    -- 由合同版本及具名修正调整；重分配建新行并指回原分配（原分配关系保留），不自动解绑他人占用。
    CREATE TABLE customer_segment (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      unit_id uuid NOT NULL REFERENCES inventory_unit (id) ON DELETE RESTRICT,
      segment_id uuid REFERENCES material_segment (id) ON DELETE RESTRICT,
      order_no text NOT NULL CHECK (order_no <> ''),
      contract_revision text,
      amendment_ref text,
      customer_ref text,
      previous_allocation_id uuid REFERENCES customer_segment (id) ON DELETE RESTRICT,
      status text NOT NULL DEFAULT 'allocated'
        CHECK (status IN ('allocated', 'reallocated', 'released')),
      plant_id uuid NOT NULL REFERENCES org_node (id) ON DELETE RESTRICT,
      enterprise_id uuid NOT NULL REFERENCES org_node (id) ON DELETE RESTRICT,
      business_time timestamptz NOT NULL DEFAULT now(),
      created_at timestamptz NOT NULL DEFAULT now(),
      created_by text,
      updated_at timestamptz NOT NULL DEFAULT now(),
      updated_by text
    );
    CREATE INDEX customer_segment_unit_idx ON customer_segment (unit_id);
    CREATE INDEX customer_segment_order_idx ON customer_segment (order_no);

    -- ============ 谱系边（六层身份 6/6 的追溯骨架；append-only，IT-34/35/S6） ============
    -- 首期边类型四类（IT-34）：receipt_origin / consumption / production_output / customer_binding。
    CREATE TABLE genealogy_edge (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      from_type text NOT NULL CHECK (from_type IN ('material_lot', 'inventory_unit', 'material_segment')),
      from_id uuid NOT NULL,
      to_type text NOT NULL CHECK (to_type IN ('inventory_unit', 'material_segment', 'customer_segment')),
      to_id uuid NOT NULL,
      edge_kind text NOT NULL CHECK (edge_kind IN (
        'receipt_origin', 'consumption', 'production_output', 'customer_binding'
      )),
      quantity numeric(18,4) NOT NULL CHECK (quantity > 0),
      uom_id uuid NOT NULL,
      uom_code text NOT NULL CHECK (uom_code <> ''),
      measurement_basis text NOT NULL,
      conversion_revision_id uuid,
      command_receipt_id uuid REFERENCES command_receipt (id) ON DELETE RESTRICT,
      business_time timestamptz NOT NULL,
      plant_id uuid NOT NULL REFERENCES org_node (id) ON DELETE RESTRICT,
      enterprise_id uuid NOT NULL REFERENCES org_node (id) ON DELETE RESTRICT,
      created_at timestamptz NOT NULL DEFAULT now(),
      created_by text,
      updated_at timestamptz NOT NULL DEFAULT now(),
      updated_by text
    );
    CREATE INDEX genealogy_edge_from_idx ON genealogy_edge (from_type, from_id);
    CREATE INDEX genealogy_edge_to_idx ON genealogy_edge (to_type, to_id);
    CREATE TRIGGER genealogy_edge_append_only
      BEFORE UPDATE OR DELETE ON genealogy_edge
      FOR EACH ROW EXECUTE FUNCTION cadenza_reject_mutation();

    -- ============ 条码标签（识别媒介；IT-01/05/S6） ============
    -- 扫描格式不作主键（value 可重复出现于历史/补打行）；补打引用原 label_id；作废/重印独立记录。
    CREATE TABLE barcode_label (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      barcode_value text NOT NULL CHECK (barcode_value <> ''),
      label_kind text NOT NULL CHECK (label_kind IN (
        'carrier', 'raw_material', 'finished_goods', 'shelf', 'transfer_spool'
      )),
      format_version integer,
      status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'voided')),
      reprint_of uuid REFERENCES barcode_label (id) ON DELETE RESTRICT,
      reprint_reason text,
      voided_at timestamptz,
      voided_reason text,
      printed_at timestamptz,
      printed_by text,
      print_channel text,
      plant_id uuid NOT NULL REFERENCES org_node (id) ON DELETE RESTRICT,
      enterprise_id uuid NOT NULL REFERENCES org_node (id) ON DELETE RESTRICT,
      created_at timestamptz NOT NULL DEFAULT now(),
      created_by text,
      updated_at timestamptz NOT NULL DEFAULT now(),
      updated_by text
    );
    -- IT-S6/S7：同一码值同一时刻至多一条活动标签；格式校验按版本化配置（不作主键）
    CREATE UNIQUE INDEX barcode_label_value_active_uidx ON barcode_label (barcode_value) WHERE status = 'active';
    CREATE INDEX barcode_label_value_idx ON barcode_label (barcode_value);

    -- ============ 条码格式版本化配置（IT-05：格式校验按版本化配置表实现） ============
    CREATE TABLE barcode_format (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      format_version integer NOT NULL,
      label_kind text NOT NULL,
      pattern text NOT NULL CHECK (pattern <> ''),
      description text,
      active boolean NOT NULL DEFAULT true,
      plant_id uuid NOT NULL REFERENCES org_node (id) ON DELETE RESTRICT,
      enterprise_id uuid NOT NULL REFERENCES org_node (id) ON DELETE RESTRICT,
      created_at timestamptz NOT NULL DEFAULT now(),
      created_by text,
      updated_at timestamptz NOT NULL DEFAULT now(),
      updated_by text,
      CONSTRAINT barcode_format_version_kind_unique UNIQUE (format_version, label_kind)
    );

    -- ============ 条码绑定（解析链 barcode → binding → 业务对象；IT-04/06/S7） ============
    -- 解析返回候选对象集合（载具码 → 载具当前装载的多个单元即多候选），由任务显式选择（IT-04）。
    CREATE TABLE barcode_binding (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      barcode_value text NOT NULL CHECK (barcode_value <> ''),
      bound_type text NOT NULL CHECK (bound_type IN ('inventory_unit', 'carrier', 'material_lot', 'location')),
      bound_id uuid NOT NULL,
      active boolean NOT NULL DEFAULT true,
      bound_at timestamptz NOT NULL DEFAULT now(),
      bound_by text,
      unbound_at timestamptz,
      unbound_by text,
      unbind_reason text,
      plant_id uuid NOT NULL REFERENCES org_node (id) ON DELETE RESTRICT,
      enterprise_id uuid NOT NULL REFERENCES org_node (id) ON DELETE RESTRICT,
      created_at timestamptz NOT NULL DEFAULT now(),
      created_by text,
      updated_at timestamptz NOT NULL DEFAULT now(),
      updated_by text,
      -- IT-06/S7：(barcode_value, active) 唯一 —— 同一条码值同一时刻至多一条活动绑定
      CONSTRAINT barcode_binding_active_unique UNIQUE (barcode_value, active)
    );
    CREATE INDEX barcode_binding_value_idx ON barcode_binding (barcode_value) WHERE active;

    -- ============ 库存余额（IT-02/08/14/20/29/S8） ============
    -- 法律/业务所有者、保管工厂（plant_id）、所在库位三分（IT-02）；可用量 = 质量 ∧ 预留（IT-14，
    -- 质量条件在本表 quality_status，预留另记 reservation 表）；无负库存（CHECK）。
    -- legacy_status：原库存状态字典 6 值并存标注、不混写（IT-16，GAP-A7 映射未裁）。
    CREATE TABLE stock_balance (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      unit_id uuid NOT NULL REFERENCES inventory_unit (id) ON DELETE RESTRICT,
      location_id uuid NOT NULL,
      location_code text NOT NULL CHECK (location_code <> ''),
      owner_id uuid NOT NULL,
      owner_name text NOT NULL CHECK (owner_name <> ''),
      quantity numeric(18,4) NOT NULL CHECK (quantity >= 0),
      uom_id uuid NOT NULL,
      uom_code text NOT NULL CHECK (uom_code <> ''),
      measurement_basis text NOT NULL,
      conversion_revision_id uuid,
      quality_status text NOT NULL DEFAULT 'pending_inspection'
        CHECK (quality_status IN ('qualified', 'pending_inspection', 'unqualified', 'suspect')),
      legacy_status text,
      status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'closed')),
      closed_at timestamptz,
      plant_id uuid NOT NULL REFERENCES org_node (id) ON DELETE RESTRICT,
      enterprise_id uuid NOT NULL REFERENCES org_node (id) ON DELETE RESTRICT,
      business_time timestamptz NOT NULL DEFAULT now(),
      created_at timestamptz NOT NULL DEFAULT now(),
      created_by text,
      updated_at timestamptz NOT NULL DEFAULT now(),
      updated_by text,
      -- IT-20/S8：余额唯一键 (unit, location, owner)
      CONSTRAINT stock_balance_key_unique UNIQUE (unit_id, location_id, owner_id)
    );
    CREATE INDEX stock_balance_unit_idx ON stock_balance (unit_id);
    CREATE INDEX stock_balance_plant_idx ON stock_balance (plant_id) WHERE status = 'active';
    CREATE INDEX stock_balance_location_idx ON stock_balance (location_id);

    -- ============ 库存流水（行级；IT-18/19/25/31/32/S8） ============
    -- 幂等唯一 (command_receipt_id, line_no)；每行必含扣前/扣后余额（IT-19）；
    -- 业务时间 business_time 与系统时间 created_at 分列（IT-37）；append-only，冲销写反向行（IT-32）。
    CREATE TABLE stock_transaction (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      command_receipt_id uuid NOT NULL REFERENCES command_receipt (id) ON DELETE RESTRICT,
      line_no integer NOT NULL CHECK (line_no >= 1),
      movement_kind text NOT NULL CHECK (movement_kind IN (
        'receive', 'issue', 'move', 'transfer_out', 'transfer_in', 'split', 'merge', 'adjust', 'reverse'
      )),
      unit_id uuid NOT NULL REFERENCES inventory_unit (id) ON DELETE RESTRICT,
      lot_id uuid REFERENCES material_lot (id) ON DELETE RESTRICT,
      balance_id uuid REFERENCES stock_balance (id) ON DELETE RESTRICT,
      from_location_id uuid,
      from_location_code text,
      to_location_id uuid,
      to_location_code text,
      from_owner_id uuid,
      from_owner_name text,
      to_owner_id uuid,
      to_owner_name text,
      quantity numeric(18,4) NOT NULL,
      uom_id uuid NOT NULL,
      uom_code text NOT NULL CHECK (uom_code <> ''),
      measurement_basis text NOT NULL,
      conversion_revision_id uuid,
      before_qty numeric(18,4) NOT NULL CHECK (before_qty >= 0),
      after_qty numeric(18,4) NOT NULL CHECK (after_qty >= 0),
      ref_type text,
      ref_id uuid,
      reason text,
      business_time timestamptz NOT NULL,
      shift_date date,
      plant_id uuid NOT NULL REFERENCES org_node (id) ON DELETE RESTRICT,
      enterprise_id uuid NOT NULL REFERENCES org_node (id) ON DELETE RESTRICT,
      created_at timestamptz NOT NULL DEFAULT now(),
      created_by text,
      updated_at timestamptz NOT NULL DEFAULT now(),
      updated_by text,
      -- IT-19/S8：流水幂等唯一键
      CONSTRAINT stock_transaction_line_unique UNIQUE (command_receipt_id, line_no)
    );
    CREATE INDEX stock_transaction_unit_idx ON stock_transaction (unit_id, created_at);
    CREATE INDEX stock_transaction_receipt_idx ON stock_transaction (command_receipt_id);
    CREATE TRIGGER stock_transaction_append_only
      BEFORE UPDATE OR DELETE ON stock_transaction
      FOR EACH ROW EXECUTE FUNCTION cadenza_reject_mutation();

    -- ============ 流水分录（构成明细；IT-19/25） ============
    -- 每条流水行的余额影响分录：余额键 + 变动量 + 扣前/扣后 + lot/segment 构成引用（谱系证据）。
    CREATE TABLE stock_entry (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      transaction_id uuid NOT NULL REFERENCES stock_transaction (id) ON DELETE RESTRICT,
      entry_no integer NOT NULL CHECK (entry_no >= 1),
      balance_id uuid NOT NULL REFERENCES stock_balance (id) ON DELETE RESTRICT,
      unit_id uuid NOT NULL REFERENCES inventory_unit (id) ON DELETE RESTRICT,
      location_id uuid NOT NULL,
      location_code text NOT NULL,
      owner_id uuid NOT NULL,
      owner_name text NOT NULL,
      lot_id uuid REFERENCES material_lot (id) ON DELETE RESTRICT,
      segment_id uuid REFERENCES material_segment (id) ON DELETE RESTRICT,
      quantity_delta numeric(18,4) NOT NULL,
      before_qty numeric(18,4) NOT NULL CHECK (before_qty >= 0),
      after_qty numeric(18,4) NOT NULL CHECK (after_qty >= 0),
      purpose text,
      plant_id uuid NOT NULL REFERENCES org_node (id) ON DELETE RESTRICT,
      enterprise_id uuid NOT NULL REFERENCES org_node (id) ON DELETE RESTRICT,
      created_at timestamptz NOT NULL DEFAULT now(),
      created_by text,
      updated_at timestamptz NOT NULL DEFAULT now(),
      updated_by text,
      CONSTRAINT stock_entry_no_unique UNIQUE (transaction_id, entry_no)
    );
    CREATE INDEX stock_entry_transaction_idx ON stock_entry (transaction_id);
    CREATE INDEX stock_entry_unit_idx ON stock_entry (unit_id);
    CREATE TRIGGER stock_entry_append_only
      BEFORE UPDATE OR DELETE ON stock_entry
      FOR EACH ROW EXECUTE FUNCTION cadenza_reject_mutation();

    -- ============ 作业预留（IT-15/23/S8） ============
    -- 四要素：所有者（holder_type/holder_ref）、占用对象（unit/可选 location）、有效期（valid_until
    -- 必填——CA-5 待裁，内核冻结"预留必须含有效期"）、释放记录（released_* 列）；过期行保留为历史
    -- （status=expired），旧终端提交必须重新校验有效后方可入账。
    CREATE TABLE reservation (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      unit_id uuid NOT NULL REFERENCES inventory_unit (id) ON DELETE RESTRICT,
      location_id uuid,
      holder_type text NOT NULL CHECK (holder_type IN ('job', 'task', 'order', 'manual')),
      holder_ref text NOT NULL CHECK (holder_ref <> ''),
      quantity numeric(18,4) NOT NULL CHECK (quantity > 0),
      uom_id uuid NOT NULL,
      uom_code text NOT NULL CHECK (uom_code <> ''),
      measurement_basis text NOT NULL,
      conversion_revision_id uuid,
      status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'released', 'expired', 'consumed')),
      valid_until timestamptz NOT NULL,
      acquired_at timestamptz NOT NULL DEFAULT now(),
      command_receipt_id uuid REFERENCES command_receipt (id) ON DELETE RESTRICT,
      released_at timestamptz,
      released_by text,
      release_reason text,
      plant_id uuid NOT NULL REFERENCES org_node (id) ON DELETE RESTRICT,
      enterprise_id uuid NOT NULL REFERENCES org_node (id) ON DELETE RESTRICT,
      created_at timestamptz NOT NULL DEFAULT now(),
      created_by text,
      updated_at timestamptz NOT NULL DEFAULT now(),
      updated_by text,
      CONSTRAINT reservation_valid_until_ck CHECK (valid_until > acquired_at)
    );
    CREATE INDEX reservation_unit_active_idx ON reservation (unit_id) WHERE status = 'active';
    CREATE INDEX reservation_holder_idx ON reservation (holder_type, holder_ref);
  `,
  down: /* sql */ `
    DROP TABLE IF EXISTS reservation;
    DROP TABLE IF EXISTS stock_entry;
    DROP TABLE IF EXISTS stock_transaction;
    DROP TABLE IF EXISTS stock_balance;
    DROP TABLE IF EXISTS barcode_binding;
    DROP TABLE IF EXISTS barcode_format;
    DROP TABLE IF EXISTS barcode_label;
    DROP TABLE IF EXISTS genealogy_edge;
    DROP TABLE IF EXISTS customer_segment;
    DROP TABLE IF EXISTS carrier_binding;
    DROP TABLE IF EXISTS carrier;
    DROP TABLE IF EXISTS material_segment;
    DROP TABLE IF EXISTS inventory_unit;
    DROP TABLE IF EXISTS material_lot;
    DROP FUNCTION IF EXISTS cadenza_reject_mutation();
  `,
}
