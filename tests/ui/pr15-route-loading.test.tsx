// @vitest-environment jsdom
// Real React/Router components with the existing local mock API. No real API, device or performance claim.
import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { lazy, type ComponentType } from 'react'
import { Link, MemoryRouter, useLocation } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LocaleProvider, LocaleSelect, MOCK_DEMO_ACCOUNT, MOCK_DEMO_PASSWORD, t } from '@cadenza/ui'
import { App as WebApp } from '../../apps/web/src/App'
import { App as PdaApp } from '../../apps/pda/src/App'
import { PageBoundary as WebBoundary } from '../../apps/web/src/loading/mount'
import { PageBoundary as PdaBoundary } from '../../apps/pda/src/loading/mount'
import * as web from '../../apps/web/src/api'
import * as pda from '../../apps/pda/src/api'

afterEach(() => vi.restoreAllMocks())
function Location() { const location = useLocation(); return <output data-testid="route-location">{location.pathname + location.search}</output> }
function show(App: ComponentType, route: string) {
  return render(<MemoryRouter initialEntries={[route]}><App /><Location /></MemoryRouter>)
}
async function session(app: 'web' | 'pda', restricted = false) {
  const connection = app === 'web' ? web : pda
  const auth = await connection.api.login({ loginName: MOCK_DEMO_ACCOUNT, password: MOCK_DEMO_PASSWORD, platform: app === 'web' ? 'WEB' : 'PDA' })
  connection.setPendingToken(auth.token)
  try {
    const me = await connection.api.me()
    connection.saveSession({ token: auth.token, expiresAt: auth.expiresAt, user: { ...me.user, ...(restricted ? { loginName: 'pr15-limited' } : {}) },
      permissions: restricted ? [] : me.permissions, dataScope: me.dataScope })
  } finally { connection.setPendingToken(null) }
}
async function login() {
  const user = userEvent.setup()
  await user.type(screen.getByLabelText(/登录账号/), MOCK_DEMO_ACCOUNT)
  await user.type(screen.getByLabelText(/密码/), MOCK_DEMO_PASSWORD)
  await user.click(screen.getByRole('button', { name: '登录' }))
}
describe('lazy routes retain login and direct URL behavior', () => {
  for (const [app, App, route] of [['web', WebApp, '/inventory/units'], ['pda', PdaApp, '/scan']] as const) {
    it(app + ' unauthenticated deep link reaches the eager login page', async () => {
      show(App, route)
      expect(await screen.findByRole('button', { name: '登录' })).toBeInTheDocument()
      expect(screen.getByTestId('route-location')).toHaveTextContent('/login')
      expect(screen.queryByText('页面加载中…')).not.toBeInTheDocument()
    })
    it(app + ' real mock-login flow returns to its original lazy destination', async () => {
      show(App, route); await login()
      await waitFor(() => expect(screen.getByTestId('route-location').textContent).toBe(route))
      if (app === 'web') expect(await screen.findByRole('heading', { name: '单元详情' })).toBeInTheDocument()
      else expect(await screen.findByText('等待扫码')).toBeInTheDocument()
    })
  }
  it('authenticated Web direct URL retains the query value when the route chunk arrives', async () => {
    await session('web'); show(WebApp, '/inventory/units?unitNo=PR15-QUERY')
    expect(await screen.findByDisplayValue('PR15-QUERY')).toBeInTheDocument()
    expect(screen.getByTestId('route-location')).toHaveTextContent('?unitNo=PR15-QUERY')
  })
  it('P2 and P3 navigation modules retain their direct lazy destinations', async () => {
    await session('web'); const first = show(WebApp, '/p2/quality/suspect')
    expect(await screen.findByRole('heading', { name: '质量存疑' })).toBeInTheDocument(); first.unmount()
    show(WebApp, '/spc/calibration')
    expect(await screen.findByRole('heading', { name: '计量校准' })).toBeInTheDocument()
  })
  for (const [route, message] of [['/inventory/units', '没有库存查询许可（inventory.read）'], ['/spc/calibration', '无 SPC 查询权限（spc.read）'], ['/ai/query', '无 AI 问数权限（aiquery.use）']]) {
    it('direct ' + route + ' retains its existing permission refusal after lazy import', async () => {
      await session('web', true); show(WebApp, route)
      expect(await screen.findByText(message)).toBeInTheDocument()
    })
  }
  it('PDA scan input works after lazy loading in Chinese and Korean', async () => {
    await session('pda'); show(PdaApp, '/scan'); const user = userEvent.setup()
    await screen.findByText('等待扫码')
    await user.type(screen.getByRole('textbox'), 'MO-PR15{enter}')
    expect(await screen.findByText('识别成功：生产订单码')).toBeInTheDocument()
    await user.selectOptions(screen.getByTestId('locale-select'), 'ko-KR')
    await user.type(screen.getByRole('textbox'), 'MO-PR15-KO{enter}')
    expect(await screen.findByText(t('识别成功：生产订单码'))).toBeInTheDocument()
    expect(screen.getByTestId('route-location').textContent).toBe('/scan')
  })
})
describe('page-only Suspense/error boundary behavior', () => {
  for (const [name, Boundary] of [['web', WebBoundary], ['pda', PdaBoundary]] as const) {
    it(name + ' preserves navigation while loading and updates the loading language', async () => {
      let finish!: (value: { default: ComponentType }) => void
      const Delayed = lazy(() => new Promise<{ default: ComponentType }>((resolve) => { finish = resolve }))
      render(<MemoryRouter><LocaleProvider><nav>navigation remains</nav><LocaleSelect /><Boundary><Delayed /></Boundary></LocaleProvider></MemoryRouter>)
      expect(screen.getByRole('navigation')).toBeVisible(); expect(screen.getByRole('status')).toHaveTextContent('页面加载中')
      await userEvent.setup().selectOptions(screen.getByTestId('locale-select'), 'ko-KR')
      expect(screen.getByRole('status')).toHaveTextContent('페이지를 불러오는 중')
      await act(async () => { finish({ default: () => <h1>Loaded page</h1> }) })
      expect(await screen.findByRole('heading', { name: 'Loaded page' })).toBeInTheDocument()
      expect(screen.queryByRole('status')).not.toBeInTheDocument()
    })
    it(name + ' shows an explicit reload action on chunk rejection in both languages', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {})
      const Broken = lazy(() => Promise.reject(new Error('synthetic chunk failure')))
      render(<MemoryRouter><LocaleProvider><LocaleSelect /><Boundary><Broken /></Boundary></LocaleProvider></MemoryRouter>)
      expect(await screen.findByRole('alert')).toHaveTextContent('页面暂时无法显示')
      expect(screen.getByRole('button', { name: '重新加载' })).toBeEnabled()
      await userEvent.setup().selectOptions(screen.getByTestId('locale-select'), 'ko-KR')
      expect(await screen.findByRole('button', { name: '다시 불러오기' })).toBeEnabled()
    })
    it(name + ' a failed page does not prevent navigation to another route', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {})
      function Broken(): never { throw new Error('synthetic page failure') }
      function Content() { return useLocation().pathname === '/broken' ? <Broken /> : <p>Healthy destination</p> }
      render(<MemoryRouter initialEntries={['/broken']}><LocaleProvider><Link to="/healthy">Continue</Link><Boundary><Content /></Boundary></LocaleProvider></MemoryRouter>)
      await screen.findByRole('alert'); await userEvent.setup().click(screen.getByRole('link', { name: 'Continue' }))
      expect(await screen.findByText('Healthy destination')).toBeInTheDocument()
    })
  }
})
