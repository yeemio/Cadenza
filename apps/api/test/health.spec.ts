import { Test } from '@nestjs/testing'
import request from 'supertest'
import type { INestApplication } from '@nestjs/common'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DbHealthService } from '../src/db/db.module'
import { AppModule } from '../src/app.module'

/**
 * API 冒烟（Nest TestingModule + supertest，不依赖真实数据库：
 * DbHealthService 以桩替换；真实 DB 联通性由 dev 容器起后的 curl /health 证明）。
 */
describe('GET /health 冒烟', () => {
  let app: INestApplication

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(DbHealthService)
      .useValue({ ping: async () => 'ok' as const })
      .compile()
    app = moduleRef.createNestApplication()
    await app.init()
  })

  afterAll(async () => {
    await app.close()
  })

  it('返回 200 与 db ok', async () => {
    const res = await request(app.getHttpServer()).get('/health').expect(200)
    expect(res.body).toMatchObject({ status: 'ok', db: 'ok' })
    expect(typeof res.body.checkedAt).toBe('string')
  })

  it('响应携带 x-request-id（请求日志中间件生效）', async () => {
    const res = await request(app.getHttpServer()).get('/health').expect(200)
    expect(typeof res.headers['x-request-id']).toBe('string')
  })

  it('未知路径经全局过滤器返回 { code, message, details } 且 404 映射 ERR_NOT_FOUND', async () => {
    const res = await request(app.getHttpServer()).get('/definitely-not-exists').expect(404)
    expect(res.body).toEqual({
      code: 'ERR_NOT_FOUND',
      message: expect.any(String),
      details: {},
    })
  })

  it('demo 模块回显 contracts 常量（跨包装配证明）', async () => {
    const res = await request(app.getHttpServer()).get('/demo/contracts').expect(200)
    expect(res.body.errorCodes).toMatchObject({ NOT_FOUND: 'ERR_NOT_FOUND' })
    expect(res.body.statuses).toContain('COMMITTED')
  })
})
