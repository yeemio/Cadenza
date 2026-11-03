/**
 * IF-01 料品主数据模拟适配器（SAP_SIM / U9_SIM）。
 * 将模拟上游载荷规范为 integration.material-master.sync 命令面字段。
 * **不**连接真实 SAP/U9；route_key=material_master。
 */

export type MaterialMasterSimSystem = 'U9_SIM' | 'SAP_SIM'

export interface MaterialMasterSyncPayload {
  companyOrgCode: string
  code: string
  name: string
  materialType: 1 | 2 | 3
  baseUom: string
  qcFlag?: 0 | 1
  externalRevision: number
  sourceSystem: MaterialMasterSimSystem
  orgScopeId?: string
  orgCode?: string
  materialGroupCode?: string
  materialGroupName?: string
  descriptionZh?: string
  descriptionEn?: string
  voltage?: string
  standard?: string
  customer?: string
  spec?: string
  color?: string
  remark?: string
  reason?: string
}

export interface RawSimMaterialMessage {
  /** 公司组织编码（业务键一侧） */
  companyOrgCode?: string
  orgCode?: string
  CompanyCode?: string
  /** 料品编号 */
  code?: string
  MaterialNumber?: string
  ItemCode?: string
  /** 名称 */
  name?: string
  MaterialName?: string
  ItemName?: string
  materialType?: number
  MaterialType?: number
  baseUom?: string
  BaseUom?: string
  Uom?: string
  qcFlag?: number
  QcFlag?: number
  externalRevision?: number
  Revision?: number
  ChangeNumber?: number
  orgScopeId?: string
  descriptionZh?: string
  descriptionEn?: string
  spec?: string
  color?: string
  remark?: string
  [key: string]: unknown
}

function pickStr(...vals: unknown[]): string | undefined {
  for (const v of vals) {
    if (typeof v === 'string' && v.trim() !== '') return v.trim()
  }
  return undefined
}

function pickNum(...vals: unknown[]): number | undefined {
  for (const v of vals) {
    if (typeof v === 'number' && Number.isFinite(v)) return v
  }
  return undefined
}

/** 将 U9_SIM / SAP_SIM 原始报文规范为命令载荷；缺必填字段抛错（由调用方转 422）。 */
export function normalizeMaterialMasterMessage(
  sourceSystem: MaterialMasterSimSystem,
  raw: RawSimMaterialMessage,
): MaterialMasterSyncPayload {
  const companyOrgCode = pickStr(raw.companyOrgCode, raw.orgCode, raw.CompanyCode)
  const code = pickStr(raw.code, raw.MaterialNumber, raw.ItemCode)
  const name = pickStr(raw.name, raw.MaterialName, raw.ItemName)
  const baseUom = pickStr(raw.baseUom, raw.BaseUom, raw.Uom)
  const materialType = pickNum(raw.materialType, raw.MaterialType)
  const externalRevision = pickNum(raw.externalRevision, raw.Revision, raw.ChangeNumber)
  if (!companyOrgCode || !code || !name || !baseUom) {
    throw new Error('模拟适配器：缺少 companyOrgCode/code/name/baseUom')
  }
  if (materialType === undefined || ![1, 2, 3].includes(materialType)) {
    throw new Error('模拟适配器：materialType 须为 1|2|3')
  }
  if (externalRevision === undefined || !Number.isInteger(externalRevision) || externalRevision < 1) {
    throw new Error('模拟适配器：externalRevision 须为正整数')
  }
  const qc = pickNum(raw.qcFlag, raw.QcFlag) ?? 0
  return {
    companyOrgCode,
    code,
    name,
    materialType: materialType as 1 | 2 | 3,
    baseUom,
    qcFlag: qc === 1 ? 1 : 0,
    externalRevision,
    sourceSystem,
    orgScopeId: pickStr(raw.orgScopeId),
    orgCode: companyOrgCode,
    descriptionZh: pickStr(raw.descriptionZh),
    descriptionEn: pickStr(raw.descriptionEn),
    spec: pickStr(raw.spec),
    color: pickStr(raw.color),
    remark: pickStr(raw.remark),
  }
}

export function normalizeU9SimMaterial(raw: RawSimMaterialMessage): MaterialMasterSyncPayload {
  return normalizeMaterialMasterMessage('U9_SIM', raw)
}

export function normalizeSapSimMaterial(raw: RawSimMaterialMessage): MaterialMasterSyncPayload {
  return normalizeMaterialMasterMessage('SAP_SIM', raw)
}
