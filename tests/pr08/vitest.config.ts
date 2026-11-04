import { defineConfig } from 'vitest/config'
import base from '../../vitest.config'
export default defineConfig({ ...base, cacheDir: '.cache/pr08-vite', test: { ...base.test, include: ['tests/pr08/**/*.spec.ts'], hookTimeout: 120_000 } })
