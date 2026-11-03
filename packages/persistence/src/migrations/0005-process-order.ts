import type { Migration } from './index'

/**
 * 0005 工艺与生产订单迁移（L1-P1-SERVER T05 工艺/生产订单块）。
 *
 * 本域尚无冻结合同：规则来源为咨询底稿 architecture/contracts/prep/p1/
 * 03-production-chain-rules-T05T09T10T11.md 的 A1/A2 节与 B1/B11，
 * 及 requirements/source/PRD文档/生产管理/生产订单.md、工序管理/{工序管理,工序模板}.md；
 * 逐条对照见 delivery/L1/server-process/DELIVERY.md §6。
 *
 * 表清单（七表，全部含审计四列 created_at/by + updated_at/by；除订单工序继承订单工厂外均 plant_id 隔离）：
 * - product_family 产品族（工艺分组主数据，工艺验证按厂进行 → 厂级隔离）；
 * - manufacturing_bom_revision 制造 BOM 版本（版本 + 状态轴 draft/reviewed/published/retired）；
 * - route_revision 工艺路线版本（同一状态轴）；
 * - operation_definition 工序主数据（工序管理 PRD：部门内名称唯一、组织编码内编码唯一、引用保护）；
 * - parameter_spec_revision 参数规范版本（同一状态轴）；
 * - production_order 生产订单（状态轴 approved→released→in_progress→pending_completion→closed；
 *   voided 不在轴上、suspended 独立开关；ERP 商业关闭字段分离 erp_closed_at/by）；
 * - order_operation 订单工序（快照列：芯倍数/绞合/下线数量/工作中心/单位 + BOM/路线版本引用冻结；
 *   settings_version + execution_status 为 S04 变更版本预留结构，报工域未建）。
 *
 * 关键约束：
 * - [底稿 A2] published 版本内容不可改：三张版本表各配库层冻结触发器（published 仅允许 retired
 *   终态迁移，retired 终态禁改禁删；命令层另有同口径校验，双保险沿用 MD-S2 模式）；
 * - [底稿 A2] 同 (plant, material)/(plant, family)/(plant, family, 规范名) 至多一条 published 版本；
 * - [底稿 A1] 生产订单主状态轴 CHECK + 独立 voided/suspended + ERP 关闭分离列；
 * - [底稿 A2] order_operation 快照列独立于 operation_definition/work_center 主数据（模板后改不影响已接订单）；
 * - 全部 FK ON DELETE RESTRICT（MD-S7 同型：被订单/工序引用的主数据不物理删除）。
 *
 * 注意：本迁移文件在 L0 整合步统一注册进 registry.ts 前不随 `pnpm db:migrate:up` 应用；
 * 本块测试以 migrateUp(pool, [...migrations, migration0005]) 在独立库（cadenza_proc）应用
 * （模式照 masterdata-test-env，每轮 DROP+CREATE），共享 dev 库保持注册表推导口径不变。
 */
