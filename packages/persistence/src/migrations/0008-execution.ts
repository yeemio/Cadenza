import type { Migration } from './index'

/**
 * 0008 报工/投料执行域迁移（L1-P1-SERVER T10 三入口报工 + T11 投料块）。
 *
 * 本域尚无冻结合同：规则来源为咨询底稿 architecture/contracts/prep/p1/
 * 03-production-chain-rules-T05T09T10T11.md 的 A5/A6/A7 节与 D 节；
 * 逐条对照见 delivery/L1/server-execution/DELIVERY.md §6。
 *
 * 表清单（五表，全部含审计四列 created_at/by + updated_at/by + enterprise/plant 双隔离）：
 * - execution_session 报工会话（ReportContext：来源三值 order/workbench/scan、
 *   订单/工序/设备/班次/操作者显式绑定，[底稿 A6-1/K13/DM §2]）；
 * - production_report 报工单（草稿/提交状态轴 + 审核轴 待审/自动通过/人工通过/取消审核；
 *   更正引用 correction_of；一张单只存一道工序 K15；撤审/删除留痕不物理删除 K17）；
 * - report_output 产出行（数量+单位+载体码+目标线边库+入库单元，[底稿 A6-5]）；
 * - material_consumption 投料记录（扣前/扣后、类型 报工投料/单独投料、销售行归属、
 *   跨订单偏离记录，[底稿 A7-4/A7-3]）；
 * - labor_record 工时记录（[底稿 A6-5] 工时日志承载）。
 *
 * 关键约束：
 * - [底稿 A6-2] 草稿隔离键库层双保险：open 会话 (operator, order, source) 唯一
 *   （order/scan）；workbench 细分到工序 (operator, order, order_operation) 唯一；
 * - [底稿 A6-1] execution_session.source CHECK 三值；production_report 一张单一道工序
 *   （order_operation_id NOT NULL + 会话 1:1 UNIQUE(session_id)）；
 * - [底稿 A5-1] 超产硬限的应用层规则（含未提交合计）以本表 status/review_status 为计数口径；
 * - production_order 追加 completed_qty（[底稿 A6-5] 审核统一动作回写订单已完成数量；
 *   0005 无该列，本迁移追加列——仅末道非质检审核产出回写，五量展示不消费该列防混口径 A5-3）。
 *
 * 注意：本迁移文件在 L0 整合步统一注册进 registry.ts 前不随 `pnpm db:migrate:up` 应用；
 * 本块测试以 migrateUp(pool, [...migrations, migration0008]) 在独立库（cadenza_exe）应用
 * （模式照 process-test-env，每轮 DROP+CREATE），共享 dev 库保持注册表推导口径不变。
 */
