#!/usr/bin/env node
import {mkdir,readFile,writeFile,rm,stat} from 'node:fs/promises'
import path from 'node:path'
import {fileURLToPath,pathToFileURL} from 'node:url'
import {randomUUID} from 'node:crypto'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {canonicalConnection,rejectDualLocator,connectCanonical,verifyClientBinding,assertSameInstance,readIdentity,runPgFile,parseArgs,safeFailure,BackupSafetyError} from './connection.mjs'
import {redactedConfiguration} from './config.mjs'
import {writeHashes,inspectObjectRoot} from './media.mjs'

export function backupRepositoryRoot(){return path.resolve(fileURLToPath(new URL('../../..',import.meta.url)))}
export async function runBackup(args,env=process.env){
  rejectDualLocator(args,env)
  const allowed=new Set(['database-url','object-store-root','env-file','out','repo-root'])
  if(Object.keys(args).some(k=>!allowed.has(k)))throw new BackupSafetyError('UNSUPPORTED_BACKUP_ARGUMENT')
  const connection=canonicalConnection(args['database-url']??env.DATABASE_URL)
  const root=path.resolve(args['repo-root']??backupRepositoryRoot())
  const outputRoot=path.resolve(args.out??path.join(root,'backups'))
  const sourceConfig=args['env-file']?await readFile(args['env-file'],'utf8'):''
  const objectRoot=args['object-store-root']?await inspectObjectRoot(args['object-store-root'],args['env-file']):null
  let client,outputDir,created=false;const started=new Date()
  try{
    client=await connectCanonical(connection)
    const identity=await verifyClientBinding(client,connection) // before creating dump media
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
    const snapshot=String((await client.query('SELECT pg_export_snapshot() AS snapshot')).rows[0].snapshot)
    const hasRegistry=(await client.query("SELECT to_regclass('public.schema_migrations') AS registry")).rows[0].registry
    const migrations=hasRegistry?(await client.query('SELECT version FROM public.schema_migrations ORDER BY version')).rows.map(r=>r.version):[]
    const serverNow=(await client.query('SELECT now()::text AS now')).rows[0].now
    await mkdir(outputRoot,{recursive:true,mode:0o700})
    outputDir=path.join(outputRoot,`${started.toISOString().replace(/[:.]/g,'-')}-${randomUUID()}`)
    await mkdir(outputDir,{mode:0o700});created=true
    await runPgFile('pg_dump',connection,['--format=custom','--no-password',`--snapshot=${snapshot}`],{output:path.join(outputDir,'database.dump')})
    if((await stat(path.join(outputDir,'database.dump'))).size===0)throw new BackupSafetyError('EMPTY_DATABASE_DUMP')
    assertSameInstance(identity,await readIdentity(client))
    await verifyClientBinding(client,connection)
    await client.query('ROLLBACK')
    if(objectRoot)await promisify(execFile)('tar',['-czf',path.join(outputDir,'object-store.tar.gz'),'-C',objectRoot,'.'])
    await writeFile(path.join(outputDir,'object-store.readme'),objectRoot?'Object media supplied; its capture is separate from the database snapshot.\n':'Object media absent; restore must not invent or overwrite attachments.\n',{mode:0o600})
    await writeFile(path.join(outputDir,'config.redacted.env'),redactedConfiguration(sourceConfig),{mode:0o600})
    const manifest={format:2,backup_id:path.basename(outputDir),source_database:connection.database,sourceInstance:identity,schema_migrations:migrations,server_now_at_backup:serverNow,databaseSnapshot:snapshot,started_at:started.toISOString(),finished_at:new Date().toISOString(),configPolicy:'NON_SECRET_VALUE_ALLOWLIST_ONLY',objectMedia:objectRoot?'PRESENT_SEPARATE_CAPTURE':'ABSENT'}
    await writeFile(path.join(outputDir,'BACKUP-MANIFEST.json'),JSON.stringify(manifest,null,2)+'\n',{mode:0o600})
    await writeHashes(outputDir)
    await writeFile(path.join(outputRoot,'backup-status.json'),JSON.stringify({result:'ok',backup_dir:outputDir,started_at:started.toISOString(),finished_at:new Date().toISOString(),detail:'CANONICAL_INSTANCE_BOUND_BACKUP_CREATED_RESTORE_NOT_YET_PROVEN'})+'\n',{mode:0o600})
    return {outputDir,manifest}
  }catch(error){
    if(created)await rm(outputDir,{recursive:true,force:true})
    if(created)await writeFile(path.join(outputRoot,'backup-status.json'),JSON.stringify({result:'failed',started_at:started.toISOString(),detail:safeFailure(error)})+'\n',{mode:0o600})
    throw error
  }finally{if(client){await client.query('ROLLBACK').catch(()=>{});await client.end()}}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
  process.umask(0o077)
  runBackup(parseArgs(process.argv.slice(2))).then(r=>console.log(JSON.stringify({result:'ok',backup_dir:r.outputDir}))).catch(error=>{console.error(safeFailure(error));process.exitCode=1})
}
