import type pg from 'pg'
export type ExclusiveDatabase = { pool: pg.Pool; database: string; runId: string; url: string; host: string; port: string }
export function parseAdminUrl(raw: string | undefined): URL
export function freshDatabaseName(lane: string, uuid?: string): string
export function createExclusiveDatabase(lane: string, env?: NodeJS.ProcessEnv): Promise<ExclusiveDatabase>
export function resumeExclusiveDatabase(meta: { database: string; runId: string; host: string; port: string }, env?: NodeJS.ProcessEnv): Promise<ExclusiveDatabase>
