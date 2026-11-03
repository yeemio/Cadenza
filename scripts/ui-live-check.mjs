#!/usr/bin/env node
/**
 * UI live 链路证据脚本（第二波：client 对齐真实 API 的直连验证）。
 *
 * 用途：apps/api 启动后（delivery/L1/stage2/DELIVERY.md §8 命令），用与
 * packages/ui/src/api/client.ts 完全相同的路由/参数/头约定直连真实后端，
 * 断言 UI 消费的响应形状与 contracts 类型一致：
 *   1. POST /auth/login（admin，企业范围）→ {token,tokenType:'Bearer',expiresAt,user:{userId,loginName}}
 *   2. GET  /auth/me（Bearer）→ {user:SessionUserInfo, permissions[], dataScope{enterpriseWide,plantIds}, session}
 *   3. GET  /org/users?page=1&pageSize=10 → PageResult<UserAccountDto>（分页四元组 + DTO 字段齐全）
 *   4. hfadmin01（厂区范围 plant）→ me.dataScope 对比（OA-25 服务端口径）
 *
 * 运行：node scripts/ui-live-check.mjs [--base http://127.0.0.1:3001]
 * 退出码：0=全部断言通过；1=任一断言失败或网络不可达。token 只打印前 8 位。
 */
const args = process.argv.slice(2)
const baseIdx = args.indexOf('--base')
const BASE = baseIdx >= 0 ? args[baseIdx + 1] : process.env.VITE_API_BASE_URL ?? 'http://127.0.0.1:3001'

let failures = 0
function check(name, cond, detail) {
  const mark = cond ? 'PASS' : 'FAIL'
  if (!cond) failures += 1
  console.log(`[${mark}] ${name}${detail ? `：${detail}` : ''}`)
}

async function call(method, path, { body, token } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : null),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  let json = null
  try {
    json = JSON.parse(text)
  } catch {
    /* 非 JSON 响应体 */
  }
  return { status: res.status, body: json, requestId: res.headers.get('x-request-id') }
}

async function loginAndInspect(loginName, password, platform) {
  const login = await call('POST', '/auth/login', { body: { loginName, password, platform } })
  check(
    `${loginName} 登录 200 且响应形状 {token,tokenType:Bearer,expiresAt,user:{userId,loginName}}`,
    login.status === 200 &&
      typeof login.body?.token === 'string' &&
      login.body?.tokenType === 'Bearer' &&
      typeof login.body?.expiresAt === 'string' &&
      !Number.isNaN(Date.parse(login.body.expiresAt)) &&
      typeof login.body?.user?.userId === 'string' &&
      login.body?.user?.loginName === loginName,
    `http=${login.status} token=${String(login.body?.token ?? '').slice(0, 8)}…`,
  )
  const me = await call('GET', '/auth/me', { token: login.body?.token })
  check(
    `${loginName} /auth/me 200 且含 user/permissions/dataScope/session`,
    me.status === 200 &&
      typeof me.body?.user?.loginName === 'string' &&
      typeof me.body?.user?.enterpriseName === 'string' &&
      typeof me.body?.user?.plantName === 'string' &&
      Array.isArray(me.body?.permissions) &&
      me.body?.dataScope !== null &&
      typeof me.body?.dataScope?.enterpriseWide === 'boolean' &&
      Array.isArray(me.body?.dataScope?.plantIds) &&
      typeof me.body?.session?.expiresAt === 'string',
    `enterprise=${me.body?.user?.enterpriseName} plant=${me.body?.user?.plantName} enterpriseWide=${me.body?.dataScope?.enterpriseWide} plantIds=${me.body?.dataScope?.plantIds?.length}`,
  )
  return { login, me }
}

