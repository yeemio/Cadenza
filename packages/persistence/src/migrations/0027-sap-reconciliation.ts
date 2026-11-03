import type { Migration } from './index'

/**
 * 0027 SAP 双账/对账差异台账（WI-L1-SAP-RECON-API）。
 * ≠ cost_recon_item / GET /cost/recon-items；≠ fixture sap_reconciliation.csv。
 */
export const migration0027: Migration = {
  version: '0027',
  name: 'sap-reconciliation',
  up: /* sql */ `
    CREATE TABLE IF NOT EXISTS sap_reconciliation_item (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      recon_no text NOT NULL CHECK (recon_no <> '' AND length(recon_no) <= 64),
      object_code text NOT NULL CHECK (object_code <> '' AND length(object_code) <= 64),
      object_name text CHECK (object_name IS NULL OR length(object_name) <= 200),
      mom_qty text,
      sap_qty text,
      diff_qty text,
      currency_code text CHECK (currency_code IS NULL OR length(currency_code) <= 8),
      match_status text NOT NULL DEFAULT 'OPEN'
        CHECK (match_status IN ('OPEN','MATCH','DIFF','OUTCOME_UNKNOWN','QUARANTINED')),
      title text NOT NULL CHECK (title <> '' AND length(title) <= 200),
      reason text NOT NULL CHECK (reason <> ''),
      payload jsonb NOT NULL DEFAULT '{}'::jsonb,
      enterprise_id uuid NOT NULL REFERENCES org_node (id) ON DELETE RESTRICT,
      plant_id uuid NOT NULL REFERENCES org_node (id) ON DELETE RESTRICT,
      command_receipt_id uuid REFERENCES command_receipt (id) ON DELETE RESTRICT,
      created_at timestamptz NOT NULL DEFAULT now(),
      created_by text,
      updated_at timestamptz NOT NULL DEFAULT now(),
      updated_by text,
      CONSTRAINT sap_reconciliation_item_no_unique UNIQUE (enterprise_id, recon_no)
    );

    CREATE INDEX IF NOT EXISTS sap_reconciliation_item_plant_idx ON sap_reconciliation_item (plant_id);
    CREATE INDEX IF NOT EXISTS sap_reconciliation_item_status_idx ON sap_reconciliation_item (match_status);
    COMMENT ON TABLE sap_reconciliation_item IS
      'SAP 双账/对账差异台账入口（≠ /cost/recon-items；≠ fixture；actual_connection=false）';
  `,
  down: /* sql */ `
    DROP TABLE IF EXISTS sap_reconciliation_item;
  `,
}
