import { Button, PageContainer, t as $t } from '@cadenza/ui'
import { useAuth } from '../auth'
import { apiMode } from '../api'

/** 我的：会话信息（用户/企业/工厂/范围，来自 /auth/me）、运行模式、登出（大触区）。 */
export function MePage() {
  const { session, logout } = useAuth()
  const scopeLabel = session?.dataScope.enterpriseWide
    ? $t('企业范围')
    : $t('厂区范围（{p0} 厂）', { p0: session?.dataScope.plantIds.length ?? 0 })
  return (
    <PageContainer title={$t('我的')} description={$t('会话与设备信息')}>
      <section
        style={{
          background: 'var(--cz-color-bg-surface)',
          border: '1px solid var(--cz-color-border)',
          borderRadius: 10,
          padding: '16px 18px',
          display: 'flex',
          flexDirection: 'column',
          gap: 8,
          fontSize: 14,
        }}
      >
        <div>
          {$t('用户：')}<b>{session?.user.displayName ?? '—'}</b>{$t('（')}{session?.user.loginName ?? '—'}{$t('）')}
        </div>
        <div>
          {$t('企业：')}{session?.user.enterpriseName ?? '—'} {$t('｜ 工厂：')}{session?.user.plantName ?? '—'}
        </div>
        <div>
          {$t('角色：')}{session?.user.roleName ?? '—'} {$t('｜ 数据范围：')}{scopeLabel}
        </div>
        <div>{$t('运行模式：')}{apiMode === 'mock' ? $t('演示数据（mock）') : $t('真实接口（live）')}</div>
      </section>
      <div style={{ marginTop: 18 }}>
        <Button size="lg" variant="danger" block onClick={() => void logout()}>
          {$t('退出登录')}
        </Button>
      </div>
    </PageContainer>
  )
}
