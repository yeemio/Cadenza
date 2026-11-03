import type { Migration } from './index'

/**
 * 0010 装箱发运迁移（L1-P1-SERVER / T14，WorkItem 指派；**不注册共享 registry**——
 * 本文件由 L0 整合步统一并入 migrations/registry.ts，测试侧以编程方式 migrateUp 单独应用
 * （独立库 cadenza_shp，与共享 dev 库及并行 writer 的 0007/0008/0009 无表名/迁移号冲突）。
 *
 * 依据：规则底稿 architecture/contracts/prep/p1/04-supply-chain-rules-T08T12T13T14.md
 * §A-T14（分段装箱/发运）；冻结合同 architecture/contracts/frozen/p1/interfaces.md
 * （IF-04 DC 分段/组成、IF-05 发货单 PL、IF-06 实发轴四态、IF-07 发货状态独立、
 * IF-00.4 出站多态、IF-00.5 复合任务身份、IF-00.6 时点快照）。
 *
 * 表：
 * - shipment_order [A-T14-1/7/8]：PL 头（外部下发禁手工新增——无手工命令面；发货单号幂等唯一；
 *   状态机 待装箱→待出库→已出库；出库人/出库完成时间；**出库回传双状态列独立**——
 *   actual_axis_sync_status 四态含 noop_needed（无需同步不是失败）、
 *   shipping_status_sync_status 独立三态；actual_axis_snapshot/status_sync_snapshot
 *   出库时点快照 jsonb（重试按快照重推，不推当前值 IF-00.6）；
 * - shipment_line [A-T14-3]：备货三类行——托盘行（packing_status 打包状态+required_count 总轴数/
 *   scanned_count 已扫轴数）、有轴单品（customer_axis_no+standard/actual_segment_length）、
 *   无轴单品（segment_length×required_count 件数、无客户轴号 CHECK）；
 *   行状态 待装箱/已装箱（删码不满足退回待装箱）；段长/客户轴号=订单下达快照列（非实时 DC）；
 * - packing_order [A-T14-4]：打包任务（托码+调入库位；先扫托码+选库位→逐行扫满→绑定托码；
 *   已打包托码库位只读——同托码 bound 唯一 partial unique 库级双保险）；
 * - packing_scan [A-T14-3/5]：扫码装入记录+补码记录（scan_kind load/supplement；
 *   删码=deleted 标记留痕非物理删（DM §8 已入账事实不物理清空）；同码同单活动装入唯一）；
 * - shipment_photo [A-T14-10]：装箱图附件元数据（append-only）；
 * - dc_segment_composition [A-T14-2/IF-04]：DC 分段/组成模拟入站数据
 *   （dcId+销售订单号+行号幂等唯一；缺组成数据→missing 标记=生产订单行标黄数据源）。
 *
 * 外键：inventory_unit/stock 侧（0004）、storage_location（0003）、org_node（0002）、
 * command_receipt（0001）均已注册落地，直接 RESTRICT。守卫函数名独立
 * cadenza_shipping_append_guard（packing_scan/shipment_photo append-only，
 * 与 0004/0006/0009 触发器互不误伤；shipment_line/shipment_order 为状态机推进面，
 * 由域规则+应用层命令通道约束，不加 UPDATE 守卫）。
 */
