import type { Migration } from './index'

/**
 * 0025 P1 回抛四单专用表（WI-L1-G-RECALL / E09-FEED-RACE-PLAN / E09-SCAN-BLOCK / G-VENDOR-RISK）。
 *
 * 边界：
 * - group_product_recall ≠ CSW 外协 recall；
 * - production_feed_race_plan ≠ 投料/排程/生产订单；
 * - scan_block_event ≠ 通用扫码/报工；
 * - group_vendor_risk ≠ 外协任务。
 * 均带 plant_id/enterprise_id（对齐 0023 holds 厂过滤教训）。
 */
export const migration0025: Migration = {
  version: '0025',
  name: 'p1-throwback-apis',
  up: /* sql */ `
    CREATE TABLE IF NOT EXISTS group_product_recall (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      recall_no text NOT NULL CHECK (recall_no <> '' AND length(recall_no) <= 64),
      recall_scope text NOT NULL CHECK (recall_scope IN ('batch','finished_product')),
      batch_no text CHECK (batch_no IS NULL OR (batch_no <> '' AND length(batch_no) <= 64)),
      material_code text CHECK (material_code IS NULL OR (material_code <> '' AND length(material_code) <= 64)),
      title text NOT NULL CHECK (title <> '' AND length(title) <= 200),
      reason text NOT NULL CHECK (reason <> ''),
      status text NOT NULL DEFAULT 'draft'
        CHECK (status IN ('draft','submitted','executing','closed','cancelled')),
      payload jsonb NOT NULL DEFAULT '{}'::jsonb,
      enterprise_id uuid NOT NULL REFERENCES org_node (id) ON DELETE RESTRICT,
      plant_id uuid NOT NULL REFERENCES org_node (id) ON DELETE RESTRICT,
      command_receipt_id uuid REFERENCES command_receipt (id) ON DELETE RESTRICT,
      created_at timestamptz NOT NULL DEFAULT now(),
      created_by text,
      updated_at timestamptz NOT NULL DEFAULT now(),
      updated_by text,
      CONSTRAINT group_product_recall_no_unique UNIQUE (enterprise_id, recall_no),
      CONSTRAINT group_product_recall_target_chk CHECK (
        batch_no IS NOT NULL OR material_code IS NOT NULL
      )
    );

    CREATE INDEX IF NOT EXISTS group_product_recall_plant_idx
      ON group_product_recall (plant_id);
    CREATE INDEX IF NOT EXISTS group_product_recall_status_idx
      ON group_product_recall (status);

    COMMENT ON TABLE group_product_recall IS
      'G 场景：成品/批次召回专用（≠ CSW 外协 recall）';

    CREATE TABLE IF NOT EXISTS production_feed_race_plan (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      plan_no text NOT NULL CHECK (plan_no <> '' AND length(plan_no) <= 64),
      plan_kind text NOT NULL CHECK (plan_kind IN ('race','partial','late_revision')),
      title text NOT NULL CHECK (title <> '' AND length(title) <= 200),
      reason text NOT NULL CHECK (reason <> ''),
      status text NOT NULL DEFAULT 'draft'
        CHECK (status IN ('draft','submitted','active','closed','cancelled')),
      payload jsonb NOT NULL DEFAULT '{}'::jsonb,
      enterprise_id uuid NOT NULL REFERENCES org_node (id) ON DELETE RESTRICT,
      plant_id uuid NOT NULL REFERENCES org_node (id) ON DELETE RESTRICT,
      command_receipt_id uuid REFERENCES command_receipt (id) ON DELETE RESTRICT,
      created_at timestamptz NOT NULL DEFAULT now(),
      created_by text,
      updated_at timestamptz NOT NULL DEFAULT now(),
      updated_by text,
      CONSTRAINT production_feed_race_plan_no_unique UNIQUE (enterprise_id, plan_no)
    );

    CREATE INDEX IF NOT EXISTS production_feed_race_plan_plant_idx
      ON production_feed_race_plan (plant_id);
    CREATE INDEX IF NOT EXISTS production_feed_race_plan_kind_idx
      ON production_feed_race_plan (plan_kind);

    COMMENT ON TABLE production_feed_race_plan IS
      'E09：投料竞争/计划部分/迟修订专用（≠ 投料/排程/生产订单）';

    CREATE TABLE IF NOT EXISTS scan_block_event (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      event_no text NOT NULL CHECK (event_no <> '' AND length(event_no) <= 64),
      policy_code text NOT NULL CHECK (policy_code <> '' AND length(policy_code) <= 64),
      scan_code text NOT NULL CHECK (scan_code <> '' AND length(scan_code) <= 128),
      block_reason text NOT NULL CHECK (block_reason <> ''),
      severity text NOT NULL DEFAULT 'block'
        CHECK (severity IN ('warn','block','escalate')),
      status text NOT NULL DEFAULT 'open'
        CHECK (status IN ('open','acknowledged','resolved','cancelled')),
      payload jsonb NOT NULL DEFAULT '{}'::jsonb,
      enterprise_id uuid NOT NULL REFERENCES org_node (id) ON DELETE RESTRICT,
      plant_id uuid NOT NULL REFERENCES org_node (id) ON DELETE RESTRICT,
      command_receipt_id uuid REFERENCES command_receipt (id) ON DELETE RESTRICT,
      created_at timestamptz NOT NULL DEFAULT now(),
      created_by text,
      updated_at timestamptz NOT NULL DEFAULT now(),
      updated_by text,
      CONSTRAINT scan_block_event_no_unique UNIQUE (enterprise_id, event_no)
    );

    CREATE INDEX IF NOT EXISTS scan_block_event_plant_idx
      ON scan_block_event (plant_id);
    CREATE INDEX IF NOT EXISTS scan_block_event_policy_idx
      ON scan_block_event (policy_code);

    COMMENT ON TABLE scan_block_event IS
      'E09：SCAN-BLOCK 拦截事件专用（≠ 通用扫码/报工）';

    CREATE TABLE IF NOT EXISTS group_vendor_risk (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      risk_no text NOT NULL CHECK (risk_no <> '' AND length(risk_no) <= 64),
      vendor_code text NOT NULL CHECK (vendor_code <> '' AND length(vendor_code) <= 64),
      vendor_name text CHECK (vendor_name IS NULL OR length(vendor_name) <= 200),
      risk_level text NOT NULL CHECK (risk_level IN ('low','medium','high','critical')),
      title text NOT NULL CHECK (title <> '' AND length(title) <= 200),
      reason text NOT NULL CHECK (reason <> ''),
      status text NOT NULL DEFAULT 'open'
        CHECK (status IN ('open','mitigating','closed','cancelled')),
      payload jsonb NOT NULL DEFAULT '{}'::jsonb,
      enterprise_id uuid NOT NULL REFERENCES org_node (id) ON DELETE RESTRICT,
      plant_id uuid NOT NULL REFERENCES org_node (id) ON DELETE RESTRICT,
      command_receipt_id uuid REFERENCES command_receipt (id) ON DELETE RESTRICT,
      created_at timestamptz NOT NULL DEFAULT now(),
      created_by text,
      updated_at timestamptz NOT NULL DEFAULT now(),
      updated_by text,
      CONSTRAINT group_vendor_risk_no_unique UNIQUE (enterprise_id, risk_no)
    );

    CREATE INDEX IF NOT EXISTS group_vendor_risk_plant_idx
      ON group_vendor_risk (plant_id);
    CREATE INDEX IF NOT EXISTS group_vendor_risk_vendor_idx
      ON group_vendor_risk (vendor_code);
    CREATE INDEX IF NOT EXISTS group_vendor_risk_level_idx
      ON group_vendor_risk (risk_level);

    COMMENT ON TABLE group_vendor_risk IS
      'G 场景：供应商风险专用（≠ 外协任务）';
  `,
  down: /* sql */ `
    DROP TABLE IF EXISTS group_vendor_risk;
    DROP TABLE IF EXISTS scan_block_event;
    DROP TABLE IF EXISTS production_feed_race_plan;
    DROP TABLE IF EXISTS group_product_recall;
  `,
}
