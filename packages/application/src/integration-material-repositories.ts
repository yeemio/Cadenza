import type { CommandTools } from './command-bus'
import type { MasterDataRepositories, MaterialRecord } from './masterdata-repositories'

/**
 * IF-01 料品入站仓储端口（集成块专用）。
 * MD-01：业务面 masterdata 仍无料品写命令；本端口仅由 integration.material-master.sync 消费。
 */

export const MATERIAL_MASTER_ENTITY_TYPE = 'material_master'
export const MATERIAL_MASTER_OBJECT_TYPE = 'material_master'

export interface MaterialInboundMappingRecord {
  sourceSystem: string
  organizationCode: string
  externalId: string
  lineNo: number
  localObjectId: string
}

export interface NewInboundMaterial {
  id?: string
  orgScopeId: string
  code: string
  name: string
  companyOrgCode: string
  materialGroupCode?: string | null
  materialGroupName?: string | null
  descriptionZh?: string | null
  descriptionEn?: string | null
  voltage?: string | null
  standard?: string | null
  customer?: string | null
  materialType: number
  spec?: string | null
  color?: string | null
  baseUom: string
  qcFlag: number
  remark?: string | null
  sourceSystem: string
  externalRevision: number
  createdBy?: string | null
}

export interface MaterialSyncRevisionPatch {
  name?: string
  materialGroupCode?: string | null
  materialGroupName?: string | null
  descriptionZh?: string | null
  descriptionEn?: string | null
  voltage?: string | null
  standard?: string | null
  customer?: string | null
  materialType?: number
  spec?: string | null
  color?: string | null
  baseUom?: string
  qcFlag?: number
  remark?: string | null
  sourceSystem?: string
  companyOrgCode?: string
  externalRevision: number
}

/** 料品入站写面：upsert 主表 + 映射 + 隔离队列。 */
export interface MaterialInboundRepository {
  insert(material: NewInboundMaterial): Promise<MaterialRecord>
  applySyncRevision(
    id: string,
    patch: MaterialSyncRevisionPatch,
    actor: string | null,
  ): Promise<MaterialRecord | null>
  findLineMapping(input: {
    sourceSystem: string
    organizationCode: string
    externalId: string
  }): Promise<MaterialInboundMappingRecord | null>
  insertLineMapping(input: {
    sourceSystem: string
    organizationCode: string
    externalId: string
    localObjectId: string
    createdBy?: string | null
  }): Promise<void>
  insertQuarantinedInbox(input: {
    sourceSystem: string
    organizationCode: string
    externalKey: string
    entityType: string
    quarantineReason: string
    payload: unknown
  }): Promise<void>
}

export interface IntegrationMaterialCommandTools extends CommandTools {
  masterdata: MasterDataRepositories
  materialInbound: MaterialInboundRepository
}
