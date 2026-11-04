import { defineConfig } from 'vitest/config'
import base from '../../vitest.config'

export default defineConfig({
  ...base,
  cacheDir: '.cache/pr06-vite',
  test: { ...base.test, include: ['tests/pr06/**/*.spec.ts'], hookTimeout: 120_000 },
})
