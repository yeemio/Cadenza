#!/usr/bin/env node
/** Default and only preflight mode is server-enforced READ ONLY. Reentrancy belongs to an authorized clone drill. */
import {createRequire} from 'node:module'
import {readFile} from 'node:fs/promises'
import path from 'node:path'
import {fileURLToPath,pathToFileURL} from 'node:url'
import {withReadOnlyConnection} from './lib/db.mjs'
import {parseArgs,canonicalConnection,BackupSafetyError,safeFailure} from './backup/connection.mjs'
const DEFAULT_ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..','..')

export function evaluateCompatibility({registry,applied,schemaPresent=true,compat,to}){
  const failures=[]
  if(!Array.isArray(registry)||registry.length===0||registry.some(v=>!/^\d{4}$/.test(v))||new Set(registry).size!==registry.length||registry.some((v,i)=>i>0&&registry[i-1]>=v))throw new BackupSafetyError('INVALID_RELEASE_MIGRATION_REGISTRY')
  if(!schemaPresent)failures.push('SCHEMA_MIGRATIONS_MISSING_NO_IMPLICIT_CREATE')
  const unknown=applied.filter(v=>!registry.includes(v))
  if(unknown.length)failures.push('UNKNOWN_APPLIED_MIGRATION')
  if(applied.some((v,i)=>registry[i]!==v))failures.push('APPLIED_MIGRATIONS_NOT_CONTIGUOUS_PREFIX')
  const target=to??registry.at(-1),current=applied.at(-1)??null
  if(!registry.includes(target))failures.push('UNKNOWN_TARGET_MIGRATION')
  if(current&&target<current)failures.push('DOWNGRADE_FORBIDDEN')
  const pending=registry.filter(v=>v<=target&&!applied.includes(v))
  if(!failures.length){let previous=current;for(const next of pending){const hop=compat?.hops?.find(h=>h.from===previous&&h.to===next);if(hop?.status!=='VERIFIED')failures.push(`UPGRADE_HOP_UNVERIFIED_${previous??'EMPTY'}_TO_${next}`);previous=next}}
  return {mode:'READ_ONLY',ok:failures.length===0,current,target,applied:applied.map(v=>/^\d{4}$/.test(v)?v:'<INVALID_VERSION>'),pending,failures,upgraded:false,reentrancy:'NOT_RUN',legacySampleEvidence:compat?.legacy_sample_evidence??'UNVERIFIED'}
}
export async function checkUpgrade(databaseUrl,options){
  canonicalConnection(databaseUrl)
  return withReadOnlyConnection(databaseUrl,async client=>{
    const registry=(await client.query("SELECT to_regclass('public.schema_migrations') AS registry")).rows[0].registry
    const applied=registry?(await client.query('SELECT version FROM public.schema_migrations ORDER BY version')).rows.map(r=>r.version):[]
    return evaluateCompatibility({...options,applied,schemaPresent:!!registry})
  })
}
export async function registryVersions(root=DEFAULT_ROOT){
  const require=createRequire(path.join(root,'packages/persistence/package.json'))
  return require('./dist/migrations/registry.js').migrations.map(m=>m.version).sort()
}
export async function main(argv=process.argv.slice(2)){
  const args=parseArgs(argv),allowed=new Set(['database-url','compat','repo-root','to','no-reentrancy'])
  if(Object.keys(args).some(k=>!allowed.has(k)))throw new BackupSafetyError('UNSUPPORTED_PREFLIGHT_ARGUMENT_NO_MUTATING_MODE')
  const url=args['database-url']??process.env.DATABASE_URL
  if(!url)throw new BackupSafetyError('DATABASE_URL_REQUIRED')
  const root=path.resolve(args['repo-root']??DEFAULT_ROOT),compat=JSON.parse(await readFile(args.compat??path.join(root,'deploy/upgrade/COMPATIBILITY.json'),'utf8'))
  const result=await checkUpgrade(url,{registry:await registryVersions(root),compat,to:args.to})
  console.log(JSON.stringify(result,null,2));return result.ok?0:1
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href)main().then(code=>{process.exitCode=code}).catch(error=>{console.error(safeFailure(error));process.exitCode=1})
