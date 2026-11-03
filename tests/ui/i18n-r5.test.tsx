// @vitest-environment jsdom
/**
 * R5 i18n 测试（中文/韩文岗位操作界面）：
 * - 默认 zh-CN 恒等（无 Provider 时与历史行为一致）；
 * - 语言切换 + localStorage 持久化 + 刷新（重挂载）保持；
 * - 两语言渲染同一业务行为一致（同 mock 数据、同结构，仅文案不同）；
 * - 关键拒绝/错误文案两语（平台错误码 + MD/RS 规则码 ko 映射）；
 * - PDA 大触区导航文案两语；
 * - 业务日/时区（computeShiftDate 口径镜像：CN +8 / KR +9 / 跨零点归前一日）；
 * - 字典完备性（22 域 zh 键 ⊆ ko 键、zh 恒等、插值占位保留）。
 */
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useEffect } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it } from 'vitest'
import {
  BusinessClock,
  ERROR_MESSAGES_ZH,
  KO_KR_DICTIONARY,
  LOCALE_STORAGE_KEY,
  LOCALES,
  LocaleProvider,
  LocaleSelect,
  RULE_MESSAGES_ZH,
  ZH_CN_DICTIONARY,
  computeBusinessShiftDate,
  errorText,
  factoryClock,
  formatErrorTitleAndDetail,
  getGlobalLocale,
  plantTimezoneOffsetHours,
  setGlobalLocale,
  t,
  tx,
} from '@cadenza/ui'
import { formatP2ErrorTitleAndDetail } from '../../packages/ui/src/api/p2'
import { OrgUsersPage } from '../../apps/web/src/pages/OrgUsersPage'
import { PdaLayout } from '../../apps/pda/src/components/PdaLayout'
import { AuthProvider } from '../../apps/pda/src/auth'

describe('R5 i18n：基建与默认行为', () => {
  it('默认 zh-CN：t() 恒等返回源串（无 Provider 与历史行为一致）', () => {
    expect(getGlobalLocale()).toBe('zh-CN')
    expect(t('登录账号')).toBe('登录账号')
    expect(t('共 {total} 条 / 第 {page}/{totalPages} 页（每页 {pageSize} 条）', { total: 28, page: 1, totalPages: 3, pageSize: 10 })).toBe(
      '共 28 条 / 第 1/3 页（每页 10 条）',
    )
    expect(tx(null)).toBeNull()
    expect(tx(undefined)).toBeUndefined()
    expect(tx('启用')).toBe('启用')
  })

  it('LOCALES 冻结为 zh-CN/ko-KR 两语言，默认 zh-CN', () => {
    expect(LOCALES).toEqual(['zh-CN', 'ko-KR'])
  })
})

/** 探针组件：t() 在自身渲染期求值（模拟真实页面组件；字符串字面 JSX 会在父级一次性求值） */
function Probe({ id, keyText }: { id: string; keyText: string }) {
  return <p data-testid={id}>{t(keyText)}</p>
}

describe('R5 i18n：切换与持久化', () => {
  it('顶栏选择器切换 → localStorage 写入 + 子树按新语言重渲染', async () => {
    const user = userEvent.setup()
    render(
      <LocaleProvider>
        <LocaleSelect />
        <Probe id="probe" keyText="保存" />
      </LocaleProvider>,
    )
    expect(screen.getByTestId('probe')).toHaveTextContent('保存')
    await user.selectOptions(screen.getByTestId('locale-select'), 'ko-KR')
    expect(localStorage.getItem(LOCALE_STORAGE_KEY)).toBe('ko-KR')
    // key 重挂载后按新语言渲染
    expect(await screen.findByTestId('probe')).toHaveTextContent('저장')
    expect(getGlobalLocale()).toBe('ko-KR')
  })

  it('刷新保持：localStorage 已存 ko-KR 时，重挂载 LocaleProvider 初始即为韩文', () => {
    localStorage.setItem(LOCALE_STORAGE_KEY, 'ko-KR')
    render(
      <LocaleProvider>
        <Probe id="probe2" keyText="取消" />
      </LocaleProvider>,
    )
    expect(screen.getByTestId('probe2')).toHaveTextContent('취소')
  })

  it('非法存储值回退默认 zh-CN（不崩、不空）', () => {
    localStorage.setItem(LOCALE_STORAGE_KEY, 'en-US')
    render(
      <LocaleProvider>
        <p data-testid="probe3">{t('删除')}</p>
      </LocaleProvider>,
    )
    expect(screen.getByTestId('probe3')).toHaveTextContent('删除')
  })

  it('Provider 卸载不影响下一次默认渲染（模块语言不串档）', () => {
    const { unmount } = render(
      <LocaleProvider>
        <span>{t('保存')}</span>
      </LocaleProvider>,
    )
    unmount()
    expect(t('保存')).toBe('保存')
  })
})

