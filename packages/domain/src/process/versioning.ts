import { ProcessRuleViolation } from './errors'

/**
 * 工艺版本状态轴与冻结规则 —— [底稿 A2-2]（DM §4.1：订单下达冻结快照、
 * 订单引用已发布版本；published 后内容不可改，变更须生成新版本）。
 *
 * 状态轴：draft → reviewed → published → retired（reviewed 为中间态；
 * 本块命令面为 create/update/publish/retire，publish 允许自 draft 或 reviewed 发起）。
 * 库层另有 0005 冻结触发器双保险（published 内容列禁改、retired 终态禁改禁删）。
 */

export type ProcessRevisionStatus = 'draft' | 'reviewed' | 'published' | 'retired'

export const PROCESS_REVISION_STATUS_VALUES: readonly ProcessRevisionStatus[] = [
  'draft',
  'reviewed',
  'published',
  'retired',
]

/** 校验状态字典值。 */
export function assertRevisionStatus(status: string): asserts status is ProcessRevisionStatus {
  if (!PROCESS_REVISION_STATUS_VALUES.includes(status as ProcessRevisionStatus)) {
    throw new ProcessRuleViolation(
      'A2-2',
      `工艺版本状态必须为 ${PROCESS_REVISION_STATUS_VALUES.join('/')}：${status}`,
    )
  }
}

/** [底稿 A2-2] published 后内容不可改（PATCH 拒绝）；retired 为终态。 */
export function assertRevisionContentMutable(status: ProcessRevisionStatus): void {
  if (status === 'published') {
    throw new ProcessRuleViolation('A2-2', '已发布版本内容不可修改（发布后冻结，变更须生成新版本）')
  }
  if (status === 'retired') {
    throw new ProcessRuleViolation('A2-2', '已失效版本为终态，不可修改')
  }
}

/** [底稿 A2-2] 发布前置：draft/reviewed 可发布；published 重复发布拒绝；retired 终态拒绝。 */
export function assertRevisionPublishable(status: ProcessRevisionStatus): void {
  if (status === 'published') {
    throw new ProcessRuleViolation('A2-2', '版本已发布，不可重复发布（如需变更请生成新版本后发布）')
  }
  if (status === 'retired') {
    throw new ProcessRuleViolation('A2-2', '已失效版本不可发布')
  }
}

/** [底稿 A2-2] 失效前置：retired 不可重复失效。 */
export function assertRevisionRetirable(status: ProcessRevisionStatus): void {
  if (status === 'retired') {
    throw new ProcessRuleViolation('A2-2', '版本已失效，无须重复失效')
  }
}

/** [底稿 A2-2] 同对象至多一条 published 版本（命令层前置；库层 partial unique 双保险）。 */
export function assertNoExistingPublishedVersion(facts: { publishedExists: boolean }): void {
  if (facts.publishedExists) {
    throw new ProcessRuleViolation(
      'A2-2',
      '同对象已存在已发布版本（发布新版本前须先失效旧版本，保持至多一条 published）',
    )
  }
}

/** 下一个版本号 = 既有最大版本 + 1（无版本则 1）。 */
export function nextRevisionVersion(existingVersions: readonly number[]): number {
  return existingVersions.reduce((max, v) => (v > max ? v : max), 0) + 1
}
