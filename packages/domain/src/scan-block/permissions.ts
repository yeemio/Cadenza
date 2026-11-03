/**
 * SCAN-BLOCK 域岗位操作许可（E09 扫描拦截专用面）。
 * 独立于通用扫码 / 报工 / 条码解析。
 */
export const SCAN_BLOCK_PERMISSIONS = {
  SCAN_BLOCK_READ: 'scan_block.read',
  SCAN_BLOCK_POST: 'scan_block.post',
} as const

export type ScanBlockPermission =
  (typeof SCAN_BLOCK_PERMISSIONS)[keyof typeof SCAN_BLOCK_PERMISSIONS]

export const SCAN_BLOCK_PERMISSION_VALUES: readonly string[] = Object.values(SCAN_BLOCK_PERMISSIONS)
