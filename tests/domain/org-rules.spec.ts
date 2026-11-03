import { describe, expect, it } from 'vitest'
import {
  assertCanAdministerAdminRole,
  assertCompliantPassword,
  assertLoginEligibility,
  assertLoginNameValid,
  assertNotSelfDelete,
  assertOrgNodeDeletable,
  assertOrgNodeFields,
  assertReasonPresentForHighImpact,
  assertRoleDeletable,
  assertBuiltinRoleMutable,
  assertUserRequiredFields,
  assertValidParent,
  assertWorkshopDeptWhenRequired,
  computeDataScope,
  computeNodeDepth,
  computeNodePath,
  findRoleUniquenessConflict,
  isAncestorOrSelf,
  isPlantInScope,
  isCompliantPassword,
  mergeGrantPermissions,
  nextFailureState,
  OrgRuleViolation,
  resolveInitPassword,
  scopeCoversPath,
  DEPT_CATEGORY,
  hasPermission,
} from '@cadenza/domain'

/** org 域纯规则单测（无 DB）：逐条对应冻结合同 org-auth.md 规则编号。 */

function expectViolation(rule: string, fn: () => void): void {
  try {
    fn()
    expect.unreachable(`应抛出 OrgRuleViolation（${rule}）`)
  } catch (error) {
    expect(error).toBeInstanceOf(OrgRuleViolation)
    expect((error as OrgRuleViolation).rule).toBe(rule)
  }
}

describe('用户规则（OA-10～OA-16）', () => {
  it('OA-10 登录账号字符集仅字母与数字', () => {
    expect(() => assertLoginNameValid('admin001')).not.toThrow()
    expect(() => assertLoginNameValid('AdminA')).not.toThrow()
    expectViolation('OA-10', () => assertLoginNameValid('admin-001'))
    expectViolation('OA-10', () => assertLoginNameValid('管理员'))
    expectViolation('OA-10', () => assertLoginNameValid('admin 001'))
  })

  it('OA-14 密码 8–16 位且同时含数字与字母', () => {
    expect(isCompliantPassword('Abc12345')).toBe(true)
    expect(isCompliantPassword('12345678a')).toBe(true)
    expect(isCompliantPassword('12345678')).toBe(false) // 无字母
    expect(isCompliantPassword('abcdefgh')).toBe(false) // 无数字
    expect(isCompliantPassword('Ab1234')).toBe(false) // 太短
    expect(isCompliantPassword('Abcdefghijklmn123')).toBe(false) // 17 位超长
    expect(() => assertCompliantPassword('Abc12345')).not.toThrow()
    expectViolation('OA-14', () => assertCompliantPassword('12345678'))
  })

  it('OA-12 必填字段任一为空拒绝', () => {
    expect(() =>
      assertUserRequiredFields({
        deptId: 'd1',
        roleId: 'r1',
        loginPlatform: 'WEB',
        accountStatus: 'enabled',
      }),
    ).not.toThrow()
    expectViolation('OA-12', () =>
      assertUserRequiredFields({ deptId: '', roleId: 'r1', loginPlatform: 'WEB', accountStatus: 'enabled' }),
    )
  })

  it('OA-13 质检部（deptCategory=2）时车间部门服务端强制必填', () => {
    expect(() => assertWorkshopDeptWhenRequired(DEPT_CATEGORY.QUALITY, 'ws1')).not.toThrow()
    expect(() => assertWorkshopDeptWhenRequired(DEPT_CATEGORY.WORKSHOP, null)).not.toThrow()
    expectViolation('OA-13', () => assertWorkshopDeptWhenRequired(DEPT_CATEGORY.QUALITY, null))
    expectViolation('OA-13', () => assertWorkshopDeptWhenRequired(2, ''))
  })

  it('OA-11 不可删除当前登录账号自身', () => {
    expect(() => assertNotSelfDelete('u1', 'u2')).not.toThrow()
    expectViolation('OA-11', () => assertNotSelfDelete('u1', 'u1'))
  })

  it('OA-16 禁用/锁定不可登录；解封语义仅清锁定缓存', () => {
    const now = new Date('2026-10-27T10:00:00Z')
    expectViolation('OA-16', () =>
      assertLoginEligibility({ accountStatus: 'disabled', status: 'active', lockedUntil: null, now }),
    )
    expectViolation('OA-16', () =>
      assertLoginEligibility({ accountStatus: 'enabled', status: 'retired', lockedUntil: null, now }),
    )
    expectViolation('OA-16', () =>
      assertLoginEligibility({
        accountStatus: 'enabled',
        status: 'active',
        lockedUntil: new Date('2026-10-27T10:10:00Z'),
        now,
      }),
    )
    // 锁定过期后可再登录（解封/到期只清缓存，不改启用状态）
    expect(() =>
      assertLoginEligibility({
        accountStatus: 'enabled',
        status: 'active',
        lockedUntil: new Date('2026-10-27T09:59:00Z'),
        now,
      }),
    ).not.toThrow()
  })

  it('失败计数推进：达到上限锁定（实现参数 5 次/15 分钟）', () => {
    const now = new Date('2026-10-27T10:00:00Z')
    let state = { failedLoginCount: 0, lockedUntil: null as Date | null }
    for (let i = 1; i <= 4; i += 1) {
      state = nextFailureState(state, now)
      expect(state.failedLoginCount).toBe(i)
      expect(state.lockedUntil).toBeNull()
    }
    state = nextFailureState(state, now)
    expect(state.failedLoginCount).toBe(5)
    expect(state.lockedUntil).toEqual(new Date('2026-10-27T10:15:00Z'))
  })

  it('OA-15 重置密码取系统参数，未配置兜底 123456', () => {
    expect(resolveInitPassword(undefined)).toBe('123456')
    expect(resolveInitPassword('')).toBe('123456')
    expect(resolveInitPassword('Init0001')).toBe('Init0001')
  })
})

