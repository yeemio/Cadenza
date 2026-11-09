import {createHash} from 'node:crypto'
import {createReadStream} from 'node:fs'
import {readFile,writeFile,lstat,realpath,readdir} from 'node:fs/promises'
import path from 'node:path'
import {BackupSafetyError} from './connection.mjs'
export const MEDIA_FILES=['database.dump','object-store.tar.gz','object-store.readme','config.redacted.env','BACKUP-MANIFEST.json']
export async function sha256File(file){const hash=createHash('sha256');for await(const chunk of createReadStream(file))hash.update(chunk);return hash.digest('hex')}
export async function writeHashes(dir){const lines=[];for(const name of MEDIA_FILES){try{if((await lstat(path.join(dir,name))).isFile())lines.push(`${await sha256File(path.join(dir,name))}  ${name}`)}catch(error){if(error.code!=='ENOENT')throw error}}await writeFile(path.join(dir,'SHA256SUMS'),lines.join('\n')+'\n',{mode:0o600,flag:'wx'})}
export async function verifyMedia(dir){
  const lines=(await readFile(path.join(dir,'SHA256SUMS'),'utf8')).trim().split('\n'),seen=new Set()
  for(const line of lines){const match=/^([a-f0-9]{64})  (.+)$/.exec(line);if(!match||!MEDIA_FILES.includes(match[2])||seen.has(match[2]))throw new BackupSafetyError('INVALID_MEDIA_HASH_LIST');seen.add(match[2]);const file=path.join(dir,match[2]);if(!(await lstat(file)).isFile()||await sha256File(file)!==match[1])throw new BackupSafetyError('MEDIA_HASH_MISMATCH')}
  for(const file of ['database.dump','config.redacted.env','BACKUP-MANIFEST.json'])if(!seen.has(file))throw new BackupSafetyError('REQUIRED_MEDIA_HASH_MISSING')
  for(const file of MEDIA_FILES){try{await lstat(path.join(dir,file));if(!seen.has(file))throw new BackupSafetyError('UNHASHED_MEDIA_ARTIFACT')}catch(error){if(error.code!=='ENOENT')throw error}}
  const manifest=JSON.parse(await readFile(path.join(dir,'BACKUP-MANIFEST.json'),'utf8'))
  if(manifest.format!==2||!manifest.sourceInstance?.systemIdentifier||!Array.isArray(manifest.schema_migrations))throw new BackupSafetyError('LEGACY_OR_INVALID_BACKUP_MANIFEST_UNVERIFIED')
  if((manifest.objectMedia==='PRESENT_SEPARATE_CAPTURE')!==seen.has('object-store.tar.gz'))throw new BackupSafetyError('OBJECT_MEDIA_MANIFEST_MISMATCH')
  return manifest
}
/** Object media is data, not a second path to export .env or secret files/symlinks. */
export async function inspectObjectRoot(root,envFile){
  const actual=await realpath(root),env=envFile?await realpath(envFile):null
  async function walk(dir){for(const entry of await readdir(dir,{withFileTypes:true})){const file=path.join(dir,entry.name);if(entry.isSymbolicLink()||!entry.isDirectory()&&!entry.isFile())throw new BackupSafetyError('OBJECT_STORE_LINK_OR_SPECIAL_FILE_UNSUPPORTED');if(file===env||/^\.env(?:\.|$)/i.test(entry.name))throw new BackupSafetyError('ENV_FILE_MUST_NOT_BE_INSIDE_OBJECT_MEDIA');if(entry.isDirectory())await walk(file)}}
  await walk(actual);return actual
}
