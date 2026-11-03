import pg from 'pg'

/**
 * dev 默认值与 docker-compose.yml、.env.example 一致：
 * 宿主端口 55433（55432 被其他项目占用，见 delivery/L1/stage1/DELIVERY.md）。
 */
export const DEFAULT_DEV_DATABASE_URL =
  'postgres://postgres:cadenza_dev@127.0.0.1:55433/cadenza'

export function resolveDatabaseUrl(env: Record<string, string | undefined> = process.env): string {
  return env.DATABASE_URL ?? DEFAULT_DEV_DATABASE_URL
}

export interface PoolOptions {
  max?: number
  idleTimeoutMillis?: number
}

/** 从 DATABASE_URL（缺省回落 dev 默认）创建连接池。连接是惰性的，构造不触网。 */
export function createPool(url: string = resolveDatabaseUrl(), options: PoolOptions = {}): pg.Pool {
  return new pg.Pool({
    connectionString: url,
    max: options.max ?? 10,
    idleTimeoutMillis: options.idleTimeoutMillis ?? 30_000,
  })
}
