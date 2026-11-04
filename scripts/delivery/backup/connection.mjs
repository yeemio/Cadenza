import {execFile,spawn} from 'node:child_process'
import {promisify} from 'node:util'
import {open} from 'node:fs/promises'
import {loadPg} from '../lib/db.mjs'

export class BackupSafetyError extends Error { constructor(code){super(code);this.code=code} }
const fail=code=>{throw new BackupSafetyError(code)}
const sslKeys=new Map([['sslmode','PGSSLMODE'],['sslrootcert','PGSSLROOTCERT'],['sslcert','PGSSLCERT'],['sslkey','PGSSLKEY'],['connect_timeout','PGCONNECT_TIMEOUT'],['application_name','PGAPPNAME']])
/** One explicit endpoint. Query-string host/db/user overrides, implicit containers and PG* defaults are rejected. */
export function canonicalConnection(raw){
  let url;try{url=new URL(raw)}catch{fail('INVALID_DATABASE_URL')}
  if(!['postgres:','postgresql:'].includes(url.protocol)||!url.hostname||!url.username||url.hash)fail('EXPLICIT_PG_ENDPOINT_REQUIRED')
  const decoded=value=>{try{return decodeURIComponent(value)}catch{fail('INVALID_DATABASE_URL_ENCODING')}}
  const database=decoded(url.pathname.slice(1)),user=decoded(url.username),password=decoded(url.password)
  const host=url.hostname.replace(/^\[|\]$/g,''),port=Number(url.port||5432)
  if(!/^[a-zA-Z0-9_][a-zA-Z0-9_-]*$/.test(database)||!Number.isInteger(port)||port<1||port>65535||/[\u0000-\u001f]/.test(user+password+host))fail('INVALID_PG_ENDPOINT')
  const options={};for(const [key,value] of url.searchParams){if(!sslKeys.has(key)||key in options||/[\u0000-\u001f]/.test(value))fail('AMBIGUOUS_PG_CONNECTION_OPTION');options[key]=value}
  if(options.sslmode&&!['disable','allow','prefer','require','verify-ca','verify-full'].includes(options.sslmode))fail('INVALID_SSL_MODE')
  if(options.connect_timeout&&!/^\d+$/.test(options.connect_timeout))fail('INVALID_CONNECT_TIMEOUT')
  return {url:url.toString(),host,port,user,password,database,options}
}
export function connectionForDatabase(connection,database){const url=new URL(connection.url);url.pathname=`/${database}`;return canonicalConnection(url.toString())}
export function rejectDualLocator(args,env=process.env){if(args['pg-container']!==undefined||env.PG_CONTAINER)fail('PG_CONTAINER_DUAL_LOCATOR_UNSUPPORTED_USE_CANONICAL_DATABASE_URL')}
export function nativePgEnvironment(connection,original=process.env){
  const env=Object.fromEntries(Object.entries(original).filter(([key])=>!key.startsWith('PG')))
  Object.assign(env,{PGHOST:connection.host,PGPORT:String(connection.port),PGUSER:connection.user,PGPASSWORD:connection.password,PGDATABASE:connection.database,PGPASSFILE:'/dev/null',PGCONNECT_TIMEOUT:'15'})
  for(const [key,value] of Object.entries(connection.options))env[sslKeys.get(key)]=value
  return env
}
export const IDENTITY_SQL=`SELECT json_build_object('systemIdentifier',(SELECT system_identifier::text FROM pg_control_system()),'instanceStartedAt',pg_postmaster_start_time(),'database',current_database(),'databaseOid',(SELECT oid::text FROM pg_database WHERE datname=current_database())) AS identity`
export async function readIdentity(client){const row=(await client.query(IDENTITY_SQL)).rows[0];if(!row?.identity)fail('INSTANCE_IDENTITY_UNAVAILABLE');return row.identity}
export function assertSameInstance(expected,actual,{database=true}={}){
  if(!expected?.systemIdentifier||!expected?.instanceStartedAt||!actual?.systemIdentifier||!actual?.instanceStartedAt)fail('INSTANCE_IDENTITY_UNAVAILABLE')
  if(expected.systemIdentifier!==actual.systemIdentifier||Date.parse(expected.instanceStartedAt)!==Date.parse(actual.instanceStartedAt)||(database&&(expected.database!==actual.database||expected.databaseOid!==actual.databaseOid)))fail('PG_INSTANCE_BINDING_MISMATCH')
}
export async function nativeIdentity(connection){
  try{const {stdout}=await promisify(execFile)('psql',['-X','-A','-t','-v','ON_ERROR_STOP=1','-c',IDENTITY_SQL],{env:nativePgEnvironment(connection),maxBuffer:1024*1024,timeout:30_000});return JSON.parse(stdout.trim())}catch{fail('NATIVE_PG_IDENTITY_UNAVAILABLE')}
}
export async function connectCanonical(connection){
  const pg=await loadPg(),client=new pg.Client({connectionString:connection.url,host:connection.host,port:connection.port,user:connection.user,password:connection.password,database:connection.database,connectionTimeoutMillis:15_000})
  try{await client.connect();return client}catch{await client.end().catch(()=>{});fail('PG_CONNECTION_FAILED')}
}
export async function verifyClientBinding(client,connection,probe=nativeIdentity){const identity=await readIdentity(client);if(identity.database!==connection.database)fail('PG_DATABASE_BINDING_MISMATCH');assertSameInstance(identity,await probe(connection));return identity}

/** Credentials stay in the child environment, never argv, manifests or captured stderr. */
export async function runPgFile(tool,connection,args,{output,input}={}){
  if(!['pg_dump','pg_restore'].includes(tool))fail('UNSUPPORTED_PG_TOOL')
  let outputHandle,inputHandle
  try{
    if(output)outputHandle=await open(output,'wx',0o600)
    if(input)inputHandle=await open(input,'r')
    await new Promise((resolve,reject)=>{
      const child=spawn(tool,args,{env:nativePgEnvironment(connection),stdio:[inputHandle?.fd??'ignore',outputHandle?.fd??'ignore','ignore']})
      child.once('error',()=>reject(new BackupSafetyError('PG_NATIVE_TOOL_FAILED')))
      child.once('exit',code=>code===0?resolve():reject(new BackupSafetyError('PG_NATIVE_TOOL_FAILED')))
    })
  }finally{await outputHandle?.close();await inputHandle?.close()}
}

export function parseArgs(argv){
  const args={};for(let i=0;i<argv.length;i++){const key=argv[i];if(!key?.startsWith('--'))fail('INVALID_ARGUMENT');const name=key.slice(2);if(Object.hasOwn(args,name))fail('DUPLICATE_ARGUMENT');const next=argv[i+1];if(next===undefined||next.startsWith('--'))args[name]=true;else{args[name]=next;i++}}
  return args
}
export function safeFailure(error){return error instanceof BackupSafetyError?error.code:'BACKUP_OPERATION_FAILED_NO_SENSITIVE_DIAGNOSTICS_EXPORTED'}
