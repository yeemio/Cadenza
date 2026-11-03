import type {
  MaterialInboundMappingRecord,
  MaterialInboundRepository,
  MaterialSyncRevisionPatch,
  NewInboundMaterial,
} from '@cadenza/application'

/** 与 application MATERIAL_MASTER_OBJECT_TYPE 同字面（避免运行时循环依赖）。 */
const MATERIAL_MASTER_OBJECT_TYPE = 'material_master'
import type { SqlClient } from './sql-client'
import { PgMaterialRepository } from './masterdata-repositories'

/**
 * IF-01 料品入站 Pg 实现：写 material + external_mapping + inbox QUARANTINED。
 * 读投影复用 PgMaterialRepository 列映射（含 external_revision）。
 */

const MAPPING_LINE_NO = 1

export class PgMaterialInboundRepository implements MaterialInboundRepository {
  private readonly materials: PgMaterialRepository

  constructor(private readonly client: SqlClient) {
    this.materials = new PgMaterialRepository(client)
  }

  async insert(material: NewInboundMaterial) {
    const r = await this.client.query(
      `INSERT INTO material (
         id, org_scope_id, code, name, company_org_code, material_group_code, material_group_name,
         description_zh, description_en, voltage, standard, customer, material_type, spec, color,
         base_uom, qc_flag, remark, source_system, external_revision, created_by, updated_by
       ) VALUES (
         COALESCE($1, gen_random_uuid()), $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15,
         $16, $17, $18, $19, $20, $21, $21
       )
       RETURNING id`,
      [
        material.id ?? null,
        material.orgScopeId,
        material.code,
        material.name,
        material.companyOrgCode,
        material.materialGroupCode ?? null,
        material.materialGroupName ?? null,
        material.descriptionZh ?? null,
        material.descriptionEn ?? null,
        material.voltage ?? null,
        material.standard ?? null,
        material.customer ?? null,
        material.materialType,
        material.spec ?? null,
        material.color ?? null,
        material.baseUom,
        material.qcFlag,
        material.remark ?? null,
        material.sourceSystem,
        material.externalRevision,
        material.createdBy ?? null,
      ],
    )
    const id = (r.rows[0] as { id: string }).id
    const row = await this.materials.findById(id)
    if (row === null) throw new Error(`material insert 后找不到行 ${id}`)
    return row
  }

  async applySyncRevision(id: string, patch: MaterialSyncRevisionPatch, actor: string | null) {
    const sets: string[] = ['updated_at = now()', 'updated_by = $1', 'external_revision = $2']
    const values: unknown[] = [actor, patch.externalRevision]
    const add = (column: string, value: unknown): void => {
      values.push(value)
      sets.push(`${column} = $${values.length}`)
    }
    if (patch.name !== undefined) add('name', patch.name)
    if (patch.materialGroupCode !== undefined) add('material_group_code', patch.materialGroupCode)
    if (patch.materialGroupName !== undefined) add('material_group_name', patch.materialGroupName)
    if (patch.descriptionZh !== undefined) add('description_zh', patch.descriptionZh)
    if (patch.descriptionEn !== undefined) add('description_en', patch.descriptionEn)
    if (patch.voltage !== undefined) add('voltage', patch.voltage)
    if (patch.standard !== undefined) add('standard', patch.standard)
    if (patch.customer !== undefined) add('customer', patch.customer)
    if (patch.materialType !== undefined) add('material_type', patch.materialType)
    if (patch.spec !== undefined) add('spec', patch.spec)
    if (patch.color !== undefined) add('color', patch.color)
    if (patch.baseUom !== undefined) add('base_uom', patch.baseUom)
    if (patch.qcFlag !== undefined) add('qc_flag', patch.qcFlag)
    if (patch.remark !== undefined) add('remark', patch.remark)
    if (patch.sourceSystem !== undefined) add('source_system', patch.sourceSystem)
    if (patch.companyOrgCode !== undefined) add('company_org_code', patch.companyOrgCode)
    values.push(id)
    await this.client.query(
      `UPDATE material SET ${sets.join(', ')} WHERE id = $${values.length} AND status = 'active'`,
      values,
    )
    return this.materials.findById(id)
  }

  async findLineMapping(input: {
    sourceSystem: string
    organizationCode: string
    externalId: string
  }): Promise<MaterialInboundMappingRecord | null> {
    const r = await this.client.query(
      `SELECT source_system, organization_code, external_id, line_no, local_object_id
       FROM external_mapping
       WHERE source_system = $1 AND organization_code = $2 AND object_type = $3
         AND external_id = $4 AND line_no = $5`,
      [
        input.sourceSystem,
        input.organizationCode,
        MATERIAL_MASTER_OBJECT_TYPE,
        input.externalId,
        MAPPING_LINE_NO,
      ],
    )
    const row = r.rows[0] as
      | {
          source_system: string
          organization_code: string
          external_id: string
          line_no: number
          local_object_id: string
        }
      | undefined
    if (!row) return null
    return {
      sourceSystem: row.source_system,
      organizationCode: row.organization_code,
      externalId: row.external_id,
      lineNo: row.line_no,
      localObjectId: row.local_object_id,
    }
  }

  async insertLineMapping(input: {
    sourceSystem: string
    organizationCode: string
    externalId: string
    localObjectId: string
    createdBy?: string | null
  }): Promise<void> {
    await this.client.query(
      `INSERT INTO external_mapping (source_system, organization_code, object_type, external_id, line_no,
         local_object_type, local_object_id, created_by)
       VALUES ($1, $2, $3, $4, $5, $3, $6, $7)`,
      [
        input.sourceSystem,
        input.organizationCode,
        MATERIAL_MASTER_OBJECT_TYPE,
        input.externalId,
        MAPPING_LINE_NO,
        input.localObjectId,
        input.createdBy ?? null,
      ],
    )
  }

  async insertQuarantinedInbox(input: {
    sourceSystem: string
    organizationCode: string
    externalKey: string
    entityType: string
    quarantineReason: string
    payload: unknown
  }): Promise<void> {
    await this.client.query(
      `INSERT INTO inbox (source_system, organization_code, external_key, entity_type, status,
         quarantine_reason, payload)
       VALUES ($1, $2, $3, $4, 'QUARANTINED', $5, $6::jsonb)
       ON CONFLICT (source_system, organization_code, external_key, entity_type) DO NOTHING`,
      [
        input.sourceSystem,
        input.organizationCode,
        input.externalKey,
        input.entityType,
        input.quarantineReason,
        JSON.stringify(input.payload ?? {}),
      ],
    )
  }
}
