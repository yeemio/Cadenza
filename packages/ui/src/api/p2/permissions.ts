/**
 * P2 六域岗位操作许可常量（P2-UI 线）。
 *
 * 形状镜像 P1 先例（apps/web/src/permissions.ts ↔ domain/<域>/permissions.ts 同值镜像）。
 * 对账注意：P2-A~F 后端线尚未落地 rework/conversionform/reverse/disposition/maintenance/
 * reporting 域的 permissions.ts；本表许可串为按既有命名惯例（<域>.read / <域>.post）
 * 的先行定义，L0 整合时以后端 domain 落地值为准逐串核对（交付记录对账清单已登记）。
 * 服务端守卫终校（PC-10）：前端显隐仅为一道提示。
 */
export const REWORK_READ = 'rework.read'
export const REWORK_POST = 'rework.post'
export const CONVERSION_READ = 'conversion.read'
export const CONVERSION_POST = 'conversion.post'
export const REVERSE_READ = 'reverse.read'
export const REVERSE_POST = 'reverse.post'
export const DISPOSITION_READ = 'disposition.read'
export const DISPOSITION_POST = 'disposition.post'
export const MAINTENANCE_READ = 'maintenance.read'
export const MAINTENANCE_POST = 'maintenance.post'
export const REPORTING_READ = 'reporting.read'

/** P2 全集（mock 演示模式 admin 合并用，先例：L3 三/四波 mock admin 许可合并） */
export const P2_ALL_PERMISSIONS: readonly string[] = [
  REWORK_READ,
  REWORK_POST,
  CONVERSION_READ,
  CONVERSION_POST,
  REVERSE_READ,
  REVERSE_POST,
  DISPOSITION_READ,
  DISPOSITION_POST,
  MAINTENANCE_READ,
  MAINTENANCE_POST,
  REPORTING_READ,
]
