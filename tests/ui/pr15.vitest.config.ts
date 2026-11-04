import { defineConfig } from 'vitest/config'
import base from './vitest.config'
export default defineConfig({ ...base, cacheDir: '.cache/pr15-ui-vite', test: { ...base.test,
  include: ['tests/ui/pr15-route-loading.test.tsx'], fileParallelism: false } })
