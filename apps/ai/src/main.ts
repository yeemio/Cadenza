/**
 * apps/ai 独立进程入口（dsh-edge.md DS-01~03；AR-03/AR-06 进程分离）。
 *
 * 独立启动/停止：`node apps/ai/dist/apps/ai/src/main.js`（先跑 apps/ai/build.sh）。
 * 不 import apps/api、不挂 AppModule、无生产数据库账号（config fail-fast 拒绝 DATABASE_URL）。
 * 优雅停机：SIGTERM/SIGINT → 停扫描、关服务器、退出 0。
 */
import { DSH_RUNTIME_DECLARATION } from '../../../packages/integrations/dsh'
import { createAiRuntime } from './composition-root'
import { createHttpServer } from './http-server'
import { loadConfig } from './config'

function main(): void {
  const config = loadConfig(process.env)
  const runtime = createAiRuntime()
  const server = createHttpServer({
    orchestrator: runtime.orchestrator,
    store: runtime.store,
    registry: runtime.registry,
    internalToken: config.internalToken,
  })

  // DS-06：会话空闲关停与过期清理（定时扫描 + 日志）
  const sweeper = setInterval(() => {
    void runtime.store
      .sweepSessions(runtime.profile.sessionIdleTimeoutMs, runtime.profile.sessionRetentionMs, new Date())
      .then((ids) => {
        if (ids.length > 0) console.log(`[ai] 会话扫描：${ids.length} 个会话状态推进（空闲关停/过期清理）`)
      })
      .catch((error: unknown) => console.error('[ai] 会话扫描失败', error))
  }, runtime.profile.sweepIntervalMs)
  sweeper.unref()

  server.listen(config.port, '127.0.0.1', () => {
    console.log(
      `[ai] Cadenza AI 运行服务已启动：http://127.0.0.1:${String(config.port)}` +
        `（runtime=${DSH_RUNTIME_DECLARATION.kind}/${DSH_RUNTIME_DECLARATION.version} profileRef=${String(DSH_RUNTIME_DECLARATION.profileRef)}；` +
        `受控查询=${config.controlledQueryMode}；优雅停机：SIGTERM/SIGINT）`,
    )
  })

  let shuttingDown = false
  const shutdown = (signal: string): void => {
    if (shuttingDown) return
    shuttingDown = true
    console.log(`[ai] 收到 ${signal}，优雅停机…`)
    clearInterval(sweeper)
    server.close(() => {
      console.log('[ai] 已关闭')
      process.exit(0)
    })
    // 兜底：连接未排空时也最多等 3 秒退出
    setTimeout(() => process.exit(0), 3_000).unref()
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))
}

main()
