import { existsSync } from 'node:fs'
import { appendFile, readFile } from 'node:fs/promises'
import { canonicalJson, nowIso, sha256Text } from './util.mjs'

/**
 * 哈希链账本：追加式 JSONL，每条含 prev_hash + hash（canonical(record)+prev_hash）。
 * 用途：DO-S2 拒绝清单不可删改、DO-S5/DO-27 试点绕行记录不可删——删除或篡改任一历史行
 * 都会使其后所有行的 prev_hash 校验失败，验证器能定位断点。
 */

export async function appendRecord(ledgerPath, record) {
  const lines = await readLedgerLines(ledgerPath)
  const prevHash = lines.length > 0 ? lines[lines.length - 1].hash : 'GENESIS'
  const seq = lines.length + 1
  const entry = {
    seq,
    recorded_at: nowIso(),
    record,
    prev_hash: prevHash,
    hash: sha256Text(`${canonicalJson(record)}|${prevHash}`),
  }
  await appendFile(ledgerPath, `${JSON.stringify(entry)}\n`, 'utf8')
  return entry
}

async function readLedgerLines(ledgerPath) {
  if (!existsSync(ledgerPath)) return []
  const text = await readFile(ledgerPath, 'utf8')
  return text
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line))
}

export async function verifyLedger(ledgerPath) {
  if (!existsSync(ledgerPath)) return { ok: true, count: 0, brokenAtSeq: null, reason: null }
  const lines = await readLedgerLines(ledgerPath)
  let prevHash = 'GENESIS'
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    if (line.seq !== i + 1) {
      return { ok: false, count: lines.length, brokenAtSeq: line.seq, reason: '序号不连续（疑似删除历史行）' }
    }
    if (line.prev_hash !== prevHash) {
      return { ok: false, count: lines.length, brokenAtSeq: line.seq, reason: 'prev_hash 链断裂（历史行被删改）' }
    }
    const expected = sha256Text(`${canonicalJson(line.record)}|${prevHash}`)
    if (line.hash !== expected) {
      return { ok: false, count: lines.length, brokenAtSeq: line.seq, reason: '行内容哈希不符（记录被篡改）' }
    }
    prevHash = line.hash
  }
  return { ok: true, count: lines.length, brokenAtSeq: null, reason: null }
}

/** 当前账本头（末行哈希）与条数——供外部锚（运行表/检查单）登记，检测尾部截断。 */
export async function ledgerHead(ledgerPath) {
  const lines = await readLedgerLines(ledgerPath)
  return {
    count: lines.length,
    headHash: lines.length > 0 ? lines[lines.length - 1].hash : 'GENESIS',
  }
}
