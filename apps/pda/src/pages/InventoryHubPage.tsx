import { Message, PageContainer, t as $t } from '@cadenza/ui'
import { Link } from 'react-router-dom'

/**
 * PDA 库存/移库可达入口（补 /inventory|/stock|/moves 深链；复用 putaway 与 P2 move）。
 */
export function InventoryHubPage() {
  return (
    <PageContainer title={$t('库存/移库')} description={$t('PDA 库存与移库入口（补齐 inventory/stock/moves 深链）')}>
      <Message kind="info" title={$t('可达作业')}>
        <ul style={{ margin: '8px 0 0', paddingLeft: 18 }}>
          <li>
            {$t('入库扫码：')}<Link to="/putaway">/putaway</Link>
          </li>
          <li>
            {$t('P2 移库：')}<Link to="/p2/move">/p2/move</Link>
          </li>
          <li>
            {$t('调出/调入：')}<Link to="/p2/transfer-out">/p2/transfer-out</Link> ·{' '}
            <Link to="/p2/transfer-in">/p2/transfer-in</Link>
          </li>
        </ul>
      </Message>
    </PageContainer>
  )
}
