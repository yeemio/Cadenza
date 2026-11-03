/**
 * P3 四域岗位操作许可常量（P3-UI 线）。
 *
 * 形状镜像 P1/P2 先例（apps/web/src/permissions.ts ↔ domain/<域>/permissions.ts 同值镜像）。
 * 对账：四域 domain 许可已全部落盘（2026-10-28 核对）——
 * - ot：packages/domain/src/ot/permissions.ts（ot.read / ot.post）；
 * - spc：packages/domain/src/spc/permissions.ts（spc.read / spc.post）；
 * - csw：packages/domain/src/csw/permissions.ts（csw.read / csw.post / csw.unfreeze）；
 * - cost：packages/domain/src/cost/permissions.ts（cost.read / cost.post——P3-D 线落盘，
 *   本线早期 PROPOSED 假设与落盘值一致，交付记录 §对账已闭合）。
 * 服务端守卫终校（PC-10）：前端显隐仅为一道提示。
 */
export const OT_READ = 'ot.read'
export const OT_POST = 'ot.post'
export const SPC_READ = 'spc.read'
export const SPC_POST = 'spc.post'
export const CSW_READ = 'csw.read'
export const CSW_POST = 'csw.post'
export const CSW_UNFREEZE = 'csw.unfreeze'
export const COST_READ = 'cost.read'
export const COST_POST = 'cost.post'

/** P3 全集（mock 演示模式 admin 合并用，先例：P2-UI/L3 波次 mock admin 许可合并） */
export const P3_ALL_PERMISSIONS: readonly string[] = [
  OT_READ,
  OT_POST,
  SPC_READ,
  SPC_POST,
  CSW_READ,
  CSW_POST,
  CSW_UNFREEZE,
  COST_READ,
  COST_POST,
]
