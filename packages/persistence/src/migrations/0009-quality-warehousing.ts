import type { Migration } from './index'

/**
 * 0009 质量闭环与仓储主链迁移（L1-P1-SERVER / T12+T13，WorkItem 指派；**不注册共享 registry**——
 * 本文件由 L0 整合步统一并入 migrations/registry.ts，测试侧以编程方式 migrateUp 单独应用
 * （独立库 cadenza_qw，与共享 dev 库及并行 writer 的 0007/0008 无表名/迁移号冲突）。
 *
 * 依据：规则底稿 architecture/contracts/prep/p1/04-supply-chain-rules-T08T12T13T14.md
 * §A-T12（质量放行）+ §A-T13（入库/移库/调拨）；
 * 冻结合同 architecture/contracts/frozen/p1/inventory-trace-core.md（质量闸门 IT-14、
 * 三分存储 IT-02、流水幂等 IT-19、预留四要素 IT-23、两段原子 IT-25、时间双轨 IT-37）。
 *
 * 表：
 * - quality 域（T12）：
 *   - quality_inspection_order [A-T12-5]：过程/成品检验任务（来源报工/入库，来源幂等唯一；
 *     检验规范引用版本化 spec_code+spec_version，提交后不可改——无更新命令路径承载）；
 *   - quality_test_result [A-T12-1/S14]：实测值追加历史 + 生效结论版本化——
 *     (inspection_order_id, version) 唯一 + partial unique 生效指针 + 守卫触发器
 *     （UPDATE 仅允许翻转 is_effective、DELETE 拒绝：结论事实不可改，新结论走追加版本行）；
 *   - quality_disposition [A-T12-1]：放行/让步处置记录（append-only；让步 based_on_version
 *     显式引用原结论版本——保留原不合格事实，不清不改）；
 *   - quality_hold [A-T12-2/A-T12-3]：隔离与处置独立（待检/不合格/存疑不可用；
 *     同码至多一条活动隔离 partial unique；存疑恢复留最小处置记录列 [底稿 B-9/C-5]）。
 * - warehousing 域（T13）：
 *   - putaway_task [A-T13-1]：待入库任务台账（报工/成品质检异步写入来源；禁手工增删改——
 *     仅 putaway.refresh（端口重跑）生成、confirm 回填，无手工命令面）；
 *   - warehouse_move [A-T13-4]：移库记录（原/现库位逐码，append-only）；
 *   - transfer_order + transfer_order_line [A-T13-6/A-T13-10]：调拨状态机
 *     （草稿→待执行→出库中→已出库在途→收货中→完成）+ 两段事实行
 *     （out_qty 出库段 / in_qty 接收段，各行独立推进；锁定=作业预留 reservation 引用）。
 *
 * 外键：inventory_unit/stock 侧（0004）、material/warehouse/storage_location（0003）、
 * org_node（0002）、command_receipt（0001）均已注册落地，直接 RESTRICT。
 * 守卫函数名独立（cadenza_quality_history_guard / cadenza_warehousing_append_guard），
 * 与 0004 cadenza_reject_mutation、0006 cadenza_purchase_history_guard 互不影响。
 */
