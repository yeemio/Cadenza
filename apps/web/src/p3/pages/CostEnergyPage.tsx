import { useCallback, useEffect, useMemo, useState } from 'react'
import { Badge, Button, Field, Input, Message, PageContainer, Table, t as $t, tx as $tx } from '@cadenza/ui'
import { formatP3Error, type CostMeterView, type CostOeeResponse } from '../../../../../packages/ui/src/api/p3'
import { createWebP3Client } from '../client'
import { COST_READ, useP3Permissions } from '../permissions'

/**
 * 能源单耗页（CE-09/CE-10 + CE-S3，端点对齐落盘 apps/api/src/cost）：
 * - 表计清单先行（计量表/覆盖范围/采样来源/单位——先明确清单与覆盖，再算单耗，CE-09）；
 * - 能源单耗：实测与估算分列（CE-03）、覆盖率（实测覆盖用量/总用量）显著标注；
 *   产出为零或全缺 → 单耗显示缺项，不以 0 冒充（CE-03）；
 * - OEE 按设备＋时间窗查询：分母齐备后才计算，缺项展示缺项而非假百分比（CE-10/GAP-S1）。
 */

const ENERGY_TYPE_LABELS: Record<string, string> = { electric: '电', water: '水', gas: '气' }
const COVERAGE_LABELS: Record<string, string> = { equipment: '设备级', workshop: '车间级' }
const SAMPLE_SOURCE_LABELS: Record<string, string> = { ot: 'OT 表计样本', manual: '人工抄表' }