export const migration0005: Migration = {
  version: '0005',
  name: 'process-order',
  up: /* sql */ `
    -- ============ 产品族（工艺分组主数据；工艺验证按厂进行 → 厂级隔离） ============
    CREATE TABLE product_family (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      enterprise_id uuid NOT NULL REFERENCES org_node (id) ON DELETE RESTRICT,
      plant_id uuid NOT NULL REFERENCES org_node (id) ON DELETE RESTRICT,
      code text NOT NULL CHECK (code <> '' AND length(code) <= 32),
      name text NOT NULL CHECK (name <> '' AND length(name) <= 50),
      description text CHECK (description IS NULL OR length(description) <= 255),
      status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','retired')),
      deleted_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      created_by text,
      updated_at timestamptz NOT NULL DEFAULT now(),
      updated_by text
    );
    CREATE UNIQUE INDEX product_family_plant_code_active_uidx ON product_family (plant_id, code) WHERE status = 'active';
    CREATE INDEX product_family_plant_idx ON product_family (plant_id) WHERE status = 'active';

    -- ============ 制造 BOM 版本（版本 + 状态轴 draft/reviewed/published/retired） ============
    -- 行 = 某厂某料品 BOM 的一个版本；lines 为 BOM 行 jsonb（料品/数量/单位，P1 行级查询未需求）。
    -- 同 (plant, material) 至多一条 published（partial unique）——订单只引用已发布版本（底稿 A2）。
    CREATE TABLE manufacturing_bom_revision (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      enterprise_id uuid NOT NULL REFERENCES org_node (id) ON DELETE RESTRICT,
      plant_id uuid NOT NULL REFERENCES org_node (id) ON DELETE RESTRICT,
      product_family_id uuid NOT NULL REFERENCES product_family (id) ON DELETE RESTRICT,
      material_id uuid NOT NULL REFERENCES material (id) ON DELETE RESTRICT,
      version integer NOT NULL CHECK (version >= 1),
      status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','reviewed','published','retired')),
      lines jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(lines) = 'array'),
      remark text,
      published_at timestamptz,
      published_by text,
      created_at timestamptz NOT NULL DEFAULT now(),
      created_by text,
      updated_at timestamptz NOT NULL DEFAULT now(),
      updated_by text,
      CONSTRAINT manufacturing_bom_revision_version_unique UNIQUE (plant_id, material_id, version)
    );
    CREATE UNIQUE INDEX manufacturing_bom_published_uidx ON manufacturing_bom_revision (plant_id, material_id) WHERE status = 'published';
    CREATE INDEX manufacturing_bom_plant_idx ON manufacturing_bom_revision (plant_id) WHERE status <> 'retired';

    -- [底稿 A2] published 冻结：published 行仅允许迁 retired（终态），内容列不可改；retired 禁改禁删。
    CREATE OR REPLACE FUNCTION cadenza_bom_revision_freeze_guard() RETURNS trigger AS $$
    BEGIN
      IF OLD.status = 'published' THEN
        IF NEW.status NOT IN ('published','retired') THEN
          RAISE EXCEPTION 'A2-2: 已发布 BOM 版本不可变更状态（仅可失效为 retired）';
        END IF;
        IF NEW.status = 'published' AND (
             NEW.product_family_id IS DISTINCT FROM OLD.product_family_id
             OR NEW.material_id IS DISTINCT FROM OLD.material_id
             OR NEW.version IS DISTINCT FROM OLD.version
             OR NEW.lines IS DISTINCT FROM OLD.lines
             OR NEW.remark IS DISTINCT FROM OLD.remark) THEN
          RAISE EXCEPTION 'A2-2: 已发布 BOM 版本内容不可修改（发布后冻结，变更须生成新版本）';
        END IF;
      END IF;
      IF OLD.status = 'retired' THEN
        RAISE EXCEPTION 'A2-2: 已失效 BOM 版本为终态，不可修改';
      END IF;
      RETURN COALESCE(NEW, OLD);
    END;
    $$ LANGUAGE plpgsql;
    CREATE TRIGGER bom_revision_freeze_guard
      BEFORE UPDATE OR DELETE ON manufacturing_bom_revision
      FOR EACH ROW EXECUTE FUNCTION cadenza_bom_revision_freeze_guard();

    -- ============ 工艺路线版本（同一状态轴；订单接收时按路线展开订单工序） ============
    -- steps 为工序步 jsonb 数组：[{seq, operationDefinitionId, workCenterId, coreMultiple?, strandFactor?}]，
    -- 系数缺省 芯倍数=1、绞合=空（订单侧可改；底稿 A2 公式口径）。
    CREATE TABLE route_revision (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      enterprise_id uuid NOT NULL REFERENCES org_node (id) ON DELETE RESTRICT,
      plant_id uuid NOT NULL REFERENCES org_node (id) ON DELETE RESTRICT,
      product_family_id uuid NOT NULL REFERENCES product_family (id) ON DELETE RESTRICT,
      version integer NOT NULL CHECK (version >= 1),
      status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','reviewed','published','retired')),
      steps jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(steps) = 'array'),
      remark text,
      published_at timestamptz,
      published_by text,
      created_at timestamptz NOT NULL DEFAULT now(),
      created_by text,
      updated_at timestamptz NOT NULL DEFAULT now(),
      updated_by text,
      CONSTRAINT route_revision_version_unique UNIQUE (plant_id, product_family_id, version)
    );
    CREATE UNIQUE INDEX route_published_uidx ON route_revision (plant_id, product_family_id) WHERE status = 'published';
    CREATE INDEX route_plant_idx ON route_revision (plant_id) WHERE status <> 'retired';

    CREATE OR REPLACE FUNCTION cadenza_route_revision_freeze_guard() RETURNS trigger AS $$
    BEGIN
      IF OLD.status = 'published' THEN
        IF NEW.status NOT IN ('published','retired') THEN
          RAISE EXCEPTION 'A2-2: 已发布工艺路线版本不可变更状态（仅可失效为 retired）';
        END IF;
        IF NEW.status = 'published' AND (
             NEW.product_family_id IS DISTINCT FROM OLD.product_family_id
             OR NEW.version IS DISTINCT FROM OLD.version
             OR NEW.steps IS DISTINCT FROM OLD.steps
             OR NEW.remark IS DISTINCT FROM OLD.remark) THEN
          RAISE EXCEPTION 'A2-2: 已发布工艺路线版本内容不可修改（发布后冻结，变更须生成新版本）';
        END IF;
      END IF;
      IF OLD.status = 'retired' THEN
        RAISE EXCEPTION 'A2-2: 已失效工艺路线版本为终态，不可修改';
      END IF;
      RETURN COALESCE(NEW, OLD);
    END;
    $$ LANGUAGE plpgsql;
    CREATE TRIGGER route_revision_freeze_guard
      BEFORE UPDATE OR DELETE ON route_revision
      FOR EACH ROW EXECUTE FUNCTION cadenza_route_revision_freeze_guard();

    -- ============ 工序主数据（工序管理 PRD §2.1） ============
    -- 同一所属部门下工序名称唯一；同一公司组织编码下工序编码唯一（active 口径，PRD §2.1 逻辑）。
    -- 工作中心必填且须已配置部门；被订单排产引用时工作中心/所属部门不可改（编辑锁，域规则 A1-3）。
    CREATE TABLE operation_definition (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      enterprise_id uuid NOT NULL REFERENCES org_node (id) ON DELETE RESTRICT,
      plant_id uuid NOT NULL REFERENCES org_node (id) ON DELETE RESTRICT,
      dept_id uuid NOT NULL REFERENCES org_node (id) ON DELETE RESTRICT,
      work_center_id uuid NOT NULL REFERENCES work_center (id) ON DELETE RESTRICT,
      company_org_code text NOT NULL CHECK (company_org_code <> '' AND length(company_org_code) <= 50),
      code text NOT NULL CHECK (code <> '' AND length(code) <= 20),
      name text NOT NULL CHECK (name <> '' AND length(name) <= 20),
      remark text CHECK (remark IS NULL OR length(remark) <= 255),
      status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','retired')),
      deleted_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      created_by text,
      updated_at timestamptz NOT NULL DEFAULT now(),
      updated_by text
    );
    CREATE UNIQUE INDEX operation_definition_dept_name_active_uidx ON operation_definition (dept_id, name) WHERE status = 'active';
    CREATE UNIQUE INDEX operation_definition_org_code_active_uidx ON operation_definition (company_org_code, code) WHERE status = 'active';
    CREATE INDEX operation_definition_plant_idx ON operation_definition (plant_id) WHERE status = 'active';

    -- ============ 参数规范版本（同一状态轴；DM §4.1 冻结清单之检验/参数规范承载位） ============
    CREATE TABLE parameter_spec_revision (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      enterprise_id uuid NOT NULL REFERENCES org_node (id) ON DELETE RESTRICT,
      plant_id uuid NOT NULL REFERENCES org_node (id) ON DELETE RESTRICT,
      product_family_id uuid NOT NULL REFERENCES product_family (id) ON DELETE RESTRICT,
      name text NOT NULL CHECK (name <> '' AND length(name) <= 50),
      version integer NOT NULL CHECK (version >= 1),
      status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','reviewed','published','retired')),
      parameters jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(parameters) = 'array'),
      remark text,
      published_at timestamptz,
      published_by text,
      created_at timestamptz NOT NULL DEFAULT now(),
      created_by text,
      updated_at timestamptz NOT NULL DEFAULT now(),
      updated_by text,
      CONSTRAINT parameter_spec_revision_version_unique UNIQUE (plant_id, product_family_id, name, version)
    );
    CREATE UNIQUE INDEX parameter_spec_published_uidx ON parameter_spec_revision (plant_id, product_family_id, name) WHERE status = 'published';
    CREATE INDEX parameter_spec_plant_idx ON parameter_spec_revision (plant_id) WHERE status <> 'retired';

    CREATE OR REPLACE FUNCTION cadenza_parameter_spec_freeze_guard() RETURNS trigger AS $$
    BEGIN
      IF OLD.status = 'published' THEN
        IF NEW.status NOT IN ('published','retired') THEN
          RAISE EXCEPTION 'A2-2: 已发布参数规范版本不可变更状态（仅可失效为 retired）';
        END IF;
        IF NEW.status = 'published' AND (
             NEW.product_family_id IS DISTINCT FROM OLD.product_family_id
             OR NEW.name IS DISTINCT FROM OLD.name
             OR NEW.version IS DISTINCT FROM OLD.version
             OR NEW.parameters IS DISTINCT FROM OLD.parameters
             OR NEW.remark IS DISTINCT FROM OLD.remark) THEN
          RAISE EXCEPTION 'A2-2: 已发布参数规范版本内容不可修改（发布后冻结，变更须生成新版本）';
        END IF;
      END IF;
      IF OLD.status = 'retired' THEN
        RAISE EXCEPTION 'A2-2: 已失效参数规范版本为终态，不可修改';
      END IF;
      RETURN COALESCE(NEW, OLD);
    END;
    $$ LANGUAGE plpgsql;
    CREATE TRIGGER parameter_spec_freeze_guard
      BEFORE UPDATE OR DELETE ON parameter_spec_revision
      FOR EACH ROW EXECUTE FUNCTION cadenza_parameter_spec_freeze_guard();

    -- ============ 生产订单（生产订单 PRD §1.1/§1.2 + DM §5） ============
    -- 主状态轴 approved(已核准)→released(允许开工)→in_progress(进行中)→pending_completion(完工待核,
    -- DM §5 显式新增)→closed(已结束)；voided(已作废)在 CHECK 值域内但不构成轴（独立）；
    -- suspended(是否挂起)为独立布尔开关；ERP 商业关闭与 MOM 执行完成分离（erp_closed_at/by 独立列）。
    CREATE TABLE production_order (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      enterprise_id uuid NOT NULL REFERENCES org_node (id) ON DELETE RESTRICT,
      plant_id uuid NOT NULL REFERENCES org_node (id) ON DELETE RESTRICT,
      order_no text NOT NULL CHECK (order_no <> ''),
      order_type text,
      sales_contract_no text,
      sales_order_no text,
      line_no text,
      material_id uuid NOT NULL REFERENCES material (id) ON DELETE RESTRICT,
      material_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
      product_family_id uuid REFERENCES product_family (id) ON DELETE RESTRICT,
      production_dept_id uuid NOT NULL REFERENCES org_node (id) ON DELETE RESTRICT,
      production_qty numeric(16,4) NOT NULL CHECK (production_qty > 0),
      uom text NOT NULL CHECK (uom <> ''),
      overrun_ratio numeric(9,4) CHECK (overrun_ratio IS NULL OR overrun_ratio >= 0),
      order_status text NOT NULL DEFAULT 'approved'
        CHECK (order_status IN ('approved','released','in_progress','pending_completion','closed','voided')),
      process_config_status text NOT NULL DEFAULT 'unconfigured'
        CHECK (process_config_status IN ('unconfigured','configured')),
      process_confirmed_at timestamptz,
      suspended boolean NOT NULL DEFAULT false,
      suspended_reason text,
      actual_start_at timestamptz,
      actual_finish_at timestamptz,
      business_closed_at timestamptz,
      erp_closed_at timestamptz,
      erp_closed_by text,
      bom_revision_id uuid REFERENCES manufacturing_bom_revision (id) ON DELETE RESTRICT,
      route_revision_id uuid REFERENCES route_revision (id) ON DELETE RESTRICT,
      current_settings_version integer NOT NULL DEFAULT 1 CHECK (current_settings_version >= 1),
      planned_start_at timestamptz,
      planned_finish_at timestamptz,
      segment_requirement text,
      remark text,
      created_at timestamptz NOT NULL DEFAULT now(),
      created_by text,
      updated_at timestamptz NOT NULL DEFAULT now(),
      updated_by text,
      CONSTRAINT production_order_no_unique UNIQUE (enterprise_id, order_no)
    );
    CREATE INDEX production_order_plant_status_idx ON production_order (plant_id, order_status);
    CREATE INDEX production_order_plant_idx ON production_order (plant_id);

    -- ============ 订单工序（快照冻结 + 变更版本预留结构） ============
    -- 快照列：operation_name/code、work_center_id/code/name、uom、core_multiple/strand_factor/offline_qty
    -- 均为接收时冻结值（底稿 A2：BOM、路线、系数、换算等下达时快照；模板后改不影响已接订单）。
    -- settings_version + execution_status 为 S04 变更版本预留：已有报工后改系数 → 新版本行只覆盖
    -- 未执行任务，已执行行保留原版本（execution_status 由报工域置位，本块无置位路径，默认 pending）。
    CREATE TABLE order_operation (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      enterprise_id uuid NOT NULL REFERENCES org_node (id) ON DELETE RESTRICT,
      plant_id uuid NOT NULL REFERENCES org_node (id) ON DELETE RESTRICT,
      order_id uuid NOT NULL REFERENCES production_order (id) ON DELETE RESTRICT,
      seq integer NOT NULL CHECK (seq >= 1),
      settings_version integer NOT NULL DEFAULT 1 CHECK (settings_version >= 1),
      execution_status text NOT NULL DEFAULT 'pending' CHECK (execution_status IN ('pending','executed')),
      operation_definition_id uuid NOT NULL REFERENCES operation_definition (id) ON DELETE RESTRICT,
      operation_code text NOT NULL CHECK (operation_code <> ''),
      operation_name text NOT NULL CHECK (operation_name <> ''),
      operation_remark text CHECK (operation_remark IS NULL OR length(operation_remark) <= 10),
      core_multiple integer NOT NULL DEFAULT 1 CHECK (core_multiple >= 1),
      strand_factor numeric(9,4) CHECK (strand_factor IS NULL OR strand_factor > 0),
      offline_qty numeric(16,4) NOT NULL CHECK (offline_qty >= 0),
      work_center_id uuid NOT NULL REFERENCES work_center (id) ON DELETE RESTRICT,
      work_center_code text NOT NULL CHECK (work_center_code <> ''),
      work_center_name text NOT NULL CHECK (work_center_name <> ''),
      uom text NOT NULL CHECK (uom <> ''),
      production_dept_id uuid NOT NULL REFERENCES org_node (id) ON DELETE RESTRICT,
      -- 路线版本引用（接收时冻结；入站载荷显式给工序而无路线时为空）
      route_revision_id uuid REFERENCES route_revision (id) ON DELETE RESTRICT,
      bom_revision_id uuid REFERENCES manufacturing_bom_revision (id) ON DELETE RESTRICT,
      created_at timestamptz NOT NULL DEFAULT now(),
      created_by text,
      updated_at timestamptz NOT NULL DEFAULT now(),
      updated_by text,
      CONSTRAINT order_operation_order_seq_version_unique UNIQUE (order_id, seq, settings_version)
    );
    CREATE INDEX order_operation_order_idx ON order_operation (order_id);
    CREATE INDEX order_operation_definition_idx ON order_operation (operation_definition_id);
  `,
  down: /* sql */ `
    DROP TABLE IF EXISTS order_operation;
    DROP TABLE IF EXISTS production_order;
    DROP TRIGGER IF EXISTS parameter_spec_freeze_guard ON parameter_spec_revision;
    DROP FUNCTION IF EXISTS cadenza_parameter_spec_freeze_guard();
    DROP TABLE IF EXISTS parameter_spec_revision;
    DROP TABLE IF EXISTS operation_definition;
    DROP TRIGGER IF EXISTS route_revision_freeze_guard ON route_revision;
    DROP FUNCTION IF EXISTS cadenza_route_revision_freeze_guard();
    DROP TABLE IF EXISTS route_revision;
    DROP TRIGGER IF EXISTS bom_revision_freeze_guard ON manufacturing_bom_revision;
    DROP FUNCTION IF EXISTS cadenza_bom_revision_freeze_guard();
    DROP TABLE IF EXISTS manufacturing_bom_revision;
    DROP TABLE IF EXISTS product_family;
  `,
}
