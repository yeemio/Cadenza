import { defineConfig } from 'vitest/config'
import base from '../../vitest.config'
export default defineConfig({ ...base, cacheDir: '.cache/pr05-vite', test: { ...base.test, include: ['tests/pr05/**/*.spec.ts','tests/ai-service/runtime-turns.spec.ts','tests/ai-service/limits-cancel.spec.ts'], hookTimeout: 120_000 } })
