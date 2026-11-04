import { defineConfig } from 'vitest/config'
import base from '../../vitest.config'

export default defineConfig({
  ...base,
  cacheDir: '.cache/pr02-vite',
  test: { ...base.test, include: ['tests/pr02/**/*.spec.ts'], hookTimeout: 120_000 },
})
