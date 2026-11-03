import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url))

/**
 * UI 测试配置（jsdom 环境；根 vitest.config.ts 为 node 环境、且 include 不含本目录，
 * 故本目录自带配置，经根 package.json 的 test:ui / typecheck:ui 脚本运行）。
 * 运行：pnpm test:ui（根目录）。
 */
export default defineConfig({
  resolve: {
    alias: [
      { find: '@cadenza/ui/theme.css', replacement: r('../../packages/ui/src/theme.css') },
      { find: /^@cadenza\/ui$/, replacement: r('../../packages/ui/src/index.ts') },
      { find: /^@cadenza\/contracts$/, replacement: r('../../packages/contracts/src/index.ts') },
    ],
  },
  test: {
    environment: 'jsdom',
    include: ['tests/ui/**/*.test.{ts,tsx}'],
    setupFiles: ['tests/ui/setup.ts'],
    testTimeout: 20_000,
    // 测试默认 mock 演示数据（产品默认 live；live gated 用例自行构造 client 不读该 env）
    env: { VITE_API_MODE: 'mock' },
  },
})