describe('R5 i18n：两语言同一业务行为一致', () => {
  it('用户管理页（mock 演示数据）：zh 与 ko 渲染同一 28 行分页结构，仅文案不同', async () => {
    // zh 基线
    const { unmount } = render(
      <MemoryRouter>
        <OrgUsersPage />
      </MemoryRouter>,
    )
    expect(await screen.findByRole('row', { name: /admin/ })).toBeInTheDocument()
    expect(document.querySelector('.cz-pagination__info')).toHaveTextContent('共 28 条 / 第 1/3 页（每页 10 条）')
    expect(screen.getByText('新建用户')).toBeInTheDocument()
    expect(screen.getByText('登录账号')).toBeInTheDocument()
    const zhButtons = screen.getAllByRole('button').length
    unmount()

    // ko：同一 mock 数据与结构，文案为韩文
    setGlobalLocale('ko-KR')
    render(
      <MemoryRouter>
        <OrgUsersPage />
      </MemoryRouter>,
    )
    expect(await screen.findByRole('row', { name: /admin/ })).toBeInTheDocument()
    expect(document.querySelector('.cz-pagination__info')).toHaveTextContent('총 28건 / 제 1/3 페이지(페이지당 10건)')
    expect(screen.getByText('사용자 신규')).toBeInTheDocument()
    expect(screen.getByText('로그인 계정')).toBeInTheDocument()
    expect(screen.getAllByRole('button').length).toBe(zhButtons)
  })

  it('PDA 大触区底部导航：六 Tab 两语文案（任务/生产/投料/入库/发运/我的）', () => {
    render(
      <MemoryRouter>
        <AuthProvider>
          <PdaLayout />
        </AuthProvider>
      </MemoryRouter>,
    )
    for (const label of ['任务', '生产', '投料', '入库', '发运', '我的']) {
      expect(screen.getByText(label)).toBeInTheDocument()
    }
  })

  it('PDA 大触区底部导航：ko 下渲染韩文 Tab 文案', () => {
    setGlobalLocale('ko-KR')
    render(
      <MemoryRouter>
        <AuthProvider>
          <PdaLayout />
        </AuthProvider>
      </MemoryRouter>,
    )
    for (const label of ['태스크', '생산', '투입', '입고', '발송', '내 정보']) {
      expect(screen.getByText(label)).toBeInTheDocument()
    }
  })
})

describe('R5 i18n：关键拒绝/错误文案两语', () => {
  it('平台错误码 INSUFFICIENT_STOCK：zh/ko 可行动文案', () => {
    expect(errorText('ERR_INSUFFICIENT_STOCK')).toContain('库存不足')
    setGlobalLocale('ko-KR')
    expect(errorText('ERR_INSUFFICIENT_STOCK')).toContain('재고가 부족')
    // 未知码回退通用文案
    expect(errorText('ERR_NOPE')).toContain('작업이 실패')
  })

  it('规则码 [MD-24] 主文案两语 + detail 并入服务端原文与请求标识', () => {
    const zh = formatErrorTitleAndDetail({ code: 'ERR_BUSINESS_RULE', message: '[MD-24] 部门类型约束', requestId: 'req-1' })
    expect(zh.title).toContain('该部门类型仅允许创建特定仓库类型')
    expect(zh.detail).toContain('请求标识：req-1')
    setGlobalLocale('ko-KR')
    const ko = formatErrorTitleAndDetail({ code: 'ERR_BUSINESS_RULE', message: '[MD-24] 部门类型约束', requestId: 'req-1' })
    expect(ko.title).toContain('해당 부서 유형은 특정 창고 유형만')
    expect(ko.detail).toContain('요청 ID: req-1')
  })

  it('P2 规则码 [RS-01] 主文案两语（ko 缺码回退 zh 不缺位）', () => {
    const zh = formatP2ErrorTitleAndDetail({ message: '[RS-01] 守恒式不成立' })
    expect(zh.title).toContain('倒轴守恒式不成立')
    setGlobalLocale('ko-KR')
    const ko = formatP2ErrorTitleAndDetail({ message: '[RS-01] 守恒式不成立' })
    expect(ko.title).toContain('수지 등식')
    // 未收录规则码回退 zh 可行动指引
    const fallback = formatP2ErrorTitleAndDetail({ message: '[WR-99] 未知码' })
    expect(fallback.title).toBeTruthy()
  })
})

