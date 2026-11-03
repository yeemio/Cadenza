import type { Migration } from './index'

/**
 * 0024 集团分配修订 + 缺料/齐套结果表（WI-L1-G-ALLOC-REV-API / WI-L1-G-SHORTAGE-KIT-API）。
 *
 * 边界：
 * - group_allocation_revision ≠ cost_allocation_version（成本分摊）；
 * - group_shortage_kitting_result ≠ 投料/排程/CSW 内部判定表。
 * 空库无行即可交付列表 200 空态；命令面可写入本表。
 */
export const migration0024: Migration = {
  version: '0024',
  name: 'group-allocation-shortage',
  up: /* sql */ `
    CREATE TABLE IF NOT EXISTS group_allocation_revision (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      revision_no text NOT NULL CHECK (revision_no <> '' AND length(revision_no) <= 64),
      title text NOT NULL CHECK (title <> '' AND length(title) <= 200),
      reason text NOT NULL CHECK (reason <> ''),
      status text NOT NULL DEFAULT 'draft'
        CHECK (status IN ('draft','submitted','approved','rejected','cancelled')),
      payload jsonb NOT NULL DEFAULT '{}'::jsonb,
      enterprise_id uuid NOT NULL REFERENCES org_node (id) ON DELETE RESTRICT,
      plant_id uuid NOT NULL REFERENCES org_node (id) ON DELETE RESTRICT,
      command_receipt_id uuid REFERENCES command_receipt (id) ON DELETE RESTRICT,
      created_at timestamptz NOT NULL DEFAULT now(),
      created_by text,
      updated_at timestamptz NOT NULL DEFAULT now(),
      updated_by text,
      CONSTRAINT group_allocation_revision_no_unique UNIQUE (enterprise_id, revision_no)
    );

    CREATE INDEX IF NOT EXISTS group_allocation_revision_plant_idx
      ON group_allocation_revision (plant_id);
    CREATE INDEX IF NOT EXISTS group_allocation_revision_status_idx
      ON group_allocation_revision (status);

    COMMENT ON TABLE group_allocation_revision IS
      'G 场景：集团需求/产能分配修订（非 cost_allocation_version 成本分摊）';

    CREATE TABLE IF NOT EXISTS group_shortage_kitting_result (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      order_no text NOT NULL CHECK (order_no <> '' AND length(order_no) <= 64),
      order_id uuid,
      check_status text NOT NULL DEFAULT 'empty'
        CHECK (check_status IN ('empty','ok','shortage','error')),
      shortage_lines jsonb NOT NULL DEFAULT '[]'::jsonb,
      checked_at timestamptz NOT NULL DEFAULT now(),
      enterprise_id uuid NOT NULL REFERENCES org_node (id) ON DELETE RESTRICT,
      plant_id uuid NOT NULL REFERENCES org_node (id) ON DELETE RESTRICT,
      command_receipt_id uuid REFERENCES command_receipt (id) ON DELETE RESTRICT,
      created_at timestamptz NOT NULL DEFAULT now(),
      created_by text,
      updated_at timestamptz NOT NULL DEFAULT now(),
      updated_by text
    );

    CREATE INDEX IF NOT EXISTS group_shortage_kitting_plant_idx
      ON group_shortage_kitting_result (plant_id);
    CREATE INDEX IF NOT EXISTS group_shortage_kitting_order_idx
      ON group_shortage_kitting_result (order_no);

    COMMENT ON TABLE group_shortage_kitting_result IS
      'G 场景：缺料/齐套检查结果专用表（非投料/排程/CSW 内部判定冒充）';
  `,
  down: /* sql */ `
    DROP TABLE IF EXISTS group_shortage_kitting_result;
    DROP TABLE IF EXISTS group_allocation_revision;
  `,
}
