import { createHash, randomUUID } from 'node:crypto'
import { appendFile, writeFile, readFile } from 'node:fs/promises'
import type { CommandBus, CommandContext, SapReconDeriveInput, VerifiedAuthContext } from '@cadenza/application'
import { SapReconDerivationQueryService, SapSimEngineService, SapSimService } from '@cadenza/application'
import { createPool, PgSapReconDerivationRepository, createPgSapSimFactsRepositories, createPgSapSimRepositories, PgSapSimOutboxReceiptAdapter } from '@cadenza/persistence'
import path from 'node:path'
import { prepareExclusiveEnvironment } from './environment'

type RecordedCommand = { operationId: string; commandType: string; targetId: string; data: unknown }
type ObjectBinding = { objectFullKey: string; unitId: string; unitNo: string; lotNo: string; sourceOperationId: string; commandType: string }
function contains(value: unknown, needle: string): boolean {
  if (value === needle) return true
  if (Array.isArray(value)) return value.some(v => contains(v, needle))
  return typeof value === 'object' && value !== null && Object.values(value).some(v => contains(v, needle))
}

/** Same-run orchestration only. Caller must supply stable engine and reviewed operation inputs.
 * MOM writes exclusively use existing command buses. The only SQL here reads returned identities.
 * No old-run state, expected balances, direct ledger writes, resets, service lifecycle, or .env loading.
 */
export async function newSameRun(label: string) {
  if (!/^[a-z0-9-]+$/.test(label)) throw new Error('Invalid evidence label')
  return createSameRun(await prepareExclusiveEnvironment(label))
}

/** Resume this assignment's single DB/run only; never import a historical run's facts. */
export async function resumeSameRun(directory: string) {
  const evidence=path.resolve(directory)
  const root=path.resolve('delivery/sol-rework-20261031/sap-recon')
  if (!evidence.startsWith(root+'/r2-main-cadenza_sol_recon_1031')) throw new Error('Not an assignment-owned R2 run')
  const meta=JSON.parse(await readFile(path.join(evidence,'environment.json'),'utf8')) as {database:string}
  if (!/^cadenza_sol_recon_1031(?:_\d+_\d+)?$/.test(meta.database)) throw new Error('Unsafe resume database')
  const url=new URL('postgres://postgres:cadenza_dev@127.0.0.1:55433/postgres');url.pathname='/'+meta.database
  const pool=createPool(url.toString(),{max:4})
  await pool.query('SELECT current_database()')
  return createSameRun({pool,database:meta.database,evidence,url:url.toString()},true)
}

