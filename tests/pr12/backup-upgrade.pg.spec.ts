import {afterAll,beforeAll,describe,expect,it} from 'vitest'
import {createPool,migrations} from '@cadenza/persistence'
import {mkdtemp,writeFile,readFile,readdir,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import path from 'node:path'
import {createHash,randomUUID} from 'node:crypto'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {canonicalConnection,connectCanonical,nativeIdentity,verifyClientBinding,readIdentity} from '../../scripts/delivery/backup/connection.mjs'
import {runBackup} from '../../scripts/delivery/backup/backup.mjs'
import {runRestore} from '../../scripts/delivery/backup/restore.mjs'
import {checkUpgrade} from '../../scripts/delivery/upgrade-compat-check.mjs'
const aUrl=process.env['CADENZA_PR12_INSTANCE_A_URL'],bUrl=process.env['CADENZA_PR12_INSTANCE_B_URL'],restoreUrl=process.env['CADENZA_PR12_RESTORE_URL']
for(const url of [aUrl,bUrl,restoreUrl])if(!url||!/^cadenza_dops_pr12_[a-z0-9_]+$/.test(new URL(url).pathname.slice(1)))throw new Error('NOT_RUN: PR12 requires two distinct authorized PostgreSQL instances with same-name NEW EMPTY cadenza_dops_pr12_* databases and a separate NEW EMPTY restore target')
const a=canonicalConnection(aUrl!),b=canonicalConnection(bUrl!),target=canonicalConnection(restoreUrl!)
if(a.database!==b.database||(a.host===b.host&&a.port===b.port)||target.url===a.url||target.url===b.url)throw new Error('NOT_RUN: two-instance/same-database-name and separate-target prerequisites not satisfied')
const poolA=createPool(aUrl!),poolB=createPool(bUrl!),registry=migrations.map(m=>m.version).sort()
const compat={hops:[{from:'0030',to:'0031',status:'UNVERIFIED'}],legacy_sample_evidence:'E02_UNVERIFIED'}
let temporary:string,backupDir:string
const cleanEnv={...process.env,PG_CONTAINER:''}
async function versions(values:string[]){await poolA.query('TRUNCATE schema_migrations');for(const v of values)await poolA.query('INSERT INTO schema_migrations(version,name) VALUES($1,$2)',[v,'PR12 synthetic version fixture; not historical business data'])}
async function digest(){const tables=(await poolA.query("SELECT table_name,column_name,data_type,is_nullable,column_default FROM information_schema.columns WHERE table_schema='public' ORDER BY table_name,ordinal_position")).rows;const indexes=(await poolA.query("SELECT tablename,indexname,indexdef FROM pg_indexes WHERE schemaname='public' ORDER BY tablename,indexname")).rows;const marker=(await poolA.query('SELECT * FROM pr12_sentinel ORDER BY marker')).rows;const exists=(await poolA.query("SELECT to_regclass('public.schema_migrations') x")).rows[0]!.x;const applied=exists?(await poolA.query('SELECT * FROM schema_migrations ORDER BY version')).rows:null;return createHash('sha256').update(JSON.stringify({tables,indexes,marker,applied})).digest('hex')}
async function checked(to?:string){const before=await digest();const result=await checkUpgrade(aUrl!,{registry,compat,to});const after=await digest();expect(after).toBe(before);expect(result.mode).toBe('READ_ONLY');expect(result.upgraded).toBe(false);console.log('PR12_READ_ONLY_DIGEST',JSON.stringify({before,after,result}));return result}
beforeAll(async()=>{
  for(const tool of ['psql','pg_dump','pg_restore'])try{await promisify(execFile)(tool,['--version'])}catch{throw new Error(`NOT_RUN: required native client unavailable: ${tool}`)}
  const targetClient=await connectCanonical(target)
  try{for(const client of [poolA,poolB,targetClient])if((await client.query("SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'")).rowCount)throw new Error('Refusing nonempty PR12 database')}finally{await targetClient.end()}
  for(const [pool,marker] of [[poolA,'INSTANCE_A'],[poolB,'INSTANCE_B']] as const){await pool.query('CREATE TABLE pr12_sentinel(marker text PRIMARY KEY, payload text NOT NULL)');await pool.query('INSERT INTO pr12_sentinel VALUES($1,$2)',[marker,'isolated synthetic source']);await pool.query('CREATE TABLE schema_migrations(version text PRIMARY KEY,name text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now())')}
  await versions(registry)
  const clientA=await connectCanonical(a),clientB=await connectCanonical(b)
  try{const ia=await readIdentity(clientA),ib=await readIdentity(clientB);expect(ia.systemIdentifier).not.toBe(ib.systemIdentifier);expect(ia.database).toBe(ib.database);console.log('PR12_TWO_INSTANCES',JSON.stringify({a:ia,b:ib}))}finally{await clientA.end();await clientB.end()}
  temporary=await mkdtemp(path.join(tmpdir(),'cadenza-pr12-real-'))
},120_000)
afterAll(async()=>{await poolA.end();await poolB.end();if(temporary)await rm(temporary,{recursive:true,force:true})})
describe.sequential('PR12 actual PostgreSQL/native clients; synthetic isolated fixture is not E02 legacy evidence',()=>{
  it('same-name different-instance native identity is rejected before dump/recreation',async()=>{const clientA=await connectCanonical(a);const before=await digest();try{await expect(verifyClientBinding(clientA,a,()=>nativeIdentity(b))).rejects.toThrow(/BINDING_MISMATCH/)}finally{await clientA.end()}expect(await digest()).toBe(before);expect((await poolB.query('SELECT marker FROM pr12_sentinel')).rows[0]!.marker).toBe('INSTANCE_B')})
  it('latest registry check preserves schema/data/version digest',async()=>{await versions(registry);expect((await checked()).ok).toBe(true)})
  it('synthetic 0030 prefix is read-only and leaves E02/0031 unverified',async()=>{await versions(registry.slice(0,-1));const r=await checked();expect(r.ok).toBe(false);expect(r.failures).toContain('UPGRADE_HOP_UNVERIFIED_0030_TO_0031')})
  it('downgrade preflight cannot mutate target',async()=>{await versions(registry);expect((await checked('0009')).failures).toContain('DOWNGRADE_FORBIDDEN')})
  it('unknown migration preflight cannot mutate target',async()=>{await versions([...registry,'9999']);expect((await checked()).failures).toContain('UNKNOWN_APPLIED_MIGRATION')})
  it('non-contiguous registry prefix cannot mutate target',async()=>{await versions(registry.filter(v=>v!=='0030'));expect((await checked()).failures).toContain('APPLIED_MIGRATIONS_NOT_CONTIGUOUS_PREFIX')})
  it('missing migration table is not created by inspection',async()=>{await poolA.query('DROP TABLE schema_migrations');expect((await checked()).failures).toContain('SCHEMA_MIGRATIONS_MISSING_NO_IMPLICIT_CREATE');await poolA.query('CREATE TABLE schema_migrations(version text PRIMARY KEY,name text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now())');await versions(registry)})
  it('actual custom-format backup and all generated artifacts contain none of the synthetic secret values',async()=>{const secrets=Array.from({length:6},()=>`PR12_PRIVATE_${randomUUID()}`),envFile=path.join(temporary,'source.env');await writeFile(envFile,`NODE_ENV=production\nTOKEN=${secrets[0]}\nAI_RUNTIME_INTERNAL_TOKEN=${secrets[1]}\nAI_INTERNAL_QUERY_TOKEN=${secrets[2]}\nPASSWORD=${secrets[3]}\nSECRET=${secrets[4]}\nAPI_KEY=${secrets[5]}\n`);const result=await runBackup({'database-url':aUrl,'env-file':envFile,out:path.join(temporary,'media')},cleanEnv);backupDir=result.outputDir;for(const name of await readdir(backupDir)){const bytes=await readFile(path.join(backupDir,name));for(const value of secrets)expect(bytes.includes(Buffer.from(value)),name).toBe(false)}expect(result.manifest.source_database).toBe(a.database);expect(result.manifest.schema_migrations).toEqual(registry)})
  it('wrong dual locator refuses restore before target recreation',async()=>{expect(backupDir).toBeTruthy();await expect(runRestore({'backup-dir':backupDir,'database-url':restoreUrl,'target-confirm':target.database}, {...cleanEnv,PG_CONTAINER:'INSTANCE_B'})).rejects.toThrow(/DUAL_LOCATOR/);const c=await connectCanonical(target);try{expect((await c.query("SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'")).rowCount).toBe(0)}finally{await c.end()}})
  it('restore binds the intended target and recovers A sentinel while B remains B',async()=>{const restored=await runRestore({'backup-dir':backupDir,'database-url':restoreUrl,'target-confirm':target.database},cleanEnv);expect(restored.schema_migrations).toEqual(registry);const c=await connectCanonical(target);try{expect((await c.query('SELECT marker FROM pr12_sentinel')).rows[0]!.marker).toBe('INSTANCE_A')}finally{await c.end()}expect((await poolB.query('SELECT marker FROM pr12_sentinel')).rows[0]!.marker).toBe('INSTANCE_B')})
})

describe.sequential('PR12 R1 actual incompatible native pairing preserves the existing task target',()=>{
  it('newer pg_dump/pg_restore archive refuses before target recreation',async()=>{
    const badBin=process.env['CADENZA_PR12_INCOMPATIBLE_CLIENT_BIN']
    if(!badBin||!path.isAbsolute(badBin))throw new Error('NOT_RUN: provide an absolute directory containing newer native pg_dump/pg_restore for the dedicated incompatible-client proof')
    const {parseRestoreVersions}=await import('../../scripts/delivery/backup/native-compatibility.mjs')
    const dumpVersion=(await promisify(execFile)(path.join(badBin,'pg_dump'),['--version'])).stdout
    const restoreVersion=(await promisify(execFile)(path.join(badBin,'pg_restore'),['--version'])).stdout
    const dumpMajor=Number(/^pg_dump \(PostgreSQL\) (\d+)\./.exec(dumpVersion)?.[1])
    const restoreMajor=Number(/^pg_restore \(PostgreSQL\) (\d+)\./.exec(restoreVersion)?.[1])
    const c=await connectCanonical(target)
    let serverMajor:number
    try{
      serverMajor=Math.floor(Number((await c.query('SHOW server_version_num')).rows[0]!.server_version_num)/10000)
      if(!Number.isInteger(dumpMajor)||dumpMajor!==restoreMajor||dumpMajor<=serverMajor)throw new Error('NOT_RUN: incompatible proof requires a matched native pair newer than the target server')
      // Only the newly authorized target from this suite is used; never an old failed database.
      await c.query('INSERT INTO pr12_sentinel(marker,payload) VALUES($1,$2)',['KEEP_BEFORE_RECREATE','must survive native compatibility rejection'])
    }finally{await c.end()}
    const observe=async()=>{
      const client=await connectCanonical(target)
      try{
        const identity=await readIdentity(client)
        const exists=(await client.query("SELECT to_regclass('public.pr12_sentinel') AS sentinel,to_regclass('public.schema_migrations') AS registry")).rows[0]!
        const markers=exists.sentinel?(await client.query('SELECT * FROM pr12_sentinel ORDER BY marker')).rows:null
        const versions=exists.registry?(await client.query('SELECT * FROM schema_migrations ORDER BY version')).rows:null
        return {identity,markers,versions}
      }finally{await client.end()}
    }
    const before=await observe()
    const nativeEnv={...cleanEnv,PATH:`${badBin}${path.delimiter}${process.env['PATH']??''}`,LC_ALL:'C'}
    const cli=async(script:string,args:string[])=>{
      try{const result=await promisify(execFile)(process.execPath,[path.resolve(`scripts/delivery/backup/${script}.mjs`),...args],{env:nativeEnv,maxBuffer:1024*1024,timeout:120_000});return {exitCode:0,stdout:result.stdout,stderr:result.stderr}}
      catch(error){const failed=error as {code?:number|string;stdout?:string;stderr?:string};return {exitCode:failed.code,stdout:failed.stdout??'',stderr:failed.stderr??''}}
    }
    const backup=await cli('backup',['--database-url',aUrl!,'--out',path.join(temporary,'newer-native-media')])
    expect(backup.exitCode,backup.stderr).toBe(0)
    const badBackupDir=String(JSON.parse(backup.stdout).backup_dir)
    const list=(await promisify(execFile)(path.join(badBin,'pg_restore'),['--list',path.join(badBackupDir,'database.dump')],{env:nativeEnv,maxBuffer:16*1024*1024})).stdout
    const archiveVersions=parseRestoreVersions(list,restoreVersion)
    expect(archiveVersions).toEqual({sourceMajor:serverMajor,dumpMajor,restoreMajor})
    const archiveSha256=createHash('sha256').update(await readFile(path.join(badBackupDir,'database.dump'))).digest('hex')
    const refusal=await cli('restore',['--backup-dir',badBackupDir,'--database-url',restoreUrl!,'--target-confirm',target.database!])
    const after=await observe()
    console.log('PR12_NATIVE_PREFLIGHT',JSON.stringify({archiveSha256,archiveVersions,targetMajor:serverMajor,exitCode:refusal.exitCode,error:refusal.stderr.trim(),before,after}))
    expect(refusal.exitCode).not.toBe(0)
    expect(refusal.stderr.trim()).toBe('RESTORE_NATIVE_VERSION_MISMATCH')
    expect(after).toEqual(before) // Database OID, sentinel and registry survive; no recreate.
    expect((await poolA.query('SELECT marker FROM pr12_sentinel')).rows).toEqual([{marker:'INSTANCE_A'}])
    expect((await poolB.query('SELECT marker FROM pr12_sentinel')).rows).toEqual([{marker:'INSTANCE_B'}])
  })
})
