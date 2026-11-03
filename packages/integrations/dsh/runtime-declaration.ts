/**
 * DSH 运行时版本声明（dsh-edge.md DS-14）。
 *
 * 单一只读常量；产品启动可读回实际组成（GET /ai-runtime/health 的 runtime 字段，AR-11）。
 * 真实 DSH 包 / Profile / 插件版本选定前，declaration 保持 mock 占位且 profileRef=null；
 * 版本选择 = SITE_PENDING（GAP-P1），未授权不得引入真实包依赖（DS-25）。
 */
export interface DshRuntimeDeclaration {
  readonly kind: 'mock' | 'real'
  readonly version: string
  readonly profileRef: string | null
}

/** 冻结的运行时声明：mock-1，无 Profile 引用。 */
export const DSH_RUNTIME_DECLARATION: DshRuntimeDeclaration = {
  kind: 'mock',
  version: 'mock-1',
  profileRef: null,
} as const