async function createSameRun(env: Awaited<ReturnType<typeof prepareExclusiveEnvironment>>, resume=false) {
  const sapRepos = createPgSapSimRepositories(env.pool)
  const engine = new SapSimEngineService(createPgSapSimFactsRepositories(env.pool), new PgSapSimOutboxReceiptAdapter(sapRepos.outbox))
  const sapSim = new SapSimService(sapRepos, engine)
  const commands = new Map<string, RecordedCommand>()
  const bindings = new Map<string, ObjectBinding>()
  const attemptedEvents: string[] = []
  let referencePreconditions = 0
  const derivedObjects: string[] = []
  const log = (record: unknown) => appendFile(`${env.evidence}/same-run.jsonl`, `${JSON.stringify(record)}\n`)
  if (resume) {
    const lines=(await readFile(`${env.evidence}/same-run.jsonl`,'utf8')).trim().split('\n')
    for(const line of lines){
      const row=JSON.parse(line) as Record<string,unknown>
      if(row['kind']==='MOM_COMMAND'){
        const envelope=row['envelope'] as Record<string,unknown>,result=row['result'] as Record<string,unknown>
        if(result['status']==='COMMITTED'||result['status']==='DRAFT_SAVED') commands.set(String(envelope['operationId']),{operationId:String(envelope['operationId']),commandType:String(envelope['commandType']),targetId:String(envelope['targetId']),data:result['data']})
      }
      if(row['kind']==='CADENZA_EXTENSION_OBJECT_BINDING') bindings.set(String(row['objectFullKey']),row as unknown as ObjectBinding)
      if(row['kind']==='SIM_EXECUTE'||row['kind']==='SIM_QUERY') attemptedEvents.push(String((row['event'] as Record<string,unknown>)['event_key']))
      if(row['kind']==='RECON_DERIVE') derivedObjects.push(String((row['binding'] as ObjectBinding).objectFullKey))
      if(row['kind']==='REFERENCE_PRECONDITION_OUTSIDE_56_65') referencePreconditions++
    }
    await log({kind:'SAME_DB_RUN_RESUMED',database:env.database,commands:commands.size,objects:bindings.size})
  }

  return {
    ...env,
    engine,
    sapSim,
    async registerReferenceData(referenceData: Record<string, unknown>, organizationCode: string, plantCode: string) {
      const event = { event_key: `SOL-RECON-REFERENCE-${randomUUID()}`, topic: 'MASTER_VERSION_BUNDLE',
        organization_code: organizationCode, plant_code: plantCode, payload: { reference_data: referenceData } }
      const receipt = await engine.execute(event)
      referencePreconditions += 1
      await log({ kind: 'REFERENCE_PRECONDITION_OUTSIDE_56_65', event, receipt })
      return receipt
    },
    async command(bus: CommandBus, context: CommandContext, commandType: string, targetId: string, payload: Record<string, unknown>) {
      const operationId = randomUUID()
      const envelope = { operationId, commandType, targetId, expectedRevision: 0, payload }
      const result = await bus.execute(envelope, context)
      await log({ kind: 'MOM_COMMAND', database: env.database, envelope, actor: context.actorLoginName, result })
      if (result.status !== 'COMMITTED' && result.status !== 'DRAFT_SAVED') {
        throw new Error(`${commandType}: ${result.status}: ${result.errorMessage ?? ''}`)
      }
      commands.set(operationId, { operationId, commandType, targetId, data: result.data })
      return { operationId, result }
    },
    async bindObject(objectFullKey: string, unitId: string, sourceOperationId: string) {
      const source = commands.get(sourceOperationId)
      if (!source || !contains(source.data, unitId)) throw new Error('Object identity must come from this run business return')
      const r = await env.pool.query(`SELECT iu.unit_no AS "unitNo", ml.lot_no AS "lotNo"
        FROM inventory_unit iu JOIN material_lot ml ON ml.id=iu.lot_id WHERE iu.id=$1`, [unitId])
      if (r.rows.length !== 1) throw new Error('Returned unit identity is absent')
      const row = r.rows[0] as { unitNo: string; lotNo: string }
      const previous = bindings.get(objectFullKey)
      if (previous && previous.unitId !== unitId) throw new Error('Ambiguous object binding')
      const binding = { objectFullKey, unitId, ...row, sourceOperationId, commandType: source.commandType }
      bindings.set(objectFullKey, binding)
      await log({ kind: 'CADENZA_EXTENSION_OBJECT_BINDING', ...binding })
      return binding
    },
    async executeSim(event: Record<string, unknown>, sourceOperationId: string) {
      if (!commands.has(sourceOperationId)) throw new Error('Sim dispatch requires a same-run MOM command anchor')
      const eventKey = String(event['event_key'] ?? '')
      if (!eventKey) throw new Error('Original event key required')
      // Caller passes the frozen payload verbatim; no expected outcome or state overrides are allowed.
      if ('expectedOutcome' in event || 'expected_outcome' in event) throw new Error('Outcome injection prohibited')
      const message = await sapSim.deliverMessage({ source_system: 'SAP_SIM', organization_code: event['organization_code'],
        plant_code: event['plant_code'], external_key: eventKey, entity_type: event['topic'],
        aggregate_type: 'sol_same_run_business_operation', aggregate_id: sourceOperationId, payload: event })
      await log({ kind: 'CADENZA_EXTENSION_ADAPTER_DISPATCH', sourceOperationId, sourceCommandType: commands.get(sourceOperationId)!.commandType,
        outboxEventId: message.outbox.eventId, eventKey, originalEnvelopePreserved: true })
      const receipt = await engine.dispatch(message.outbox.eventId)
      attemptedEvents.push(eventKey)
      await log({ kind: 'SIM_EXECUTE', database: env.database, sourceOperationId, event,
        payloadJsonSha256: createHash('sha256').update(JSON.stringify(event['payload'])).digest('hex'), receipt })
      return receipt
    },
    async querySim(event: Record<string, unknown>, sourceOperationId: string) {
      const eventKey=String(event['event_key'])
      if (!commands.has(sourceOperationId)) throw new Error('Query requires same-run MOM anchor')
      const row=await env.pool.query('SELECT event_id FROM outbox WHERE external_ref=$1',[eventKey])
      if(row.rows.length!==1) throw new Error('Missing original outbox event for query')
      const result=await sapSim.queryConfirm(String(row.rows[0].event_id))
      attemptedEvents.push(eventKey)
      await log({kind:'SIM_QUERY',database:env.database,sourceOperationId,event,result})
      return result
    },
    async derive(auth: VerifiedAuthContext, input: SapReconDeriveInput) {
      const key = input.objectFullKey ?? `CBL01G-${input.objectId}`
      const binding = bindings.get(key)
      if (!binding) throw new Error(`No same-run business-return identity for ${key}`)
      const query = new SapReconDerivationQueryService({ repo: new PgSapReconDerivationRepository(env.pool) })
      const result = await query.derive(auth, { ...input, objectFullKey: key, momUnitNo: binding.unitNo, momLotNo: undefined })
      if (!result.mom.objectUnits.some(unit => unit.id === binding.unitId)) {
        throw new Error(`Actual material/owner/plant identity does not match ${key}`)
      }
      derivedObjects.push(key)
      await log({ kind: 'RECON_DERIVE', binding, result })
      return result
    },
    async close() {
      await writeFile(`${env.evidence}/object-bindings.json`, JSON.stringify([...bindings.values()], null, 2))
      await writeFile(`${env.evidence}/coverage.json`, JSON.stringify({ actual_connection: false,
        denominators: { prd: 45, negative: 18, branches: 12, messages: 56, attempts: 65, objects: 21 },
        observed: { referencePreconditions, businessCommands: commands.size, messages: new Set(attemptedEvents).size,
          attempts: attemptedEvents.length, derivedObjects: new Set(derivedObjects).size },
        interpretation: 'Execution counts only; business acceptance requires individual outcomes and both-end readback.' }, null, 2))
      await env.pool.end()
    },
  }
}
