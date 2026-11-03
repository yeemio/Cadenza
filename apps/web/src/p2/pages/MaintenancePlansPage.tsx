import { useCallback, useState } from 'react'
import { Badge, Button, Message, PageContainer, Select, Table, t as $t } from '@cadenza/ui'
import {
  MAINTENANCE_PLAN_KIND_LABELS,
  type MaintenancePlanDto,
} from '../../../../../packages/ui/src/api/p2'
import { p2Api } from '../api'
import { MAINTENANCE_READ, useP2Permissions } from '../permissions'
import { P2_PAGE_SIZE as PAGE_SIZE, useP2AsyncList } from '../shared'

/**
 * 点检/保养计划页（T19，MT-12）：
 * - 计划版本化（items 为版本快照引用）；超期仅提示，不自动阻断生产（overdue 列展示）；
 * - 执行记录：实际时间＋业务班次双存（IT-37），引用计划版本快照；
 * - Web 只读核对计划与执行；PDA 执行入口（扫码带出档案）见 /p2/equipment-exception。
 */
export function MaintenancePlansPage() {
  const { has } = useP2Permissions()
  const canRead = has(MAINTENANCE_READ)
  const [kind, setKind] = useState('')
  const list = useP2AsyncList(
    (p) => p2Api.listMaintenancePlans({ page: p, pageSize: PAGE_SIZE, kind: kind === '' ? undefined : (kind as MaintenancePlanDto['kind']) }),
    [kind],
  )

  const [detail, setDetail] = useState<(MaintenancePlanDto & { rounds: Array<{ id: string; roundNo: string; passed: boolean; failedNote: string | null; actualAt: string; businessShiftDate: string; shiftName: string; operatorName: string }> }) | null>(null)
  const [detailError, setDetailError] = useState<{ title: string } | null>(null)

  const openDetail = useCallback(async (id: string) => {
    try {
      const row = await p2Api.listMaintenancePlans({ page: 1, pageSize: 100 })
      const found = row.items.find((m) => m.id === id) ?? null
      setDetail(found ? { ...found, rounds: [] } : null)
      setDetailError(found ? null : { title: $t('计划不存在') })
    } catch {
      setDetailError({ title: $t('加载计划失败') })
    }
  }, [])

  if (!canRead) {
    return (
      <PageContainer title={$t('点检/保养计划')} description={$t('版本化计划与执行记录（maintenance 合同 MT-12）')}>
        <Message kind="warning" title={$t('没有维护域查询许可（maintenance.read）')}>
          <p style={{ margin: '4px 0 0' }}>{$t('请在授权管理中为当前角色配置 maintenance.read 后刷新。')}</p>
        </Message>
      </PageContainer>
    )
  }

  return (
    <PageContainer
      title={$t('点检/保养计划')}
      description={$t('执行引用计划版本快照；超期仅提示不自动阻断生产（MT-12）；实际时间与业务班次双存（IT-37）')}
      actions={
        <Select
          aria-label={$t('计划类型')}
          style={{ width: 130 }}
          value={kind}
          onChange={(e) => {
            list.setPage(1)
            setKind(e.target.value)
          }}
          placeholder={$t('全部类型')}
          options={Object.entries(MAINTENANCE_PLAN_KIND_LABELS).map(([v, label]) => ({ value: v, label }))}
        />
      }
    >
      {list.error ? <Message kind="error" title={list.error.title} detail={list.error.detail} /> : null}
      {detailError ? <Message kind="error" title={detailError.title} /> : null}
      <Table<MaintenancePlanDto>
        loading={list.loading}
        columns={[
          { key: 'planNo', title: $t('计划号') },
          { key: 'equipmentCode', title: $t('设备') },
          {
            key: 'kind',
            title: $t('类型'),
            render: (m) => <Badge tone={m.kind === 'inspection' ? 'info' : 'warning'}>{MAINTENANCE_PLAN_KIND_LABELS[m.kind]}</Badge>,
          },
          { key: 'periodRule', title: $t('周期') },
          { key: 'version', title: $t('版本（快照引用）') },
          { key: 'effectiveFrom', title: $t('生效自') },
          { key: 'lastRoundAt', title: $t('上次执行'), render: (m) => (m.lastRoundAt ? new Date(m.lastRoundAt).toLocaleString('zh-CN') : '—') },
          { key: 'nextDueAt', title: $t('下次到期'), render: (m) => (m.nextDueAt ? new Date(m.nextDueAt).toLocaleString('zh-CN') : '—') },
          {
            key: 'overdue',
            title: $t('超期提示（MT-12）'),
            render: (m) => (m.overdue ? <Badge tone="danger">{$t('已超期（不阻断生产）')}</Badge> : <Badge tone="success">{$t('正常')}</Badge>),
          },
          {
            key: 'items',
            title: $t('检查项'),
            render: (m) => (
              <ul style={{ margin: 0, paddingLeft: 16, fontSize: 12.5 }}>
                {m.items.map((it) => (
                  <li key={it.itemNo}>
                    {it.itemName}{$t('：')}{it.standard}
                  </li>
                ))}
              </ul>
            ),
          },
          {
            key: 'actions',
            title: $t('操作'),
            render: (m) => (
              <Button size="sm" variant="secondary" onClick={() => void openDetail(m.id)}>
                {$t('详情')}
              </Button>
            ),
          },
        ]}
        rows={list.items}
        rowKey={(m) => m.id}
        page={{ page: list.page, pageSize: PAGE_SIZE }}
        total={list.total}
        onPageChange={list.setPage}
        emptyText={$t('暂无点检/保养计划')}
      />
      {detail ? (
        <section style={{ marginTop: 14 }}>
          <h4 style={{ margin: '0 0 6px' }}>{$t('计划')} {detail.planNo} {$t('检查项（版本')} {detail.version} {$t('快照）')}</h4>
          <Table
            columns={[
              { key: 'itemNo', title: $t('项号') },
              { key: 'itemName', title: $t('检查项') },
              { key: 'standard', title: $t('标准') },
            ]}
            rows={detail.items}
            rowKey={(i) => i.itemNo}
            emptyText={$t('无检查项')}
          />
          <p style={{ fontSize: 12.5, color: 'var(--cz-color-text-secondary)' }}>
            {$t('执行记录在 PDA 提交（业务班次双存 IT-37）；Web 侧执行轮次列表随后端 rounds 查询面提供（对账清单登记）。')}
          </p>
        </section>
      ) : null}
    </PageContainer>
  )
}
