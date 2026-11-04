import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {BackupSafetyError,nativePgEnvironment} from './connection.mjs'

const fail=code=>{throw new BackupSafetyError(code)}
function major(version){
  const match=/^([1-9]\d*)\.\d+(?:\.\d+)?(?:[ \t].*)?$/.exec(version.trim())
  if(!match||Number(match[1])<10)fail('RESTORE_VERSION_METADATA_UNVERIFIED')
  return Number(match[1])
}
/** Read native archive headers, not caller-supplied manifest version claims. */
export function parseRestoreVersions(list,restoreVersion){
  const field=label=>{
    const matches=[...list.matchAll(new RegExp(`^;[ \\t]*${label}:[ \\t]*([^\\r\\n]+)$`,'gm'))]
    if(matches.length!==1)fail('RESTORE_VERSION_METADATA_UNVERIFIED')
    return major(matches[0][1])
  }
  const client=/^pg_restore \(PostgreSQL\) ([^\r\n]+)$/.exec(restoreVersion.trim())
  if(!client)fail('RESTORE_VERSION_METADATA_UNVERIFIED')
  return {sourceMajor:field('Dumped from database version'),dumpMajor:field('Dumped by pg_dump version'),restoreMajor:major(client[1])}
}
export async function readRestoreVersions(connection,archive){
  try{
    const options={env:{...nativePgEnvironment(connection),LC_ALL:'C'},maxBuffer:16*1024*1024,timeout:30_000}
    const [{stdout:list},{stdout:version}]=await Promise.all([
      promisify(execFile)('pg_restore',['--list',archive],options),
      promisify(execFile)('pg_restore',['--version'],options),
    ])
    return parseRestoreVersions(list,version)
  }catch(error){
    if(error instanceof BackupSafetyError)throw error
    fail('RESTORE_ARCHIVE_OR_NATIVE_CLIENT_PREFLIGHT_FAILED')
  }
}
/** This automatic recreate path supports stable PostgreSQL 10+ same-major pairs only. */
export function assertRestoreCompatibility(versions,serverVersionNum){
  if(!/^\d{6}$/.test(String(serverVersionNum)))fail('RESTORE_VERSION_METADATA_UNVERIFIED')
  const targetMajor=Math.floor(Number(serverVersionNum)/10000)
  if(targetMajor<10||!versions||Object.values(versions).some(v=>!Number.isInteger(v)||v<10)||
    !['sourceMajor','dumpMajor','restoreMajor'].every(k=>Number.isInteger(versions[k])))fail('RESTORE_VERSION_METADATA_UNVERIFIED')
  if(['sourceMajor','dumpMajor','restoreMajor'].some(k=>versions[k]!==targetMajor))fail('RESTORE_NATIVE_VERSION_MISMATCH')
  return {targetMajor,...versions}
}
