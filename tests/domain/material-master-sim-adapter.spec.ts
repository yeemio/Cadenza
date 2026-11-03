import { describe, expect, it } from 'vitest'
import {
  normalizeSapSimMaterial,
  normalizeU9SimMaterial,
} from '../../packages/integrations/material-master/index'

describe('IF-01 material-master sim adapter', () => {
  it('normalizes U9_SIM aliases', () => {
    const payload = normalizeU9SimMaterial({
      orgCode: 'LE-C100',
      ItemCode: 'MAT-IF01-U9-001',
      ItemName: '模拟料品U9',
      materialType: 3,
      BaseUom: 'KG',
      QcFlag: 1,
      Revision: 2,
    })
    expect(payload).toMatchObject({
      sourceSystem: 'U9_SIM',
      companyOrgCode: 'LE-C100',
      code: 'MAT-IF01-U9-001',
      name: '模拟料品U9',
      materialType: 3,
      baseUom: 'KG',
      qcFlag: 1,
      externalRevision: 2,
    })
  })

  it('normalizes SAP_SIM aliases', () => {
    const payload = normalizeSapSimMaterial({
      CompanyCode: 'LE-C100',
      MaterialNumber: 'MAT-IF01-SAP-001',
      MaterialName: '模拟料品SAP',
      MaterialType: 1,
      Uom: 'M',
      externalRevision: 1,
    })
    expect(payload.sourceSystem).toBe('SAP_SIM')
    expect(payload.code).toBe('MAT-IF01-SAP-001')
    expect(payload.qcFlag).toBe(0)
  })

  it('rejects missing revision', () => {
    expect(() =>
      normalizeU9SimMaterial({
        companyOrgCode: 'LE-C100',
        code: 'X',
        name: 'Y',
        materialType: 1,
        baseUom: 'KG',
      }),
    ).toThrow(/externalRevision/)
  })
})