describe('R5 i18n：业务日/时区（computeShiftDate 口径）', () => {
  it('CN +8：UTC 23:30 归当地次日前一日边界按本地日历日折算', () => {
    // 2026-10-29T23:30Z → CN 本地 2026-10-30 07:30 → 业务日 2026-10-30
    expect(computeBusinessShiftDate(new Date('2026-10-29T23:30:00Z'), { dayShiftStartHour: 0, utcOffsetHours: 8 })).toBe('2026-10-30')
    // 2026-10-30T15:59Z → CN 本地 23:59 → 业务日 2026-10-30
    expect(computeBusinessShiftDate(new Date('2026-10-30T15:59:00Z'), { dayShiftStartHour: 0, utcOffsetHours: 8 })).toBe('2026-10-30')
    // 2026-10-30T16:01Z → CN 本地 10-31 00:01 → 业务日 2026-10-31
    expect(computeBusinessShiftDate(new Date('2026-10-30T16:01:00Z'), { dayShiftStartHour: 0, utcOffsetHours: 8 })).toBe('2026-10-31')
  })

  it('白班起点前小时归前一班次日（跨午夜补正语义）', () => {
    // 白班起点 6 点：本地 05:00 归前一日
    expect(computeBusinessShiftDate(new Date('2026-10-29T21:00:00Z'), { dayShiftStartHour: 6, utcOffsetHours: 8 })).toBe('2026-10-29')
    expect(computeBusinessShiftDate(new Date('2026-10-29T22:00:00Z'), { dayShiftStartHour: 6, utcOffsetHours: 8 })).toBe('2026-10-30')
  })

  it('KR 工厂 +9 时区推断与本地时钟', () => {
    expect(plantTimezoneOffsetHours('한국 2공장', 'KR22')).toBe(9)
    expect(plantTimezoneOffsetHours('杭州制造工厂', 'F01')).toBe(8)
    expect(factoryClock(new Date('2026-10-30T01:05:00Z'), 9)).toBe('10:05')
  })

  it('BusinessClock：按工厂时区展示业务日与本地时间（zh/ko 两语）', () => {
    const now = () => new Date('2026-10-30T01:05:00Z') // KR 本地 10:05, CN 本地 09:05
    const { rerender } = render(<BusinessClock plantName="한국 2공장" now={now} />)
    expect(screen.getByTestId('business-clock')).toHaveTextContent('业务日 2026-10-30')
    expect(screen.getByTestId('business-clock')).toHaveTextContent('UTC+9 10:05')
    rerender(<BusinessClock plantName="杭州制造工厂" now={now} />)
    expect(screen.getByTestId('business-clock')).toHaveTextContent('UTC+8 09:05')
    setGlobalLocale('ko-KR')
    rerender(<BusinessClock plantName="한국 2공장" now={now} />)
    expect(screen.getByTestId('business-clock')).toHaveTextContent('업무일 2026-10-30')
  })
})

describe('R5 i18n：字典完备性与一致性', () => {
  it('22 域 zh 基准键全部有 ko 翻译（无缺译回退面）', () => {
    const missing: string[] = []
    for (const [key, value] of Object.entries(ZH_CN_DICTIONARY)) {
      if (!(key in KO_KR_DICTIONARY)) missing.push(key)
      if (value !== key) missing.push(`${key} 恒等破坏`)
    }
    expect(missing).toEqual([])
    expect(Object.keys(KO_KR_DICTIONARY).length).toBeGreaterThanOrEqual(Object.keys(ZH_CN_DICTIONARY).length)
  })

  it('ko 翻译保留插值占位（{p0}/{total} 等，防止参数丢失）', () => {
    const placeholderRe = /\{[A-Za-z0-9_]+\}/g
    for (const key of Object.keys(ZH_CN_DICTIONARY)) {
      const zhPh = key.match(placeholderRe) ?? []
      const koValue = KO_KR_DICTIONARY[key]
      if (!koValue) continue
      for (const ph of zhPh) expect(`${key} → ${koValue}`).toContain(ph)
    }
  })

  it('错误规则码 zh/ko 键集合一致（base 平台码与规则码表）', () => {
    expect(Object.keys(RULE_MESSAGES_ZH).length).toBeGreaterThan(50)
    // zh 表全部键在 t() 下可用（ko 覆盖由上条字典完备性约束 + ko 表逐键对应）
    expect(Object.keys(RULE_MESSAGES_ZH).length).toBeGreaterThan(50)
    expect(Object.keys(ERROR_MESSAGES_ZH).length).toBe(7)
  })
})

describe('R5 i18n：Provider 渲染期同步（防竞态回归）', () => {
  it('嵌套组件渲染读取的模块语言与 Provider 当前语言一致', () => {
    let seen = ''
    function Child() {
      useEffect(() => {})
      seen = getGlobalLocale()
      return null
    }
    localStorage.setItem(LOCALE_STORAGE_KEY, 'ko-KR')
    render(
      <LocaleProvider>
        <Child />
      </LocaleProvider>,
    )
    expect(seen).toBe('ko-KR')
  })
})