export const migration0010: Migration = {
  version: '0010',
  name: 'shipping',
  up: /* sql */ `
    -- ============ T14 守卫：扫码/附件 append-only（事实不可改删，纠正走删码标记/新记录） ============
    CREATE FUNCTION cadenza_shipping_append_guard() RETURNS trigger AS $$
    BEGIN
      RAISE EXCEPTION '[A-T14-10] 表 % 为 append-only 装箱事实：禁止 %（扫码删码走 deleted 标记，纠正走新记录）',
        TG_TABLE_NAME, TG_OP;
    END;
    $$ LANGUAGE plpgsql;

    -- ============ PL 头（A-T14-1/7/8：状态机 + 出库回传双状态列独立） ============
    CREATE TABLE shipment_order (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      pl_no text NOT NULL CHECK (pl_no <> ''),
      sales_order_no text NOT NULL CHECK (sales_order_no <> ''),
      customer_name text,
      source_system text NOT NULL DEFAULT 'PL',
      external_revision integer,
      status text NOT NULL DEFAULT 'pending_packing'
        CHECK (status IN ('pending_packing', 'ready_to_ship', 'shipped')),
      composition_missing boolean NOT NULL DEFAULT false,
      outbound_by text,
      outbound_at timestamptz,
      -- IF-06/IF-00.4：实发轴同步四态（noop_needed=无需同步不是失败态）
      actual_axis_sync_status text NOT NULL DEFAULT 'pending'
        CHECK (actual_axis_sync_status IN ('pending', 'synced', 'sync_failed', 'noop_needed')),
      -- IF-07/IF-00.5：发货状态同步独立三态（与实发轴互不改变对方状态）
      shipping_status_sync_status text NOT NULL DEFAULT 'pending'
        CHECK (shipping_status_sync_status IN ('pending', 'synced', 'sync_failed')),
      -- IF-00.6：出库时点快照（差异判定与状态重推按快照，不推当前值）
      actual_axis_snapshot jsonb,
      status_sync_snapshot jsonb,
      command_receipt_id uuid REFERENCES command_receipt (id) ON DELETE RESTRICT,
      plant_id uuid NOT NULL REFERENCES org_node (id) ON DELETE RESTRICT,
      enterprise_id uuid NOT NULL REFERENCES org_node (id) ON DELETE RESTRICT,
      business_time timestamptz NOT NULL DEFAULT now(),
      created_at timestamptz NOT NULL DEFAULT now(),
      created_by text,
      updated_at timestamptz NOT NULL DEFAULT now(),
      updated_by text,
      -- IF-00.2/IF-05：发货单号幂等唯一（重复下发幂等返回，不重复建）
      CONSTRAINT shipment_order_pl_no_unique UNIQUE (pl_no)
    );
    CREATE INDEX shipment_order_plant_idx ON shipment_order (plant_id);
    CREATE INDEX shipment_order_status_idx ON shipment_order (status);
    CREATE INDEX shipment_order_sales_order_idx ON shipment_order (sales_order_no);

    -- ============ 备货三类行（A-T14-3：托盘/有轴单品/无轴单品） ============
    -- required_count/scanned_count 通用列承载三类应扫/已扫：托盘=总轴数/已扫轴数；
    -- 有轴单品=1；无轴单品=件数。段长/客户轴号为订单下达快照列（PL 入站时自 DC 组成固化）。
    -- packing_status=托盘行打包状态（pending 待打包/bound 已打包——绑定托码完成）。
    CREATE TABLE shipment_line (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      shipment_order_id uuid NOT NULL REFERENCES shipment_order (id) ON DELETE RESTRICT,
      line_no integer NOT NULL CHECK (line_no >= 1),
      line_kind text NOT NULL CHECK (line_kind IN ('pallet', 'axis_item', 'plain_item')),
      material_id uuid REFERENCES material (id) ON DELETE RESTRICT,
      material_code text NOT NULL CHECK (material_code <> ''),
      sales_order_line_no text NOT NULL CHECK (sales_order_line_no <> ''),
      customer_axis_no text,
      standard_segment_length numeric(18,4),
      actual_segment_length numeric(18,4),
      segment_length numeric(18,4),
      required_count integer NOT NULL CHECK (required_count >= 1),
      scanned_count integer NOT NULL DEFAULT 0 CHECK (scanned_count >= 0),
      line_status text NOT NULL DEFAULT 'pending_packing' CHECK (line_status IN ('pending_packing', 'packed')),
      packing_status text CHECK (packing_status IN ('pending', 'bound')),
      packing_order_id uuid,
      created_at timestamptz NOT NULL DEFAULT now(),
      created_by text,
      updated_at timestamptz NOT NULL DEFAULT now(),
      updated_by text,
      CONSTRAINT shipment_line_no_unique UNIQUE (shipment_order_id, line_no),
      -- A-T14-3：有轴单品必有客户轴号+标准段长；无轴单品无客户轴号（段长可缺——缺组成数据
      -- 入站标记 composition_missing，扫码装入时"无段长拒收"）；托盘行无客户轴号
      CONSTRAINT shipment_line_kind_shape CHECK (
        (line_kind = 'pallet' AND customer_axis_no IS NULL)
        OR (line_kind = 'axis_item' AND customer_axis_no IS NOT NULL AND standard_segment_length IS NOT NULL AND standard_segment_length > 0)
        OR (line_kind = 'plain_item' AND customer_axis_no IS NULL)
      ),
      CONSTRAINT shipment_line_scanned_bounds CHECK (scanned_count <= required_count)
    );
    CREATE INDEX shipment_line_order_idx ON shipment_line (shipment_order_id);
    CREATE INDEX shipment_line_unit_axis_idx ON shipment_line (customer_axis_no);

    -- ============ 打包任务（A-T14-4：托码+调入库位+逐行扫满+绑定托码） ============
    CREATE TABLE packing_order (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      packing_no text NOT NULL CHECK (packing_no <> ''),
      shipment_order_id uuid NOT NULL REFERENCES shipment_order (id) ON DELETE RESTRICT,
      pallet_code text NOT NULL CHECK (pallet_code <> ''),
      to_location_id uuid NOT NULL REFERENCES storage_location (id) ON DELETE RESTRICT,
      to_location_code text NOT NULL CHECK (to_location_code <> ''),
      status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'bound', 'cancelled')),
      bound_by text,
      bound_at timestamptz,
      command_receipt_id uuid REFERENCES command_receipt (id) ON DELETE RESTRICT,
      plant_id uuid NOT NULL REFERENCES org_node (id) ON DELETE RESTRICT,
      enterprise_id uuid NOT NULL REFERENCES org_node (id) ON DELETE RESTRICT,
      business_time timestamptz NOT NULL DEFAULT now(),
      created_at timestamptz NOT NULL DEFAULT now(),
      created_by text,
      updated_at timestamptz NOT NULL DEFAULT now(),
      updated_by text,
      CONSTRAINT packing_order_no_unique UNIQUE (packing_no)
    );
    -- A-T14-4：已打包托码库位只读（同托码至多一条已绑定任务——库级双保险）
    CREATE UNIQUE INDEX packing_order_bound_pallet_uidx ON packing_order (pallet_code) WHERE status = 'bound';
    CREATE INDEX packing_order_plant_idx ON packing_order (plant_id);
    CREATE INDEX packing_order_shipment_idx ON packing_order (shipment_order_id);
    ALTER TABLE shipment_line ADD CONSTRAINT shipment_line_packing_fk
      FOREIGN KEY (packing_order_id) REFERENCES packing_order (id) ON DELETE RESTRICT;

    -- ============ 扫码装入/补码记录（A-T14-3/5；删码=标记留痕） ============
    CREATE TABLE packing_scan (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      shipment_order_id uuid NOT NULL REFERENCES shipment_order (id) ON DELETE RESTRICT,
      shipment_line_id uuid NOT NULL REFERENCES shipment_line (id) ON DELETE RESTRICT,
      scan_kind text NOT NULL CHECK (scan_kind IN ('load', 'supplement')),
      inventory_unit_id uuid REFERENCES inventory_unit (id) ON DELETE RESTRICT,
      unit_no text NOT NULL CHECK (unit_no <> ''),
      customer_axis_no text,
      actual_segment_length numeric(18,4),
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
    -- A-T14-3：同码同单活动装入唯一（未删除口径；删码后可重扫）
    CREATE UNIQUE INDEX packing_scan_active_unit_uidx
      ON packing_scan (shipment_order_id, unit_no) WHERE NOT deleted;
    CREATE INDEX packing_scan_line_idx ON packing_scan (shipment_line_id);
    -- 删码=标记：UPDATE 仅允许删码标记列（事实列不可改）；DELETE 拒（物理删禁）。
    CREATE FUNCTION cadenza_shipping_scan_delete_guard() RETURNS trigger AS $$
    BEGIN
      IF NEW.unit_no IS DISTINCT FROM OLD.unit_no
        OR NEW.shipment_line_id IS DISTINCT FROM OLD.shipment_line_id
        OR NEW.shipment_order_id IS DISTINCT FROM OLD.shipment_order_id
        OR NEW.scan_kind IS DISTINCT FROM OLD.scan_kind
        OR NEW.inventory_unit_id IS DISTINCT FROM OLD.inventory_unit_id
        OR NEW.actual_segment_length IS DISTINCT FROM OLD.actual_segment_length
        OR NEW.scanned_by IS DISTINCT FROM OLD.scanned_by
        OR NEW.scanned_at IS DISTINCT FROM OLD.scanned_at THEN
        RAISE EXCEPTION '[A-T14-3] packing_scan 仅允许删码标记列（deleted/deleted_by/deleted_at）：扫码事实不可修改';
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
    CREATE TRIGGER packing_scan_delete_guard
      BEFORE UPDATE ON packing_scan
      FOR EACH ROW EXECUTE FUNCTION cadenza_shipping_scan_delete_guard();
    CREATE TRIGGER packing_scan_delete_reject
      BEFORE DELETE ON packing_scan
      FOR EACH ROW EXECUTE FUNCTION cadenza_shipping_append_guard();

    -- ============ 装箱图附件元数据（A-T14-10：仅 APP，append-only） ============
    CREATE TABLE shipment_photo (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      shipment_order_id uuid NOT NULL REFERENCES shipment_order (id) ON DELETE RESTRICT,
      file_name text NOT NULL CHECK (file_name <> ''),
      storage_key text NOT NULL CHECK (storage_key <> ''),
      content_type text,
      size_bytes integer CHECK (size_bytes IS NULL OR size_bytes >= 0),
      uploaded_by text NOT NULL CHECK (uploaded_by <> ''),
      uploaded_at timestamptz NOT NULL,
      command_receipt_id uuid REFERENCES command_receipt (id) ON DELETE RESTRICT,
      plant_id uuid NOT NULL REFERENCES org_node (id) ON DELETE RESTRICT,
      enterprise_id uuid NOT NULL REFERENCES org_node (id) ON DELETE RESTRICT,
      business_time timestamptz NOT NULL DEFAULT now(),
      created_at timestamptz NOT NULL DEFAULT now(),
      created_by text
    );
    CREATE INDEX shipment_photo_order_idx ON shipment_photo (shipment_order_id);
    CREATE TRIGGER shipment_photo_append_guard
      BEFORE UPDATE OR DELETE ON shipment_photo
      FOR EACH ROW EXECUTE FUNCTION cadenza_shipping_append_guard();

    -- ============ DC 分段/组成入站数据（A-T14-2/IF-04：dcId+销售订单号+行号幂等） ============
    -- 组成 jsonb：段长/分段数量/轴具尺寸类型/是否贴红码还是托盘/包装方案/虚拟轴号/包装日期时间；
    -- 缺组成数据→sync_status='missing'（生产订单行标黄+提示的数据源，GAP-D8 名单未定）。
    CREATE TABLE dc_segment_composition (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      dc_id text NOT NULL CHECK (dc_id <> ''),
      sales_order_no text NOT NULL CHECK (sales_order_no <> ''),
      line_no integer NOT NULL CHECK (line_no >= 1),
      source_system text NOT NULL DEFAULT 'DC',
      external_revision integer,
      sync_status text NOT NULL DEFAULT 'received'
        CHECK (sync_status IN ('received', 'missing', 'failed')),
      composition jsonb,
      missing_marked_at timestamptz,
      plant_id uuid NOT NULL REFERENCES org_node (id) ON DELETE RESTRICT,
      enterprise_id uuid NOT NULL REFERENCES org_node (id) ON DELETE RESTRICT,
      business_time timestamptz NOT NULL DEFAULT now(),
      created_at timestamptz NOT NULL DEFAULT now(),
      created_by text,
      updated_at timestamptz NOT NULL DEFAULT now(),
      updated_by text,
      -- IF-00.2/IF-04：业务键幂等唯一（重复报文幂等返回）
      CONSTRAINT dc_segment_composition_key_unique UNIQUE (dc_id, sales_order_no, line_no)
    );
    CREATE INDEX dc_segment_composition_plant_idx ON dc_segment_composition (plant_id);
    CREATE INDEX dc_segment_composition_order_idx ON dc_segment_composition (sales_order_no);
  `,
  down: /* sql */ `
    DROP TABLE IF EXISTS dc_segment_composition;
    DROP TRIGGER IF EXISTS shipment_photo_append_guard ON shipment_photo;
    DROP TABLE IF EXISTS shipment_photo;
    DROP TRIGGER IF EXISTS packing_scan_delete_reject ON packing_scan;
    DROP TRIGGER IF EXISTS packing_scan_delete_guard ON packing_scan;
    DROP FUNCTION IF EXISTS cadenza_shipping_scan_delete_guard();
    DROP TRIGGER IF EXISTS packing_scan_append_guard ON packing_scan;
    DROP TABLE IF EXISTS packing_scan;
    ALTER TABLE shipment_line DROP CONSTRAINT IF EXISTS shipment_line_packing_fk;
    DROP TABLE IF EXISTS packing_order;
    DROP TABLE IF EXISTS shipment_line;
    DROP TABLE IF EXISTS shipment_order;
    DROP FUNCTION IF EXISTS cadenza_shipping_append_guard();
  `,
}
