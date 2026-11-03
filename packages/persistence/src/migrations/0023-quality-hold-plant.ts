import type { Migration } from './index'

/**
 * 0023 quality_hold 组织隔离列（GAP-QUALITY-HOLDS-500 / WI-L1-QUALITY-HOLDS-500）。
 *
 * 根因：0009 建表时 quality_hold 漏了 plant_id / enterprise_id，而 PgQualityHoldRepository
 * 的 HOLD_COLUMNS 与 listPaged 过滤已按 OA-33 / 数据范围口径引用这两列 →
 * GET /quality/holds 抛 42703 column "plant_id" does not exist → 500 ERR_INTERNAL。
 *
 * 本迁移补列、自 inventory_unit 回填、收紧 NOT NULL + FK + 索引；不改放行/存疑命令语义。
 */
export const migration0023: Migration = {
  version: '0023',
  name: 'quality-hold-plant',
  up: /* sql */ `
    ALTER TABLE quality_hold
      ADD COLUMN IF NOT EXISTS plant_id uuid,
      ADD COLUMN IF NOT EXISTS enterprise_id uuid;

    UPDATE quality_hold AS h
       SET plant_id = u.plant_id,
           enterprise_id = u.enterprise_id
      FROM inventory_unit AS u
     WHERE h.inventory_unit_id = u.id
       AND (h.plant_id IS NULL OR h.enterprise_id IS NULL);

    -- 无孤儿行预期（inventory_unit_id FK）；若仍有空值则显式失败，避免半状态 NOT NULL
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM quality_hold WHERE plant_id IS NULL OR enterprise_id IS NULL
      ) THEN
        RAISE EXCEPTION 'quality_hold backfill incomplete: plant_id/enterprise_id still null';
      END IF;
    END $$;

    ALTER TABLE quality_hold
      ALTER COLUMN plant_id SET NOT NULL,
      ALTER COLUMN enterprise_id SET NOT NULL;

    ALTER TABLE quality_hold
      DROP CONSTRAINT IF EXISTS quality_hold_plant_fk,
      DROP CONSTRAINT IF EXISTS quality_hold_enterprise_fk;

    ALTER TABLE quality_hold
      ADD CONSTRAINT quality_hold_plant_fk
        FOREIGN KEY (plant_id) REFERENCES org_node (id) ON DELETE RESTRICT,
      ADD CONSTRAINT quality_hold_enterprise_fk
        FOREIGN KEY (enterprise_id) REFERENCES org_node (id) ON DELETE RESTRICT;

    CREATE INDEX IF NOT EXISTS quality_hold_plant_idx ON quality_hold (plant_id);

    COMMENT ON COLUMN quality_hold.plant_id IS
      'OA-33/数据范围：隔离记录所属工厂；0023 补列（0009 漏建）';
    COMMENT ON COLUMN quality_hold.enterprise_id IS
      '企业冗余隔离列；0023 补列（0009 漏建），与 inventory_unit.enterprise_id 对齐';
  `,
  down: /* sql */ `
    DROP INDEX IF EXISTS quality_hold_plant_idx;
    ALTER TABLE quality_hold
      DROP CONSTRAINT IF EXISTS quality_hold_plant_fk,
      DROP CONSTRAINT IF EXISTS quality_hold_enterprise_fk;
    ALTER TABLE quality_hold
      DROP COLUMN IF EXISTS plant_id,
      DROP COLUMN IF EXISTS enterprise_id;
  `,
}
