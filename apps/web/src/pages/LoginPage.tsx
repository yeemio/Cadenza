import {
  ApiError,
  Button,
  Field,
  Form,
  Input,
  Message,
  MOCK_DEMO_ACCOUNT,
  MOCK_DEMO_PASSWORD,
  formatErrorTitleAndDetail,
  t as $t,
} from '@cadenza/ui'
import { Factory } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { Navigate, useNavigate, useLocation } from 'react-router-dom'
import { isMock } from '../api'
import { useAuth } from '../auth'

/**
 * 登录页（账号密码；UI 现代化换肤，逻辑/合同不变）：
 * - 空字段前端即提示；密码规则（OA-14）由服务端终校，错误经统一错误码中文文案展示；
 * - 失败提示包含失败锁定口径（OA-16：连续失败达到上限将临时锁定，解封由管理员处理）；
 * - 成功后回跳来源路径（PC-17 最小实现）。
 */
export function LoginPage() {
  const { session, login } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()
  const from = (location.state as { from?: string } | null)?.from ?? '/dashboard'

  const [loginName, setLoginName] = useState('')
  const [password, setPassword] = useState('')
  const [fieldErrors, setFieldErrors] = useState<{ loginName?: string; password?: string }>({})
  const [mainError, setMainError] = useState<{ title: string; detail?: string } | null>(null)
  const [submitting, setSubmitting] = useState(false)

  if (session) {
    // 已登录访问登录页 → 直接进入
    return <Navigate to={from} replace />
  }

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setMainError(null)
    const errors: { loginName?: string; password?: string } = {}
    if (!loginName.trim()) errors.loginName = $t('请输入登录账号')
    if (!password) errors.password = $t('请输入密码')
    setFieldErrors(errors)
    if (errors.loginName || errors.password) return
    setSubmitting(true)
    try {
      await login(loginName.trim(), password)
      navigate(from, { replace: true })
    } catch (err) {
      // PC-14：同一次失败只展示一个主错误 + 可行动指引；保留服务端信息供排查
      if (err instanceof ApiError) {
        setMainError(formatErrorTitleAndDetail(err))
      } else {
        setMainError({ title: $t('登录失败，请稍后重试') })
      }
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-background p-5">
      <div className="w-full max-w-sm rounded-xl border bg-card p-8 pb-6 shadow-lg">
        <div className="mb-6 flex flex-col items-center text-center">
          <span className="mb-3.5 flex size-12 items-center justify-center rounded-xl bg-primary text-primary-foreground shadow-sm">
            <Factory className="size-6" aria-hidden />
          </span>
          <h1 className="m-0 text-[22px] leading-tight font-semibold tracking-tight text-foreground">
            {$t('Cadenza 管理工作台')}
          </h1>
          <p className="mt-1.5 mb-0 text-[13px] text-muted-foreground">
            {$t('账号密码登录（线缆制造协同平台）')}
          </p>
        </div>
        {isMock ? (
          <Message kind="warning" title={$t('当前为演示数据模式')}>
            <p className="mt-1 mb-0 text-[12.5px]">
              {$t('演示账号')} {MOCK_DEMO_ACCOUNT} / {MOCK_DEMO_PASSWORD}
            </p>
          </Message>
        ) : null}
        {mainError ? (
          <Message kind="error" title={mainError.title} detail={mainError.detail}>
            <p className="mt-1 mb-0 text-[12.5px] opacity-90">
              {$t('连续多次失败将临时锁定账号；若已被锁定，请联系管理员解封。')}
            </p>
          </Message>
        ) : null}
        <Form onSubmit={(e) => void onSubmit(e)}>
          <Field label={$t('登录账号')} required error={fieldErrors.loginName} htmlFor="login-name">
            <Input
              id="login-name"
              value={loginName}
              autoComplete="username"
              placeholder={$t('字母或数字（OA-10）')}
              invalid={Boolean(fieldErrors.loginName)}
              onChange={(e) => setLoginName(e.target.value)}
            />
          </Field>
          <Field
            label={$t('密码')}
            required
            error={fieldErrors.password}
            htmlFor="login-password"
            hint={$t('8–16 位，须同时包含数字与字母')}
          >
            <Input
              id="login-password"
              type="password"
              value={password}
              autoComplete="current-password"
              invalid={Boolean(fieldErrors.password)}
              onChange={(e) => setPassword(e.target.value)}
            />
          </Field>
          <Button type="submit" block loading={submitting} loadingText={$t("登录中…")}>
            {$t('登录')}
          </Button>
        </Form>
      </div>
    </main>
  )
}
