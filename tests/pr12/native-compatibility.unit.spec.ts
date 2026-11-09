import {beforeEach,describe,expect,it,vi} from 'vitest'
import {canonicalConnection,connectCanonical,verifyClientBinding,readIdentity,runPgFile} from '../../scripts/delivery/backup/connection.mjs'
import {parseRestoreVersions,assertRestoreCompatibility,readRestoreVersions} from '../../scripts/delivery/backup/native-compatibility.mjs'
import {recreateBoundDatabase,runRestore} from '../../scripts/delivery/backup/restore.mjs'

// Port doubles prove the actual restore coordinator's ordering, not native PG.
vi.mock('../../scripts/delivery/backup/connection.mjs',async importOriginal=>({
  ...await importOriginal<typeof import('../../scripts/delivery/backup/connection.mjs')>(),
  connectCanonical:vi.fn(),verifyClientBinding:vi.fn(),readIdentity:vi.fn(),runPgFile:vi.fn(),
}))
vi.mock('../../scripts/delivery/backup/native-compatibility.mjs',async importOriginal=>({
  ...await importOriginal<typeof import('../../scripts/delivery/backup/native-compatibility.mjs')>(),readRestoreVersions:vi.fn(),
}))
vi.mock('../../scripts/delivery/backup/media.mjs',()=>({verifyMedia:vi.fn(async()=>({schema_migrations:[]})),inspectObjectRoot:vi.fn()}))
const connection=canonicalConnection('postgresql://fixture:synthetic@127.0.0.1:5544/cadenza_dops_pr12_restore_unit')
const identity={systemIdentifier:'700000000000000001',instanceStartedAt:'2026-11-04T00:00:00Z',database:'postgres',databaseOid:'5'}
const matching={sourceMajor:16,dumpMajor:16,restoreMajor:16}
const header=(source='16.15 (Debian 16.15-1)',dump='16.14')=>`;\n;     Dumped from database version: ${source}\n;     Dumped by pg_dump version: ${dump}\n;\n`
let client:{query:ReturnType<typeof vi.fn>;end:ReturnType<typeof vi.fn>}
beforeEach(()=>{
  vi.clearAllMocks()
  client={query:vi.fn(async(sql:string)=>({rows:sql==='SHOW server_version_num'?[{server_version_num:'160015'}]:[]})),end:vi.fn(async()=>{})}
  vi.mocked(connectCanonical).mockResolvedValue(client)
  vi.mocked(verifyClientBinding).mockResolvedValue(identity)
  vi.mocked(readIdentity).mockResolvedValue(identity)
  vi.mocked(readRestoreVersions).mockResolvedValue(matching)
})
describe('PR12 native restore compatibility preflight (local boundary evidence)',()=>{
  it('accepts same-major stable client/source/archive/target with different minor releases',()=>{
    const versions=parseRestoreVersions(header(),'pg_restore (PostgreSQL) 16.13 (Homebrew)\n')
    expect(assertRestoreCompatibility(versions,'160015')).toEqual({...matching,targetMajor:16})
  })
  it.each([
    ['missing archive producer',`;\n; Dumped from database version: 16.15\n`,'pg_restore (PostgreSQL) 16.15'],
    ['duplicate archive producer',header()+'; Dumped by pg_dump version: 16.15\n','pg_restore (PostgreSQL) 16.15'],
    ['unrecognized client',header(),'unknown SYNTHETIC_PRIVATE_VALUE'],
    ['prerelease client',header(),'pg_restore (PostgreSQL) 16beta1'],
    ['legacy version scheme',header('9.6.24','9.6.24'),'pg_restore (PostgreSQL) 9.6.24'],
  ])('rejects unverifiable metadata: %s',(_name,list,version)=>{
    expect(()=>parseRestoreVersions(list!,version!)).toThrow('RESTORE_VERSION_METADATA_UNVERIFIED')
  })
  it.each([undefined,'16.15','unknown'])('unknown target version %s cannot reach mutation',async version=>{
    client.query.mockResolvedValue({rows:[{server_version_num:version}]})
    await expect(recreateBoundDatabase(connection,connection.database,matching)).rejects.toThrow('RESTORE_VERSION_METADATA_UNVERIFIED')
    expect(client.query.mock.calls.map(c=>c[0])).toEqual(['SHOW server_version_num'])
    expect(client.end).toHaveBeenCalledTimes(1)
  })
  it.each([
    {sourceMajor:16,dumpMajor:18,restoreMajor:18},
    {sourceMajor:16,dumpMajor:18,restoreMajor:16},
    {sourceMajor:18,dumpMajor:16,restoreMajor:16},
    {sourceMajor:16,dumpMajor:16,restoreMajor:18},
  ])('actual runRestore refuses $sourceMajor/$dumpMajor/$restoreMajor on target16 before terminate/DROP/CREATE',async versions=>{
    vi.mocked(readRestoreVersions).mockResolvedValue(versions)
    await expect(runRestore({'backup-dir':'/pr12-unit-missing-object-archive','database-url':connection.url,'target-confirm':connection.database},{}))
      .rejects.toThrow('RESTORE_NATIVE_VERSION_MISMATCH')
    expect(readRestoreVersions).toHaveBeenCalledWith(connection,'/pr12-unit-missing-object-archive/database.dump')
    expect(verifyClientBinding).toHaveBeenCalledTimes(1)
    expect(client.query.mock.calls.map(c=>c[0])).toEqual(['SHOW server_version_num'])
    expect(runPgFile).not.toHaveBeenCalled()
    expect(client.end).toHaveBeenCalledTimes(1)
  })
  it('checks compatibility on the bound admin connection before the existing recreation sequence',async()=>{
    await expect(recreateBoundDatabase(connection,connection.database,matching)).resolves.toEqual(identity)
    expect(vi.mocked(connectCanonical).mock.calls[0]![0].database).toBe('postgres')
    const sql=client.query.mock.calls.map(c=>String(c[0]))
    expect(sql[0]).toBe('SHOW server_version_num')
    expect(sql.slice(1)).toEqual([
      'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()',
      `DROP DATABASE IF EXISTS "${connection.database}"`,
      `CREATE DATABASE "${connection.database}" ENCODING 'UTF8'`,
    ])
    expect(client.end).toHaveBeenCalledTimes(1)
  })
})
