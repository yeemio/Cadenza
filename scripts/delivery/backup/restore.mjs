#!/usr/bin/env node
import {readFile,writeFile,mkdir,lstat} from 'node:fs/promises'
import path from 'node:path'
import {pathToFileURL} from 'node:url'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {assertDrillSafeDbName} from '../lib/db.mjs'
import {canonicalConnection,connectionForDatabase,rejectDualLocator,connectCanonical,verifyClientBinding,assertSameInstance,readIdentity,runPgFile,nativePgEnvironment,parseArgs,safeFailure,BackupSafetyError} from './connection.mjs'
import {verifyMedia,inspectObjectRoot} from './media.mjs'

export async function recreateBoundDatabase(connection,targetConfirm){
  assertDrillSafeDbName(connection.database)
  if(targetConfirm!==connection.database)throw new BackupSafetyError('EXACT_TARGET_DATABASE_CONFIRMATION_REQUIRED')
  const admin=connectionForDatabase(connection,'postgres'),client=await connectCanonical(admin)
  try{
    const identity=await verifyClientBinding(client,admin) // Node and native target instance must match before DROP
    assertSameInstance(identity,await readIdentity(client))
    await client.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()',[connection.database])
    await client.query(`DROP DATABASE IF EXISTS "${connection.database}"`)
    await client.query(`CREATE DATABASE "${connection.database}" ENCODING 'UTF8'`)
    assertSameInstance(identity,await readIdentity(client))
    return identity
  }finally{await client.end()}
}
export async function runRestore(args,env=process.env){
  rejectDualLocator(args,env)
  const allowed=new Set(['backup-dir','database-url','target-confirm','object-store-root','repo-root'])
  if(Object.keys(args).some(k=>!allowed.has(k)))throw new BackupSafetyError('UNSUPPORTED_RESTORE_ARGUMENT')
  const connection=canonicalConnection(args['database-url']??env.DATABASE_URL)
  assertDrillSafeDbName(connection.database)
  if(args['target-confirm']!==connection.database)throw new BackupSafetyError('EXACT_TARGET_DATABASE_CONFIRMATION_REQUIRED')
  if(typeof args['backup-dir']!=='string')throw new BackupSafetyError('BACKUP_DIRECTORY_REQUIRED')
  const dir=path.resolve(args['backup-dir']),manifest=await verifyMedia(dir)
  // Missing/incompatible pg_restore or corrupt custom archive must fail before DROP/CREATE.
  try{await promisify(execFile)('pg_restore',['--list',path.join(dir,'database.dump')],{env:nativePgEnvironment(connection),maxBuffer:16*1024*1024,timeout:30_000})}catch{throw new BackupSafetyError('RESTORE_ARCHIVE_OR_NATIVE_CLIENT_PREFLIGHT_FAILED')}
  let archive=false
  try{archive=(await lstat(path.join(dir,'object-store.tar.gz'))).isFile()}catch(error){if(error.code!=='ENOENT')throw error}
  let destination
  if(archive){
    if(typeof args['object-store-root']!=='string')throw new BackupSafetyError('EXPLICIT_OBJECT_RESTORE_ROOT_REQUIRED')
    destination=path.resolve(args['object-store-root'])
    const {stdout}=await promisify(execFile)('tar',['-tzf',path.join(dir,'object-store.tar.gz')],{maxBuffer:16*1024*1024})
    if(stdout.split('\n').filter(Boolean).some(name=>name.startsWith('/')||name.split('/').includes('..')))throw new BackupSafetyError('UNSAFE_OBJECT_ARCHIVE_PATH')
    try{await inspectObjectRoot(destination)}catch(error){if(error.code!=='ENOENT')throw error}
  }
  const boundInstance=await recreateBoundDatabase(connection,args['target-confirm'])
  let client=await connectCanonical(connection)
  try{
    const target=await verifyClientBinding(client,connection);assertSameInstance(boundInstance,target,{database:false})
    await runPgFile('pg_restore',connection,['--dbname',connection.database,'--exit-on-error','--single-transaction','--no-owner','--no-privileges','--no-password'],{input:path.join(dir,'database.dump')})
    assertSameInstance(target,await readIdentity(client));await verifyClientBinding(client,connection)
    const exists=(await client.query("SELECT to_regclass('public.schema_migrations') AS registry")).rows[0].registry
    const applied=exists?(await client.query('SELECT version FROM public.schema_migrations ORDER BY version')).rows.map(r=>r.version):[]
    if(JSON.stringify(applied)!==JSON.stringify(manifest.schema_migrations))throw new BackupSafetyError('RESTORED_MIGRATION_FINGERPRINT_MISMATCH')
    if(archive){await mkdir(destination,{recursive:true,mode:0o700});await promisify(execFile)('tar',['-xzf',path.join(dir,'object-store.tar.gz'),'--no-same-owner','--no-same-permissions','-C',destination])}
    // A reference file is not an executable environment and never injects secrets automatically.
    await writeFile(path.join(dir,'config.restored.env'),await readFile(path.join(dir,'config.redacted.env')),{mode:0o600})
    return {result:'RESTORED_FINGERPRINT_MATCHED_RECONCILIATION_REQUIRED',targetInstance:target,schema_migrations:applied}
  }finally{await client.end()}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
  process.umask(0o077)
  runRestore(parseArgs(process.argv.slice(2))).then(r=>console.log(JSON.stringify(r))).catch(error=>{console.error(safeFailure(error));process.exitCode=1})
}
