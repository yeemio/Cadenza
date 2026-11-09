import { defineConfig } from 'vitest/config'
import base from '../../vitest.config'
export default defineConfig({ ...base, cacheDir: '.cache/pr13-vite', test: { ...base.test,
  include: ['tests/pr13/exclusive-pg.spec.ts', 'tests/integration/command-idempotency.spec.ts'], hookTimeout: 120_000 } })
