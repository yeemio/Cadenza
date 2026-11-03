/**
 * P3 域 API 层出口（P3-UI 线新增；零共享文件——未并入 packages/ui/src/index.ts，
 * 消费方经相对路径导入：apps `…/packages/ui/src/api/p3`、tests `../../packages/ui/src/api/p3`。
 * [L0-整合标记] 并桶导出归 L0，先例 P2-UI/P4-UI 决策同型）。
 */

export * from './types'
export * from './errorMessages'
export * from './permissions'
export * from './client'
