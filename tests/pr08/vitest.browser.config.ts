import { defineConfig } from 'vitest/config'
import base from '../../vitest.config'
export default defineConfig({ ...base, cacheDir: '.cache/pr08-ui', esbuild:{jsx:'automatic'},test:{...base.test,environment:'jsdom',include:['tests/pr08/*.browser.spec.tsx']} })
