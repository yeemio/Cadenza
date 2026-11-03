import type { Migration } from './index'

/**
 * 0003 工厂主数据迁移（L1-P1-SERVER T04 主数据块）。
 *
 * 依据冻结合合 architecture/contracts/frozen/p1/master-data.md：
 * - MD-S1 material：(org_scope, code) 唯一（partial, where active）＝MD-03 料品同组织内编号唯一；
 * - MD-S2 conversion_revision：版本子表 + referenced 行禁改禁删（触发器等价机制，MD-05）；
 * - MD-S3 equipment：code 全局唯一、name 全局唯一（partial, where active）；状态流水表 append-only（触发器）；
 * - MD-S4 work_center：code 全局唯一 + (dept_id, name) 唯一（均 partial, where active）；
 * - MD-S5 external_mapping 对照表唯一键：0002 已建（五元组唯一 ⊇ (ERP 工作中心编码, 组织编码)），本迁移不重复建表；
 * - MD-S6 warehouse/rack/storage_location：(plant_id, code) 各自唯一（partial, where active）；warehouse.name 全局唯一；
 * - MD-S7 全部主数据表：FK ON DELETE RESTRICT + status(active/retired) 状态列 + deleted_at；
 *   被库存余额/流水引用拒退役由命令层校验（MD-37，见 application masterdata-handlers）。
 * - MD-36 逻辑删除：全部主数据表带 status + deleted_at，不物理删行；retire 不级联删业务历史（MD-35）。
 * - MD-31/32 货架自动生成：区域码 = 货架号(2)+区域序号(2)；货架库位码 = 货架号(2)+区域序号(2)+层号(2)；
 *   普通库位码 = 仓库码(4)+库位码(4)（MD-28）；区域完整码 = 工厂编码 + 区域编码（域函数计算，无区域表）。
 *
 * 注意：本迁移文件在 L0 整合步统一注册进 registry.ts 前不随 `pnpm db:migrate:up` 应用；
 * 主数据测试以 migrateUp(pool, [...migrations, migration0003]) 在独立库（cadenza_md）应用，
 * 避免与注册表推导的既有迁移往返测试（packages/persistence/test）产生 drift 冲突。
 */
