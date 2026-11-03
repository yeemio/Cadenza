import { Controller, Get, HttpCode, HttpStatus, Inject, Param, Post } from '@nestjs/common'
import { ERROR_CODES } from '@cadenza/contracts'
import type { VerifiedAuthContext } from '@cadenza/application'
import { AIQUERY_PERMISSIONS } from '@cadenza/domain'
import { HttpException } from '@nestjs/common'
import { CurrentAuth, RequirePermission } from '../auth/decorators'
import { AIQUERY_SERVICE } from './aiquery.tokens'
import type { AiQueryService } from '@cadenza/application'

/**
 * 网页端绑定码签发端点（P4 五内部接缝补齐轮 2026-10-30，接缝 5/IM-03：
 * 登录用户 → 生成一次性绑定码 → IM 端凭码绑定身份）。
 *
 * - POST /aiquery/im/binding-codes：签发（用户令牌 + aiquery.use）。单活动码语义——
 *   签发即撤销该用户此前 issued 码；明文码只在应答出现一次（库内只存 sha-256 摘要）；
 * - GET /aiquery/im/binding-codes：当前用户绑定码清单（不回显明文码；过期按 expired 展示）；
 * - POST /aiquery/im/binding-codes/:id/revoke：撤销（须属当前用户且仍 issued）。
 *
 * 绑定码不是权限（IM-03）：绑定只建立平台身份↔账号对应，每次查询仍实时重验（AQ-AUTH-01）。
 */
@Controller('aiquery/im/binding-codes')
export class AiImBindingCodeController {
  constructor(@Inject(AIQUERY_SERVICE) private readonly service: AiQueryService) {}

  /** 缺省有效期（秒）；env AIQUERY_BINDING_CODE_TTL_SECONDS 覆盖（30s~1h 内取值）。 */
  private ttlSeconds(): number {
    const raw = process.env['AIQUERY_BINDING_CODE_TTL_SECONDS']
    const parsed = raw === undefined ? Number.NaN : Number(raw)
    if (!Number.isInteger(parsed) || parsed < 30 || parsed > 3_600) return 600
    return parsed
  }

  @RequirePermission(AIQUERY_PERMISSIONS.USE)
  @HttpCode(HttpStatus.CREATED)
  @Post()
  async issue(@CurrentAuth() auth: VerifiedAuthContext): Promise<unknown> {
    const issued = await this.service.issueImBindingCode({
      enterpriseId: auth.user.enterpriseId,
      userId: auth.user.id,
      ttlSeconds: this.ttlSeconds(),
    })
    return {
      id: issued.id,
      code: issued.code,
      expiresAt: issued.expiresAt,
      status: 'issued' as const,
      hint: '请在有效期内于 IM 个人会话发送该绑定码完成绑定；绑定不是授权，每次查询仍按账号权限实时校验（IM-03/AQ-AUTH-01）。明文码仅此一次显示。',
    }
  }

  @RequirePermission(AIQUERY_PERMISSIONS.USE)
  @Get()
  async list(@CurrentAuth() auth: VerifiedAuthContext): Promise<unknown> {
    const rows = await this.service.listImBindingCodes(auth.user.id)
    return {
      items: rows.map((row) => ({
        id: row.id,
        status: row.status,
        issuedAt: row.issuedAt,
        expiresAt: row.expiresAt,
        usedAt: row.usedAt,
        usedChannel: row.usedChannel,
        usedPlatformUserId: row.usedPlatformUserId,
        revokedAt: row.revokedAt,
      })),
      total: rows.length,
    }
  }

  @RequirePermission(AIQUERY_PERMISSIONS.USE)
  @HttpCode(HttpStatus.OK)
  @Post(':id/revoke')
  async revoke(@CurrentAuth() auth: VerifiedAuthContext, @Param('id') id: string): Promise<unknown> {
    if (!/^[0-9a-fA-F-]{36}$/.test(id)) {
      throw new HttpException(
        { code: ERROR_CODES.BUSINESS_RULE, message: 'id 非法（须为 UUID）', details: {} },
        HttpStatus.UNPROCESSABLE_ENTITY,
      )
    }
    const revoked = await this.service.revokeImBindingCode(id, auth.user.id)
    if (!revoked) {
      throw new HttpException(
        { code: ERROR_CODES.BUSINESS_RULE, message: '撤销失败：绑定码不存在、不属于当前用户或已不可撤销（used/revoked/expired）', details: { id } },
        HttpStatus.UNPROCESSABLE_ENTITY,
      )
    }
    return { id, status: 'revoked' as const }
  }
}
