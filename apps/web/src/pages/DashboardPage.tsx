import { PageContainer, t as $t } from '@cadenza/ui'
import { Boxes, ClipboardCheck, Truck, type LucideIcon } from 'lucide-react'

/**
 * 看板占位页（骨架，UI 现代化卡片化）。
 * PC-11：未交付能力不显示可用按钮——本页只描述规划内容，不放置任何可操作入口。
 */
export function DashboardPage() {
  const planned: Array<{ title: string; desc: string; icon: LucideIcon }> = [
    { title: $t('生产执行总览'), desc: $t('各车间在制、完工与异常概况（后续 WorkItem 交付）'), icon: ClipboardCheck },
    { title: $t('质量与批次'), desc: $t('批次合格率与不良分布（后续 WorkItem 交付）'), icon: Boxes },
    { title: $t('库存与物流'), desc: $t('关键库位容量与发运节奏（后续 WorkItem 交付）'), icon: Truck },
  ]
  return (
    <PageContainer title={$t('看板')} description={$t('管理驾驶舱占位骨架：统计卡片与图表由后续功能域 WorkItem 交付')}>
      <div className="grid grid-cols-[repeat(auto-fit,minmax(280px,1fr))] gap-4">
        {planned.map((card) => (
          <section
            key={card.title}
            className="relative overflow-hidden rounded-xl border bg-card p-5 shadow-xs transition-shadow hover:shadow-md"
          >
            <span className="absolute inset-y-0 left-0 w-1 bg-primary/70" aria-hidden />
            <div className="mb-3 flex items-center gap-2.5">
              <span className="flex size-9 items-center justify-center rounded-lg bg-primary/10 text-primary">
                <card.icon className="size-4.5" aria-hidden />
              </span>
              <h3 className="m-0 text-[15px] font-semibold text-foreground">{card.title}</h3>
            </div>
            <p className="m-0 text-[13px] leading-relaxed text-muted-foreground">{card.desc}</p>
          </section>
        ))}
      </div>
    </PageContainer>
  )
}