export const migration0003: Migration = {
  version: '0003',
  name: 'master-data',
  up: /* sql */ `
    -- ============ 料品主表（MD-S1；MD-01/02/03/07） ============
    -- 由 U9/ERP 同步写入；本系统无新增/删除入口（MD-01），主表字段同步后不可本系统改（MD-02）。
    -- org_scope_id = 组织范围节点（enterprise 层，MD-03 唯一键 (org_scope, code)）。
    CREATE TABLE material (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      org_scope_id uuid NOT NULL REFERENCES org_node (id) ON DELETE RESTRICT,
      code text NOT NULL CHECK (code <> ''),
      name text NOT NULL CHECK (name <> ''),
      company_org_code text,
      material_group_code text,
      material_group_name text,
      description_zh text,
      description_en text,
      voltage text,
      standard text,
      customer text,
      material_type smallint NOT NULL CHECK (material_type IN (1,2,3)),
      spec text,
      color text,
      base_uom text NOT NULL CHECK (base_uom <> ''),
      qc_flag smallint NOT NULL DEFAULT 0 CHECK (qc_flag IN (0,1)),
      remark text,
      source_system text NOT NULL DEFAULT 'U9',
      status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','retired')),
      deleted_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      created_by text,
      updated_at timestamptz NOT NULL DEFAULT now(),
      updated_by text
    );
    -- MD-S1：(org_scope, code) 唯一（partial, where active；retired 行保留历史占用，MD-36）
    CREATE UNIQUE INDEX material_scope_code_active_uidx ON material (org_scope_id, code) WHERE status = 'active';
    CREATE INDEX material_scope_idx ON material (org_scope_id) WHERE status = 'active';

    -- ============ 单位主数据（MD-08 GAP-A6 未裁定：最小占位，主权不冒充） ============
    -- 主计量单位与本地自定义包装单位同表；is_custom 行挂 material_id（MD-06）。
    CREATE TABLE uom (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      code text NOT NULL CHECK (code <> ''),
      name text NOT NULL CHECK (name <> ''),
      is_custom boolean NOT NULL DEFAULT false,
      material_id uuid REFERENCES material (id) ON DELETE RESTRICT,
      status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','retired')),
      deleted_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      created_by text,
      updated_at timestamptz NOT NULL DEFAULT now(),
      updated_by text
    );
    -- 主单位编码全局唯一；自定义包装单位同料品内唯一（active 口径，MD-36）
    CREATE UNIQUE INDEX uom_code_active_uidx ON uom (code) WHERE status = 'active' AND NOT is_custom;
    CREATE UNIQUE INDEX uom_custom_active_uidx ON uom (material_id, code) WHERE status = 'active' AND is_custom;

    -- ============ 换算版本子表（MD-S2；MD-04/05/06） ============
    -- 一行 = 料品的一条换算行的一个版本：1 换算单位 = factor 主单位（factor 满足 MD-04）。
    -- referenced=true 表示已被采购收货引用（MD-05 immutable）。
    CREATE TABLE conversion_revision (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      material_id uuid NOT NULL REFERENCES material (id) ON DELETE RESTRICT,
      version integer NOT NULL CHECK (version >= 1),
      unit_name text NOT NULL CHECK (unit_name <> '' AND length(unit_name) <= 100),
      factor numeric(13,4) NOT NULL CHECK (factor >= 0),
      referenced boolean NOT NULL DEFAULT false,
      status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','retired')),
      deleted_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      created_by text,
      updated_at timestamptz NOT NULL DEFAULT now(),
      updated_by text,
      CONSTRAINT conversion_revision_material_version_unique UNIQUE (material_id, version)
    );
    CREATE INDEX conversion_revision_material_idx ON conversion_revision (material_id) WHERE status = 'active';

    -- MD-S2 等价机制：referenced 行禁改禁删；referenced 标志单向闩锁
    -- （仅允许 false→true 置位，供采购收货引用时落标志；不可回退）
    CREATE OR REPLACE FUNCTION cadenza_conversion_referenced_guard() RETURNS trigger AS $$
    BEGIN
      IF OLD.referenced THEN
        IF TG_OP = 'DELETE' THEN
          RAISE EXCEPTION 'MD-05: 换算行已被采购收货引用，禁止删除';
        END IF;
        IF NEW.unit_name IS DISTINCT FROM OLD.unit_name
          OR NEW.factor IS DISTINCT FROM OLD.factor
          OR NEW.material_id IS DISTINCT FROM OLD.material_id
          OR NEW.version IS DISTINCT FROM OLD.version THEN
          RAISE EXCEPTION 'MD-05: 换算行已被采购收货引用，禁止修改';
        END IF;
      END IF;
      IF NEW.referenced IS DISTINCT FROM OLD.referenced
        AND NOT (OLD.referenced = false AND NEW.referenced = true) THEN
        RAISE EXCEPTION 'MD-05: referenced 标志单向闩锁，置位后不可回退';
      END IF;
      RETURN COALESCE(NEW, OLD);
    END;
    $$ LANGUAGE plpgsql;
    CREATE TRIGGER conversion_referenced_guard
      BEFORE UPDATE OR DELETE ON conversion_revision
      FOR EACH ROW EXECUTE FUNCTION cadenza_conversion_referenced_guard();

    -- ============ 工作中心（MD-S4；MD-17/18/34） ============
    -- 工厂建模主数据；组织树中的 work_center 节点（org_node）为组织侧对象，两表并存、FK 对齐部门。
    CREATE TABLE work_center (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      enterprise_id uuid NOT NULL REFERENCES org_node (id) ON DELETE RESTRICT,
      plant_id uuid NOT NULL REFERENCES org_node (id) ON DELETE RESTRICT,
      dept_id uuid NOT NULL REFERENCES org_node (id) ON DELETE RESTRICT,
      code text NOT NULL CHECK (code <> ''),
      name text NOT NULL CHECK (name <> ''),
      status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','retired')),
      deleted_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      created_by text,
      updated_at timestamptz NOT NULL DEFAULT now(),
      updated_by text
    );
    -- MD-S4：code 全局唯一 + (dept, name) 唯一（均 active 口径）
    CREATE UNIQUE INDEX work_center_code_active_uidx ON work_center (code) WHERE status = 'active';
    CREATE UNIQUE INDEX work_center_dept_name_active_uidx ON work_center (dept_id, name) WHERE status = 'active';
    CREATE INDEX work_center_plant_idx ON work_center (plant_id) WHERE status = 'active';

    -- ============ 设备（MD-S3；MD-09~16） ============
    -- 设备码 = 'EQU-' + code（MD-15 仅大写前缀，域函数计算，不落库冗余列）。
    CREATE TABLE equipment (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      enterprise_id uuid NOT NULL REFERENCES org_node (id) ON DELETE RESTRICT,
      plant_id uuid NOT NULL REFERENCES org_node (id) ON DELETE RESTRICT,
      dept_id uuid NOT NULL REFERENCES org_node (id) ON DELETE RESTRICT,
      work_center_id uuid NOT NULL REFERENCES work_center (id) ON DELETE RESTRICT,
      code text NOT NULL CHECK (code <> '' AND length(code) <= 32),
      name text NOT NULL CHECK (name <> '' AND length(name) <= 50),
      actual_no text CHECK (actual_no IS NULL OR length(actual_no) <= 50),
      model text CHECK (model IS NULL OR length(model) <= 50),
      std_rate_text text CHECK (std_rate_text IS NULL OR length(std_rate_text) <= 50),
      equipment_status smallint NOT NULL CHECK (equipment_status IN (1,2)),
      capacity numeric(14,4) CHECK (capacity IS NULL OR capacity >= 0),
      status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','retired')),
      deleted_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      created_by text,
      updated_at timestamptz NOT NULL DEFAULT now(),
      updated_by text
    );
    -- MD-S3/MD-09：code/name 全局唯一（active 口径）
    CREATE UNIQUE INDEX equipment_code_active_uidx ON equipment (code) WHERE status = 'active';
    CREATE UNIQUE INDEX equipment_name_active_uidx ON equipment (name) WHERE status = 'active';
    CREATE INDEX equipment_plant_idx ON equipment (plant_id) WHERE status = 'active';
    CREATE INDEX equipment_work_center_idx ON equipment (work_center_id) WHERE status = 'active';

    -- MD-S3/MD-14：状态变更流水 append-only（前值/后值/来源/操作人/时间）
    CREATE TABLE equipment_status_log (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      equipment_id uuid NOT NULL REFERENCES equipment (id) ON DELETE RESTRICT,
      old_status smallint NOT NULL CHECK (old_status IN (1,2)),
      new_status smallint NOT NULL CHECK (new_status IN (1,2)),
      source text NOT NULL CHECK (source IN ('WEB','PDA')),
      actor text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX equipment_status_log_equipment_idx ON equipment_status_log (equipment_id, created_at DESC);
    -- append-only 等价机制（MD-S3）
    CREATE OR REPLACE FUNCTION cadenza_equipment_status_log_append_only() RETURNS trigger AS $$
    BEGIN
      RAISE EXCEPTION 'MD-S3: 设备状态流水表 append-only，禁止修改或删除';
    END;
    $$ LANGUAGE plpgsql;
    CREATE TRIGGER equipment_status_log_append_only
      BEFORE UPDATE OR DELETE ON equipment_status_log
      FOR EACH ROW EXECUTE FUNCTION cadenza_equipment_status_log_append_only();

    -- ============ 仓库（MD-S6；MD-22~27） ============
    CREATE TABLE warehouse (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      enterprise_id uuid NOT NULL REFERENCES org_node (id) ON DELETE RESTRICT,
      plant_id uuid NOT NULL REFERENCES org_node (id) ON DELETE RESTRICT,
      dept_id uuid NOT NULL REFERENCES org_node (id) ON DELETE RESTRICT,
      code text NOT NULL CHECK (code ~ '^[0-9]{4}$'),
      name text NOT NULL CHECK (name <> '' AND length(name) <= 20),
      warehouse_type text NOT NULL CHECK (warehouse_type IN ('WAREHOUSE','LINE_SIDE')),
      material_types integer[] NOT NULL CHECK (cardinality(material_types) >= 1),
      manager_user_id uuid REFERENCES user_account (id) ON DELETE RESTRICT,
      phone text,
      address text,
      qr_bound boolean NOT NULL DEFAULT false,
      status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','retired')),
      deleted_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      created_by text,
      updated_at timestamptz NOT NULL DEFAULT now(),
      updated_by text
    );
    -- MD-S6/MD-22：(plant, code) 唯一 + name 全局唯一（active 口径）
    CREATE UNIQUE INDEX warehouse_plant_code_active_uidx ON warehouse (plant_id, code) WHERE status = 'active';
    CREATE UNIQUE INDEX warehouse_name_active_uidx ON warehouse (name) WHERE status = 'active';
    CREATE INDEX warehouse_plant_idx ON warehouse (plant_id) WHERE status = 'active';

    -- ============ 货架（MD-S6；MD-30/31/33） ============
    -- 区域无独立表：区域随库位增删自动维护（MD-32），区域码由库位行 zone_code 派生。
    CREATE TABLE rack (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      enterprise_id uuid NOT NULL REFERENCES org_node (id) ON DELETE RESTRICT,
      plant_id uuid NOT NULL REFERENCES org_node (id) ON DELETE RESTRICT,
      warehouse_id uuid NOT NULL REFERENCES warehouse (id) ON DELETE RESTRICT,
      code text NOT NULL CHECK (code ~ '^[0-9]{2}$'),
      zones smallint NOT NULL CHECK (zones BETWEEN 1 AND 99),
      layers smallint NOT NULL CHECK (layers BETWEEN 1 AND 99),
      remark text,
      status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','retired')),
      deleted_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      created_by text,
      updated_at timestamptz NOT NULL DEFAULT now(),
      updated_by text
    );
    -- MD-S6/MD-30：(plant, code) 唯一（active 口径）
    CREATE UNIQUE INDEX rack_plant_code_active_uidx ON rack (plant_id, code) WHERE status = 'active';
    CREATE INDEX rack_warehouse_idx ON rack (warehouse_id) WHERE status = 'active';

    -- ============ 库位（MD-S6；MD-28/29/31） ============
    -- NORMAL：8 位数字 = 仓库码(4)+库位码(4)；RACK：6 位数字 = 货架号(2)+区域号(2)+层号(2)。
    CREATE TABLE storage_location (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      enterprise_id uuid NOT NULL REFERENCES org_node (id) ON DELETE RESTRICT,
      plant_id uuid NOT NULL REFERENCES org_node (id) ON DELETE RESTRICT,
      warehouse_id uuid NOT NULL REFERENCES warehouse (id) ON DELETE RESTRICT,
      rack_id uuid REFERENCES rack (id) ON DELETE RESTRICT,
      location_kind text NOT NULL CHECK (location_kind IN ('NORMAL','RACK')),
      code text NOT NULL CHECK (code ~ '^[0-9]{6}$' OR code ~ '^[0-9]{8}$'),
      zone_code text CHECK (zone_code IS NULL OR zone_code ~ '^[0-9]{4}$'),
      remark text,
      qr_bound boolean NOT NULL DEFAULT false,
      status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','retired')),
      deleted_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      created_by text,
      updated_at timestamptz NOT NULL DEFAULT now(),
      updated_by text
    );
    -- MD-S6/MD-28：(plant, code) 唯一（active 口径）
    CREATE UNIQUE INDEX storage_location_plant_code_active_uidx ON storage_location (plant_id, code) WHERE status = 'active';
    CREATE INDEX storage_location_warehouse_idx ON storage_location (warehouse_id) WHERE status = 'active';
    CREATE INDEX storage_location_rack_idx ON storage_location (rack_id) WHERE status = 'active';
  `,
  down: /* sql */ `
    DROP TABLE IF EXISTS storage_location;
    DROP TABLE IF EXISTS rack;
    DROP TABLE IF EXISTS warehouse;
    DROP TRIGGER IF EXISTS equipment_status_log_append_only ON equipment_status_log;
    DROP FUNCTION IF EXISTS cadenza_equipment_status_log_append_only();
    DROP TABLE IF EXISTS equipment_status_log;
    DROP TABLE IF EXISTS equipment;
    DROP TABLE IF EXISTS work_center;
    DROP TRIGGER IF EXISTS conversion_referenced_guard ON conversion_revision;
    DROP FUNCTION IF EXISTS cadenza_conversion_referenced_guard();
    DROP TABLE IF EXISTS conversion_revision;
    DROP TABLE IF EXISTS uom;
    DROP TABLE IF EXISTS material;
  `,
}
