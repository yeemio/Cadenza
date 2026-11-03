import type { Migration } from './index'

/**
 * 0020 能源与制造成本迁移（P3-D / T24，WorkItem 指派；**不注册共享 registry**——
 * 本文件由 L0 整合步统一并入 migrations/registry.ts，测试侧以编程方式 migrateUp 单独应用
 * （独立库 cadenza_p3d，与共享 dev 库及并行 writer 的 0011–0019/0021 无表名/迁移号冲突）。
 *
 * 依据：冻结合同 architecture/contracts/frozen/p3/cost-energy.md（CE-01～CE-20 +
 * CE-S1～CE-S5；CA-12/CA-13 为 PROPOSED 依赖——按合同默认口径落列并显式登记）。
 *
 * 表（9）：
 * - cost_meter [CE-S3]：能源表计配置（类型电/水/气、覆盖范围设备/车间、采样来源 OT 点位/
 *   人工、单位；(plant, code) active 唯一）；
 * - cost_meter_reading [CE-05/CE-09]：表计读数事实（人工抄表读数+OT 样本引用固化；
 *   append-only——读数为事实，纠正走新读数）；
 * - cost_allocation_version [CE-S2/CE-11/12]：分摊规则版本（公式枚举 machine_hours/
 *   output_qty/power_weight+参数；(plant, version) 唯一；**被归集引用后 immutable**）；
 * - cost_price_version / cost_price_item [CE-14]：材料价格版本与行（来源枚举标准成本/
 *   ERP 实际价；价格主权归上游只引用标版本；同料品一行；被引用后 immutable）；
 * - cost_acquisition_run [CE-S1/11/17/19]：归集产出头（绑定 分摊版本+价格版本+数据截止时点
 *   +班次日期/班次日历引用+班次快照锚〔消费 0016 shift_snapshot，CE-19〕；估算/实测两列
 *   并存〔CE-17，缺价/缺项为 NULL 不出假值〕；能源实测/估算用量与覆盖率〔CE-09〕；
 *   CA-12 工时主源/CA-13 设备成本口径显式落列；重算=新 run 挂 recalc_of+新旧对照 jsonb
 *   〔CE-11〕；append-only——历史报表不随新版本静默重算）；
 * - cost_acquisition_line [CE-S1/03/05/07/15]：归集明细（源事实表+源事实 ID 非空〔回算路径
 *   CE-15〕、实测/估算标志、理论/实耗/损耗分列+去向缺口标注〔CE-07〕、价格缺失行
 *   price_missing+amount NULL〔CE-14 不得填默认价〕；append-only）；
 * - cost_recon_item [CE-S5/CE-16]：ERP 对账差异清单（双侧数量+差异+处置状态三态；
 *   **DELETE 恒拒**——未处置不得清零；UPDATE 仅允许处置列，事实列不可改）；
 * - cost_labor_check [CA-12·PROPOSED]：工时核对提示（报工主源 vs OT 参考源偏差超阈值
 *   生成 open 提示，不改写报工；UPDATE 仅允许确认列）。
 *
 * 外键：equipment/work_center（0003）、ot_point/ot_sample（0017）、shift_calendar（0002）、
 * production_order/order_operation/product_family（0005）——0020 在版本序上晚于上述迁移，
 * 注册链全量应用时顺序成立；测试侧 0015/0016/0017 程序式先行应用。守卫函数名独立
 * cadenza_cost_fact_guard / cadenza_cost_version_ref_guard / cadenza_cost_recon_guard /
 * cadenza_cost_labor_check_guard（与既有触发器互不误伤）。
 */
