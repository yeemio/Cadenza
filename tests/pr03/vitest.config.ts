import { defineConfig } from 'vitest/config'
import base from '../../vitest.config'

export default defineConfig({
  ...base,
  cacheDir: '.cache/pr03-vite',
  test: { ...base.test, include: ['tests/pr03/**/*.spec.ts', 'tests/domain/inventory-rules.spec.ts'], hookTimeout: 120_000 },
})
