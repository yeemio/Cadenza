import { Message, PageContainer, t as $t } from '@cadenza/ui'
import { Link } from 'react-router-dom'

/**
 * E09 轴号修正 / 清码（退役）专用入口。
 * 已有 rework 轴号修正与轴码退役 API/台账；本页作专用发现入口，不借通用扫码冒充。
 */
export function CorrectClearPage() {
  return (
    <PageContainer
      title={$t('轴号修正/清码')}
      description={$t('E09 CORRECT/CLEAR 专用入口（对接 rework 轴号修正与轴码退役；非通用扫码冒充）')}
    >
      <Message kind="info" title={$t('已接 P2 倒轴域（修正/清码=退役）')}>
        <ul style={{ margin: '8px 0 0', paddingLeft: 18 }}>
          <li>
            {$t('Web 台账（含「轴号修正」「轴码退役」页签）：')}
            <Link to="/p2/rework">/p2/rework</Link>
          </li>
          <li>
            {$t('PDA 轴号修正：')}<code>/p2/axis-correction</code>
          </li>
          <li>
            {$t('PDA 轴码退役（清码）：')}<code>/p2/axis-retire</code>
          </li>
        </ul>
        {$t('专用列表 API 若需与台账分离的「修正/清码工作队列」，请 L1 另开；当前以 rework 域关闭入口缺口，勿用 通用扫码/报工壳冒充。')}
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
        {$t('请从上方深链进入修正/清码作业面；本页保持 CORRECT/CLEAR 专用标签与可发现性')}
      </div>
    </PageContainer>
  )
}
