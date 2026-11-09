import { Component, Suspense, type ReactNode } from 'react'
import { Outlet, useLocation } from 'react-router-dom'
import { useLocale } from '@cadenza/ui'

class PageErrorBoundary extends Component<{ children: ReactNode; fallback: ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() { return { failed: true } }
  render() { return this.state.failed ? this.props.fallback : this.props.children }
}

/** Keeps the authenticated layout/navigation mounted while only the selected page loads. */
export function PageBoundary({ children }: { children: ReactNode }) {
  const { locale } = useLocale()
  const location = useLocation()
  const korean = locale === 'ko-KR'
  const failure = (
    <section role="alert" className="space-y-3 rounded-md border bg-card p-4">
      <p>{korean ? '페이지를 표시할 수 없습니다. 다시 불러와 주세요.' : '页面暂时无法显示，请重新加载。'}</p>
      <button type="button" className="min-h-14 rounded-md border px-4 font-medium" onClick={() => window.location.reload()}>
        {korean ? '다시 불러오기' : '重新加载'}
      </button>
    </section>
  )
  return (
    <PageErrorBoundary key={location.pathname} fallback={failure}>
      <Suspense fallback={<div role="status" aria-live="polite" aria-busy="true" className="min-h-24 p-4 text-muted-foreground">
        {korean ? '페이지를 불러오는 중…' : '页面加载中…'}
      </div>}>
        {children}
      </Suspense>
    </PageErrorBoundary>
  )
}

export function LazyRouteOutlet() {
  return <PageBoundary><Outlet /></PageBoundary>
}
