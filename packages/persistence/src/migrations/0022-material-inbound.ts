import type { Migration } from './index'

/**
 * 0022 料品入站修订列（IF-01 / IF-00.3）。
 *
 * 为 material 主表追加 external_revision（整数，可空），承载上游修订号乱序保护：
 * 低于已应用 → stale 不覆盖；等于 → 幂等重放；高于 → 应用新版。
 * 业务键仍是 (org_scope, code) active 唯一（MD-S1）+ 公司组织编码（IF-01）；
 * inbox/external_mapping 去重与隔离沿用 0001/0002，本迁移不新建表。
 *
 * GAP-B9（删除/停用传导、增量/全量）不在本迁移范围。
 */
export const migration0022: Migration = {
  version: '0022',
  name: 'material-inbound-revision',
  up: /* sql */ `
    ALTER TABLE material
      ADD COLUMN IF NOT EXISTS external_revision integer;

    COMMENT ON COLUMN material.external_revision IS
      'IF-01/IF-00.3：上游料品主数据外部修订号；入站同步乱序保护（stale/幂等/应用）';
  `,
  down: /* sql */ `
    ALTER TABLE material DROP COLUMN IF EXISTS external_revision;
  `,
}
