import { describe, expect, it } from 'vitest'
import {
  assertCapacityInput,
  assertConversionFactorInput,
  assertConversionLineMutable,
  assertEquipmentDeptConsistent,
  assertEquipmentRetirable,
  assertEquipmentStatusValue,
  assertLocationRetirable,
  assertMappingDeletable,
  assertMaterialTypesAllowedForWarehouseType,
  assertNormalLocationCode,
  assertNotStockReferenced,
  assertQrBoundLocationMutable,
  assertRackCodeImmutable,
  assertRackGridSize,
  assertRackLayersImmutable,
  assertWarehouseCode,
  assertWarehouseRetirable,
  assertWarehouseTypeAllowedForDept,
  assertWorkCenterRetirable,
  buildNormalLocationCode,
  buildRackLocationCode,
  buildZoneCode,
  equipmentCodeFromQr,
  equipmentQrCode,
  findEquipmentUniquenessConflict,
  findWorkCenterConflict,
  isValidConversionFactorInput,
  mapUpstreamMaterialLifecycle,
  mappingChangeTriggersBackfill,
  matchesEquipmentQrPrefix,
  shouldRecordStatusChange,
  workCenterMappingKey,
  zoneFullCode,
  MasterDataRuleViolation,
  DEFAULT_DEPT_WAREHOUSE_TYPE_RULE,
  WAREHOUSE_TYPE,
} from '@cadenza/domain'

/** masterdata 纯规则单测（MD-01～MD-37 抽测可判定分支，无数据库依赖）。 */

function expectViolation(fn: () => void, rule: string): void {
  try {
    fn()
    expect.unreachable(`期望抛出 ${rule} 规则违例`)
  } catch (error) {
    expect(error).toBeInstanceOf(MasterDataRuleViolation)
    expect((error as MasterDataRuleViolation).rule).toBe(rule)
  }
}

describe('料品与换算（MD-01～08）', () => {
  it('MD-04：换算数量非负、整数 ≤9 位、小数 ≤4 位', () => {
    expect(isValidConversionFactorInput('2.5')).toBe(true)
    expect(isValidConversionFactorInput('123456789.1234')).toBe(true)
    expect(isValidConversionFactorInput('0')).toBe(true)
    expectViolation(() => assertConversionFactorInput('-1'), 'MD-04')
    expectViolation(() => assertConversionFactorInput('1234567890'), 'MD-04')
    expectViolation(() => assertConversionFactorInput('1.12345'), 'MD-04')
    expectViolation(() => assertConversionFactorInput('abc'), 'MD-04')
  })

  it('MD-05：referenced 换算行不可修改（mutable 断言拒绝）', () => {
    expect(() => assertConversionLineMutable({ referenced: false })).not.toThrow()
    expectViolation(() => assertConversionLineMutable({ referenced: true }), 'MD-05')
  })

  it('MD-07：上游停用/删除均映射 retired（不物理删）', () => {
    expect(mapUpstreamMaterialLifecycle('active')).toBe('active')
    expect(mapUpstreamMaterialLifecycle('disabled')).toBe('retired')
    expect(mapUpstreamMaterialLifecycle('deleted')).toBe('retired')
  })
})

describe('设备（MD-09～16）', () => {
  it('MD-09：设备编码/名称全局唯一冲突检出', () => {
    const existing = [
      { id: 'e1', code: 'JZ-001', name: '绞线机一号' },
      { id: 'e2', code: 'JZ-002', name: '绞线机二号' },
    ]
    expect(findEquipmentUniquenessConflict({ code: 'JZ-003', name: '绞线机三号' }, existing)).toBeNull()
    expect(findEquipmentUniquenessConflict({ code: 'JZ-001', name: '新名' }, existing)).toEqual({
      field: 'code',
      value: 'JZ-001',
    })
    expect(
      findEquipmentUniquenessConflict({ id: 'e1', code: 'JZ-001', name: '绞线机一号' }, existing),
    ).toBeNull()
  })

  it('MD-10：设备部门须与工作中心部门一致；工作中心未配部门拒绝', () => {
    expect(() => assertEquipmentDeptConsistent('d1', 'd1')).not.toThrow()
    expectViolation(() => assertEquipmentDeptConsistent('d1', 'd2'), 'MD-10')
    expectViolation(() => assertEquipmentDeptConsistent('d1', null), 'MD-10')
  })

  it('MD-11：排产/报工任一引用即拒绝（先排产后报工文案）', () => {
    expect(() => assertEquipmentRetirable({ schedulingRefs: 0, workReportRefs: 0 })).not.toThrow()
    expectViolation(
      () => assertEquipmentRetirable({ schedulingRefs: 1, workReportRefs: 1 }),
      'MD-11',
    )
    expectViolation(() => assertEquipmentRetirable({ schedulingRefs: 0, workReportRefs: 2 }), 'MD-11')
  })

  it('MD-13/MD-14：状态字典 2 值；同值不产生流水', () => {
    expect(() => assertEquipmentStatusValue(1)).not.toThrow()
    expect(() => assertEquipmentStatusValue(2)).not.toThrow()
    expectViolation(() => assertEquipmentStatusValue(3), 'MD-13')
    expect(shouldRecordStatusChange(1, 1)).toBe(false)
    expect(shouldRecordStatusChange(1, 2)).toBe(true)
  })

  it('MD-15：设备码 = EQU- + 编码；仅大写前缀匹配；编码不得自带前缀', () => {
    expect(equipmentQrCode('JZ001')).toBe('EQU-JZ001')
    expect(matchesEquipmentQrPrefix('EQU-JZ001')).toBe(true)
    // CA-8 裁定前设备主档侧仅大写：小写前缀不匹配
    expect(matchesEquipmentQrPrefix('equ-JZ001')).toBe(false)
    expect(equipmentCodeFromQr('EQU-JZ001')).toBe('JZ001')
    expect(equipmentCodeFromQr('BAD-JZ001')).toBeNull()
  })

  it('MD-16：产能 10 位整数＋4 位小数、非负', () => {
    expect(() => assertCapacityInput('1234567890.1234')).not.toThrow()
    expectViolation(() => assertCapacityInput('12345678901'), 'MD-16')
    expectViolation(() => assertCapacityInput('1.12345'), 'MD-16')
    expectViolation(() => assertCapacityInput('-2'), 'MD-16')
  })
})

