/**
 * 入池传输通道（OT-03/OT-04：样本批量上行 API；遥测通道只读，不承载业务命令）。
 */

export interface IngestBatchPayload {
  gatewayCode: string
  samples: Array<{
    deviceSerial: string
    pointCode: string
    eventId: string
    eventTime: string
    rawValue: number
    rawUnit: string
    deviceQualityCode: string
  }>
  overflow?: { count: number; firstAt: string; lastAt: string; deviceSerials?: string[] } | null
  backlogCount?: number
  checkpointSeq?: number
}

export interface IngestTransport {
  send(payload: IngestBatchPayload): Promise<unknown>
}

/** 内存传输（测试/演示收集；直连命令总线的集成测试用它收集批次再自行入池）。 */
export class MemoryTransport implements IngestTransport {
  readonly sent: IngestBatchPayload[] = []

  async send(payload: IngestBatchPayload): Promise<unknown> {
    this.sent.push(payload)
    return { ok: true, received: payload.samples.length }
  }
}

/** HTTP 入池传输（POST /ot/samples/ingest；OT-30：经获准网关接入）。 */
export class HttpIngestTransport implements IngestTransport {
  constructor(
    private readonly baseUrl: string,
    private readonly tokenProvider: () => string | Promise<string>,
  ) {}

  async send(payload: IngestBatchPayload): Promise<unknown> {
    const token = await this.tokenProvider()
    const res = await fetch(`${this.baseUrl.replace(/\/$/, '')}/ot/samples/ingest`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
        'x-operation-id': `edge-${payload.gatewayCode}-${payload.checkpointSeq ?? 0}-${payload.samples.length}-${Date.now()}`,
      },
      body: JSON.stringify(payload),
    })
    if (!res.ok) {
      throw new Error(`[OT-04] 边缘入池失败：HTTP ${res.status} ${await res.text()}`)
    }
    return await res.json()
  }
}
