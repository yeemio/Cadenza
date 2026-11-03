/**
 * 分页合同（查询侧）。total 为行数计数，不是数量，允许 number；
 * 数量类字段仍一律 DecimalString。
 */
export interface PageRequest {
  /** 1 起始页码 */
  page: number
  /** 每页条数（服务端设上限） */
  pageSize: number
}

export interface PageResult<TItem> {
  items: TItem[]
  /** 满足条件的总行数 */
  total: number
  page: number
  pageSize: number
}
