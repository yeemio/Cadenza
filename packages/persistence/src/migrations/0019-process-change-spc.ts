import type { Migration } from './index'

/**
 * 0019 工艺变更影响控制 / SPC / 计量校准 / 工具寿命迁移（P3-C / T23，WorkItem 指派；
 * **不注册共享 registry**——本文件由 L0 整合步统一并入 migrations/registry.ts，
 * 测试侧以编程方式 migrateUp 单独应用（独立库 cadenza_p3c，与共享 dev 库及并行
 * writer 的 0011–0018 无表名/迁移号/守卫函数名冲突）。
 *
 * 依据：冻结合同 architecture/contracts/frozen/p3/process-change-spc-calibration.md
 * （PE-01～PE-21 业务规则 + PE-S1～PE-S5 表级约束）。
 *
 * 表（16）：
 * - spc_gauge / spc_calibration_record [PE-15/16]：器具台账 + 校准记录（append-only，
 *   器具+校准日期索引支撑失准圈定 PE-S3）；
 * - spc_rule_set [PE-09/PE-S2]：规则集版本（控制图类型+判异准则子集；发布后 immutable）；
 * - spc_control_item [PE-08]：受控项目（检验规范版本+计量型特性项冻结唯一；可选点位引用）；
 * - spc_control_limit_version [PE-10/PE-S2]：控制限版本（口径/基线组数/CL/UCL/LCL/触发；
 *   append-only——历史点位保留判定时点版本，重算走新版本行）；
 * - spc_sample [PE-11/14/16]：样本（来源/实测引用/器具+校准状态快照/工序执行实例定位/准入）；
 * - spc_point_judgement [PE-12/PE-S2]：样本判定（append-only，绑定判定时点规则集+控制限版本）；
 * - spc_ooc_task [PE-12/13]：失控处置任务（open→disposed→re_control_confirmed；
 *   质量存疑提示列——不写质量域）；
 * - spc_process_change [PE-01~05/PE-S1]：变更单（版本对/审批人/生效时间非空；
 *   工序变动清单 jsonb 供 PE-07 守卫）；
 * - spc_change_impact [PE-03/04/06]：影响任务清单（分类/已排产标记/逐单处置结论/遵循版本）；
 * - spc_change_adjustment [PE-03]：调整指令（append-only；计划量重算留痕，不静默重算 PE-02）；
 * - spc_miscalibration_action [PE-19]：失准逐项处置（append-only；已发运项客诉提示标记）；
 * - spc_tool_ledger / spc_tool_config / spc_tool_usage / spc_tool_adjustment
 *   [PE-20/21/PE-S5]：工具寿命台账（累计列只增）+ 版本化配置 + 累计消耗行 + 具名调整行。
 *
 * 守卫函数名独立（cadenza_spc_*，与 0004/0009/0010 触发器互不误伤）：
 * - cadenza_spc_append_guard：append-only 表拒改拒删（PE-15/PE-S2/PE-S3/PE-19/PE-S5）；
 * - cadenza_spc_rule_set_freeze_guard：规则集发布后 immutable、retired 终态（PE-S2）；
 * - cadenza_spc_change_guard：变更单仅 draft→published 状态列可推进（PE-S1）；
 * - cadenza_spc_impact_guard：影响行仅处置/重算列可改，行不可删（PE-04/06 留痕）；
 * - cadenza_spc_tool_life_guard：累计列只增 + 配置列随版本递增才可改（PE-21/PE-S5）；
 * - cadenza_spc_ooc_guard：处置任务仅处置/复控列可改，行不可删（PE-12 不得静默关闭）。
 *
 * 外键：parameter_spec_revision/production_order/order_operation（0005）、
 * quality_test_result（0009）、equipment（0003）、command_receipt（0001）、
 * org_node（0002）均已注册落地，直接 RESTRICT。
 */
