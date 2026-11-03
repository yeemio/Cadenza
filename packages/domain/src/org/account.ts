import { DEPT_CATEGORY } from './org-node'
import { OrgRuleViolation } from './errors'

/**
 * 用户账号纯规则 —— 对应冻结合同 org-auth.md §2：OA-10～OA-16。
 */

/** OA-10 登录账号字符集：仅允许字母与数字。 */
export const LOGIN_NAME_PATTERN = /^[A-Za-z0-9]+$/

export function assertLoginNameValid(loginName: string): void {
  if (!LOGIN_NAME_PATTERN.test(loginName)) {
    throw new OrgRuleViolation('OA-10', '登录账号全局唯一，字符集仅允许字母与数字')
  }
}

/** OA-14 密码规则：8–16 位，必须同时含数字与字母。 */
export const PASSWORD_MIN_LENGTH = 8
export const PASSWORD_MAX_LENGTH = 16

export function isCompliantPassword(password: string): boolean {
  if (password.length < PASSWORD_MIN_LENGTH || password.length > PASSWORD_MAX_LENGTH) {
    return false
  }
  return /[0-9]/.test(password) && /[A-Za-z]/.test(password)
}

export function assertCompliantPassword(password: string): void {
  if (!isCompliantPassword(password)) {
    throw new OrgRuleViolation('OA-14', '密码须 8–16 位且同时包含数字与字母')
  }
}

/** OA-12 登录平台必填字典。 */
export const LOGIN_PLATFORMS = ['WEB', 'PDA'] as const
export type LoginPlatform = (typeof LOGIN_PLATFORMS)[number]

/** OA-12 用户必填字段：所属部门、所属角色、登录平台、账号状态。 */
export interface UserRequiredFieldsInput {
  deptId: string | null | undefined
  roleId: string | null | undefined
  loginPlatform: string | null | undefined
  accountStatus: string | null | undefined
}

export function assertUserRequiredFields(input: UserRequiredFieldsInput): void {
  if (!input.deptId || !input.roleId || !input.loginPlatform || !input.accountStatus) {
    throw new OrgRuleViolation('OA-12', '所属部门、所属角色、登录平台、账号状态均为必填')
  }
}

/**
 * OA-13 所属部门 deptCategory=2（质检部）时"车间部门"服务端强制必填。
 * 合同口径：[合同新造·建议] 服务端强制（PI K12），最终以 GAP-A5 裁定为准。
 */
export function assertWorkshopDeptWhenRequired(
  deptCategory: number | null,
  workshopDeptId: string | null | undefined,
): void {
  if (deptCategory === DEPT_CATEGORY.QUALITY && !(workshopDeptId ?? '').length) {
    throw new OrgRuleViolation(
      'OA-13',
      '所属部门为质检部（deptCategory=2）时车间部门必填（服务端强制，GAP-A5 待裁定口径）',
    )
  }
}

/** OA-11 不可删除当前登录账号自身（服务端拒绝）。 */
export function assertNotSelfDelete(actorUserId: string, targetUserId: string): void {
  if (actorUserId === targetUserId) {
    throw new OrgRuleViolation('OA-11', '不可删除当前登录账号自身')
  }
}

export interface LoginEligibilityInput {
  accountStatus: string
  status: string
  lockedUntil: Date | string | null
  now: Date
}

/** OA-16 账号状态=禁用不可登录；锁定缓存到期前同样拒绝。 */
export function assertLoginEligibility(input: LoginEligibilityInput): void {
  if (input.accountStatus === 'disabled') {
    throw new OrgRuleViolation('OA-16', '账号已禁用，不可登录')
  }
  if (input.status === 'retired') {
    throw new OrgRuleViolation('OA-16', '账号已注销，不可登录')
  }
  if (input.lockedUntil !== null && new Date(input.lockedUntil).getTime() > input.now.getTime()) {
    throw new OrgRuleViolation('OA-16', '登录失败次数过多，账号处于锁定状态（解封仅清除锁定缓存）')
  }
}

/**
 * [实现参数] 登录失败锁定策略：连续失败达上限后锁定。
 * 原文只定义了"登录失败锁定缓存"与"解封"动作，未给出定量；此常量为实现参数，非合同规则。
 */
export const DEFAULT_MAX_LOGIN_FAILURES = 5
export const DEFAULT_LOCK_MINUTES = 15

export interface LoginFailureState {
  failedLoginCount: number
  lockedUntil: Date | null
}

/** 失败后计数与锁定状态推进：达到上限则锁定 LOCK_MINUTES。 */
export function nextFailureState(
  current: LoginFailureState,
  now: Date,
  maxFailures: number = DEFAULT_MAX_LOGIN_FAILURES,
  lockMinutes: number = DEFAULT_LOCK_MINUTES,
): LoginFailureState {
  const failedLoginCount = current.failedLoginCount + 1
  const lockedUntil =
    failedLoginCount >= maxFailures
      ? new Date(now.getTime() + lockMinutes * 60_000)
      : current.lockedUntil
  return { failedLoginCount, lockedUntil }
}

/**
 * OA-15 重置密码取系统参数 account.initPassword；未配置时页面路径兜底 '123456'；
 * 导入路径不设兜底（本阶段无导入入口，不适用）。
 * 注意：兜底值 '123456' 不满足 OA-14 密码策略——这是原文口径（初始密码供首次登录），
 * OA-14 校验仅作用于用户显式提供/修改密码的路径。
 */
export const INIT_PASSWORD_FALLBACK = '123456'

export function resolveInitPassword(configured: string | null | undefined): string {
  return configured && configured.length > 0 ? configured : INIT_PASSWORD_FALLBACK
}
