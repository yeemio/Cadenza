/**
 * P2 六域 API 层出口（P2-UI 线新增；零共享文件——未并入 packages/ui/src/index.ts，
 * 消费方经相对路径导入：apps `…/packages/ui/src/api/p2`、tests `../../packages/ui/src/api/p2`
 * （先例：api/p4/index.ts 同型；并桶导出与裸名子路径支持归 L0 [L0-整合标记]）。
 */

export * from './types'
export * from './permissions'
export * from './errorMessages'
export * from './mock'
export * from './client'