export const migration0008: Migration = {
  version: '0008',
  name: 'execution',
  up: /* sql */ `
    -- ============ 报工会话（ReportContext 显式绑定，[底稿 A6-1/K13]） ============
    CREATE TABLE execution_session (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      enterprise_id uuid NOT NULL REFERENCES org_node (id) ON DELETE RESTRICT,
      plant_id uuid NOT NULL REFERENCES org_node (id) ON DELETE RESTRICT,
      order_id uuid NOT NULL REFERENCES production_order (id) ON DELETE RESTRICT,
      source text NOT NULL CHECK (source IN ('order','workbench','scan')),
      order_operation_id uuid REFERENCES order_operation (id) ON DELETE RESTRICT,
      operation_seq integer,
      equipment_id text,
      equipment_code text,
      operator_user_id uuid NOT NULL REFERENCES user_account (id) ON DELETE RESTRICT,
      operator_login text NOT NULL CHECK (operator_login <> ''),
      shift_date date NOT NULL,
      status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','submitted','cancelled')),
      business_time timestamptz NOT NULL,
      -- 草稿投料意图行快照（[底稿 A6-2] 草稿续作带出托码/库位/备注；提交时逐行扣减转 material_consumption）
      draft_feeds jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(draft_feeds) = 'array'),
      remark text,
      created_at timestamptz NOT NULL DEFAULT now(),
      created_by text,
      updated_at timestamptz NOT NULL DEFAULT now(),
      updated_by text
    );
    CREATE INDEX execution_session_order_idx ON execution_session (order_id);
    CREATE INDEX execution_session_operator_idx ON execution_session (operator_user_id, status);
    -- [底稿 A6-2] 草稿隔离键库层双保险：order/scan 来源 (operator, order, source) 至多一张未提交
    CREATE UNIQUE INDEX execution_session_open_default_uidx
      ON execution_session (operator_user_id, order_id, source)
      WHERE status = 'open' AND source IN ('order','scan');
    -- [底稿 A6-2] 工作台报工细分到工序：(operator, order, operation) 至多一张未提交
    CREATE UNIQUE INDEX execution_session_open_workbench_uidx
      ON execution_session (operator_user_id, order_id, order_operation_id)
      WHERE status = 'open' AND source = 'workbench';

    -- ============ 报工单（草稿/提交轴 + 审核轴 + 更正引用，[底稿 A6-4/A6-6]） ============
    -- 一张报工单只存一道工序（K15）：order_operation_id NOT NULL；会话 1:1。
    -- 撤审（cancelled 审核留痕 + review_cancelled_at/by）与删除（status='deleted' 留行）
    -- 均不物理删除（K17 生效事实走冲销；审计与五量历史口径依赖留痕行）。
    CREATE TABLE production_report (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      enterprise_id uuid NOT NULL REFERENCES org_node (id) ON DELETE RESTRICT,
      plant_id uuid NOT NULL REFERENCES org_node (id) ON DELETE RESTRICT,
      session_id uuid NOT NULL UNIQUE REFERENCES execution_session (id) ON DELETE RESTRICT,
      order_id uuid NOT NULL REFERENCES production_order (id) ON DELETE RESTRICT,
      order_operation_id uuid NOT NULL REFERENCES order_operation (id) ON DELETE RESTRICT,
      operation_seq integer NOT NULL CHECK (operation_seq >= 1),
      source text NOT NULL CHECK (source IN ('order','workbench','scan')),
      status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','submitted','deleted')),
      -- 审核轴三值（待审/自动通过/人工通过）；取消审核=回到 pending_review 并以
      -- review_cancelled_at/by/reason 留痕（不设第四值，防状态与留痕列脱节）。
      review_status text NOT NULL DEFAULT 'pending_review'
        CHECK (review_status IN ('pending_review','auto_approved','manual_approved')),
      operator_user_id uuid NOT NULL REFERENCES user_account (id) ON DELETE RESTRICT,
      operator_login text NOT NULL,
      business_time timestamptz NOT NULL,
      shift_date date NOT NULL,
      equipment_id text,
      equipment_code text,
      reviewed_at timestamptz,
      reviewed_by text,
      review_cancelled_at timestamptz,
      review_cancelled_by text,
      review_cancel_reason text,
      qc_completed_at timestamptz,
      correction_of uuid REFERENCES production_report (id) ON DELETE RESTRICT,
      deleted_at timestamptz,
      deleted_by text,
      remark text,
      created_at timestamptz NOT NULL DEFAULT now(),
      created_by text,
      updated_at timestamptz NOT NULL DEFAULT now(),
      updated_by text
    );
    CREATE INDEX production_report_order_idx ON production_report (order_id, operation_seq);
    CREATE INDEX production_report_operation_idx ON production_report (order_operation_id);
    CREATE INDEX production_report_review_idx ON production_report (review_status) WHERE status = 'submitted';

    -- ============ 报工产出行（数量+单位+载体码+目标线边库，[底稿 A6-5]） ============
    -- stock_unit_id：审核通过经库存记账（receiveGoods）转线边库后的库存单元；
    -- 五量 stocked 口径 = stock_unit_id 非空且所属单审核通过（A5-3）。
    CREATE TABLE report_output (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      enterprise_id uuid NOT NULL REFERENCES org_node (id) ON DELETE RESTRICT,
      plant_id uuid NOT NULL REFERENCES org_node (id) ON DELETE RESTRICT,
      report_id uuid NOT NULL REFERENCES production_report (id) ON DELETE RESTRICT,
      line_no integer NOT NULL CHECK (line_no >= 1),
      quantity numeric(18,4) NOT NULL CHECK (quantity > 0),
      qualified_qty numeric(18,4) NOT NULL CHECK (qualified_qty >= 0 AND qualified_qty <= quantity),
      uom_id uuid NOT NULL,
      uom_code text NOT NULL CHECK (uom_code <> ''),
      carrier_code text,
      target_location_id uuid NOT NULL,
      target_location_code text NOT NULL CHECK (target_location_code <> ''),
      owner_id uuid NOT NULL,
      owner_name text NOT NULL CHECK (owner_name <> ''),
      measurement_basis text NOT NULL DEFAULT 'nominal',
      stock_unit_id uuid REFERENCES inventory_unit (id) ON DELETE RESTRICT,
      created_at timestamptz NOT NULL DEFAULT now(),
      created_by text,
      updated_at timestamptz NOT NULL DEFAULT now(),
      updated_by text,
      CONSTRAINT report_output_report_line_unique UNIQUE (report_id, line_no)
    );
    CREATE INDEX report_output_report_idx ON report_output (report_id);
    CREATE INDEX report_output_stock_unit_idx ON report_output (stock_unit_id) WHERE stock_unit_id IS NOT NULL;

    -- ============ 投料记录（扣前/扣后 + 类型 + 销售行归属 + 跨订单偏离，[底稿 A7]） ============
    -- 每行对应一次库存记账发料（stock_transaction issue 行）的业务快照；
    -- before_qty/after_qty 即扣前/扣后余额（K05 实时余量，非扫码快照）；
    -- genealogy_target_unit_id：谱系消费边补写目标（产出单元落成时回填，A7-4 谱系边）。
    CREATE TABLE material_consumption (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      enterprise_id uuid NOT NULL REFERENCES org_node (id) ON DELETE RESTRICT,
      plant_id uuid NOT NULL REFERENCES org_node (id) ON DELETE RESTRICT,
      order_id uuid NOT NULL REFERENCES production_order (id) ON DELETE RESTRICT,
      order_operation_id uuid NOT NULL REFERENCES order_operation (id) ON DELETE RESTRICT,
      operation_seq integer NOT NULL CHECK (operation_seq >= 1),
      report_id uuid REFERENCES production_report (id) ON DELETE RESTRICT,
      feed_type text NOT NULL CHECK (feed_type IN ('report','standalone')),
      inventory_unit_id uuid NOT NULL REFERENCES inventory_unit (id) ON DELETE RESTRICT,
      unit_no text NOT NULL CHECK (unit_no <> ''),
      barcode_value text,
      quantity numeric(18,4) NOT NULL CHECK (quantity > 0),
      before_qty numeric(18,4) NOT NULL CHECK (before_qty >= 0),
      after_qty numeric(18,4) NOT NULL CHECK (after_qty >= 0),
      uom_id uuid NOT NULL,
      uom_code text NOT NULL CHECK (uom_code <> ''),
      sales_order_no text,
      sales_line_no text,
      cross_order boolean NOT NULL DEFAULT false,
      deviation_reason text,
      issued_location_id uuid,
      issued_location_code text,
      genealogy_target_unit_id uuid REFERENCES inventory_unit (id) ON DELETE RESTRICT,
      operator_user_id uuid NOT NULL REFERENCES user_account (id) ON DELETE RESTRICT,
      operator_login text NOT NULL,
      business_time timestamptz NOT NULL,
      shift_date date,
      command_receipt_id uuid NOT NULL REFERENCES command_receipt (id) ON DELETE RESTRICT,
      created_at timestamptz NOT NULL DEFAULT now(),
      created_by text,
      updated_at timestamptz NOT NULL DEFAULT now(),
      updated_by text
    );
    CREATE INDEX material_consumption_order_idx ON material_consumption (order_id, operation_seq);
    CREATE INDEX material_consumption_report_idx ON material_consumption (report_id) WHERE report_id IS NOT NULL;
    CREATE INDEX material_consumption_unit_idx ON material_consumption (inventory_unit_id);

    -- ============ 工时记录（[底稿 A6-5] 审核统一动作之工时日志承载；独立记录亦可） ============
    CREATE TABLE labor_record (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      enterprise_id uuid NOT NULL REFERENCES org_node (id) ON DELETE RESTRICT,
      plant_id uuid NOT NULL REFERENCES org_node (id) ON DELETE RESTRICT,
      order_id uuid NOT NULL REFERENCES production_order (id) ON DELETE RESTRICT,
      order_operation_id uuid REFERENCES order_operation (id) ON DELETE RESTRICT,
      report_id uuid REFERENCES production_report (id) ON DELETE RESTRICT,
      operator_user_id uuid NOT NULL REFERENCES user_account (id) ON DELETE RESTRICT,
      operator_login text NOT NULL,
      hours numeric(8,2) NOT NULL CHECK (hours > 0),
      business_time timestamptz NOT NULL,
      shift_date date NOT NULL,
      note text,
      created_at timestamptz NOT NULL DEFAULT now(),
      created_by text,
      updated_at timestamptz NOT NULL DEFAULT now(),
      updated_by text
    );
    CREATE INDEX labor_record_order_idx ON labor_record (order_id);
    CREATE INDEX labor_record_operator_idx ON labor_record (operator_user_id, shift_date);

    -- ============ 生产订单完成数量回写列（[底稿 A6-5]；仅末道非质检审核产出回写） ============
    -- 追加列而非新表：0005 production_order 无完成数量列；A5-3 五量展示不消费该列（防混口径），
    -- 该列仅为订单视图的「已完成数量」回写锚点（取消审核同事务回退，不为负）。
    ALTER TABLE production_order ADD COLUMN completed_qty numeric(16,4) NOT NULL DEFAULT 0;
    ALTER TABLE production_order ADD CONSTRAINT production_order_completed_qty_check CHECK (completed_qty >= 0);
  `,
  down: /* sql */ `
    ALTER TABLE production_order DROP CONSTRAINT IF EXISTS production_order_completed_qty_check;
    ALTER TABLE production_order DROP COLUMN IF EXISTS completed_qty;
    DROP TABLE IF EXISTS labor_record;
    DROP TABLE IF EXISTS material_consumption;
    DROP TABLE IF EXISTS report_output;
    DROP TABLE IF EXISTS production_report;
    DROP TABLE IF EXISTS execution_session;
  `,
}
