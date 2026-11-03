import { t } from './i18n'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { cn } from './cn'

export interface TreeNode {
  id: string
  name: string
  code?: string
  /** 附加标记（如机构类型），以纯文本展示 */
  tag?: string
  children?: TreeNode[]
}

export interface TreeProps {
  nodes: ReadonlyArray<TreeNode>
  selectedId?: string | null
  onSelect?: (id: string) => void
  /** 默认全部展开 */
  defaultExpanded?: boolean
  emptyText?: string
}

export function Tree({
  nodes,
  selectedId,
  onSelect,
  defaultExpanded = true,
  emptyText = t('暂无数据'),
}: TreeProps) {
  if (nodes.length === 0) {
    return (
      <div className="cz-tree__hint text-[13px] text-muted-foreground" data-slot="tree-empty">
        {emptyText}
      </div>
    )
  }
  return (
    <ul className="m-0 list-none p-0 text-sm" role="tree" data-slot="tree">
      {nodes.map((node) => (
        <TreeItem
          key={node.id}
          node={node}
          selectedId={selectedId}
          onSelect={onSelect}
          defaultExpanded={defaultExpanded}
          depth={0}
        />
      ))}
    </ul>
  )
}

function TreeItem({
  node,
  selectedId,
  onSelect,
  defaultExpanded,
  depth,
}: {
  node: TreeNode
  selectedId?: string | null
  onSelect?: (id: string) => void
  defaultExpanded: boolean
  depth: number
}) {
  const [expanded, setExpanded] = useState(defaultExpanded)
  const hasChildren = Boolean(node.children && node.children.length > 0)
  const selected = selectedId === node.id
  const toggle: ReactNode = hasChildren ? (
    <button
      type="button"
      className="flex size-[18px] shrink-0 cursor-pointer items-center justify-center rounded-sm text-muted-foreground transition-colors outline-none hover:bg-muted hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/35"
      aria-label={expanded ? t('收起') : t('展开')}
      aria-expanded={expanded}
      onClick={(e) => {
        e.stopPropagation()
        setExpanded((v) => !v)
      }}
    >
      {expanded ? (
        <ChevronDown className="size-3.5" aria-hidden />
      ) : (
        <ChevronRight className="size-3.5" aria-hidden />
      )}
    </button>
  ) : (
    <span className="size-[18px] shrink-0" aria-hidden />
  )

  return (
    <li role="treeitem" aria-expanded={hasChildren ? expanded : undefined}>
      <div
        className={cn(
          'flex cursor-pointer items-center gap-1.5 rounded-md px-2 py-1.5 transition-colors',
          selected
            ? 'bg-primary/10 font-semibold text-primary'
            : 'text-foreground hover:bg-accent',
        )}
        onClick={() => onSelect?.(node.id)}
      >
        {toggle}
        <span className="truncate">{node.name}</span>
        {node.tag ? (
          <span className="rounded-sm border border-border bg-muted px-1 text-[11.5px] leading-4 text-muted-foreground">
            {node.tag}
          </span>
        ) : null}
      </div>
      {hasChildren && expanded ? (
        <ul className="m-0 list-none pl-4">
          {node.children!.map((child) => (
            <TreeItem
              key={child.id}
              node={child}
              selectedId={selectedId}
              onSelect={onSelect}
              defaultExpanded={defaultExpanded}
              depth={depth + 1}
            />
          ))}
        </ul>
      ) : null}
    </li>
  )
}
