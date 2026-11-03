import { Message, PageContainer, t as $t } from '@cadenza/ui'
import { Link } from 'react-router-dom'

/** PDA /packing 深链别名 → 发运备货扫码面 */
export function PackingAliasPage() {
  return (
    <PageContainer title={$t('备货/打包')} description={$t('PDA packing 深链（复用发运扫码面）')}>
      <Message kind="info" title={$t('入口已挂')}>
        {$t('请进入')} <Link to="/shipping">{$t('发运扫码 /shipping')}</Link> {$t('进行备货与打包绑定。')}
      </Message>
    </PageContainer>
  )
}
