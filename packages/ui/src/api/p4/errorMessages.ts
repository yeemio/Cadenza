/**
 * P4 问数规则码中文映射（P4-UI 线新增）。
 *
 * 规则号来源：`architecture/contracts/frozen/p4/capability-contract.md`（AQ-REG/AQ-AMB/AQ-AUTH）
 * 与 `frozen/p4/architecture.md`（AR 系，含红线）；服务端可理解文案携带 `[AQ-xx-x]`/`[AR-xx-x]`
 * 规则码（AQ-REG-07 message 承载位）。未收录码回退既有 `formatErrorTitleAndDetail`
 * （PC-14/15：中文首发、服务端原文并入 detail）。
 */

import { formatErrorTitleAndDetail } from '../errorMessages'
import { getGlobalLocale } from '../../i18n/global'
import { t } from '../../i18n/translate'
import { AIQUERY_RULE_MESSAGES_KO } from './errorMessages.ko'

export const AIQUERY_RULE_MESSAGES_ZH: Record<string, string> = {
  // capability-contract.md §0 机制总则
  'AQ-REG-01': '该问法未注册为受控问数能力（或属未就绪问法族），请换个问法或到对应业务页面查询',
  'AQ-REG-07': '查询结果已附完整性与时效标注：未取全的数据不会被总结为完整总量',
  'AQ-REG-08': '查询成功且读面有对象时数值为零也是有效结果；无匹配记录才会提示无数据',
  'AQ-REG-10': '查询超时或失败已如实返回，不会伪装成「无数据」；可稍后重试',
  // §5 歧义澄清
  'AQ-AMB-01': '命中的订单不止一张，请在候选清单中选择一张后继续（不会自行替您择一作答）',
  'AQ-AMB-02': '未指定时间范围时按「最近 7 个自然日」查询，实际生效起止已回显，可修改后重问',
  'AQ-AMB-03': '缺口数量口径未定（BOM 基数语义未冻结），首版固定标注「口径未定」，不给猜测数值',
  // §6 权限与执行上下文
  'AQ-AUTH-01': '问数权限按当前登录状态实时校验：账号权限变化后下一次提问即按新权限执行',
  'AQ-AUTH-02': '无 AI 问数权限（aiquery.use）或缺少对应业务域读权限，请联系管理员授权后再使用',
  'AQ-AUTH-03': '查询范围已按您的数据授权收敛：工厂不在授权范围内的数据不可见',
  'AQ-AUTH-04': '企业/用户身份由登录会话绑定，不可通过提问文本或参数指定',
  // frozen/p4/architecture.md（含红线）
  'AR-04': '详情将在既有业务页面打开：仍需登录且有相应权限（链接可见不等于内容可见）',
  'AR-11': 'AI 问数暂不可用：生产业务不受影响，可稍后重试或到业务页面查询',
  'AR-12': '问数请求超时已按失败返回，不会无限等待；可稍后重试',
  'AR-14': '问数接入层暂时不可用（如审计存储异常），失败不会被伪装成「无数据」',
}

/**
 * 从服务端 message 提取 P4 规则码：覆盖 `[AQ-REG-07]`/`[AQ-AMB-01]`/`[AQ-AUTH-02]`/
 * `[AQ-C1-1]`/`[AQ-C2-2]` 与无中段的 `[AR-04]`/`[AR-11]`；无则 null。
 */
export function aiQueryRuleCodeOf(message: string | undefined | null): string | null {
  if (!message) return null
  const m = /\[((?:AQ|AR)(?:-[A-Z0-9]+)+)\]/.exec(message)
  return m ? m[0].slice(1, -1) : null
}

/**
 * 组装问数错误展示（PC-14 口径）：
 * 规则码已收录 → 可行动中文指引为主文案；服务端原文与规则码并入 detail；
 * 未收录 → 回退既有 formatErrorTitleAndDetail（平台 7 码与 OA/MD/IT 映射不回归）。
 */
export function formatAiQueryError(err: {
  code?: string
  message?: string
  requestId?: string
}): { title: string; detail?: string } {
  const rule = aiQueryRuleCodeOf(err.message)
  const table = getGlobalLocale() === 'ko-KR' ? AIQUERY_RULE_MESSAGES_KO : AIQUERY_RULE_MESSAGES_ZH
  if (rule !== null && table[rule]) {
    const parts: string[] = []
    if (err.message) parts.push(err.message)
    if (err.requestId) parts.push(t('请求标识：{p0}', { p0: err.requestId }))
    return { title: table[rule], detail: parts.length > 0 ? parts.join('；') : undefined }
  }
  return formatErrorTitleAndDetail(err)
}