describe('工作中心与对照表（MD-17～21）', () => {
  it('MD-17：编码全局冲突与同部门名称冲突分别检出', () => {
    const existing = [
      { id: 'w1', code: 'WC-A', name: '绞制一线', deptId: 'd1' },
      { id: 'w2', code: 'WC-B', name: '绞制一线', deptId: 'd2' },
    ]
    expect(findWorkCenterConflict({ code: 'WC-C', name: '绞制一线', deptId: 'd3' }, existing)).toBeNull()
    expect(findWorkCenterConflict({ code: 'WC-A', name: 'x', deptId: 'd1' }, existing)).toEqual({
      field: 'code',
      value: 'WC-A',
    })
    expect(findWorkCenterConflict({ code: 'WC-C', name: '绞制一线', deptId: 'd1' }, existing)).toEqual({
      field: 'name',
      value: '绞制一线',
    })
  })

  it('MD-18：删除校验顺序——设备引用优先命中', () => {
    expect(() =>
      assertWorkCenterRetirable({ equipmentRefs: 0, processRefs: 0, orderProcessRefs: 0 }),
    ).not.toThrow()
    expectViolation(
      () => assertWorkCenterRetirable({ equipmentRefs: 2, processRefs: 1, orderProcessRefs: 1 }),
      'MD-18',
    )
    expectViolation(
      () => assertWorkCenterRetirable({ equipmentRefs: 0, processRefs: 1, orderProcessRefs: 1 }),
      'MD-18',
    )
    expectViolation(
      () => assertWorkCenterRetirable({ equipmentRefs: 0, processRefs: 0, orderProcessRefs: 3 }),
      'MD-18',
    )
  })

  it('MD-19/20/21：对照表唯一键、仅新增触发补绑、有未完成任务拒绝删除', () => {
    expect(workCenterMappingKey('U9-WC-01', 'ORG-SZ')).toBe('U9-WC-01:ORG-SZ')
    expect(mappingChangeTriggersBackfill('create')).toBe(true)
    expect(mappingChangeTriggersBackfill('update')).toBe(false)
    expect(() => assertMappingDeletable({ pendingBackfillTasks: 0 })).not.toThrow()
    expectViolation(() => assertMappingDeletable({ pendingBackfillTasks: 2 }), 'MD-21')
  })
})