describe('组织树规则（OA-01～OA-08/OA-34）', () => {
  const enterprise = { id: 'e1', kind: 'enterprise' as const, path: '/e1/' }
  const legal = { id: 'l1', kind: 'legal_entity' as const, path: '/e1/l1/' }
  const plant = { id: 'p1', kind: 'plant' as const, path: '/e1/l1/p1/' }
  const dept = { id: 'd1', kind: 'department' as const, path: '/e1/l1/p1/d1/' }
  const wc = { id: 'w1', kind: 'work_center' as const, path: '/e1/l1/p1/d1/w1/' }

  it('OA-02 不可选自身/下级为上级（无环）', () => {
    expectViolation('OA-02', () => assertValidParent({ id: 'd1', path: dept.path }, dept, 'department'))
    expectViolation('OA-02', () => assertValidParent({ id: 'p1', path: plant.path }, wc, 'plant'))
    expect(() => assertValidParent({ id: 'd2', path: '/e1/l1/p1/d2/' }, plant, 'department')).not.toThrow()
  })

  it('OA-02/OA-08 层级配对（上级类型字典）', () => {
    expectViolation('OA-02', () => assertValidParent(null, dept, 'plant')) // plant 不能挂 department
    expectViolation('OA-02', () => assertValidParent(null, plant, 'enterprise')) // enterprise 无上级
    expect(() => assertValidParent(null, enterprise, 'legal_entity')).not.toThrow()
    expect(() => assertValidParent(null, legal, 'plant')).not.toThrow()
    expect(() => assertValidParent(null, plant, 'department')).not.toThrow()
    expect(() => assertValidParent(null, dept, 'work_center')).not.toThrow()
  })

  it('OA-03 机构类型字典仅 3 值', () => {
    expectViolation('OA-03', () => assertOrgNodeFields({ kind: 'department', deptCategory: 4 }))
    expectViolation('OA-03', () => assertOrgNodeFields({ kind: 'department' }))
    expect(() => assertOrgNodeFields({ kind: 'department', deptCategory: 1 })).not.toThrow()
    expect(() => assertOrgNodeFields({ kind: 'department', deptCategory: 2 })).not.toThrow()
    expect(() => assertOrgNodeFields({ kind: 'department', deptCategory: 3 })).not.toThrow()
  })

  it('OA-04 工厂编码必填且最长 10 字符；公司组织编码选填', () => {
    expectViolation('OA-04', () => assertOrgNodeFields({ kind: 'plant', plantCode: '' }))
    expectViolation('OA-04', () => assertOrgNodeFields({ kind: 'plant', plantCode: 'A'.repeat(11) }))
    expect(() => assertOrgNodeFields({ kind: 'plant', plantCode: 'SZ0001' })).not.toThrow()
    expect(() => assertOrgNodeFields({ kind: 'plant', plantCode: 'SZ0001', companyOrgCode: undefined })).not.toThrow()
  })

  it('OA-05/OA-07 删除前置：挂用户/被工作中心引用即拒', () => {
    expectViolation('OA-05', () =>
      assertOrgNodeDeletable({ usersInSubtree: 1, workCenterRefs: 0, warehouseRefs: 0, equipmentRefs: 0 }),
    )
    expectViolation('OA-07', () =>
      assertOrgNodeDeletable({ usersInSubtree: 0, workCenterRefs: 2, warehouseRefs: 0, equipmentRefs: 0 }),
    )
    expectViolation('OA-07', () =>
      assertOrgNodeDeletable({ usersInSubtree: 0, workCenterRefs: 0, warehouseRefs: 1, equipmentRefs: 0 }),
    )
    expectViolation('OA-07', () =>
      assertOrgNodeDeletable({ usersInSubtree: 0, workCenterRefs: 0, warehouseRefs: 0, equipmentRefs: 1 }),
    )
    expect(() =>
      assertOrgNodeDeletable({ usersInSubtree: 0, workCenterRefs: 0, warehouseRefs: 0, equipmentRefs: 0 }),
    ).not.toThrow()
  })

  it('OA-34 path/depth 物化与祖先判定', () => {
    expect(computeNodePath(null, 'e1')).toBe('/e1/')
    expect(computeNodePath('/e1/', 'l1')).toBe('/e1/l1/')
    expect(computeNodeDepth(null)).toBe(0)
    expect(computeNodeDepth(0)).toBe(1)
    expect(isAncestorOrSelf(enterprise, dept)).toBe(true)
    expect(isAncestorOrSelf(dept, enterprise)).toBe(false)
    expect(isAncestorOrSelf(dept, dept)).toBe(true)
  })
})

