import { Message, PageContainer, t as $t } from '@cadenza/ui'
import { Link } from 'react-router-dom'

/**
 * E09 退料/退货/质量恢复入口：复用已挂 P2 reverse 与质量 holds 恢复。
 */
export function ReturnRestoreHubPage() {
  return (
    <PageContainer
      title={$t('退料/退货/质量恢复')}
      description={$t('E09 RETURN-RESTORE 专用入口（复用 P2 仓储逆向 + 存疑隔离恢复）')}
    >
      <Message kind="info" title={$t('已挂可用路径')}>
        <ul style={{ margin: '8px 0 0', paddingLeft: 18 }}>
          <li>
            {$t('逆向台账：')}<Link to="/p2/reverse/ledger">/p2/reverse/ledger</Link>
          </li>
          <li>
            {$t('调拨出入库：')}<Link to="/p2/reverse/transfer">/p2/reverse/transfer</Link>
          </li>
          <li>
            {$t('采购批次纠正（退货相关）：')}
            <Link to="/p2/reverse/receipt">/p2/reverse/receipt</Link>
          </li>
          <li>
            {$t('质量恢复（holds 恢复列）：')}
            <Link to="/quality/holds">/quality/holds</Link>
          </li>
        </ul>
      </Message>
      <div
        className="cz-table__empty"
        style={{
          marginTop: 16,
          padding: 24,
          border: '1px dashed var(--cz-color-border)',
          borderRadius: 8,
          textAlign: 'center',
          color: 'var(--cz-color-text-secondary)',
        }}
        role="status"
      >
        {$t('请从上方深链进入退料/退货/质量恢复作业面')}
      </div>
    </PageContainer>
  )
}