describe('仓库/库位/货架（MD-22～33）', () => {
  it('MD-22：仓库编码须为 4 位数字', () => {
    expect(() => assertWarehouseCode('0101')).not.toThrow()
    expectViolation(() => assertWarehouseCode('101'), 'MD-22')
    expectViolation(() => assertWarehouseCode('01a1'), 'MD-22')
  })

  it('MD-23：仓库类型限定可收料品类型集合', () => {
    expect(() =>
      assertMaterialTypesAllowedForWarehouseType(WAREHOUSE_TYPE.WAREHOUSE, [1, 3]),
    ).not.toThrow()
    expect(() =>
      assertMaterialTypesAllowedForWarehouseType(WAREHOUSE_TYPE.LINE_SIDE, [1, 2, 3]),
    ).not.toThrow()
    expectViolation(
      () => assertMaterialTypesAllowedForWarehouseType(WAREHOUSE_TYPE.WAREHOUSE, [2]),
      'MD-23',
    )
    expectViolation(
      () => assertMaterialTypesAllowedForWarehouseType(WAREHOUSE_TYPE.LINE_SIDE, []),
      'MD-23',
    )
  })

  it('MD-24：部门类型约束配置化（默认=原文基线，可覆盖）', () => {
    // 物流部(3)→仓库；车间(1)→线边仓
    expect(() =>
      assertWarehouseTypeAllowedForDept(3, WAREHOUSE_TYPE.WAREHOUSE, DEFAULT_DEPT_WAREHOUSE_TYPE_RULE),
    ).not.toThrow()
    expectViolation(
      () => assertWarehouseTypeAllowedForDept(3, WAREHOUSE_TYPE.LINE_SIDE, DEFAULT_DEPT_WAREHOUSE_TYPE_RULE),
      'MD-24',
    )
    expectViolation(
      () => assertWarehouseTypeAllowedForDept(1, WAREHOUSE_TYPE.WAREHOUSE, DEFAULT_DEPT_WAREHOUSE_TYPE_RULE),
      'MD-24',
    )
    // 质检部(2)不受限
    expect(() =>
      assertWarehouseTypeAllowedForDept(2, WAREHOUSE_TYPE.WAREHOUSE, DEFAULT_DEPT_WAREHOUSE_TYPE_RULE),
    ).not.toThrow()
    // 配置覆盖：质检部也只许仓库
    const custom = new Map([[2, [WAREHOUSE_TYPE.WAREHOUSE] as const]])
    expectViolation(() => assertWarehouseTypeAllowedForDept(2, WAREHOUSE_TYPE.LINE_SIDE, custom), 'MD-24')
  })

  it('MD-27/26：仓库 retire——二维码占用与库存引用分别拒绝', () => {
    expect(() => assertWarehouseRetirable({ qrBound: false, stockRefs: 0 })).not.toThrow()
    expectViolation(() => assertWarehouseRetirable({ qrBound: true, stockRefs: 0 }), 'MD-26')
    expectViolation(() => assertWarehouseRetirable({ qrBound: false, stockRefs: 3 }), 'MD-27')
  })

  it('MD-28：普通库位码 8 位、前缀须为仓库码', () => {
    expect(buildNormalLocationCode('0101', '0001')).toBe('01010001')
    expect(() => assertNormalLocationCode('01010001', '0101')).not.toThrow()
    expectViolation(() => assertNormalLocationCode('0101001', '0101'), 'MD-28')
    expectViolation(() => assertNormalLocationCode('02020001', '0101'), 'MD-28')
  })

  it('MD-29/37：被二维码占用库位不可改码/删除；库存引用拒绝', () => {
    expect(() => assertQrBoundLocationMutable({ qrBound: false, codeChanged: true })).not.toThrow()
    expectViolation(() => assertQrBoundLocationMutable({ qrBound: true, codeChanged: true }), 'MD-29')
    expect(() => assertLocationRetirable({ qrBound: false, stockRefs: 0 })).not.toThrow()
    expectViolation(() => assertLocationRetirable({ qrBound: true, stockRefs: 0 }), 'MD-29')
    expectViolation(() => assertLocationRetirable({ qrBound: false, stockRefs: 1 }), 'MD-37')
  })

  it('MD-30/31：货架编号 2 位；区域/层数 1–99；层数编辑不可改', () => {
    expect(() => assertRackGridSize(2, 3)).not.toThrow()
    expectViolation(() => assertRackGridSize(0, 3), 'MD-31')
    expectViolation(() => assertRackGridSize(2, 100), 'MD-31')
    expectViolation(() => assertRackLayersImmutable(true), 'MD-31')
    expectViolation(() => assertRackCodeImmutable({ activeLocations: 1, codeChanged: true }), 'MD-31')
    expect(() => assertRackCodeImmutable({ activeLocations: 0, codeChanged: true })).not.toThrow()
  })

  it('MD-31/32：区域码 2+2、库位码 2+2+2、区域完整码=工厂编码+区域编码', () => {
    expect(buildZoneCode('07', 1)).toBe('0701')
    expect(buildZoneCode('07', 12)).toBe('0712')
    expect(buildRackLocationCode('07', 1, 3)).toBe('070103')
    expect(zoneFullCode('SZ0001', '0701')).toBe('SZ00010701')
  })
})

describe('主数据通用（MD-34～37）', () => {
  it('MD-37：被库存余额或流水引用即拒绝退役', () => {
    expect(() => assertNotStockReferenced({ stockBalanceRefs: 0, stockTransactionRefs: 0 })).not.toThrow()
    expectViolation(() => assertNotStockReferenced({ stockBalanceRefs: 1, stockTransactionRefs: 0 }), 'MD-37')
    expectViolation(() => assertNotStockReferenced({ stockBalanceRefs: 0, stockTransactionRefs: 2 }), 'MD-37')
  })
})