export const migration0019: Migration = {
  version: '0019',
  name: 'process-change-spc',
  up: /* sql */ `
    -- ============ 守卫：append-only 事实（拒改拒删，纠正走新记录） ============
    -- 覆盖表级约束族：PE-S2（规则集引用版本/控制限版本/判定记录）、PE-S3（校准记录）、
    -- PE-S5（工具配置版本/消耗行/调整行）与 PE-03（调整指令）/PE-19（失准处置）。
    CREATE FUNCTION cadenza_spc_append_guard() RETURNS trigger AS $$
    BEGIN
      RAISE EXCEPTION '[PE-S2/PE-S3/PE-S5] 表 % 为 append-only spc 事实：禁止 %（纠正走追加新记录）',
        TG_TABLE_NAME, TG_OP;
    END;
    $$ LANGUAGE plpgsql;

    -- ============ 计量器具台账（PE-15 器具身份） ============
    CREATE TABLE spc_gauge (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      gauge_no text NOT NULL CHECK (gauge_no <> ''),
      name text NOT NULL CHECK (name <> ''),
      gauge_kind text,
      plant_id uuid NOT NULL REFERENCES org_node (id) ON DELETE RESTRICT,
      enterprise_id uuid NOT NULL REFERENCES org_node (id) ON DELETE RESTRICT,
      created_at timestamptz NOT NULL DEFAULT now(),
      created_by text,
      CONSTRAINT spc_gauge_no_unique UNIQUE (plant_id, gauge_no)
    );
    CREATE INDEX spc_gauge_plant_idx ON spc_gauge (plant_id);

    -- ============ 校准记录（PE-15/PE-S3：append-only + 圈定索引） ============
    CREATE TABLE spc_calibration_record (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      gauge_id uuid NOT NULL REFERENCES spc_gauge (id) ON DELETE RESTRICT,
      calibrated_at timestamptz NOT NULL,
      result text NOT NULL CHECK (result IN ('qualified', 'limited', 'failed')),
      certificate_no text NOT NULL CHECK (certificate_no <> ''),
      valid_until timestamptz NOT NULL,
      basis text NOT NULL CHECK (basis <> ''),
      recorded_by text,
      command_receipt_id uuid REFERENCES command_receipt (id) ON DELETE RESTRICT,
      plant_id uuid NOT NULL REFERENCES org_node (id) ON DELETE RESTRICT,
      enterprise_id uuid NOT NULL REFERENCES org_node (id) ON DELETE RESTRICT,
      business_time timestamptz NOT NULL DEFAULT now(),
      created_at timestamptz NOT NULL DEFAULT now(),
      created_by text
    );
    -- PE-S3：器具身份+校准日期索引支撑失准圈定查询
    CREATE INDEX spc_calibration_gauge_date_idx ON spc_calibration_record (gauge_id, calibrated_at DESC);
    CREATE INDEX spc_calibration_plant_idx ON spc_calibration_record (plant_id);
    CREATE TRIGGER spc_calibration_record_append_guard
      BEFORE UPDATE OR DELETE ON spc_calibration_record
      FOR EACH ROW EXECUTE FUNCTION cadenza_spc_append_guard();

    -- ============ SPC 规则集版本（PE-09/PE-S2：发布后 immutable） ============
    CREATE TABLE spc_rule_set (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      name text NOT NULL CHECK (name <> ''),
      version integer NOT NULL CHECK (version >= 1),
      chart_type text NOT NULL CHECK (chart_type IN ('xbar_r', 'i_mr', 'p')),
      criteria jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(criteria) = 'array'),
      status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'retired')),
      is_default boolean NOT NULL DEFAULT false,
      published_at timestamptz,
      published_by text,
      plant_id uuid NOT NULL REFERENCES org_node (id) ON DELETE RESTRICT,
      enterprise_id uuid NOT NULL REFERENCES org_node (id) ON DELETE RESTRICT,
      created_at timestamptz NOT NULL DEFAULT now(),
      created_by text,
      updated_at timestamptz NOT NULL DEFAULT now(),
      updated_by text,
      CONSTRAINT spc_rule_set_version_unique UNIQUE (plant_id, name, version)
    );
    CREATE INDEX spc_rule_set_plant_idx ON spc_rule_set (plant_id);
    CREATE INDEX spc_rule_set_published_idx ON spc_rule_set (plant_id, name) WHERE status = 'published';
    CREATE FUNCTION cadenza_spc_rule_set_freeze_guard() RETURNS trigger AS $$
    BEGIN
      IF OLD.status = 'published' THEN
        IF NEW.status = 'retired' THEN
          IF NEW.name IS DISTINCT FROM OLD.name OR NEW.version IS DISTINCT FROM OLD.version
             OR NEW.chart_type IS DISTINCT FROM OLD.chart_type OR NEW.criteria IS DISTINCT FROM OLD.criteria
             OR NEW.is_default IS DISTINCT FROM OLD.is_default THEN
            RAISE EXCEPTION '[PE-S2] 已发布规则集内容不可修改（版本化配置，失效只改状态）';
          END IF;
        ELSE
          RAISE EXCEPTION '[PE-S2] 已发布规则集仅可失效为 retired（不可回草稿/不可改内容）';
        END IF;
      END IF;
      IF OLD.status = 'retired' THEN
        RAISE EXCEPTION '[PE-S2] 已失效规则集为终态，不可修改';
      END IF;
      RETURN COALESCE(NEW, OLD);
    END;
    $$ LANGUAGE plpgsql;
    CREATE TRIGGER spc_rule_set_freeze_guard
      BEFORE UPDATE OR DELETE ON spc_rule_set
      FOR EACH ROW EXECUTE FUNCTION cadenza_spc_rule_set_freeze_guard();

    -- ============ 受控项目（PE-08：随检验规范版本冻结） ============
    CREATE TABLE spc_control_item (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      spec_code text NOT NULL CHECK (spec_code <> ''),
      spec_version integer NOT NULL CHECK (spec_version >= 1),
      item_no text NOT NULL CHECK (item_no <> ''),
      item_name text,
      point_ref text,
      rule_set_id uuid REFERENCES spc_rule_set (id) ON DELETE RESTRICT,
      status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'retired')),
      plant_id uuid NOT NULL REFERENCES org_node (id) ON DELETE RESTRICT,
      enterprise_id uuid NOT NULL REFERENCES org_node (id) ON DELETE RESTRICT,
      created_at timestamptz NOT NULL DEFAULT now(),
      created_by text,
      updated_at timestamptz NOT NULL DEFAULT now(),
      updated_by text,
      CONSTRAINT spc_control_item_spec_unique UNIQUE (spec_code, spec_version, item_no)
    );
    CREATE INDEX spc_control_item_plant_idx ON spc_control_item (plant_id);

    -- ============ 控制限版本（PE-10/PE-S2：append-only，重算走新版本行） ============
    CREATE TABLE spc_control_limit_version (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      control_item_id uuid NOT NULL REFERENCES spc_control_item (id) ON DELETE RESTRICT,
      version integer NOT NULL CHECK (version >= 1),
      method text NOT NULL CHECK (method IN ('mean_pm_3sigma')),
      baseline_group_count integer NOT NULL CHECK (baseline_group_count >= 2),
      cl numeric(18,6),
      ucl numeric(18,6),
      lcl numeric(18,6),
      status text NOT NULL CHECK (status IN ('building', 'active')),
      trigger_kind text NOT NULL CHECK (trigger_kind IN ('initial', 'rule_set_change', 'process_change', 'calibration_change')),
      trigger_ref text,
      rule_set_id uuid REFERENCES spc_rule_set (id) ON DELETE RESTRICT,
      enterprise_id uuid NOT NULL REFERENCES org_node (id) ON DELETE RESTRICT,
      created_at timestamptz NOT NULL DEFAULT now(),
      created_by text,
      CONSTRAINT spc_control_limit_version_unique UNIQUE (control_item_id, version),
      -- active 版本必有控制限（building 允许空）
      CONSTRAINT spc_control_limit_active_shape CHECK (status = 'building' OR (cl IS NOT NULL AND ucl IS NOT NULL AND lcl IS NOT NULL))
    );
    CREATE INDEX spc_control_limit_item_idx ON spc_control_limit_version (control_item_id);
    CREATE TRIGGER spc_control_limit_append_guard
      BEFORE UPDATE OR DELETE ON spc_control_limit_version
      FOR EACH ROW EXECUTE FUNCTION cadenza_spc_append_guard();

    -- ============ SPC 样本（PE-11/14/16：来源/器具校准快照/定位/准入） ============
    CREATE TABLE spc_sample (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      control_item_id uuid NOT NULL REFERENCES spc_control_item (id) ON DELETE RESTRICT,
      source text NOT NULL CHECK (source IN ('manual_inspection', 'collection')),
      test_result_id uuid REFERENCES quality_test_result (id) ON DELETE RESTRICT,
      measured_value numeric(18,4) NOT NULL CHECK (measured_value >= 0),
      sampled_at timestamptz NOT NULL,
      production_order_id uuid REFERENCES production_order (id) ON DELETE RESTRICT,
      order_operation_id uuid REFERENCES order_operation (id) ON DELETE RESTRICT,
      operation_seq integer,
      equipment_id uuid REFERENCES equipment (id) ON DELETE RESTRICT,
      equipment_code text,
      shift_date date,
      gauge_id uuid REFERENCES spc_gauge (id) ON DELETE RESTRICT,
      calibration_status text CHECK (calibration_status IN ('valid', 'limited', 'invalid', 'expired', 'unknown')),
      admission text NOT NULL CHECK (admission IN ('admitted', 'rejected')),
      reject_reason text CHECK (reject_reason IS NULL OR reject_reason IN
        ('bad_point', 'clock_deviation', 'calibration_suspect', 'quality_code_not_good', 'test_result_missing')),
      command_receipt_id uuid REFERENCES command_receipt (id) ON DELETE RESTRICT,
      plant_id uuid NOT NULL REFERENCES org_node (id) ON DELETE RESTRICT,
      enterprise_id uuid NOT NULL REFERENCES org_node (id) ON DELETE RESTRICT,
      business_time timestamptz NOT NULL DEFAULT now(),
      created_at timestamptz NOT NULL DEFAULT now(),
      created_by text,
      -- PE-11：被拒样本必带拒绝原因；准入样本不得带
      CONSTRAINT spc_sample_reject_shape CHECK (
        (admission = 'rejected' AND reject_reason IS NOT NULL)
        OR (admission = 'admitted' AND reject_reason IS NULL)
      )
    );
    CREATE INDEX spc_sample_item_time_idx ON spc_sample (control_item_id, sampled_at);
    CREATE INDEX spc_sample_gauge_idx ON spc_sample (gauge_id, sampled_at);
    CREATE INDEX spc_sample_plant_idx ON spc_sample (plant_id);
    CREATE TRIGGER spc_sample_append_guard
      BEFORE UPDATE OR DELETE ON spc_sample
      FOR EACH ROW EXECUTE FUNCTION cadenza_spc_append_guard();

    -- ============ 样本判定（PE-12/PE-S2：append-only，绑定判定时点版本） ============
    CREATE TABLE spc_point_judgement (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      sample_id uuid NOT NULL UNIQUE REFERENCES spc_sample (id) ON DELETE RESTRICT,
      control_item_id uuid NOT NULL REFERENCES spc_control_item (id) ON DELETE RESTRICT,
      point_no integer NOT NULL CHECK (point_no >= 1),
      verdict text NOT NULL CHECK (verdict IN ('in_control', 'out_of_control')),
      violated_codes jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(violated_codes) = 'array'),
      rule_set_id uuid REFERENCES spc_rule_set (id) ON DELETE RESTRICT,
      rule_set_version integer,
      control_limit_id uuid REFERENCES spc_control_limit_version (id) ON DELETE RESTRICT,
      control_limit_version integer,
      judged_at timestamptz NOT NULL,
      enterprise_id uuid NOT NULL REFERENCES org_node (id) ON DELETE RESTRICT,
      created_at timestamptz NOT NULL DEFAULT now(),
      created_by text,
      CONSTRAINT spc_point_judgement_no_unique UNIQUE (control_item_id, point_no)
    );
    CREATE INDEX spc_point_judgement_item_idx ON spc_point_judgement (control_item_id);
    CREATE TRIGGER spc_point_judgement_append_guard
      BEFORE UPDATE OR DELETE ON spc_point_judgement
      FOR EACH ROW EXECUTE FUNCTION cadenza_spc_append_guard();

    -- ============ 失控处置任务（PE-12/13：闭环，不得静默关闭） ============
    CREATE TABLE spc_ooc_task (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      task_no text NOT NULL,
      status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'disposed', 're_control_confirmed')),
      control_item_id uuid NOT NULL REFERENCES spc_control_item (id) ON DELETE RESTRICT,
      sample_id uuid NOT NULL UNIQUE REFERENCES spc_sample (id) ON DELETE RESTRICT,
      notify_roles jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(notify_roles) = 'array'),
      quality_doubt_hint boolean NOT NULL DEFAULT true,
      cause_category text,
      corrective_action text,
      isolation_suggestion text,
      raised_at timestamptz NOT NULL,
      raised_by text NOT NULL CHECK (raised_by <> ''),
      disposed_by text,
      disposed_at timestamptz,
      recontrol_confirmed_by text,
      recontrol_confirmed_at timestamptz,
      command_receipt_id uuid REFERENCES command_receipt (id) ON DELETE RESTRICT,
      plant_id uuid NOT NULL REFERENCES org_node (id) ON DELETE RESTRICT,
      enterprise_id uuid NOT NULL REFERENCES org_node (id) ON DELETE RESTRICT,
      business_time timestamptz NOT NULL DEFAULT now(),
      created_at timestamptz NOT NULL DEFAULT now(),
      created_by text,
      CONSTRAINT spc_ooc_task_no_unique UNIQUE (task_no),
      -- PE-12：处置必留记录（原因分类+纠正措施）；复控确认必有确认人
      CONSTRAINT spc_ooc_dispose_shape CHECK (
        status = 'open'
        OR (cause_category IS NOT NULL AND cause_category <> '' AND corrective_action IS NOT NULL AND corrective_action <> '')
      ),
      CONSTRAINT spc_ooc_recontrol_shape CHECK (
        status <> 're_control_confirmed'
        OR (recontrol_confirmed_by IS NOT NULL AND disposed_at IS NOT NULL)
      )
    );
    CREATE INDEX spc_ooc_task_plant_status_idx ON spc_ooc_task (plant_id, status);
    CREATE INDEX spc_ooc_task_item_idx ON spc_ooc_task (control_item_id);
    CREATE FUNCTION cadenza_spc_ooc_guard() RETURNS trigger AS $$
    BEGIN
      IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION '[PE-12] 失控处置任务行不可删除（失控未处置不得静默关闭；处置链留痕可查）';
      END IF;
      IF NEW.task_no IS DISTINCT FROM OLD.task_no
        OR NEW.control_item_id IS DISTINCT FROM OLD.control_item_id
        OR NEW.sample_id IS DISTINCT FROM OLD.sample_id
        OR NEW.notify_roles IS DISTINCT FROM OLD.notify_roles
        OR NEW.quality_doubt_hint IS DISTINCT FROM OLD.quality_doubt_hint
        OR NEW.raised_at IS DISTINCT FROM OLD.raised_at
        OR NEW.raised_by IS DISTINCT FROM OLD.raised_by THEN
        RAISE EXCEPTION '[PE-12] spc_ooc_task 仅允许处置/复控列变更（事实列不可改）';
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
    CREATE TRIGGER spc_ooc_task_guard
      BEFORE UPDATE OR DELETE ON spc_ooc_task
      FOR EACH ROW EXECUTE FUNCTION cadenza_spc_ooc_guard();

    -- ============ 工艺变更单（PE-01~05/PE-S1） ============
    CREATE TABLE spc_process_change (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      change_no text NOT NULL,
      status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published')),
      old_spec_revision_id uuid NOT NULL REFERENCES parameter_spec_revision (id) ON DELETE RESTRICT,
      new_spec_revision_id uuid NOT NULL REFERENCES parameter_spec_revision (id) ON DELETE RESTRICT,
      approver text NOT NULL CHECK (approver <> ''),
      effective_at timestamptz NOT NULL,
      operation_mutations jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(operation_mutations) = 'array'),
      published_at timestamptz,
      published_by text,
      command_receipt_id uuid REFERENCES command_receipt (id) ON DELETE RESTRICT,
      plant_id uuid NOT NULL REFERENCES org_node (id) ON DELETE RESTRICT,
      enterprise_id uuid NOT NULL REFERENCES org_node (id) ON DELETE RESTRICT,
      business_time timestamptz NOT NULL DEFAULT now(),
      created_at timestamptz NOT NULL DEFAULT now(),
      created_by text,
      updated_at timestamptz NOT NULL DEFAULT now(),
      updated_by text,
      CONSTRAINT spc_process_change_no_unique UNIQUE (change_no),
      -- PE-S1：版本对/审批人/生效时间非空已由列约束承担；生效时间须晚于版本对建立
      CONSTRAINT spc_change_version_pair_distinct CHECK (old_spec_revision_id <> new_spec_revision_id)
    );
    CREATE INDEX spc_process_change_plant_idx ON spc_process_change (plant_id);
    CREATE INDEX spc_process_change_status_idx ON spc_process_change (status);
    CREATE FUNCTION cadenza_spc_change_guard() RETURNS trigger AS $$
    BEGIN
      IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION '[PE-S1] 变更单行不可删除（审批与执行版本对应留痕可回查）';
      END IF;
      IF OLD.status = 'published' THEN
        RAISE EXCEPTION '[PE-S1] 已生效变更单不可修改';
      END IF;
      IF NEW.old_spec_revision_id IS DISTINCT FROM OLD.old_spec_revision_id
        OR NEW.new_spec_revision_id IS DISTINCT FROM OLD.new_spec_revision_id
        OR NEW.approver IS DISTINCT FROM OLD.approver
        OR NEW.effective_at IS DISTINCT FROM OLD.effective_at
        OR NEW.operation_mutations IS DISTINCT FROM OLD.operation_mutations
        OR NEW.change_no IS DISTINCT FROM OLD.change_no THEN
        RAISE EXCEPTION '[PE-S1] 变更单内容列不可修改（仅可推进状态 draft→published）';
      END IF;
      IF NEW.status = 'published' AND (NEW.published_at IS NULL OR NEW.published_by IS NULL) THEN
        RAISE EXCEPTION '[PE-S1] 变更单生效必须留生效时点与生效人';
      END IF;
      -- PE-S1/PE-04 库级双保险：存在未处置在制任务不得生效（不允许不选择即发布）
      IF NEW.status = 'published' THEN
        IF EXISTS (SELECT 1 FROM spc_change_impact
                   WHERE change_id = OLD.id AND category = 'in_process' AND disposition IS NULL) THEN
          RAISE EXCEPTION '[PE-04] 存在未处置的在制任务：不允许不选择处置即发布（continue_old/switch_new/isolation_review 逐单显式选择）';
        END IF;
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
    CREATE TRIGGER spc_process_change_guard
      BEFORE UPDATE OR DELETE ON spc_process_change
      FOR EACH ROW EXECUTE FUNCTION cadenza_spc_change_guard();

    -- ============ 影响任务清单（PE-03/04/06） ============
    CREATE TABLE spc_change_impact (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      change_id uuid NOT NULL REFERENCES spc_process_change (id) ON DELETE RESTRICT,
      category text NOT NULL CHECK (category IN ('unexecuted', 'in_process', 'completed')),
      production_order_id uuid NOT NULL REFERENCES production_order (id) ON DELETE RESTRICT,
      order_no text NOT NULL CHECK (order_no <> ''),
      order_status text NOT NULL,
      order_operation_id uuid NOT NULL REFERENCES order_operation (id) ON DELETE RESTRICT,
      operation_seq integer NOT NULL CHECK (operation_seq >= 1),
      operation_name text NOT NULL,
      scheduled boolean NOT NULL DEFAULT false,
      disposition text CHECK (disposition IS NULL OR disposition IN ('continue_old', 'switch_new', 'isolation_review')),
      follows_version text CHECK (follows_version IN ('old', 'new')),
      planned_qty numeric(16,4) NOT NULL DEFAULT 0 CHECK (planned_qty >= 0),
      recomputed_planned_qty numeric(16,4) CHECK (recomputed_planned_qty >= 0),
      disposition_by text,
      disposition_at timestamptz,
      enterprise_id uuid NOT NULL REFERENCES org_node (id) ON DELETE RESTRICT,
      created_at timestamptz NOT NULL DEFAULT now(),
      created_by text,
      updated_at timestamptz NOT NULL DEFAULT now(),
      updated_by text,
      CONSTRAINT spc_change_impact_unique UNIQUE (change_id, order_operation_id),
      -- PE-04：仅在制任务可携带处置结论（处置值域由列 CHECK 承担；
      -- "无未处置在制任务方可生效"由 cadenza_spc_change_guard 在生效时校验）
      CONSTRAINT spc_impact_disposition_shape CHECK (
        disposition IS NULL OR category = 'in_process'
      )
    );
    CREATE INDEX spc_change_impact_change_idx ON spc_change_impact (change_id);
    CREATE INDEX spc_change_impact_order_idx ON spc_change_impact (production_order_id);
    CREATE FUNCTION cadenza_spc_impact_guard() RETURNS trigger AS $$
    BEGIN
      IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION '[PE-06] 影响任务清单行不可删除（变更影响可回查）';
      END IF;
      IF NEW.change_id IS DISTINCT FROM OLD.change_id
        OR NEW.category IS DISTINCT FROM OLD.category
        OR NEW.production_order_id IS DISTINCT FROM OLD.production_order_id
        OR NEW.order_operation_id IS DISTINCT FROM OLD.order_operation_id
        OR NEW.scheduled IS DISTINCT FROM OLD.scheduled
        OR NEW.planned_qty IS DISTINCT FROM OLD.planned_qty THEN
        RAISE EXCEPTION '[PE-04] spc_change_impact 仅允许处置/重算列变更（扫描事实列不可改）';
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
    CREATE TRIGGER spc_change_impact_guard
      BEFORE UPDATE OR DELETE ON spc_change_impact
      FOR EACH ROW EXECUTE FUNCTION cadenza_spc_impact_guard();

    -- ============ 调整指令（PE-03：重算留痕 append-only；PE-02 不静默重算） ============
    CREATE TABLE spc_change_adjustment (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      change_id uuid NOT NULL REFERENCES spc_process_change (id) ON DELETE RESTRICT,
      order_operation_id uuid NOT NULL REFERENCES order_operation (id) ON DELETE RESTRICT,
      order_no text NOT NULL,
      operation_seq integer NOT NULL CHECK (operation_seq >= 1),
      old_planned_qty numeric(16,4) NOT NULL CHECK (old_planned_qty >= 0),
      new_planned_qty numeric(16,4) NOT NULL CHECK (new_planned_qty >= 0),
      basis jsonb NOT NULL DEFAULT '{}'::jsonb,
      enterprise_id uuid NOT NULL REFERENCES org_node (id) ON DELETE RESTRICT,
      created_at timestamptz NOT NULL DEFAULT now(),
      created_by text
    );
    CREATE INDEX spc_change_adjustment_change_idx ON spc_change_adjustment (change_id);
    CREATE INDEX spc_change_adjustment_operation_idx ON spc_change_adjustment (order_operation_id);
    CREATE TRIGGER spc_change_adjustment_append_guard
      BEFORE UPDATE OR DELETE ON spc_change_adjustment
      FOR EACH ROW EXECUTE FUNCTION cadenza_spc_append_guard();

    -- ============ 失准逐项处置（PE-19：append-only；已发运项客诉提示） ============
    CREATE TABLE spc_miscalibration_action (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      gauge_id uuid NOT NULL REFERENCES spc_gauge (id) ON DELETE RESTRICT,
      window_from timestamptz NOT NULL,
      window_to timestamptz NOT NULL,
      item_kind text NOT NULL CHECK (item_kind IN
        ('measurement', 'inspection_conclusion', 'release', 'lot', 'wip_order', 'stock_unit', 'shipped_unit')),
      item_ref text NOT NULL CHECK (item_ref <> ''),
      item_label text,
      action_kind text NOT NULL CHECK (action_kind IN ('isolation', 'retest', 'concession', 'rework_scrap')),
      external_ref text,
      customer_complaint_hint boolean NOT NULL DEFAULT false,
      acted_by text NOT NULL CHECK (acted_by <> ''),
      acted_at timestamptz NOT NULL,
      command_receipt_id uuid REFERENCES command_receipt (id) ON DELETE RESTRICT,
      plant_id uuid NOT NULL REFERENCES org_node (id) ON DELETE RESTRICT,
      enterprise_id uuid NOT NULL REFERENCES org_node (id) ON DELETE RESTRICT,
      created_at timestamptz NOT NULL DEFAULT now(),
      created_by text,
      -- PE-18：圈定时段有效
      CONSTRAINT spc_miscalibration_window CHECK (window_from <= window_to)
    );
    CREATE INDEX spc_miscalibration_action_gauge_idx ON spc_miscalibration_action (gauge_id, window_from, window_to);
    CREATE TRIGGER spc_miscalibration_action_append_guard
      BEFORE UPDATE OR DELETE ON spc_miscalibration_action
      FOR EACH ROW EXECUTE FUNCTION cadenza_spc_append_guard();

    -- ============ 工具寿命台账（PE-20/PE-S5：累计列只增） ============
    CREATE TABLE spc_tool_ledger (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tool_no text NOT NULL CHECK (tool_no <> ''),
      name text NOT NULL CHECK (name <> ''),
      tool_kind text,
      config_version integer NOT NULL DEFAULT 1 CHECK (config_version >= 1),
      life_uom text NOT NULL CHECK (life_uom IN ('count', 'meters', 'hours')),
      rated_life numeric(18,4) NOT NULL CHECK (rated_life > 0),
      warning_threshold numeric(18,4) NOT NULL CHECK (warning_threshold >= 0 AND warning_threshold <= rated_life),
      expire_policy text NOT NULL CHECK (expire_policy IN ('block', 'degrade')),
      accumulated_life numeric(18,4) NOT NULL DEFAULT 0 CHECK (accumulated_life >= 0),
      plant_id uuid NOT NULL REFERENCES org_node (id) ON DELETE RESTRICT,
      enterprise_id uuid NOT NULL REFERENCES org_node (id) ON DELETE RESTRICT,
      created_at timestamptz NOT NULL DEFAULT now(),
      created_by text,
      updated_at timestamptz NOT NULL DEFAULT now(),
      updated_by text,
      CONSTRAINT spc_tool_ledger_no_unique UNIQUE (plant_id, tool_no)
    );
    CREATE INDEX spc_tool_ledger_plant_idx ON spc_tool_ledger (plant_id);
    -- PE-21/PE-S5：累计列只增；配置列仅随版本递增可改；修正走 spc_tool_adjustment（具名调整审计行独立）
    CREATE FUNCTION cadenza_spc_tool_life_guard() RETURNS trigger AS $$
    BEGIN
      IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION '[PE-20] 工具台账行不可删除（寿命事实留痕）';
      END IF;
      IF NEW.accumulated_life < OLD.accumulated_life THEN
        RAISE EXCEPTION '[PE-21] 工具寿命累计只增不改（当前 %，试图改为 %）：修正走具名调整（理由＋审计）',
          OLD.accumulated_life, NEW.accumulated_life;
      END IF;
      IF NEW.tool_no IS DISTINCT FROM OLD.tool_no THEN
        RAISE EXCEPTION '[PE-20] 工具编号不可修改（台账身份）';
      END IF;
      IF (NEW.life_uom IS DISTINCT FROM OLD.life_uom
          OR NEW.rated_life IS DISTINCT FROM OLD.rated_life
          OR NEW.warning_threshold IS DISTINCT FROM OLD.warning_threshold
          OR NEW.expire_policy IS DISTINCT FROM OLD.expire_policy)
        AND NEW.config_version <= OLD.config_version THEN
        RAISE EXCEPTION '[PE-20] 寿命配置修改必须伴随配置版本递增（版本化配置，历史版本留痕）';
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
    CREATE TRIGGER spc_tool_ledger_guard
      BEFORE UPDATE OR DELETE ON spc_tool_ledger
      FOR EACH ROW EXECUTE FUNCTION cadenza_spc_tool_life_guard();

    -- ============ 工具配置版本（PE-20：append-only 版本行） ============
    CREATE TABLE spc_tool_config (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tool_id uuid NOT NULL REFERENCES spc_tool_ledger (id) ON DELETE RESTRICT,
      version integer NOT NULL CHECK (version >= 1),
      life_uom text NOT NULL CHECK (life_uom IN ('count', 'meters', 'hours')),
      rated_life numeric(18,4) NOT NULL CHECK (rated_life > 0),
      warning_threshold numeric(18,4) NOT NULL CHECK (warning_threshold >= 0),
      expire_policy text NOT NULL CHECK (expire_policy IN ('block', 'degrade')),
      effective_at timestamptz NOT NULL,
      enterprise_id uuid NOT NULL REFERENCES org_node (id) ON DELETE RESTRICT,
      created_at timestamptz NOT NULL DEFAULT now(),
      created_by text,
      CONSTRAINT spc_tool_config_version_unique UNIQUE (tool_id, version)
    );
    CREATE INDEX spc_tool_config_tool_idx ON spc_tool_config (tool_id);
    CREATE TRIGGER spc_tool_config_append_guard
      BEFORE UPDATE OR DELETE ON spc_tool_config
      FOR EACH ROW EXECUTE FUNCTION cadenza_spc_append_guard();

    -- ============ 寿命累计消耗行（PE-20：OT-26 显式映射来源；append-only） ============
    CREATE TABLE spc_tool_usage (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tool_id uuid NOT NULL REFERENCES spc_tool_ledger (id) ON DELETE RESTRICT,
      source text NOT NULL CHECK (source IN ('work_report_output', 'collected_sample')),
      quantity numeric(18,4) NOT NULL CHECK (quantity > 0),
      ref_type text NOT NULL CHECK (ref_type <> ''),
      ref_id text NOT NULL CHECK (ref_id <> ''),
      command_receipt_id uuid REFERENCES command_receipt (id) ON DELETE RESTRICT,
      plant_id uuid NOT NULL REFERENCES org_node (id) ON DELETE RESTRICT,
      enterprise_id uuid NOT NULL REFERENCES org_node (id) ON DELETE RESTRICT,
      business_time timestamptz NOT NULL DEFAULT now(),
      created_at timestamptz NOT NULL DEFAULT now(),
      created_by text
    );
    CREATE INDEX spc_tool_usage_tool_idx ON spc_tool_usage (tool_id);
    CREATE TRIGGER spc_tool_usage_append_guard
      BEFORE UPDATE OR DELETE ON spc_tool_usage
      FOR EACH ROW EXECUTE FUNCTION cadenza_spc_append_guard();

    -- ============ 具名调整行（PE-21：理由＋审计；与累计列分离） ============
    CREATE TABLE spc_tool_adjustment (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tool_id uuid NOT NULL REFERENCES spc_tool_ledger (id) ON DELETE RESTRICT,
      delta numeric(18,4) NOT NULL CHECK (delta <> 0),
      reason text NOT NULL CHECK (reason <> ''),
      command_receipt_id uuid REFERENCES command_receipt (id) ON DELETE RESTRICT,
      enterprise_id uuid NOT NULL REFERENCES org_node (id) ON DELETE RESTRICT,
      created_at timestamptz NOT NULL DEFAULT now(),
      created_by text
    );
    CREATE INDEX spc_tool_adjustment_tool_idx ON spc_tool_adjustment (tool_id);
    CREATE TRIGGER spc_tool_adjustment_append_guard
      BEFORE UPDATE OR DELETE ON spc_tool_adjustment
      FOR EACH ROW EXECUTE FUNCTION cadenza_spc_append_guard();
  `,
  down: /* sql */ `
    DROP TRIGGER IF EXISTS spc_tool_adjustment_append_guard ON spc_tool_adjustment;
    DROP TABLE IF EXISTS spc_tool_adjustment;
    DROP TRIGGER IF EXISTS spc_tool_usage_append_guard ON spc_tool_usage;
    DROP TABLE IF EXISTS spc_tool_usage;
    DROP TRIGGER IF EXISTS spc_tool_config_append_guard ON spc_tool_config;
    DROP TABLE IF EXISTS spc_tool_config;
    DROP TRIGGER IF EXISTS spc_tool_ledger_guard ON spc_tool_ledger;
    DROP FUNCTION IF EXISTS cadenza_spc_tool_life_guard();
    DROP TABLE IF EXISTS spc_tool_ledger;
    DROP TRIGGER IF EXISTS spc_miscalibration_action_append_guard ON spc_miscalibration_action;
    DROP TABLE IF EXISTS spc_miscalibration_action;
    DROP TRIGGER IF EXISTS spc_change_adjustment_append_guard ON spc_change_adjustment;
    DROP TABLE IF EXISTS spc_change_adjustment;
    DROP TRIGGER IF EXISTS spc_change_impact_guard ON spc_change_impact;
    DROP FUNCTION IF EXISTS cadenza_spc_impact_guard();
    DROP TABLE IF EXISTS spc_change_impact;
    DROP TRIGGER IF EXISTS spc_process_change_guard ON spc_process_change;
    DROP FUNCTION IF EXISTS cadenza_spc_change_guard();
    DROP TABLE IF EXISTS spc_process_change;
    DROP TRIGGER IF EXISTS spc_ooc_task_guard ON spc_ooc_task;
    DROP FUNCTION IF EXISTS cadenza_spc_ooc_guard();
    DROP TABLE IF EXISTS spc_ooc_task;
    DROP TRIGGER IF EXISTS spc_point_judgement_append_guard ON spc_point_judgement;
    DROP TABLE IF EXISTS spc_point_judgement;
    DROP TRIGGER IF EXISTS spc_sample_append_guard ON spc_sample;
    DROP TABLE IF EXISTS spc_sample;
    DROP TRIGGER IF EXISTS spc_control_limit_append_guard ON spc_control_limit_version;
    DROP TABLE IF EXISTS spc_control_limit_version;
    DROP TABLE IF EXISTS spc_control_item;
    DROP TRIGGER IF EXISTS spc_rule_set_freeze_guard ON spc_rule_set;
    DROP FUNCTION IF EXISTS cadenza_spc_rule_set_freeze_guard();
    DROP TABLE IF EXISTS spc_rule_set;
    DROP TRIGGER IF EXISTS spc_calibration_record_append_guard ON spc_calibration_record;
    DROP TABLE IF EXISTS spc_calibration_record;
    DROP TABLE IF EXISTS spc_gauge;
    DROP FUNCTION IF EXISTS cadenza_spc_append_guard();
  `,
}
