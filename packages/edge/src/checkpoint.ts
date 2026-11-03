import type { BufferedSample } from './buffer'

/**
 * 网关持久检查点（OT-15）：唯一事件 ID 的网关内单调序号从持久检查点续发
 * （检查点随缓冲落盘）；网关重装后加载检查点继续，不用裸时间戳充当唯一 ID。
 */

export interface EdgeCheckpoint {
  gatewayCode: string
  /** 已构造（无论是否送达）的最后一个网关单调序号 */
  lastSeq: number
  /** 未送达的缓冲条目（检查点随缓冲落盘，OT-14/15） */
  buffered: BufferedSample[]
  savedAt: string
}

export interface EdgeCheckpointStore {
  save(checkpoint: EdgeCheckpoint): Promise<void>
  load(gatewayCode: string): Promise<EdgeCheckpoint | null>
}

/** 内存检查点存储（测试/演示；生产换文件或嵌入式库）。 */
export class MemoryCheckpointStore implements EdgeCheckpointStore {
  private readonly map = new Map<string, EdgeCheckpoint>()

  async save(checkpoint: EdgeCheckpoint): Promise<void> {
    this.map.set(checkpoint.gatewayCode, { ...checkpoint, buffered: [...checkpoint.buffered] })
  }

  async load(gatewayCode: string): Promise<EdgeCheckpoint | null> {
    const found = this.map.get(gatewayCode)
    return found === undefined ? null : { ...found, buffered: [...found.buffered] }
  }
}

/** JSON 文件检查点存储（模拟网关的"持久"落盘；原子写临时文件后改名）。 */
export class FileCheckpointStore implements EdgeCheckpointStore {
  constructor(private readonly filePath: string) {}

  async save(checkpoint: EdgeCheckpoint): Promise<void> {
    const { rename, writeFile } = await import('node:fs/promises')
    const tmp = `${this.filePath}.tmp`
    await writeFile(tmp, JSON.stringify(checkpoint), 'utf8')
    await rename(tmp, this.filePath)
  }

  async load(gatewayCode: string): Promise<EdgeCheckpoint | null> {
    try {
      const { readFile } = await import('node:fs/promises')
      const raw = await readFile(this.filePath, 'utf8')
      const parsed = JSON.parse(raw) as EdgeCheckpoint
      if (parsed.gatewayCode !== gatewayCode) return null
      return parsed
    } catch {
      return null
    }
  }
}
