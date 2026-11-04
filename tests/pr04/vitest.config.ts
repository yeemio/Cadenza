import { defineConfig } from 'vitest/config'
import base from '../../vitest.config'
export default defineConfig({ ...base, cacheDir: '.cache/pr04-vite',
  test: { ...base.test, include: ['tests/pr04/**/*.spec.ts', 'tests/domain/shipping-rules.spec.ts'], hookTimeout: 120_000 } })
