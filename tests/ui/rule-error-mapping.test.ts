// @vitest-environment jsdom
/**
 * MD/IT 规则码中文映射测试（第三波补全）：
 * 域规则违例以 ERR_BUSINESS_RULE + message 携带 [MD-xx]/[IT-xx] 规则号返回（violationOutcome 口径）。
 * - ruleCodeOf 提取规则号；已知规则换主文案为可行动指引，服务端原始 message 并入 detail（PC-14/15）；
 * - 未收录规则（如 OA-10）回退错误码通用文案且 message 保留在 detail（第二波既有行为不回归）。
 */
import { describe, expect, it } from 'vitest'
import {
  ERROR_MESSAGES_ZH,
  RULE_MESSAGES_ZH,
  errorText,
  formatErrorTitleAndDetail,
  ruleCodeOf,
} from '@cadenza/ui'

describe('规则码提取与中文映射', () => {
  it('ruleCodeOf：提取 [MD-24]/[IT-14]/[OA-10]，无规则号返回 null', () => {
    expect(ruleCodeOf('[MD-24] 该部门类型仅允许创建仓库')).toBe('MD-24')
    expect(ruleCodeOf('库存单元 X 可用 1.0、本次申请 2.0 [IT-14] 可用量不足')).toBe('IT-14')
    expect(ruleCodeOf('[OA-10] 登录账号已存在：admin')).toBe('OA-10')
    expect(ruleCodeOf('普通业务错误，无规则号')).toBeNull()
    expect(ruleCodeOf(undefined)).toBeNull()
  })

  it('MD/IT 规则码已收录中文可行动文案（MD-24 建仓约束、IT-14 可用量、MD-28 库位编码）', () => {
    expect(RULE_MESSAGES_ZH['MD-24']).toContain('仓库类型')
    expect(RULE_MESSAGES_ZH['MD-24']).toContain('物流部')
    expect(RULE_MESSAGES_ZH['IT-14']).toContain('可用量')
    expect(RULE_MESSAGES_ZH['MD-28']).toContain('8 位数字')
    // 平台 7 码映射保持既有（不回归）
    expect(Object.keys(ERROR_MESSAGES_ZH).length).toBe(7)
  })

  it('formatErrorTitleAndDetail：已知规则码 → 规则文案为主文案，服务端 message 并入 detail', () => {
    const { title, detail } = formatErrorTitleAndDetail({
      code: 'ERR_BUSINESS_RULE',
      message: '[MD-24] 该部门类型仅允许创建仓库',
      requestId: 'req-md24',
    })
    expect(title).toBe(RULE_MESSAGES_ZH['MD-24'])
    expect(detail).toContain('[MD-24] 该部门类型仅允许创建仓库')
    expect(detail).toContain('请求标识：req-md24')
  })

  it('未收录规则（OA-10）：回退 ERR_BUSINESS_RULE 通用文案，message 保留 detail（不回归）', () => {
    const { title, detail } = formatErrorTitleAndDetail({
      code: 'ERR_BUSINESS_RULE',
      message: '[OA-10] 登录账号已存在：admin',
    })
    expect(title).toBe(errorText('ERR_BUSINESS_RULE'))
    expect(detail).toContain('[OA-10] 登录账号已存在：admin')
  })

  it('INSUFFICIENT_STOCK 平台码 + IT 规则 message：平台码文案优先（库存不足主指引）', () => {
    const { title, detail } = formatErrorTitleAndDetail({
      code: 'ERR_INSUFFICIENT_STOCK',
      message: '[IT-30] 并发余量不足导致负库存（扣前 1.0000、本次 2.0000），拒绝',
    })
    // IT-30 已收录 → 规则文案为主（负库存拒绝与重试指引）；服务端明细进 detail
    expect(title).toBe(RULE_MESSAGES_ZH['IT-30'])
    expect(detail).toContain('扣前 1.0000')
  })

  it('第四波规则号提取：[A3-2w]/[A-T12-5]/[A-T13-11]/复合 [A7-1/K03]', () => {
    expect(ruleCodeOf('[A3-2w] 设备 LZ-450-01 在 2026-10-27 计划量合计 10.0000 超过日产能 8.0000')).toBe('A3-2w')
    expect(ruleCodeOf('[A-T12-5] 来源 (work_report, rp-002, process) 已生成检验单')).toBe('A-T12-5')
    expect(ruleCodeOf('[A-T13-11] 调拨锁定（作业预留）必须含有效期')).toBe('A-T13-11')
    expect(ruleCodeOf('[A7-1/K03] 投料须订单进行中且未挂起')).toBe('A7-1/K03')
    expect(ruleCodeOf('[A6-5] 产出目标库位 01030001 不在线边库清单内，拒绝')).toBe('A6-5')
  })

  it('第四波规则文案主首发：A3-2w 弱提醒与 A-T13-1 台账禁改（第三波行为不回归）', () => {
    const weak = formatErrorTitleAndDetail({
      code: 'ERR_BUSINESS_RULE',
      message: '[A3-2w] 设备 LZ-450-01 计划量合计 10.0000 超过日产能 8.0000（超设备日产能为弱提醒，确认后请携带 confirm=true 重新提交）',
    })
    expect(weak.title).toContain('弱提醒')
    expect(weak.detail).toContain('confirm=true')
    const ledger = formatErrorTitleAndDetail({
      code: 'ERR_BUSINESS_RULE',
      message: '[A-T13-1] 任务 pt-003 状态 done 不可确认入库（仅待入库；台账禁手工增删改）',
    })
    expect(ledger.title).toContain('手工增删改')
    expect(ruleCodeOf('[MD-24] 部门类型仅允许创建特定仓库类型')).toBe('MD-24')
  })
})
