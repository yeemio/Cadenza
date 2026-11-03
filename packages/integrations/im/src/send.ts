/**
 * 发送端口（IM-04，frozen/p4/im-channels.md §1）。
 *
 * SendResult.status = 'sent' | 'unknown' | 'failed'：
 * - 发送结果未知态不得冒称严格送达（unknown 保持 unknown，不自动改写）；
 * - unknown 须记录并允许人工核对，不自动补发；
 * - 发送结果由接入层回写 ai_query_audit.sent_result_status（AQ-S2：sent/send_unknown/failed/not_sent，
 *   回写动作经 A 线接缝端口完成，见 apps/api/src/aiquery/im/im.ports.ts）。
 */
import type { OutboundChannelMessage } from './messages'
import type { ImSendResult } from './processing'

export type { ImSendResult }

export interface ImSendPort {
  send(message: OutboundChannelMessage): Promise<ImSendResult>
}

/**
 * mock 出站发送器（IM-15）：捕获全部出站消息供测试断言；
 * 发送结果可脚本化（缺省 'sent'）——用于可复现地产生 sent/unknown/failed 三态证据。
 * 不访问网络。
 */
export class MockChannelSender implements ImSendPort {
  readonly captured: OutboundChannelMessage[] = []
  private readonly outcomeQueue: ImSendResult['status'][] = []

  /** 脚本化下一次（及后续）发送结果；不脚本则恒为 'sent'。 */
  scriptOutcomes(...statuses: ImSendResult['status'][]): void {
    this.outcomeQueue.push(...statuses)
  }

  async send(message: OutboundChannelMessage): Promise<ImSendResult> {
    this.captured.push(message)
    const queued = this.outcomeQueue.shift()
    return { status: queued ?? 'sent' }
  }
}
