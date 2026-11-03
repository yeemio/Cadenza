/**
 * 身份绑定端口（IM-03，frozen/p4/im-channels.md §1）。
 *
 * - 平台身份（channelKind + enterpriseAppRef + platformUserId，企业应用维度）→ Cadence user_account；
 * - 绑定必须由用户主动发起并经验证（验证与"用户主动发起"的执行在接入层：绑定码校验通过才调 bind；
 *   首版 mock 绑定为显式登记动作——用户经渠道发送绑定码）；
 * - 绑定关系不是权限：权限仍按 AQ-AUTH-01 每次重算，本端口只做身份解析；
 * - 持久化承载：首版包内存储（IM-05 / GAP-P8——C 线无迁移号，真实接入授权时由 L0 分配迁移落库）。
 */
import type { ImChannelKind } from './messages'

/** 平台身份键（企业应用维度三元组）。 */
export interface ImIdentityBindingKey {
  channelKind: ImChannelKind
  enterpriseAppRef: string
  platformUserId: string
}

export interface ImIdentityBindingPort {
  /** 解析平台身份 → Cadence 用户；未绑定/解析失败返回 null（接入层据此回 no_permission + 引导文案，AQ-AUTH-05）。 */
  resolve(binding: ImIdentityBindingKey): Promise<{ userId: string } | null>
  /** 登记绑定（调用前提：接入层已完成绑定码验证）。重复绑定=覆盖更新（同键至多一条）。 */
  bind(binding: ImIdentityBindingKey, userId: string, boundAt: string): Promise<void>
  /** 解除绑定；返回是否确有绑定被移除。 */
  unbind(binding: ImIdentityBindingKey): Promise<boolean>
}

/** 绑定键字符串化（去重/存储共用分隔符，禁止平台标识内含 '|'——见 assertKeySafe）。 */
export function imIdentityBindingKeyString(key: ImIdentityBindingKey): string {
  return `${key.channelKind}|${key.enterpriseAppRef}|${key.platformUserId}`
}

/** 平台标识不得含分隔符（防键歧义/碰撞，先例：IF-08 幂等键同构思想）。 */
export function assertImIdentityKeySafe(key: ImIdentityBindingKey): void {
  const parts = [key.enterpriseAppRef, key.platformUserId]
  for (const part of parts) {
    if (part.length === 0 || part.includes('|')) {
      throw new Error('平台身份标识非法：enterpriseAppRef/platformUserId 不得为空或含“|” [IM-03-4]')
    }
  }
}

export interface StoredImIdentityBinding {
  userId: string
  boundAt: string
}

/**
 * 首版包内存储承载（IM-05 / GAP-P8）：进程内 Map。
 * 真实接入授权时由 L0 分配迁移号落库（合同行为不变，仅承载替换）。
 */
export class InMemoryImIdentityBindingStore implements ImIdentityBindingPort {
  private readonly bindings = new Map<string, StoredImIdentityBinding>()

  async resolve(binding: ImIdentityBindingKey): Promise<{ userId: string } | null> {
    assertImIdentityKeySafe(binding)
    const hit = this.bindings.get(imIdentityBindingKeyString(binding))
    return hit ? { userId: hit.userId } : null
  }

  async bind(binding: ImIdentityBindingKey, userId: string, boundAt: string): Promise<void> {
    assertImIdentityKeySafe(binding)
    if (userId.length === 0) throw new Error('绑定目标用户不得为空 [IM-03-4]')
    this.bindings.set(imIdentityBindingKeyString(binding), { userId, boundAt })
  }

  async unbind(binding: ImIdentityBindingKey): Promise<boolean> {
    assertImIdentityKeySafe(binding)
    return this.bindings.delete(imIdentityBindingKeyString(binding))
  }

  /** 观测用：当前绑定条数（测试/运维核对）。 */
  get size(): number {
    return this.bindings.size
  }
}