describe('角色规则（OA-17～OA-20）', () => {
  const existing = [
    { id: 'r1', enterpriseId: 'e1', name: '系统管理员', alias: 'sysadmin', sort: 1, isSystem: 2, status: 'active' },
    { id: 'r2', enterpriseId: 'e1', name: '质检员', alias: 'qc', sort: 3, isSystem: 1, status: 'active' },
  ]

  it('OA-17 名称/别名/排序任一重复即拒', () => {
    expect(findRoleUniquenessConflict({ name: '系统管理员', alias: 'x', sort: 99 }, existing)).not.toBeNull()
    expect(findRoleUniquenessConflict({ name: 'x', alias: 'qc', sort: 99 }, existing)).not.toBeNull()
    expect(findRoleUniquenessConflict({ name: 'x', alias: 'x', sort: 1 }, existing)).not.toBeNull()
    expect(findRoleUniquenessConflict({ name: 'x', alias: 'x', sort: 99 }, existing)).toBeNull()
    // 排除自身（更新场景）
    expect(findRoleUniquenessConflict({ name: '系统管理员', alias: 'sysadmin', sort: 1, id: 'r1' }, existing)).toBeNull()
  })

  it('OA-18 内置角色不可改别名、不可删除', () => {
    expectViolation('OA-18', () =>
      assertBuiltinRoleMutable({ isSystem: 2, alias: 'sysadmin' }, { alias: 'changed' }),
    )
    expect(() => assertBuiltinRoleMutable({ isSystem: 2, alias: 'sysadmin' }, { alias: 'sysadmin' })).not.toThrow()
    expect(() => assertBuiltinRoleMutable({ isSystem: 2, alias: 'sysadmin' }, { alias: undefined })).not.toThrow()
    expect(() => assertBuiltinRoleMutable({ isSystem: 1, alias: 'qc' }, { alias: 'changed' })).not.toThrow()
    expectViolation('OA-18', () =>
      assertRoleDeletable({ id: 'r1', isSystem: 2, name: '系统管理员' }, { assignedActiveUsers: 0, childRoles: 0 }),
    )
  })

  it('OA-19 已关联用户/存在下级角色不可删除', () => {
    expectViolation('OA-19', () =>
      assertRoleDeletable({ id: 'r2', isSystem: 1, name: '质检员' }, { assignedActiveUsers: 1, childRoles: 0 }),
    )
    expectViolation('OA-19', () =>
      assertRoleDeletable({ id: 'r2', isSystem: 1, name: '质检员' }, { assignedActiveUsers: 0, childRoles: 2 }),
    )
    expect(() =>
      assertRoleDeletable({ id: 'r2', isSystem: 1, name: '质检员' }, { assignedActiveUsers: 0, childRoles: 0 }),
    ).not.toThrow()
  })

  it('OA-20 非管理员不可配置 admin 角色', () => {
    expect(() => assertCanAdministerAdminRole(['org.read', 'org.role.admin'])).not.toThrow()
    expectViolation('OA-20', () => assertCanAdministerAdminRole(['org.read', 'org.admin']))
  })
})

