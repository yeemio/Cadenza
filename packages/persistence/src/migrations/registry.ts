import type { Migration } from './index'
import { migration0001 } from './0001-platform'
import { migration0002 } from './0002-org-auth'
import { migration0003 } from './0003-master-data'
import { migration0004 } from './0004-inventory-trace'
import { migration0005 } from './0005-process-order'
import { migration0006 } from './0006-purchase'
import { migration0007 } from './0007-scheduling'
import { migration0008 } from './0008-execution'
import { migration0009 } from './0009-quality-warehousing'
import { migration0010 } from './0010-shipping'
import { migration0011 } from './0011-rework'
import { migration0012 } from './0012-conversion-form'
import { migration0013 } from './0013-warehouse-reverse'
import { migration0014 } from './0014-quality-disposition'
import { migration0015 } from './0015-maintenance'
import { migration0016 } from './0016-reporting'
import { migration0017 } from './0017-ot-collection'
import { migration0018 } from './0018-constrained-scheduling'
import { migration0019 } from './0019-process-change-spc'
import { migration0020 } from './0020-cost-energy'
import { migration0021 } from './0021-ai-query'
import { migration0022 } from './0022-material-inbound'
import { migration0023 } from './0023-quality-hold-plant'
import { migration0024 } from './0024-group-allocation-shortage'
import { migration0025 } from './0025-p1-throwback-apis'
import { migration0026 } from './0026-p2-rework-scrap-write'
import { migration0027 } from './0027-sap-reconciliation'
import { migration0028 } from './0028-sap-recon-full-classification'
import { migration0029 } from './0029-sap-sim-facts'
import { migration0030 } from './0030-ai-seam-tables'
import { migration0031 } from './0031-inventory-business-hold'

/** 全部已注册迁移（版本字符串排序即应用顺序）。
 *  [L0-整合标记] 2026-10-28 P2/P4 整合轮注册 0011–0016（P2 六域）+ 0021（P4 AI 问数）。
 *  2026-10-30 P4 五内部接缝补齐轮注册 0030（apps/ai 运行事件留档 + 一次性 IM 绑定码）。 */
export const migrations: readonly Migration[] = [
  migration0001,
  migration0002,
  migration0003,
  migration0004,
  migration0005,
  migration0006,
  migration0007,
  migration0008,
  migration0009,
  migration0010,
  migration0011,
  migration0012,
  migration0013,
  migration0014,
  migration0015,
  migration0016,
  migration0017,
  migration0018,
  migration0019,
  migration0020,
  migration0021,
  migration0022,
  migration0023,
  migration0024,
  migration0025,
  migration0026,
  migration0027,
  migration0028,
  migration0029,
  migration0030,
  migration0031,
]
