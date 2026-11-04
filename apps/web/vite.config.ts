import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url))

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    // 工作区源码模式：直接消费 packages/ui 的 TS 源码（改组件无需先 build）
    alias: [
      { find: '@cadenza/ui/theme.css', replacement: r('../../packages/ui/src/theme.css') },
      { find: /^@cadenza\/ui$/, replacement: r('../../packages/ui/src/index.ts') },
      // contracts dist 为 CJS，rollup 命名导入不可用；统一走源码（纯常量，零运行时副作用）
      { find: /^@cadenza\/contracts$/, replacement: r('../../packages/contracts/src/index.ts') },
    ],
  },
  // Emitted for repeatable initial-import-closure and route-chunk measurements.
  build: { manifest: true },
  server: {
    port: 5173,
    strictPort: true, // 端口被占直接失败，不静默换端口
    host: '127.0.0.1',
  },
})
