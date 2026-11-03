import { ApiError, Badge, Message, formatErrorTitleAndDetail, type PdaTaskDto, t as $t, tx as $tx } from '@cadenza/ui'
import { useEffect, useState } from 'react'
import { api } from '../api'

/**
 * 任务列表占位页：大卡片、数量与单位同时呈现（PC-06）。
 * - 等待生产任务端点交付（live 模式下真实请求返回 404 ERR_NOT_FOUND 时转为占位空态并显式标注）；
 *   401 由客户端统一回调跳登录；403 范围拒绝按错误渲染；
 * - mock 模式显示演示任务数据（"演示数据"标识）；任务认领/报工命令属后续域 WorkItem（PC-11）。
 */
export function TasksPage() {
  const [tasks, setTasks] = useState<PdaTaskDto[]>([])
  const [error, setError] = useState<{ title: string; detail?: string } | null>(null)
  const [placeholder, setPlaceholder] = useState(false)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let alive = true
    api
      .listTasks({ page: 1, pageSize: 20 })
      .then((r) => {
        if (!alive) return
        setTasks(r.items)
        setError(null)
        setPlaceholder(false)
      })
      .catch((err) => {
        if (!alive) return
        if (err instanceof ApiError && err.httpStatus === 404) {
          // 后端 PDA 任务端点未交付（本波保持占位并标注）
          setPlaceholder(true)
          setError(null)
          return
        }
        setError(err instanceof ApiError ? formatErrorTitleAndDetail(err) : { title: $t('加载任务失败') })
      })
      .finally(() => {
        if (alive) setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [])

  const statusBadge = (t: PdaTaskDto) =>
    t.status === 'DONE' ? (
      <Badge tone="success">{$t('已完成')}</Badge>
    ) : t.status === 'IN_PROGRESS' ? (
      <Badge tone="info">{$t('进行中')}</Badge>
    ) : (
      <Badge tone="warning">{$t('待处理')}</Badge>
    )

  return (
    <section>
      <h2 style={{ fontSize: 17, margin: '0 0 10px' }}>{$t('我的任务')}</h2>
      {error ? <Message kind="error" title={error.title} detail={error.detail} /> : null}
      {placeholder ? (
        <Message kind="info" title={$t('任务数据待接入')}>
          <p style={{ margin: '4px 0 0' }}>
            {$t('等待生产任务端点交付（本页保持占位，不做演示数据）：登录会话已通过真实 /auth/login 与 /auth/me 校验， 生产域任务端点就绪后在此呈现任务列表。')}
          </p>
        </Message>
      ) : loading ? (
        <p style={{ color: 'var(--cz-color-text-secondary)' }}>{$t('加载中…')}</p>
      ) : tasks.length === 0 && !error ? (
        <p style={{ color: 'var(--cz-color-text-secondary)' }}>{$t('暂无任务')}</p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {tasks.map((t) => (
            <article
              key={t.id}
              style={{
                background: 'var(--cz-color-bg-surface)',
                border: '1px solid var(--cz-color-border)',
                borderRadius: 10,
                padding: '14px 16px',
                minHeight: 72,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <strong style={{ fontSize: 16, flex: 1 }}>{$tx(t.title)}</strong>
                {statusBadge(t)}
              </div>
              <div style={{ fontSize: 13, color: 'var(--cz-color-text-secondary)', marginTop: 6 }}>
                {$t('订单')} {t.orderNo} {$t('｜ 工序')} {t.processName}
              </div>
              <div style={{ fontSize: 14, marginTop: 4 }}>
                {$t('数量')} <b>{t.quantity}</b> {t.unit}
              </div>
            </article>
          ))}
        </div>
      )}
    </section>
  )
}
