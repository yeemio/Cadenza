// @vitest-environment jsdom
/**
 * P2 规则码中文映射测试（P2-UI 线；先例 rule-error-mapping.test.ts）：
 * 六域规则违例以 ERR_BUSINESS_RULE + message 携带 [RS/FC/WR/QD/MT/RP-xx] 返回；
 * - p2RuleCodeOf 提取六前缀规则号；
 * - 已知规则换主文案为可行动指引，服务端原始 message 并入 detail（PC-14/15）；
 * - 未收录规则回退既有 formatErrorTitleAndDetail（P1 平台 7 码 + MD/IT/OA/A 系不回归）。
 */
import { describe, expect, it } from 'vitest'
import { errorText } from '@cadenza/ui'
import {
  P2_RULE_MESSAGES_ZH,
  formatP2ErrorTitleAndDetail,
  p2RuleCodeOf,
} from '../../packages/ui/src/api/p2'

describe('P2 规则码提取（p2RuleCodeOf）', () => {
  it('提取 [RS-01]/[FC-05]/[WR-24]/[QD-08]/[MT-10]/[RP-03]；无规则号返回 null', () => {
    expect(p2RuleCodeOf('[RS-01] 倒轴守恒式不成立')).toBe('RS-01')
    expect(p2RuleCodeOf('同一"销售单号+行号"不可重复加入 [FC-05]')).toBe('FC-05')
    expect(p2RuleCodeOf('[WR-24] 仓库盘点锁定中')).toBe('WR-24')
    expect(p2RuleCodeOf('[QD-08] 审核通过扣数必须记录去向')).toBe('QD-08')
    expect(p2RuleCodeOf('[MT-10] 复机仅待复机状态可执行')).toBe('MT-10')
    expect(p2RuleCodeOf('数量÷0.3048 截取 4 位 [RP-03]')).toBe('RP-03')
    expect(p2RuleCodeOf('普通业务错误，无规则号')).toBeNull()
    expect(p2RuleCodeOf(undefined)).toBeNull()
  })

  it('不误捕非 P2 前缀（[MD-24]/[IT-14] 返回 null，归既有映射）', () => {
    expect(p2RuleCodeOf('[MD-24] 该部门类型仅允许创建仓库')).toBeNull()
    expect(p2RuleCodeOf('[IT-14] 可用量不足')).toBeNull()
  })
})

describe('P2 规则码中文映射覆盖（六域关键条款）', () => {
  it('T15 rework-split：守恒式/前置拒绝/损耗原因/占用核权', () => {
    expect(P2_RULE_MESSAGES_ZH['RS-01']).toContain('守恒式')
    expect(P2_RULE_MESSAGES_ZH['RS-03']).toContain('前置拒绝')
    expect(P2_RULE_MESSAGES_ZH['RS-11']).toContain('损耗原因')
    expect(P2_RULE_MESSAGES_ZH['RS-30']).toContain('占用')
  })

  it('T16 form-conversion：两协议分立/编辑门/恢复路径', () => {
    expect(P2_RULE_MESSAGES_ZH['FC-01']).toContain('两套业务')
    expect(P2_RULE_MESSAGES_ZH['FC-06']).toContain('尚无任何扫码')
    expect(P2_RULE_MESSAGES_ZH['FC-15']).toContain('不再推 U9')
  })

  it('T17 warehouse-reverse：移库/盘点锁定/下游拦截', () => {
    expect(P2_RULE_MESSAGES_ZH['WR-02']).toContain('同仓库')
    expect(P2_RULE_MESSAGES_ZH['WR-24']).toContain('盘点')
    expect(P2_RULE_MESSAGES_ZH['WR-22']).toContain('下游')
  })

  it('T18 quality-disposition：存疑拦截/去向/复检一次', () => {
    expect(P2_RULE_MESSAGES_ZH['QD-04']).toContain('存疑')
    expect(P2_RULE_MESSAGES_ZH['QD-08']).toContain('去向')
    expect(P2_RULE_MESSAGES_ZH['QD-14']).toContain('复检仅一次')
  })

  it('T19 maintenance：状态字典/状态机/复机事务', () => {
    expect(P2_RULE_MESSAGES_ZH['MT-01']).toContain('1=正常、2=维修')
    expect(P2_RULE_MESSAGES_ZH['MT-07']).toContain('越级')
    expect(P2_RULE_MESSAGES_ZH['MT-10']).toContain('一次事务')
  })

  it('T20 reporting：口径/英尺/不以 0 冒充', () => {
    expect(P2_RULE_MESSAGES_ZH['RP-01']).toContain('汇总')
    expect(P2_RULE_MESSAGES_ZH['RP-03']).toContain('0.3048')
    expect(P2_RULE_MESSAGES_ZH['RP-21']).toContain('不以 0 冒充')
  })
})

describe('formatP2ErrorTitleAndDetail（PC-14/15）', () => {
  it('已知 P2 规则码 → P2 可行动文案为主文案，服务端 message 并入 detail', () => {
    const { title, detail } = formatP2ErrorTitleAndDetail({
      code: 'ERR_BUSINESS_RULE',
      message: '[WR-24] 仓库盘点锁定中：WH-F01',
      requestId: 'req-wr24',
    })
    expect(title).toBe(P2_RULE_MESSAGES_ZH['WR-24'])
    expect(detail).toContain('[WR-24] 仓库盘点锁定中：WH-F01')
    expect(detail).toContain('请求标识：req-wr24')
  })

  it('P2 规则优先于 P1 映射：同 message 含 [RS-xx] 时不回退平台文案', () => {
    const { title } = formatP2ErrorTitleAndDetail({
      code: 'ERR_BUSINESS_RULE',
      message: '[RS-02] 倒入数量须大于 0',
    })
    expect(title).toBe(P2_RULE_MESSAGES_ZH['RS-02'])
    expect(title).not.toBe(errorText('ERR_BUSINESS_RULE'))
  })

  it('未收录 P2 规则号：回退既有映射（行为不回归）', () => {
    const { title, detail } = formatP2ErrorTitleAndDetail({
      code: 'ERR_BUSINESS_RULE',
      message: '[RP-99] 未收录的规则',
    })
    expect(title).toBe(errorText('ERR_BUSINESS_RULE'))
    expect(detail).toContain('[RP-99] 未收录的规则')
  })

  it('无规则号（P1 平台码）：完全走既有 formatErrorTitleAndDetail', () => {
    const { title } = formatP2ErrorTitleAndDetail({
      code: 'ERR_UNAUTHORIZED',
      message: '登录会话已过期',
    })
    expect(title).toBe(errorText('ERR_UNAUTHORIZED'))
  })
})
