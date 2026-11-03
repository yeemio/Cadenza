/**
 * 问数 UI 组件出口（P4-UI 线新增；未并入 packages/ui/src/index.ts——零共享文件，
 * 消费方经相对路径导入 `…/packages/ui/src/aiquery`。[L0-整合标记] 并桶归 L0）。
 */

export { AiResultCard, AiExplainNote } from './AiResultCard'
export { AiClarifyPanel } from './AiClarifyPanel'
export { AiUnavailableNotice } from './AiUnavailableNotice'
