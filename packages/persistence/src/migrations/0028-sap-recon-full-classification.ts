import type { Migration } from './index'

/**
 * 0028 SAP 对账全量加深（WI-L1-SAP-RECON-FULL）：
 * - 对齐 G-B02 fixture 分类：MATCH / CLASSIFICATION_DIFFERENCE / QUALITY_STATUS_DIFFERENCE / OUTCOME_UNKNOWN
 * - 保留既有 OPEN/DIFF/QUARANTINED（入口兼容）
 * - 补充 sap_stock_state / mom_hold / unknown_slice_qty 可演示字段
 * - ≠ /cost/recon-items；≠ fixture 直导；actual_connection=false；不改 frozen
 */
export const migration0028: Migration = {
  version: '0028',
  name: 'sap-recon-full-classification',
  up: /* sql */ `
    ALTER TABLE sap_reconciliation_item
      DROP CONSTRAINT IF EXISTS sap_reconciliation_item_match_status_check;

    ALTER TABLE sap_reconciliation_item
      ADD CONSTRAINT sap_reconciliation_item_match_status_check
      CHECK (match_status IN (
        'OPEN',
        'MATCH',
        'DIFF',
        'OUTCOME_UNKNOWN',
        'QUARANTINED',
        'CLASSIFICATION_DIFFERENCE',
        'QUALITY_STATUS_DIFFERENCE'
      ));

    ALTER TABLE sap_reconciliation_item
      ADD COLUMN IF NOT EXISTS sap_stock_state text
        CHECK (sap_stock_state IS NULL OR length(sap_stock_state) <= 64),
      ADD COLUMN IF NOT EXISTS mom_hold boolean,
      ADD COLUMN IF NOT EXISTS unknown_slice_qty text;

    COMMENT ON COLUMN sap_reconciliation_item.match_status IS
      'G-B02 分类口径：MATCH / CLASSIFICATION_DIFFERENCE / QUALITY_STATUS_DIFFERENCE / OUTCOME_UNKNOWN（兼 OPEN/DIFF/QUARANTINED）';
    COMMENT ON TABLE sap_reconciliation_item IS
      'SAP 双账/对账差异台账（全量分类加深；≠ /cost/recon-items；≠ fixture；actual_connection=false）';
  `,
  down: /* sql */ `
    ALTER TABLE sap_reconciliation_item
      DROP COLUMN IF EXISTS unknown_slice_qty,
      DROP COLUMN IF EXISTS mom_hold,
      DROP COLUMN IF EXISTS sap_stock_state;

    ALTER TABLE sap_reconciliation_item
      DROP CONSTRAINT IF EXISTS sap_reconciliation_item_match_status_check;

    ALTER TABLE sap_reconciliation_item
      ADD CONSTRAINT sap_reconciliation_item_match_status_check
      CHECK (match_status IN ('OPEN','MATCH','DIFF','OUTCOME_UNKNOWN','QUARANTINED'));
  `,
}
