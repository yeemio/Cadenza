import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'

const scrypt = promisify(scryptCallback) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: { N: number; r: number; p: number },
) => Promise<Buffer>

/**
 * 口令散列（application 层服务，node:crypto，无外部依赖）。
 * 格式：scrypt$N$r$p$<saltB64>$<keyB64>；校验恒定时间比较。
 * 明文口令不落库、不入日志（SA §8：日志不记录凭据）。
 */
export interface PasswordHasher {
  hash(plain: string): Promise<string>
  verify(plain: string, stored: string): Promise<boolean>
}

const SCRYPT_N = 16384
const SCRYPT_R = 8
const SCRYPT_P = 1
const KEY_LENGTH = 64

export function createScryptPasswordHasher(): PasswordHasher {
  return {
    async hash(plain: string): Promise<string> {
      const salt = randomBytes(16)
      const key = await scrypt(plain, salt, KEY_LENGTH, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P })
      return [
        'scrypt',
        String(SCRYPT_N),
        String(SCRYPT_R),
        String(SCRYPT_P),
        salt.toString('base64'),
        key.toString('base64'),
      ].join('$')
    },
    async verify(plain: string, stored: string): Promise<boolean> {
      const parts = stored.split('$')
      if (parts.length !== 6 || parts[0] !== 'scrypt') return false
      const [n, r, p, saltB64, keyB64] = parts.slice(1) as [string, string, string, string, string]
      const salt = Buffer.from(saltB64, 'base64')
      const expected = Buffer.from(keyB64, 'base64')
      if (expected.length === 0) return false
      const actual = await scrypt(plain, salt, expected.length, {
        N: Number(n),
        r: Number(r),
        p: Number(p),
      })
      return actual.length === expected.length && timingSafeEqual(actual, expected)
    },
  }
}