export const migration0009: Migration = {
  version: '0009',
  name: 'quality-warehousing',
  up: /* sql */ `
    -- ============ T12 守卫：检验结论版本化（S14 同构）与处置/移库 append-only ============
    -- quality_test_result：DELETE 拒；UPDATE 仅允许翻转生效指针 is_effective（结论事实不可改）。
    CREATE FUNCTION cadenza_quality_history_guard() RETURNS trigger AS $$
    BEGIN
      IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION '[A-T12-S14] 表 % 禁止 DELETE：检验结论历史不可物理删除（纠正走生效指针切换或新版本行）',
          TG_TABLE_NAME;
      END IF;
      IF TG_TABLE_NAME = 'quality_test_result' THEN
        IF NEW.conclusion IS DISTINCT FROM OLD.conclusion
          OR NEW.items IS DISTINCT FROM OLD.items
          OR NEW.version IS DISTINCT FROM OLD.version
          OR NEW.inspection_order_id IS DISTINCT FROM OLD.inspection_order_id
          OR NEW.result_kind IS DISTINCT FROM OLD.result_kind
          OR NEW.inspector IS DISTINCT FROM OLD.inspector
          OR NEW.inspected_at IS DISTINCT FROM OLD.inspected_at
          OR NEW.command_receipt_id IS DISTINCT FROM OLD.command_receipt_id THEN
          RAISE EXCEPTION '[A-T12-S14] quality_test_result 仅允许翻转生效指针列（is_effective）：结论与实测事实不可修改，新结论走追加版本行';
        END IF;
      ELSE
        RAISE EXCEPTION '[A-T12-1] 表 % 为 append-only 处置事实：禁止 UPDATE（纠正走新处置记录）',
          TG_TABLE_NAME;
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;

    -- warehouse_move：append-only（移库事实拒改拒删，纠正走反向移库）。
    CREATE FUNCTION cadenza_warehousing_append_guard() RETURNS trigger AS $$
    BEGIN
      RAISE EXCEPTION '[A-T13-4] 表 % 为 append-only 移库事实：禁止 %（纠正走反向移库记录）',
        TG_TABLE_NAME, TG_OP;
    END;
    $$ LANGUAGE plpgsql;

    -- ============ 检验任务（A-T12-5：过程/成品检验；来源报工/入库；规范引用版本化） ============
    CREATE TABLE quality_inspection_order (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      order_no text NOT NULL CHECK (order_no <> ''),
      source_type text NOT NULL CHECK (source_type IN ('work_report', 'putaway_receipt')),
      source_ref text NOT NULL CHECK (source_ref <> ''),
      inspection_stage text NOT NULL CHECK (inspection_stage IN ('process', 'finished')),
      spec_code text NOT NULL CHECK (spec_code <> ''),
      spec_version integer NOT NULL CHECK (spec_version >= 1),
      inventory_unit_id uuid REFERENCES inventory_unit (id) ON DELETE RESTRICT,
      unit_no text,
      material_id uuid NOT NULL REFERENCES material (id) ON DELETE RESTRICT,
      material_code text NOT NULL CHECK (material_code <> ''),
      lot_id uuid REFERENCES material_lot (id) ON DELETE RESTRICT,
      quantity numeric(18,4) NOT NULL CHECK (quantity > 0),
      uom_id uuid NOT NULL,
      uom_code text NOT NULL CHECK (uom_code <> ''),
      status text NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'in_progress', 'concluded', 'cancelled')),
      production_order_no text,
      production_dept_id uuid,
      production_dept_name text,
      plant_id uuid NOT NULL REFERENCES org_node (id) ON DELETE RESTRICT,
      enterprise_id uuid NOT NULL REFERENCES org_node (id) ON DELETE RESTRICT,
      business_time timestamptz NOT NULL DEFAULT now(),
      created_at timestamptz NOT NULL DEFAULT now(),
      created_by text,
      updated_at timestamptz NOT NULL DEFAULT now(),
      updated_by text,
      -- A-T12-5：同来源同阶段检验任务幂等唯一（报工/入库事件重放不重复生成）
      CONSTRAINT quality_inspection_order_source_unique UNIQUE (source_type, source_ref, inspection_stage),
      CONSTRAINT quality_inspection_order_no_unique UNIQUE (order_no)
    );
    CREATE INDEX quality_inspection_order_plant_idx ON quality_inspection_order (plant_id);
    CREATE INDEX quality_inspection_order_unit_idx ON quality_inspection_order (inventory_unit_id);
    CREATE INDEX quality_inspection_order_status_idx ON quality_inspection_order (status);

    -- ============ 实测/结论（A-T12-1/S14：追加历史 + 生效结论版本化） ============
    -- 每行 = 一次实测提交（items=检验项实测明细快照）+ 本次判定；结论变更 = 追加新版本行 +
    -- 翻转生效指针；生成时插入 v1（pending）作为链起点。守卫触发器拒事实列 UPDATE 与 DELETE。
    CREATE TABLE quality_test_result (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      inspection_order_id uuid NOT NULL REFERENCES quality_inspection_order (id) ON DELETE RESTRICT,
      version integer NOT NULL CHECK (version >= 1),
      conclusion text NOT NULL CHECK (conclusion IN ('pending', 'qualified', 'unqualified')),
      items jsonb NOT NULL DEFAULT '[]'::jsonb,
      result_kind text NOT NULL DEFAULT 'test' CHECK (result_kind IN ('initial', 'test', 're_inspection')),
      is_effective boolean NOT NULL DEFAULT false,
      inspector text,
      inspected_at timestamptz,
      command_receipt_id uuid REFERENCES command_receipt (id) ON DELETE RESTRICT,
      business_time timestamptz NOT NULL DEFAULT now(),
      created_at timestamptz NOT NULL DEFAULT now(),
      created_by text,
      updated_at timestamptz NOT NULL DEFAULT now(),
      updated_by text,
      CONSTRAINT quality_test_result_version_unique UNIQUE (inspection_order_id, version)
    );
    -- S14 生效指针：同检验单至多一条生效结论行
    CREATE UNIQUE INDEX quality_test_result_effective_uidx
      ON quality_test_result (inspection_order_id) WHERE is_effective;
    CREATE INDEX quality_test_result_order_idx ON quality_test_result (inspection_order_id);
    CREATE TRIGGER quality_test_result_history_guard
      BEFORE UPDATE OR DELETE ON quality_test_result
      FOR EACH ROW EXECUTE FUNCTION cadenza_quality_history_guard();

    -- ============ 处置记录（A-T12-1：放行/让步；让步保留原不合格事实） ============
    CREATE TABLE quality_disposition (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      inspection_order_id uuid NOT NULL REFERENCES quality_inspection_order (id) ON DELETE RESTRICT,
      disposition_kind text NOT NULL CHECK (disposition_kind IN ('release', 'concession')),
      based_on_version integer NOT NULL CHECK (based_on_version >= 1),
      released_by text NOT NULL CHECK (released_by <> ''),
      released_at timestamptz NOT NULL,
      reason text,
      command_receipt_id uuid REFERENCES command_receipt (id) ON DELETE RESTRICT,
      business_time timestamptz NOT NULL DEFAULT now(),
      created_at timestamptz NOT NULL DEFAULT now(),
      created_by text
    );
    CREATE INDEX quality_disposition_order_idx ON quality_disposition (inspection_order_id);
    CREATE TRIGGER quality_disposition_append_guard
      BEFORE UPDATE OR DELETE ON quality_disposition
      FOR EACH ROW EXECUTE FUNCTION cadenza_quality_history_guard();

    -- ============ 隔离（A-T12-2/A-T12-3：隔离与处置独立；待检/不合格/存疑不可用） ============
    CREATE TABLE quality_hold (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      inventory_unit_id uuid NOT NULL REFERENCES inventory_unit (id) ON DELETE RESTRICT,
      unit_no text NOT NULL,
      hold_kind text NOT NULL CHECK (hold_kind IN ('pending_inspection', 'unqualified', 'suspect')),
      status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'released')),
      previous_quality_status text,
      raised_by text NOT NULL CHECK (raised_by <> ''),
      raised_at timestamptz NOT NULL,
      production_dept_id uuid,
      production_dept_name text,
      released_by text,
      released_at timestamptz,
      disposition_note text,
      command_receipt_id uuid REFERENCES command_receipt (id) ON DELETE RESTRICT,
      business_time timestamptz NOT NULL DEFAULT now(),
      created_at timestamptz NOT NULL DEFAULT now(),
      created_by text,
      updated_at timestamptz NOT NULL DEFAULT now(),
      updated_by text
    );
    -- A-T12-3：同码至多一条活动隔离（未存疑才可再存疑，域规则 + 库级双保险）
    CREATE UNIQUE INDEX quality_hold_active_uidx ON quality_hold (inventory_unit_id) WHERE status = 'active';
    CREATE INDEX quality_hold_unit_idx ON quality_hold (inventory_unit_id);

    -- ============ 待入库任务台账（A-T13-1：报工/成品质检异步写入；禁手工增删改） ============
    -- 仅 warehousing.putaway.refresh（ExecutionEventPort 重跑）生成、putaway.confirm 回填；
    -- 无手工增删改命令面（应用层保证 + 审计）。
    CREATE TABLE putaway_task (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      source_type text NOT NULL CHECK (source_type IN ('work_report', 'finished_inspection')),
      source_ref text NOT NULL CHECK (source_ref <> ''),
      unit_no text,
      pallet_code text,
      material_id uuid NOT NULL REFERENCES material (id) ON DELETE RESTRICT,
      material_code text NOT NULL CHECK (material_code <> ''),
      quantity numeric(18,4) NOT NULL CHECK (quantity > 0),
      uom_id uuid NOT NULL,
      uom_code text NOT NULL CHECK (uom_code <> ''),
      target_warehouse_id uuid REFERENCES warehouse (id) ON DELETE RESTRICT,
      status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'done', 'cancelled')),
      inventory_unit_id uuid REFERENCES inventory_unit (id) ON DELETE RESTRICT,
      location_id uuid REFERENCES storage_location (id) ON DELETE RESTRICT,
      location_code text,
      putaway_by text,
      putaway_at timestamptz,
      command_receipt_id uuid REFERENCES command_receipt (id) ON DELETE RESTRICT,
      plant_id uuid NOT NULL REFERENCES org_node (id) ON DELETE RESTRICT,
      enterprise_id uuid NOT NULL REFERENCES org_node (id) ON DELETE RESTRICT,
      business_time timestamptz NOT NULL DEFAULT now(),
      created_at timestamptz NOT NULL DEFAULT now(),
      created_by text,
      updated_at timestamptz NOT NULL DEFAULT now(),
      updated_by text,
      -- A-T13-1：来源幂等唯一（端口重跑不重复生成任务）
      CONSTRAINT putaway_task_source_unique UNIQUE (source_type, source_ref)
    );
    CREATE INDEX putaway_task_plant_idx ON putaway_task (plant_id);
    CREATE INDEX putaway_task_status_idx ON putaway_task (status);
    CREATE INDEX putaway_task_pallet_idx ON putaway_task (pallet_code) WHERE status = 'pending';

    -- ============ 移库记录（A-T13-4：同仓库位移动，原/现库位逐码，append-only） ============
    CREATE TABLE warehouse_move (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      inventory_unit_id uuid NOT NULL REFERENCES inventory_unit (id) ON DELETE RESTRICT,
      unit_no text NOT NULL CHECK (unit_no <> ''),
      from_location_id uuid REFERENCES storage_location (id) ON DELETE RESTRICT,
      from_location_code text,
      to_location_id uuid REFERENCES storage_location (id) ON DELETE RESTRICT,
      to_location_code text,
      quantity numeric(18,4) NOT NULL CHECK (quantity > 0),
      uom_id uuid NOT NULL,
      uom_code text NOT NULL CHECK (uom_code <> ''),
      moved_by text NOT NULL CHECK (moved_by <> ''),
      moved_at timestamptz NOT NULL,
      reason text,
      command_receipt_id uuid REFERENCES command_receipt (id) ON DELETE RESTRICT,
      plant_id uuid NOT NULL REFERENCES org_node (id) ON DELETE RESTRICT,
      enterprise_id uuid NOT NULL REFERENCES org_node (id) ON DELETE RESTRICT,
      business_time timestamptz NOT NULL DEFAULT now(),
      created_at timestamptz NOT NULL DEFAULT now(),
      created_by text
    );
    CREATE INDEX warehouse_move_unit_idx ON warehouse_move (inventory_unit_id);
    CREATE INDEX warehouse_move_plant_idx ON warehouse_move (plant_id);
    CREATE TRIGGER warehouse_move_append_guard
      BEFORE UPDATE OR DELETE ON warehouse_move
      FOR EACH ROW EXECUTE FUNCTION cadenza_warehousing_append_guard();

    -- ============ 调拨单（A-T13-6/A-T13-10：状态机 + 仓库规则） ============
    CREATE TABLE transfer_order (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      order_no text NOT NULL CHECK (order_no <> ''),
      transfer_kind text NOT NULL CHECK (transfer_kind IN ('production', 'warehouse', 'auto')),
      from_warehouse_id uuid NOT NULL REFERENCES warehouse (id) ON DELETE RESTRICT,
      to_warehouse_id uuid NOT NULL REFERENCES warehouse (id) ON DELETE RESTRICT,
      from_warehouse_code text,
      to_warehouse_code text,
      from_warehouse_type text,
      to_warehouse_type text,
      status text NOT NULL DEFAULT 'draft'
        CHECK (status IN ('draft', 'ready', 'shipping', 'shipped_in_transit', 'receiving', 'completed', 'cancelled')),
      transit_location_id uuid REFERENCES storage_location (id) ON DELETE RESTRICT,
      transit_location_code text,
      locked_valid_until timestamptz,
      note text,
      submitted_by text,
      submitted_at timestamptz,
      shipped_by text,
      shipped_at timestamptz,
      completed_by text,
      completed_at timestamptz,
      plant_id uuid NOT NULL REFERENCES org_node (id) ON DELETE RESTRICT,
      enterprise_id uuid NOT NULL REFERENCES org_node (id) ON DELETE RESTRICT,
      business_time timestamptz NOT NULL DEFAULT now(),
      created_at timestamptz NOT NULL DEFAULT now(),
      created_by text,
      updated_at timestamptz NOT NULL DEFAULT now(),
      updated_by text,
      -- A-T13-6：调入不得等于调出（库级双保险；域规则先行）
      CONSTRAINT transfer_order_warehouses_differ CHECK (from_warehouse_id <> to_warehouse_id),
      CONSTRAINT transfer_order_no_unique UNIQUE (order_no)
    );
    CREATE INDEX transfer_order_plant_idx ON transfer_order (plant_id);
    CREATE INDEX transfer_order_status_idx ON transfer_order (status);

    -- ============ 调拨行（A-T13-10：两段事实——出库段 out_qty / 接收段 in_qty） ============
    CREATE TABLE transfer_order_line (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      transfer_order_id uuid NOT NULL REFERENCES transfer_order (id) ON DELETE RESTRICT,
      line_no integer NOT NULL CHECK (line_no >= 1),
      inventory_unit_id uuid NOT NULL REFERENCES inventory_unit (id) ON DELETE RESTRICT,
      unit_no text NOT NULL CHECK (unit_no <> ''),
      material_id uuid REFERENCES material (id) ON DELETE RESTRICT,
      material_code text,
      material_type smallint,
      quantity numeric(18,4) NOT NULL CHECK (quantity > 0),
      out_qty numeric(18,4) NOT NULL DEFAULT 0 CHECK (out_qty >= 0),
      in_qty numeric(18,4) NOT NULL DEFAULT 0 CHECK (in_qty >= 0),
      reservation_id uuid,
      out_done boolean NOT NULL DEFAULT false,
      out_at timestamptz,
      in_done boolean NOT NULL DEFAULT false,
      in_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      created_by text,
      updated_at timestamptz NOT NULL DEFAULT now(),
      updated_by text,
      CONSTRAINT transfer_order_line_no_unique UNIQUE (transfer_order_id, line_no),
      CONSTRAINT transfer_order_line_qty_bounds CHECK (out_qty <= quantity AND in_qty <= quantity)
    );
    CREATE INDEX transfer_order_line_order_idx ON transfer_order_line (transfer_order_id);
    CREATE INDEX transfer_order_line_unit_idx ON transfer_order_line (inventory_unit_id);
  `,
  down: /* sql */ `
    DROP TABLE IF EXISTS transfer_order_line;
    DROP TABLE IF EXISTS transfer_order;
    DROP TRIGGER IF EXISTS warehouse_move_append_guard ON warehouse_move;
    DROP TABLE IF EXISTS warehouse_move;
    DROP TABLE IF EXISTS putaway_task;
    DROP TRIGGER IF EXISTS quality_disposition_append_guard ON quality_disposition;
    DROP TABLE IF EXISTS quality_hold;
    DROP TABLE IF EXISTS quality_disposition;
    DROP TRIGGER IF EXISTS quality_test_result_history_guard ON quality_test_result;
    DROP TABLE IF EXISTS quality_test_result;
    DROP TABLE IF EXISTS quality_inspection_order;
    DROP FUNCTION IF EXISTS cadenza_warehousing_append_guard();
    DROP FUNCTION IF EXISTS cadenza_quality_history_guard();
  `,
}