export const migration0020: Migration = {
  version: '0020',
  name: 'cost-energy',
  up: /* sql */ `
    -- ============ 守卫：归集/读数/明细事实 append-only（CE-02/CE-11：事实与历史产出不可改删） ============
    CREATE FUNCTION cadenza_cost_fact_guard() RETURNS trigger AS $$
    BEGIN
      RAISE EXCEPTION '[CE-02] 表 % 为归集事实：禁止 %（纠正走新读数/新归集产出，重算走显式命令新 run）',
        TG_TABLE_NAME, TG_OP;
    END;
    $$ LANGUAGE plpgsql;

    -- ============ 能源表计配置（CE-S3） ============
    CREATE TABLE cost_meter (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      meter_code text NOT NULL CHECK (meter_code <> '' AND length(meter_code) <= 64),
      meter_name text,
      energy_type text NOT NULL CHECK (energy_type IN ('electric','water','gas')),
      coverage_kind text NOT NULL CHECK (coverage_kind IN ('equipment','workshop')),
      equipment_id uuid REFERENCES equipment (id) ON DELETE RESTRICT,
      work_center_id uuid REFERENCES work_center (id) ON DELETE RESTRICT,
      sample_source text NOT NULL CHECK (sample_source IN ('ot','manual')),
      ot_point_id uuid REFERENCES ot_point (id) ON DELETE RESTRICT,
      uom_code text NOT NULL CHECK (uom_code <> ''),
      status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','retired')),
      remark text,
      enterprise_id uuid NOT NULL REFERENCES org_node (id) ON DELETE RESTRICT,
      plant_id uuid NOT NULL REFERENCES org_node (id) ON DELETE RESTRICT,
      business_time timestamptz NOT NULL DEFAULT now(),
      command_receipt_id uuid REFERENCES command_receipt (id) ON DELETE RESTRICT,
      created_at timestamptz NOT NULL DEFAULT now(),
      created_by text,
      updated_at timestamptz NOT NULL DEFAULT now(),
      updated_by text,
      -- CE-S3：覆盖范围与目标成对；采样来源与 OT 点位成对（人工不得绑点位防双源混读）
      CONSTRAINT cost_meter_coverage_shape CHECK (
        (coverage_kind = 'equipment' AND equipment_id IS NOT NULL AND work_center_id IS NULL)
        OR (coverage_kind = 'workshop' AND work_center_id IS NOT NULL AND equipment_id IS NULL)
      ),
      CONSTRAINT cost_meter_sample_shape CHECK (
        (sample_source = 'ot' AND ot_point_id IS NOT NULL)
        OR (sample_source = 'manual' AND ot_point_id IS NULL)
      )
    );
    CREATE UNIQUE INDEX cost_meter_plant_code_active_uidx ON cost_meter (plant_id, meter_code) WHERE status = 'active';
    CREATE INDEX cost_meter_plant_idx ON cost_meter (plant_id) WHERE status = 'active';
    CREATE INDEX cost_meter_equipment_idx ON cost_meter (equipment_id) WHERE status = 'active';

    -- ============ 表计读数事实（CE-05/CE-09；append-only） ============
    CREATE TABLE cost_meter_reading (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      meter_id uuid NOT NULL REFERENCES cost_meter (id) ON DELETE RESTRICT,
      reading_type text NOT NULL CHECK (reading_type IN ('manual','ot')),
      reading numeric(18,4) NOT NULL CHECK (reading >= 0),
      read_at timestamptz NOT NULL,
      read_by text,
      ot_sample_id uuid REFERENCES ot_sample (id) ON DELETE RESTRICT,
      captured_event_time timestamptz,
      enterprise_id uuid NOT NULL REFERENCES org_node (id) ON DELETE RESTRICT,
      plant_id uuid NOT NULL REFERENCES org_node (id) ON DELETE RESTRICT,
      business_time timestamptz NOT NULL DEFAULT now(),
      command_receipt_id uuid REFERENCES command_receipt (id) ON DELETE RESTRICT,
      created_at timestamptz NOT NULL DEFAULT now(),
      created_by text,
      CONSTRAINT cost_meter_reading_shape CHECK (
        (reading_type = 'manual' AND read_by IS NOT NULL AND ot_sample_id IS NULL)
        OR (reading_type = 'ot' AND ot_sample_id IS NOT NULL AND captured_event_time IS NOT NULL)
      )
    );
    -- 同表计同抄表时点幂等；OT 来源同样本不重复固化
    CREATE UNIQUE INDEX cost_meter_reading_manual_uidx ON cost_meter_reading (meter_id, read_at) WHERE reading_type = 'manual';
    CREATE UNIQUE INDEX cost_meter_reading_ot_uidx ON cost_meter_reading (meter_id, ot_sample_id) WHERE reading_type = 'ot';
    CREATE INDEX cost_meter_reading_meter_time_idx ON cost_meter_reading (meter_id, read_at);
    CREATE TRIGGER cost_meter_reading_fact_guard
      BEFORE UPDATE OR DELETE ON cost_meter_reading
      FOR EACH ROW EXECUTE FUNCTION cadenza_cost_fact_guard();

    -- ============ 分摊规则版本（CE-S2/CE-11/CE-12；被引用后 immutable） ============
    CREATE TABLE cost_allocation_version (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      version_no integer NOT NULL CHECK (version_no >= 1),
      formula text NOT NULL CHECK (formula IN ('machine_hours','output_qty','power_weight')),
      params jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(params) = 'object'),
      overhead_caliber text,
      status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','retired')),
      remark text,
      enterprise_id uuid NOT NULL REFERENCES org_node (id) ON DELETE RESTRICT,
      plant_id uuid NOT NULL REFERENCES org_node (id) ON DELETE RESTRICT,
      business_time timestamptz NOT NULL DEFAULT now(),
      command_receipt_id uuid REFERENCES command_receipt (id) ON DELETE RESTRICT,
      created_at timestamptz NOT NULL DEFAULT now(),
      created_by text,
      updated_at timestamptz NOT NULL DEFAULT now(),
      updated_by text,
      CONSTRAINT cost_allocation_version_no_unique UNIQUE (plant_id, version_no)
    );

    -- ============ 材料价格版本与行（CE-14；被引用后 immutable） ============
    CREATE TABLE cost_price_version (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      version_no integer NOT NULL CHECK (version_no >= 1),
      price_source text NOT NULL CHECK (price_source IN ('standard_cost','erp_actual')),
      status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','retired')),
      remark text,
      enterprise_id uuid NOT NULL REFERENCES org_node (id) ON DELETE RESTRICT,
      plant_id uuid NOT NULL REFERENCES org_node (id) ON DELETE RESTRICT,
      business_time timestamptz NOT NULL DEFAULT now(),
      command_receipt_id uuid REFERENCES command_receipt (id) ON DELETE RESTRICT,
      created_at timestamptz NOT NULL DEFAULT now(),
      created_by text,
      updated_at timestamptz NOT NULL DEFAULT now(),
      updated_by text,
      CONSTRAINT cost_price_version_no_unique UNIQUE (plant_id, version_no)
    );
    CREATE TABLE cost_price_item (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      price_version_id uuid NOT NULL REFERENCES cost_price_version (id) ON DELETE RESTRICT,
      material_id uuid REFERENCES material (id) ON DELETE RESTRICT,
      material_code text NOT NULL CHECK (material_code <> ''),
      unit_price numeric(18,6) NOT NULL CHECK (unit_price > 0),
      uom_code text NOT NULL CHECK (uom_code <> ''),
      created_at timestamptz NOT NULL DEFAULT now(),
      created_by text,
      CONSTRAINT cost_price_item_material_unique UNIQUE (price_version_id, material_code)
    );
    CREATE INDEX cost_price_item_version_idx ON cost_price_item (price_version_id);

    -- CE-S2/CE-14：被归集引用后 immutable（未引用行允许修订；引用后只能换新版本）
    CREATE FUNCTION cadenza_cost_version_ref_guard() RETURNS trigger AS $$
    DECLARE
      v_ref_count integer;
    BEGIN
      IF TG_TABLE_NAME = 'cost_price_item' THEN
        SELECT count(*) INTO v_ref_count FROM cost_acquisition_run r
          JOIN cost_price_version v ON v.id = r.price_version_id
          WHERE v.id = OLD.price_version_id;
      ELSIF TG_TABLE_NAME = 'cost_price_version' THEN
        SELECT count(*) INTO v_ref_count FROM cost_acquisition_run r
          WHERE r.price_version_id = OLD.id;
      ELSE
        SELECT count(*) INTO v_ref_count FROM cost_acquisition_run r
          WHERE r.allocation_version_id = OLD.id;
      END IF;
      IF v_ref_count > 0 THEN
        RAISE EXCEPTION '[CE-S2] 分摊/价格版本已被归集产出引用，immutable：禁止 %（变更须新建版本并显式重算）',
          TG_OP;
      END IF;
      RETURN COALESCE(NEW, OLD);
    END;
    $$ LANGUAGE plpgsql;
    CREATE TRIGGER cost_allocation_version_ref_guard
      BEFORE UPDATE OR DELETE ON cost_allocation_version
      FOR EACH ROW EXECUTE FUNCTION cadenza_cost_version_ref_guard();
    CREATE TRIGGER cost_price_version_ref_guard
      BEFORE UPDATE OR DELETE ON cost_price_version
      FOR EACH ROW EXECUTE FUNCTION cadenza_cost_version_ref_guard();
    CREATE TRIGGER cost_price_item_ref_guard
      BEFORE UPDATE OR DELETE ON cost_price_item
      FOR EACH ROW EXECUTE FUNCTION cadenza_cost_version_ref_guard();

    -- ============ 归集产出头（CE-S1/11/17/19 + CA-12/13 口径落列；append-only） ============
    CREATE TABLE cost_acquisition_run (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      run_no text NOT NULL CHECK (run_no <> ''),
      order_id uuid NOT NULL REFERENCES production_order (id) ON DELETE RESTRICT,
      allocation_version_id uuid NOT NULL REFERENCES cost_allocation_version (id) ON DELETE RESTRICT,
      price_version_id uuid NOT NULL REFERENCES cost_price_version (id) ON DELETE RESTRICT,
      shift_date date NOT NULL,
      shift_calendar_id uuid NOT NULL REFERENCES shift_calendar (id) ON DELETE RESTRICT,
      data_cutoff_at timestamptz NOT NULL,
      -- CE-19：班次快照锚（消费 0016 shift_snapshot 的窗口内快照统计；null=无快照行=快照缺项）
      shift_snapshot_anchor jsonb,
      -- CE-17：订单级估算/实测两列并存（缺价/缺项为 NULL，不以估算冒充实测 CE-03）
      estimate_amount numeric(18,4),
      actual_amount numeric(18,4),
      estimate_possible boolean NOT NULL DEFAULT true,
      estimate_missing_reason text,
      -- CE-09：能源实测/估算用量与覆盖率（覆盖率 NULL=总用量零，不可除）
      energy_metered_usage numeric(18,4) NOT NULL DEFAULT 0,
      energy_estimated_usage numeric(18,4) NOT NULL DEFAULT 0,
      energy_coverage_ratio numeric(9,4),
      energy_uom_code text,
      -- 机时（分摊基与设备运行占用口径的量化）
      machine_hours numeric(18,4) NOT NULL DEFAULT 0,
      -- CA-12（PROPOSED 默认）：工时主源=labor_record（OT 仅参考源，见 cost_labor_check）
      labor_source text NOT NULL DEFAULT 'labor_record',
      -- CA-13（PROPOSED 默认）：设备成本=机时+备件消耗，不含折旧
      equipment_cost_caliber text NOT NULL DEFAULT 'runtime_hours_plus_spare_parts_excluding_depreciation',
      -- CE-11：显式重算=新 run 挂 recalc_of + 新旧对照（历史 run 不动）
      recalc_of uuid REFERENCES cost_acquisition_run (id) ON DELETE RESTRICT,
      old_new_comparison jsonb,
      enterprise_id uuid NOT NULL REFERENCES org_node (id) ON DELETE RESTRICT,
      plant_id uuid NOT NULL REFERENCES org_node (id) ON DELETE RESTRICT,
      business_time timestamptz NOT NULL DEFAULT now(),
      command_receipt_id uuid NOT NULL REFERENCES command_receipt (id) ON DELETE RESTRICT,
      created_at timestamptz NOT NULL DEFAULT now(),
      created_by text,
      CONSTRAINT cost_acquisition_run_no_unique UNIQUE (run_no)
    );
    CREATE INDEX cost_acquisition_run_order_idx ON cost_acquisition_run (order_id, created_at DESC);
    CREATE INDEX cost_acquisition_run_plant_shift_idx ON cost_acquisition_run (plant_id, shift_date DESC);
    CREATE INDEX cost_acquisition_run_allocation_idx ON cost_acquisition_run (allocation_version_id);
    CREATE INDEX cost_acquisition_run_price_idx ON cost_acquisition_run (price_version_id);
    CREATE TRIGGER cost_acquisition_run_fact_guard
      BEFORE UPDATE OR DELETE ON cost_acquisition_run
      FOR EACH ROW EXECUTE FUNCTION cadenza_cost_fact_guard();

    -- ============ 归集明细（CE-S1/03/05/07/15；append-only） ============
    CREATE TABLE cost_acquisition_line (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      run_id uuid NOT NULL REFERENCES cost_acquisition_run (id) ON DELETE RESTRICT,
      line_no integer NOT NULL CHECK (line_no >= 1),
      source_kind text NOT NULL CHECK (source_kind IN ('material','labor','scrap','equipment_runtime','spare_part','energy')),
      source_table text NOT NULL CHECK (source_table <> ''),
      source_fact_id uuid NOT NULL,
      value_flag text NOT NULL CHECK (value_flag IN ('measured','estimated')),
      order_id uuid NOT NULL REFERENCES production_order (id) ON DELETE RESTRICT,
      order_operation_id uuid REFERENCES order_operation (id) ON DELETE RESTRICT,
      product_family_id uuid REFERENCES product_family (id) ON DELETE RESTRICT,
      quantity numeric(18,4) NOT NULL CHECK (quantity >= 0),
      uom_code text NOT NULL CHECK (uom_code <> ''),
      -- CE-07：理论/实耗分列（理论=BOM×计划数量；实耗=material_consumption）与损耗/去向
      theoretical_quantity numeric(18,4),
      variance_quantity numeric(18,4),
      destination_breakdown_missing boolean NOT NULL DEFAULT false,
      -- CE-14：缺价行 amount=NULL+price_missing=true（数量列示+缺价标注，不得填默认价）
      unit_price numeric(18,6),
      price_missing boolean NOT NULL DEFAULT false,
      amount numeric(18,4),
      facts jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(facts) = 'object'),
      created_at timestamptz NOT NULL DEFAULT now(),
      created_by text,
      CONSTRAINT cost_acquisition_line_no_unique UNIQUE (run_id, line_no),
      -- CE-S1：源事实可回算（事实表名在域规则 SOURCE_TABLES 枚举内，应用层校验；
      -- source_fact_id 非空由列约束承担；设备运行来源=ot_sample（CE-05/OT-26），
      -- execution_session 仅作订单-设备占用关系、不作运行量来源）
      CONSTRAINT cost_acquisition_line_source_table_shape CHECK (
        source_table IN ('material_consumption','labor_record','report_output','ot_sample','spare_part_usage','cost_meter_reading')
      )
    );
    CREATE INDEX cost_acquisition_line_run_idx ON cost_acquisition_line (run_id);
    CREATE INDEX cost_acquisition_line_order_kind_idx ON cost_acquisition_line (order_id, source_kind);
    CREATE INDEX cost_acquisition_line_fact_idx ON cost_acquisition_line (source_table, source_fact_id);
    CREATE TRIGGER cost_acquisition_line_fact_guard
      BEFORE UPDATE OR DELETE ON cost_acquisition_line
      FOR EACH ROW EXECUTE FUNCTION cadenza_cost_fact_guard();

    -- ============ ERP 对账差异清单（CE-S5/CE-16） ============
    CREATE TABLE cost_recon_item (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      recon_key text NOT NULL CHECK (recon_key <> ''),
      run_id uuid NOT NULL REFERENCES cost_acquisition_run (id) ON DELETE RESTRICT,
      kind text NOT NULL CHECK (kind IN ('material','labor','energy')),
      local_quantity numeric(18,4) NOT NULL CHECK (local_quantity >= 0),
      erp_quantity numeric(18,4) NOT NULL CHECK (erp_quantity >= 0),
      diff_quantity numeric(18,4) NOT NULL,
      uom_code text NOT NULL CHECK (uom_code <> ''),
      material_code text,
      order_no text,
      erp_document_ref text,
      disposition_status text NOT NULL DEFAULT 'open'
        CHECK (disposition_status IN ('open','confirmed','adjusted')),
      disposed_by text,
      disposed_at timestamptz,
      disposition_reason text,
      enterprise_id uuid NOT NULL REFERENCES org_node (id) ON DELETE RESTRICT,
      plant_id uuid NOT NULL REFERENCES org_node (id) ON DELETE RESTRICT,
      business_time timestamptz NOT NULL DEFAULT now(),
      command_receipt_id uuid NOT NULL REFERENCES command_receipt (id) ON DELETE RESTRICT,
      created_at timestamptz NOT NULL DEFAULT now(),
      created_by text,
      updated_at timestamptz NOT NULL DEFAULT now(),
      updated_by text,
      -- 同键幂等（同 run 同维度同料品只一行；ERP 重推走处置列留痕不重复建）
      CONSTRAINT cost_recon_item_key_unique UNIQUE (recon_key)
    );
    CREATE INDEX cost_recon_item_run_idx ON cost_recon_item (run_id);
    CREATE INDEX cost_recon_item_plant_status_idx ON cost_recon_item (plant_id, disposition_status);
    -- CE-S5：DELETE 恒拒（未处置不得清零；差异吸收以 adjusted+理由留痕）；UPDATE 仅处置列
    CREATE FUNCTION cadenza_cost_recon_guard() RETURNS trigger AS $$
    BEGIN
      IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION '[CE-S5] 对账差异清单不得删除（未处置不得清零；差异吸收以 adjusted+处置理由留痕）';
      END IF;
      IF NEW.recon_key IS DISTINCT FROM OLD.recon_key
        OR NEW.run_id IS DISTINCT FROM OLD.run_id
        OR NEW.kind IS DISTINCT FROM OLD.kind
        OR NEW.local_quantity IS DISTINCT FROM OLD.local_quantity
        OR NEW.erp_quantity IS DISTINCT FROM OLD.erp_quantity
        OR NEW.diff_quantity IS DISTINCT FROM OLD.diff_quantity
        OR NEW.uom_code IS DISTINCT FROM OLD.uom_code
        OR NEW.material_code IS DISTINCT FROM OLD.material_code
        OR NEW.order_no IS DISTINCT FROM OLD.order_no
        OR NEW.disposition_status = 'open' AND OLD.disposition_status <> 'open' THEN
        RAISE EXCEPTION '[CE-S5] 对账差异行事实列不可修改（仅处置列可流转：disposition_status/disposed_by/disposed_at/disposition_reason/erp_document_ref）';
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
    CREATE TRIGGER cost_recon_item_guard
      BEFORE UPDATE OR DELETE ON cost_recon_item
      FOR EACH ROW EXECUTE FUNCTION cadenza_cost_recon_guard();

    -- ============ 工时核对提示（CA-12·PROPOSED 默认口径；主从：不改写报工） ============
    CREATE TABLE cost_labor_check (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      order_id uuid NOT NULL REFERENCES production_order (id) ON DELETE RESTRICT,
      operation_key text NOT NULL DEFAULT '',
      order_operation_id uuid REFERENCES order_operation (id) ON DELETE RESTRICT,
      shift_date date NOT NULL,
      labor_hours numeric(8,2) NOT NULL CHECK (labor_hours > 0),
      ot_runtime_hours numeric(8,2),
      deviation_ratio numeric(9,4),
      threshold_ratio numeric(9,4) NOT NULL,
      status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','acknowledged')),
      missing_side text CHECK (missing_side IS NULL OR missing_side IN ('labor','ot')),
      acknowledged_by text,
      acknowledged_at timestamptz,
      reason text,
      enterprise_id uuid NOT NULL REFERENCES org_node (id) ON DELETE RESTRICT,
      plant_id uuid NOT NULL REFERENCES org_node (id) ON DELETE RESTRICT,
      business_time timestamptz NOT NULL DEFAULT now(),
      command_receipt_id uuid NOT NULL REFERENCES command_receipt (id) ON DELETE RESTRICT,
      created_at timestamptz NOT NULL DEFAULT now(),
      created_by text,
      updated_at timestamptz NOT NULL DEFAULT now(),
      updated_by text,
      -- 同订单同工序同班次至多一行（重跑核对不重复建，open 行保留）
      CONSTRAINT cost_labor_check_key_unique UNIQUE (order_id, operation_key, shift_date)
    );
    CREATE INDEX cost_labor_check_plant_status_idx ON cost_labor_check (plant_id, status);
    -- CA-12：核对行事实不可改；仅确认列可流转；不删除（提示留痕）
    CREATE FUNCTION cadenza_cost_labor_check_guard() RETURNS trigger AS $$
    BEGIN
      IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION '[CA-12] 工时核对提示不得删除（核对留痕；主从口径下永不改写报工工时）';
      END IF;
      IF NEW.order_id IS DISTINCT FROM OLD.order_id
        OR NEW.operation_key IS DISTINCT FROM OLD.operation_key
        OR NEW.shift_date IS DISTINCT FROM OLD.shift_date
        OR NEW.labor_hours IS DISTINCT FROM OLD.labor_hours
        OR NEW.ot_runtime_hours IS DISTINCT FROM OLD.ot_runtime_hours
        OR NEW.deviation_ratio IS DISTINCT FROM OLD.deviation_ratio THEN
        RAISE EXCEPTION '[CA-12] 工时核对行事实列不可修改（仅确认列可流转：status/acknowledged_by/acknowledged_at/reason）';
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
    CREATE TRIGGER cost_labor_check_guard
      BEFORE UPDATE OR DELETE ON cost_labor_check
      FOR EACH ROW EXECUTE FUNCTION cadenza_cost_labor_check_guard();
  `,
  down: /* sql */ `
    DROP TRIGGER IF EXISTS cost_labor_check_guard ON cost_labor_check;
    DROP FUNCTION IF EXISTS cadenza_cost_labor_check_guard();
    DROP TABLE IF EXISTS cost_labor_check;
    DROP TRIGGER IF EXISTS cost_recon_item_guard ON cost_recon_item;
    DROP FUNCTION IF EXISTS cadenza_cost_recon_guard();
    DROP TABLE IF EXISTS cost_recon_item;
    DROP TRIGGER IF EXISTS cost_acquisition_line_fact_guard ON cost_acquisition_line;
    DROP TABLE IF EXISTS cost_acquisition_line;
    DROP TRIGGER IF EXISTS cost_acquisition_run_fact_guard ON cost_acquisition_run;
    DROP TABLE IF EXISTS cost_acquisition_run;
    DROP TRIGGER IF EXISTS cost_price_item_ref_guard ON cost_price_item;
    DROP TRIGGER IF EXISTS cost_price_version_ref_guard ON cost_price_version;
    DROP TRIGGER IF EXISTS cost_allocation_version_ref_guard ON cost_allocation_version;
    DROP FUNCTION IF EXISTS cadenza_cost_version_ref_guard();
    DROP TABLE IF EXISTS cost_price_item;
    DROP TABLE IF EXISTS cost_price_version;
    DROP TABLE IF EXISTS cost_allocation_version;
    DROP TRIGGER IF EXISTS cost_meter_reading_fact_guard ON cost_meter_reading;
    DROP TABLE IF EXISTS cost_meter_reading;
    DROP TABLE IF EXISTS cost_meter;
    DROP FUNCTION IF EXISTS cadenza_cost_fact_guard();
  `,
}
