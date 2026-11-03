import type { Migration } from './index'

/**
 * 0026 P2 返工/报废写命令入口表（WI-L1-REWORK-SCRAP-WRITE）。
 *
 * 边界：
 * - group_rework_write / group_scrap_write = 空库可演示的创建/处置写契约入口；
 * - ≠ disposition.disposition.rework/scrap（库存单元联动扣减，需既有 unit）；
 * - ≠ /group/recalls（召回已有，勿重复）；
 * - ≠ 全量业务闭环（入口/契约 Done-when）。
 */
export const migration0026: Migration = {
  version: '0026',
  name: 'p2-rework-scrap-write',
  up: /* sql */ `
    CREATE TABLE IF NOT EXISTS group_rework_write (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      rework_no text NOT NULL CHECK (rework_no <> '' AND length(rework_no) <= 64),
      title text NOT NULL CHECK (title <> '' AND length(title) <= 200),
      reason text NOT NULL CHECK (reason <> ''),
      unit_no text CHECK (unit_no IS NULL OR (unit_no <> '' AND length(unit_no) <= 64)),
      batch_no text CHECK (batch_no IS NULL OR (batch_no <> '' AND length(batch_no) <= 64)),
      material_code text CHECK (material_code IS NULL OR (material_code <> '' AND length(material_code) <= 64)),
      status text NOT NULL DEFAULT 'draft'
        CHECK (status IN ('draft','submitted','in_progress','closed','cancelled')),
      payload jsonb NOT NULL DEFAULT '{}'::jsonb,
      enterprise_id uuid NOT NULL REFERENCES org_node (id) ON DELETE RESTRICT,
      plant_id uuid NOT NULL REFERENCES org_node (id) ON DELETE RESTRICT,
      command_receipt_id uuid REFERENCES command_receipt (id) ON DELETE RESTRICT,
      created_at timestamptz NOT NULL DEFAULT now(),
      created_by text,
      updated_at timestamptz NOT NULL DEFAULT now(),
      updated_by text,
      CONSTRAINT group_rework_write_no_unique UNIQUE (enterprise_id, rework_no),
      CONSTRAINT group_rework_write_target_chk CHECK (
        unit_no IS NOT NULL OR batch_no IS NOT NULL OR material_code IS NOT NULL
      )
    );

    CREATE INDEX IF NOT EXISTS group_rework_write_plant_idx ON group_rework_write (plant_id);
    CREATE INDEX IF NOT EXISTS group_rework_write_status_idx ON group_rework_write (status);
    COMMENT ON TABLE group_rework_write IS
      'P2：返工写命令入口（≠ disposition 库存联动返工；≠ 召回）';

    CREATE TABLE IF NOT EXISTS group_scrap_write (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      scrap_no text NOT NULL CHECK (scrap_no <> '' AND length(scrap_no) <= 64),
      title text NOT NULL CHECK (title <> '' AND length(title) <= 200),
      reason text NOT NULL CHECK (reason <> ''),
      unit_no text CHECK (unit_no IS NULL OR (unit_no <> '' AND length(unit_no) <= 64)),
      batch_no text CHECK (batch_no IS NULL OR (batch_no <> '' AND length(batch_no) <= 64)),
      material_code text CHECK (material_code IS NULL OR (material_code <> '' AND length(material_code) <= 64)),
      scrap_qty text CHECK (scrap_qty IS NULL OR scrap_qty ~ '^[0-9]+(\\.[0-9]+)?$'),
      status text NOT NULL DEFAULT 'draft'
        CHECK (status IN ('draft','submitted','disposed','closed','cancelled')),
      payload jsonb NOT NULL DEFAULT '{}'::jsonb,
      enterprise_id uuid NOT NULL REFERENCES org_node (id) ON DELETE RESTRICT,
      plant_id uuid NOT NULL REFERENCES org_node (id) ON DELETE RESTRICT,
      command_receipt_id uuid REFERENCES command_receipt (id) ON DELETE RESTRICT,
      created_at timestamptz NOT NULL DEFAULT now(),
      created_by text,
      updated_at timestamptz NOT NULL DEFAULT now(),
      updated_by text,
      CONSTRAINT group_scrap_write_no_unique UNIQUE (enterprise_id, scrap_no),
      CONSTRAINT group_scrap_write_target_chk CHECK (
        unit_no IS NOT NULL OR batch_no IS NOT NULL OR material_code IS NOT NULL
      )
    );

    CREATE INDEX IF NOT EXISTS group_scrap_write_plant_idx ON group_scrap_write (plant_id);
    CREATE INDEX IF NOT EXISTS group_scrap_write_status_idx ON group_scrap_write (status);
    COMMENT ON TABLE group_scrap_write IS
      'P2：报废写命令入口（≠ disposition 库存扣减报废；≠ 召回）';
  `,
  down: /* sql */ `
    DROP TABLE IF EXISTS group_scrap_write;
    DROP TABLE IF EXISTS group_rework_write;
  `,
}