describe('授权与数据范围（OA-21～OA-25）', () => {
  const nodes = [
    { id: 'e1', parentId: null, kind: 'enterprise' as const, path: '/e1/' },
    { id: 'p1', parentId: 'e1', kind: 'plant' as const, path: '/e1/p1/' },
    { id: 'p2', parentId: 'e1', kind: 'plant' as const, path: '/e1/p2/' },
    { id: 'd1', parentId: 'p1', kind: 'department' as const, path: '/e1/p1/d1/' },
    { id: 'w1', parentId: 'd1', kind: 'work_center' as const, path: '/e1/p1/d1/w1/' },
  ]

  it('OA-22 同键授权合并为至多一行', () => {
    const existing = [
      { principalType: 'role' as const, principalId: 'r1', permissions: ['org.read'], scopeType: 'plant' as const, scopeObjectId: 'p1' },
    ]
    const merged = mergeGrantPermissions(existing, {
      principalType: 'role',
      principalId: 'r1',
      scopeType: 'plant',
      scopeObjectId: 'p1',
      permissions: ['org.read', 'org.admin'],
    })
    expect(merged.mergeInto).not.toBeNull()
    expect([...merged.permissions].sort()).toEqual(['org.admin', 'org.read'])
  })

  it('OA-23 范围覆盖按 path 前缀计算（plant/workshop 不越厂）', () => {
    expect(scopeCoversPath({ scopeType: 'plant', scopeObjectId: 'p1' }, '/e1/p1/', '/e1/', '/e1/p1/d1/w1/')).toBe(true)
    expect(scopeCoversPath({ scopeType: 'plant', scopeObjectId: 'p1' }, '/e1/p1/', '/e1/', '/e1/p2/d9/')).toBe(false)
    expect(scopeCoversPath({ scopeType: 'enterprise', scopeObjectId: 'e1' }, '/e1/', '/e1/', '/e1/p2/')).toBe(true)
    expect(hasPermission(
      [{ principalType: 'role', principalId: 'r1', permissions: ['org.read'], scopeType: 'plant', scopeObjectId: 'p1' }],
      'org.read',
    )).toBe(true)
  })

  it('OA-25 数据范围服务端计算：workshop 授权收敛到所属厂', () => {
    const byScope = computeDataScope(
      [{ principalType: 'role', principalId: 'r1', permissions: ['org.read'], scopeType: 'workshop', scopeObjectId: 'w1' }],
      nodes,
    )
    expect(byScope.enterpriseWide).toBe(false)
    expect(byScope.plantIds).toEqual(['p1'])
    expect(isPlantInScope(byScope, 'p1')).toBe(true)
    expect(isPlantInScope(byScope, 'p2')).toBe(false)

    const enterpriseScope = computeDataScope(
      [{ principalType: 'role', principalId: 'r2', permissions: ['org.admin'], scopeType: 'enterprise', scopeObjectId: 'e1' }],
      nodes,
    )
    expect(enterpriseScope.enterpriseWide).toBe(true)
    expect(isPlantInScope(enterpriseScope, 'p2')).toBe(true)
  })
})

describe('审计规则（OA-28/29）', () => {
  it('OA-29 高影响操作强制理由', () => {
    expect(() => assertReasonPresentForHighImpact('org.node.create', undefined)).not.toThrow()
    expectViolation('OA-29', () => assertReasonPresentForHighImpact('org.grant.grant', undefined))
    expectViolation('OA-29', () => assertReasonPresentForHighImpact('org.grant.revoke', ''))
    expect(() => assertReasonPresentForHighImpact('org.node.retire', '组织重组')).not.toThrow()
  })
})
