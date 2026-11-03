import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url))

export default defineConfig({
  resolve: {
    // 测试直接消费各包 TS 源码，不依赖先 build 出 dist
    alias: {
      '@cadenza/contracts': r('packages/contracts/src/index.ts'),
      '@cadenza/domain': r('packages/domain/src/index.ts'),
      '@cadenza/application': r('packages/application/src/index.ts'),
      '@cadenza/persistence': r('packages/persistence/src/index.ts'),
      '@cadenza/integrations': r('packages/integrations/src/index.ts'),
      '@cadenza/ui': r('packages/ui/src/index.ts'),
      '@cadenza/testkit': r('packages/testkit/src/index.ts'),
    },
  },
  test: {
    environment: 'node',
    include: ['packages/*/test/**/*.spec.ts', 'apps/*/test/**/*.spec.ts', 'tests/**/*.spec.ts'],
    // P1-S2 起 tests/** 与真实容器共享数据库（迁移/种子/会话），串行执行避免跨文件数据竞态
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
})
