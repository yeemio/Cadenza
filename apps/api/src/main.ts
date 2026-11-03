import 'reflect-metadata'
import { NestFactory } from '@nestjs/core'
import { AppModule } from './app.module'
import { DEFAULT_API_PORT } from './env'

/** dev 默认 3001（3000 被其他项目容器占用）；生产以 PORT 环境变量为准。 */
const port = Number(process.env['PORT'] ?? DEFAULT_API_PORT)

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { logger: ['log', 'warn', 'error'] })

  app.enableCors({
    origin: [
      'http://localhost:5173',
      'http://127.0.0.1:5173',
      'http://localhost:5174',
      'http://127.0.0.1:5174',
      'http://localhost:5175',
      'http://127.0.0.1:5175',
      'http://localhost:5176',
      'http://127.0.0.1:5176',
    ],
  })
  await app.listen(port, '127.0.0.1')
  const url = await app.getUrl()
  console.log(`[api] Cadenza API 已启动：${url}（优雅停机：SIGTERM/SIGINT）`)

  // 显式兜底：确保信号被处理且以 0 退出（不依赖框架默认行为）
  const shutdown = (signal: string): void => {
    console.log(`[api] 收到 ${signal}，优雅停机…`)
    void app
      .close()
      .then(() => {
        console.log('[api] 已关闭（连接池已释放）')
        process.exit(0)
      })
      .catch((error: unknown) => {
        console.error('[api] 关闭异常', error)
        process.exit(1)
      })
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))
}

void bootstrap()
