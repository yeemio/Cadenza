#!/usr/bin/env node
/** One canonical connection for read helpers and guarded drill recreation. No implicit container endpoint. */
import path from 'node:path'
import {pathToFileURL} from 'node:url'
import {canonicalConnection,connectionForDatabase,connectCanonical,readIdentity,rejectDualLocator,parseArgs,safeFailure,BackupSafetyError} from './connection.mjs'
import {recreateBoundDatabase} from './restore.mjs'
export async function main(argv=process.argv.slice(2)){
  const [command,...rest]=argv,args=parseArgs(rest);rejectDualLocator(args)
  if(Object.keys(args).some(k=>!['database-url','admin-url','database','target-confirm'].includes(k)))throw new BackupSafetyError('UNSUPPORTED_PG_OPS_ARGUMENT')
  const connection=canonicalConnection(args['database-url']??args['admin-url']??process.env.DATABASE_URL)
  if(command==='recreate'){
    const target=args.database?connectionForDatabase(connection,args.database):connection
    console.log(JSON.stringify({result:'RECREATED',instance:await recreateBoundDatabase(target,args['target-confirm'])}));return 0
  }
  const client=await connectCanonical(connection)
  try{
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
    if(command==='identity')console.log(JSON.stringify(await readIdentity(client)))
    else if(command==='applied'){const exists=(await client.query("SELECT to_regclass('public.schema_migrations') AS registry")).rows[0].registry;console.log(exists?(await client.query('SELECT version FROM public.schema_migrations ORDER BY version')).rows.map(r=>r.version).join(','):'')}
    else if(command==='server-now')console.log((await client.query('SELECT now()::text AS now')).rows[0].now)
    else if(command==='exists')console.log((await client.query('SELECT 1 FROM pg_database WHERE datname=$1',[args.database])).rowCount?'yes':'no')
    else throw new BackupSafetyError('UNKNOWN_PG_OPS_COMMAND')
    return 0
  }finally{await client.query('ROLLBACK').catch(()=>{});await client.end()}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href)main().then(code=>{process.exitCode=code}).catch(error=>{console.error(safeFailure(error));process.exitCode=1})
