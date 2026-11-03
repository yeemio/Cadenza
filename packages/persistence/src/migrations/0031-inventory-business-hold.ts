import type { Migration } from './index'

/** Independent business custody: no quality change, reservation expiry or implicit release. */
export const migration0031: Migration = {
  version: '0031',
  name: 'inventory-business-hold',
  up: /* sql */ `
    CREATE TABLE inventory_business_hold (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      unit_id uuid NOT NULL REFERENCES inventory_unit(id) ON DELETE RESTRICT,
      enterprise_id uuid NOT NULL REFERENCES org_node(id) ON DELETE RESTRICT,
      plant_id uuid NOT NULL REFERENCES org_node(id) ON DELETE RESTRICT,
      reason text NOT NULL CHECK (btrim(reason) <> ''),
      business_ref text NOT NULL CHECK (btrim(business_ref) <> ''),
      command_receipt_id uuid NOT NULL REFERENCES command_receipt(id) ON DELETE RESTRICT,
      actor_user_id uuid NOT NULL REFERENCES user_account(id) ON DELETE RESTRICT,
      actor_login_name text NOT NULL,
      created_at timestamptz NOT NULL,
      UNIQUE (enterprise_id, unit_id, business_ref)
    );
    CREATE INDEX inventory_business_hold_scope_idx ON inventory_business_hold(enterprise_id, plant_id, unit_id);
    COMMENT ON TABLE inventory_business_hold IS 'Unresolved physical business hold; independent of quality/reservation; no release or expiry in this delivery';
  `,
  down: /* sql */ `DROP TABLE inventory_business_hold;`,
}