export function CostEnergyPage() {
  const { has, plantId } = useP3Permissions()
  const canRead = has(COST_READ)
  const client = useMemo(() => createWebP3Client(), [])
  const [error, setError] = useState<{ title: string; detail?: string } | null>(null)

  // ---------------- 表计清单（CE-S3/CE-09） ----------------
  const [meters, setMeters] = useState<CostMeterView[]>([])

  // ---------------- 能源单耗（CE-09：实测/估算分列 + 覆盖率） ----------------
  const [intensity, setIntensity] = useState<Array<{
    runId: string
    orderNo: string | null
    productFamilyId: string | null
    shiftDate: string
    meteredUsage: string
    estimatedUsage: string
    coverageRatio: string | null
    uomCode: string | null
    outputQty: string
    intensityPerOutput: string | null
  }> | null>(null)

  // ---------------- OEE 查询（CE-10） ----------------
  const [equipmentCode, setEquipmentCode] = useState('EQU-0007')
  const [windowStart, setWindowStart] = useState('2026-10-27T08:00')
  const [windowEnd, setWindowEnd] = useState('2026-10-27T20:00')
  const [oee, setOee] = useState<CostOeeResponse | null>(null)
  const [oeeBusy, setOeeBusy] = useState(false)

  const load = useCallback(() => {
    if (!canRead) return
    client
      .costListMeters({ page: 1, pageSize: 20, plantId: plantId ?? undefined })
      .then((page) => setMeters(page.items))
      .catch((err: unknown) => setError(formatP3Error(err as { code?: string; message?: string; requestId?: string })))
    client
      .costEnergyIntensity({ page: 1, pageSize: 20, plantId: plantId ?? undefined })
      .then((resp) => setIntensity(resp.items))
      .catch(() => setIntensity([]))
  }, [canRead, client, plantId])

  useEffect(() => {
    load()
  }, [load])

  const queryOee = async () => {
    setOeeBusy(true)
    setError(null)
    try {
      const result = await client.costOee({
        plantId: plantId ?? 'n-plant',
        equipmentCode: equipmentCode.trim(),
        windowStart: `${windowStart}:00+08:00`,
        windowEnd: `${windowEnd}:00+08:00`,
      })
      setOee(result)
    } catch (err) {
      setOee(null)
      setError(formatP3Error(err as { code?: string; message?: string; requestId?: string }))
    } finally {
      setOeeBusy(false)
    }
  }

  if (!canRead) {
    return (
      <PageContainer title={$t('能源单耗')} description={$t('能源单耗与覆盖率、OEE 缺项口径（CE-09/CE-10）')}>
        <Message kind="warning" title={$t('无能源单耗权限（cost.read）')}>{$t('未授予成本域查询许可，请联系管理员授权后使用。')}</Message>
      </PageContainer>
    )
  }

  return (
    <PageContainer
      title={$t('能源单耗')}
      description={$t('先明确计量表清单、采样覆盖与分摊版本，再计算单耗；覆盖不足按估算并显著标注（CE-09）；分摊默认工序机时占比（CE-12，取值 GAP-E21 待裁）')}
    >
      {error ? <Message kind="error" title={error.title} detail={error.detail} /> : null}

      <h3 style={{ fontSize: 15, margin: '0 0 8px' }}>{$t('计量表清单（CE-S3：表计身份/类型/覆盖范围/采样来源/单位）')}</h3>
      <Table
        columns={[
          { key: 'meterCode', title: $t('表计') },
          { key: 'meterName', title: $t('名称'), render: (m) => m.meterName ?? '—' },
          { key: 'energyType', title: $t('类型'), render: (m) => $tx(ENERGY_TYPE_LABELS[String(m.energyType)]) ?? String(m.energyType) },
          { key: 'coverageKind', title: $t('覆盖'), render: (m) => $tx(COVERAGE_LABELS[String(m.coverageKind)]) ?? String(m.coverageKind) },
          { key: 'sampleSource', title: $t('采样来源'), render: (m) => $tx(SAMPLE_SOURCE_LABELS[String(m.sampleSource)]) ?? String(m.sampleSource) },
          { key: 'otPointId', title: $t('OT 点位'), render: (m) => m.otPointId ?? '—' },
          { key: 'uomCode', title: $t('单位') },
          { key: 'status', title: $t('状态'), render: (m) => (m.status === 'active' ? <Badge tone="success">{$t('在用')}</Badge> : $t('停用')) },
        ]}
        rows={meters}
        rowKey={(m) => m.id}
        loading={meters.length === 0}
        emptyText={$t('暂无表计配置')}
      />

      <h3 style={{ fontSize: 15, margin: '16px 0 8px' }}>{$t('能源单耗（实测与估算分列，CE-03/09；覆盖率＝实测覆盖用量/总用量）')}</h3>
      <Table
        columns={[
          { key: 'orderNo', title: $t('订单'), render: (l) => l.orderNo ?? '—' },
          { key: 'productFamilyId', title: $t('产品族'), render: (l) => l.productFamilyId ?? '—' },
          { key: 'shiftDate', title: $t('班次') },
          { key: 'meteredUsage', title: $t('实测用量'), render: (l) => `${l.meteredUsage}${l.uomCode ? ` ${l.uomCode}` : ''}` },
          {
            key: 'estimatedUsage',
            title: $t('估算用量'),
            render: (l) => (Number(l.estimatedUsage) > 0 ? <Badge tone="warning">{l.estimatedUsage}{l.uomCode ? ` ${l.uomCode}` : ''}{$t('（估算，显著标注）')}</Badge> : '0'),
          },
          {
            key: 'coverageRatio',
            title: $t('覆盖率'),
            render: (l) =>
              l.coverageRatio === null ? (
                '—'
              ) : Number(l.coverageRatio) >= 1 ? (
                <Badge tone="success">100%</Badge>
              ) : Number(l.coverageRatio) <= 0 ? (
                <Badge tone="danger">{$t('0%（表计未装，全估算）')}</Badge>
              ) : (
                <Badge tone="warning">{(Number(l.coverageRatio) * 100).toFixed(1)}%</Badge>
              ),
          },
          { key: 'outputQty', title: $t('产出量') },
          {
            key: 'intensityPerOutput',
            title: $t('单耗（总用量/产出）'),
            render: (l) => (l.intensityPerOutput === null ? <Badge tone="warning">{$t('缺项（产出为零或全缺，不以 0 冒充）')}</Badge> : `${l.intensityPerOutput}${l.uomCode ? ` ${l.uomCode}` : ''}`),
          },
        ]}
        rows={intensity ?? []}
        rowKey={(l) => l.runId}
        loading={intensity === null}
        emptyText={$t('暂无能源数据（先执行归集）')}
      />

      <h3 style={{ fontSize: 15, margin: '16px 0 8px' }}>{$t('设备绩效 OEE（CE-10：按设备＋时间窗查询；分母齐备后才计算）')}</h3>
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 12 }}>
        <div style={{ minWidth: 160 }}>
          <Field label={$t('设备编码')} required>
            <Input value={equipmentCode} onChange={(e) => setEquipmentCode(e.target.value)} aria-label={$t('设备编码')} />
          </Field>
        </div>
        <div style={{ minWidth: 200 }}>
          <Field label={$t('窗口起（本地时间）')} required>
            <Input value={windowStart} onChange={(e) => setWindowStart(e.target.value)} aria-label={$t('窗口起')} />
          </Field>
        </div>
        <div style={{ minWidth: 200 }}>
          <Field label={$t('窗口止（本地时间）')} required>
            <Input value={windowEnd} onChange={(e) => setWindowEnd(e.target.value)} aria-label={$t('窗口止')} />
          </Field>
        </div>
        <div style={{ paddingTop: 26 }}>
          <Button loading={oeeBusy} onClick={() => void queryOee()}>{$t('查询 OEE')}</Button>
        </div>
      </div>

      {oee !== null ? (
        <>
          <Table
            columns={[
              { key: 'equipmentCode', title: $t('设备') },
              { key: 'window', title: $t('窗口'), render: () => `${oee.windowStart.slice(0, 16)} ~ ${oee.windowEnd.slice(0, 16)}` },
              { key: 'availability', title: $t('可用率'), render: () => pct(oee.availability) },
              { key: 'performance', title: $t('性能'), render: () => pct(oee.performance) },
              { key: 'qualityRate', title: $t('质量率'), render: () => pct(oee.qualityRate) },
              { key: 'oee', title: 'OEE', render: () => pct(oee.oee) },
            ]}
            rows={[oee]}
            rowKey={() => oee.equipmentId}
          />
          <p style={{ fontSize: 12, color: 'var(--cz-color-text-secondary)', marginTop: 6 }}>
            {$t('计划分钟')} {oee.plannedMinutes ?? '—'}{$t('｜停机分钟')} {oee.downtimeMinutes ?? '—'}{$t('｜标准速度')} {oee.standardSpeedPerHour ?? '—'}
            {oee.stdRateText ? $t('（主档文本「{p0}」，仅纯数值才作为分母）', { p0: oee.stdRateText }) : ''}{$t('｜产出')} {oee.actualOutputQty ?? '—'}{$t('｜合格')} {oee.qualifiedQty ?? '—'}
          </p>
          {oee.missing.length > 0 ? (
            <Message kind="warning" title={$t('OEE 缺项（分母未齐备，不以假百分比冒充，CE-10）')}>
              <ul style={{ margin: '4px 0 0 18px', padding: 0 }}>
                {oee.missing.map((m) => (
                  <li key={m}>{oee.equipmentCode}{$t('：')}{m}</li>
                ))}
              </ul>
            </Message>
          ) : null}
        </>
      ) : (
        <Message kind="info" title={$t('输入设备编码与时间窗后查询（演示：EQU-0001 全齐备 / EQU-0007 缺项）')} />
      )}
    </PageContainer>
  )
}

function pct(v: string | null): React.ReactNode {
  if (v === null) return <Badge tone="warning">{$t('缺项')}</Badge>
  return `${(Number(v) * 100).toFixed(1)}%`
}
