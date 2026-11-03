import type { QueryResult } from 'pg'

/**
 * 最小 SQL 执行器抽象：pg.Pool 与 pg.PoolClient 都满足此接口，
 * 仓储据此可绑定连接池（只读查询）或事务客户端（命令事务内）。
 */
export interface SqlClient {
  query(text: string, values?: readonly unknown[]): Promise<QueryResult>
}