async function main() {
  console.log(`UI live 链路证据（base=${BASE}，时间 ${new Date().toISOString()}）`)

  const admin = await loginAndInspect('admin', 'CadAdmin001', 'WEB')
  const token = admin.login.body?.token

  // 用户列表（分页）
  const users = await call('GET', '/org/users?page=1&pageSize=10', { token })
  const u = users.body?.items?.[0]
  check(
    'GET /org/users?page=1&pageSize=10 → PageResult 四元组',
    users.status === 200 &&
      Array.isArray(users.body?.items) &&
      typeof users.body?.total === 'number' &&
      users.body?.page === 1 &&
      users.body?.pageSize === 10,
    `http=${users.status} total=${users.body?.total} rows=${users.body?.items?.length}`,
  )
  const userKeys = [
    'id', 'loginName', 'displayName', 'deptId', 'workshopDeptId', 'roleId',
    'loginPlatform', 'accountStatus', 'plantId', 'phone', 'failedLoginCount', 'lockedUntil', 'status',
  ]
  check(
    'UserAccountDto 字段齐全且不含 password 类敏感字段（OA-27）',
    u != null && userKeys.every((k) => k in u) && !Object.keys(u).some((k) => k.toLowerCase().includes('password')),
    `首行 loginName=${u?.loginName} accountStatus=${u?.accountStatus} loginPlatform=${u?.loginPlatform}`,
  )

  // loginNameLike 过滤参数（client 拼装口径）
  const filtered = await call('GET', '/org/users?page=1&pageSize=10&loginNameLike=admin', { token })
  check(
    'loginNameLike 服务端过滤生效',
    filtered.status === 200 && filtered.body?.total >= 1 && filtered.body?.items?.every((x) => x.loginName.includes('admin')),
    `total=${filtered.body?.total}`,
  )

  // 机构/角色/授权列表（kind/deptCategory/isSystem/principalType 字典）
  const nodes = await call('GET', '/org/nodes?page=1&pageSize=100', { token })
  const kinds = [...new Set((nodes.body?.items ?? []).map((n) => n.kind))]
  const dept = (nodes.body?.items ?? []).find((n) => n.kind === 'department')
  check(
    'GET /org/nodes → kind 字典（enterprise/legal_entity/plant/department/work_center）+ deptCategory',
    nodes.status === 200 &&
      ['enterprise', 'plant', 'department'].every((k) => kinds.includes(k)) &&
      [1, 2, 3].includes(dept?.deptCategory),
    `total=${nodes.body?.total} kinds=${kinds.join('|')} deptCategory=${dept?.deptCategory}`,
  )
  const roles = await call('GET', '/org/roles?page=1&pageSize=50', { token })
  check(
    'GET /org/roles → RoleDto（isSystem 1/2）',
    roles.status === 200 && (roles.body?.items ?? []).every((r) => r.isSystem === 1 || r.isSystem === 2),
    `total=${roles.body?.total} 内置=${(roles.body?.items ?? []).filter((r) => r.isSystem === 2).length}`,
  )
  const grants = await call('GET', '/org/grants?page=1&pageSize=50', { token })
  check(
    'GET /org/grants → ScopeGrantDto（principalType/scopeType/permissions）',
    grants.status === 200 &&
      (grants.body?.items ?? []).every(
        (g) =>
          (g.principalType === 'role' || g.principalType === 'user') &&
          ['enterprise', 'plant', 'workshop'].includes(g.scopeType) &&
          Array.isArray(g.permissions),
      ),
    `total=${grants.body?.total}`,
  )

  // 401 行为：无 token 访问受保护端点
  const noAuth = await call('GET', '/org/users?page=1&pageSize=10')
  check(
    '无 Bearer 访问 /org/users → 401 {code:ERR_AUTH_REQUIRED,message,details}',
    noAuth.status === 401 &&
      noAuth.body?.code === 'ERR_AUTH_REQUIRED' &&
      typeof noAuth.body?.message === 'string' &&
      noAuth.body?.details !== undefined,
    `http=${noAuth.status} code=${noAuth.body?.code}`,
  )

  // 错误密码：401 统一错误体（不泄露账号存在性）
  const badLogin = await call('POST', '/auth/login', {
    body: { loginName: 'admin', password: 'WrongPassword1', platform: 'WEB' },
  })
  check(
    '错误密码登录 → 401 ERR_AUTH_REQUIRED {code,message,details}',
    badLogin.status === 401 &&
      badLogin.body?.code === 'ERR_AUTH_REQUIRED' &&
      typeof badLogin.body?.message === 'string' &&
      badLogin.body?.details !== undefined,
    `http=${badLogin.status} message=${badLogin.body?.message}`,
  )

  // 厂区范围账号对比（OA-25：plant 范围）
  const hf = await loginAndInspect('hfadmin01', 'HfPlant0001', 'WEB')
  check(
    '范围对比：admin=企业范围（enterpriseWide）与 hfadmin01=厂区范围口径互异',
    admin.me.body?.dataScope?.enterpriseWide === true && hf.me.body?.dataScope?.enterpriseWide === false,
    `admin.enterpriseWide=${admin.me.body?.dataScope?.enterpriseWide} hfadmin01.plantIds=${hf.me.body?.dataScope?.plantIds?.length}`,
  )

  // PDA 平台不匹配拒绝（login.use case：平台不符 401）
  const pdaPlatform = await call('POST', '/auth/login', {
    body: { loginName: 'admin', password: 'CadAdmin001', platform: 'PDA' },
  })
  check(
    'admin 以 PDA 平台登录 → 401（loginPlatform 与请求平台不符，真实范围行为）',
    pdaPlatform.status === 401 && pdaPlatform.body?.code === 'ERR_AUTH_REQUIRED',
    `http=${pdaPlatform.status} message=${pdaPlatform.body?.message}`,
  )

  console.log(failures === 0 ? '\n结论：UI live 链路全部断言通过。' : `\n结论：${failures} 项断言失败。`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((error) => {
  console.error(`网络不可达或脚本异常：${BASE}`, error)
  process.exit(1)
})
