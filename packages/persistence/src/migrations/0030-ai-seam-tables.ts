import type { Migration } from './index'

/**
 * 0030 P4 五内部接缝补齐迁移（PM 增量单 2026-10-29 §4：查询会话落库 / 发送审计 /
 * 权限重验 / 转发 apps/ai turns / 网页签发绑定码——内部集成，mock 外部渠道/模型下
 * 证明真实内部数据链）。会话/审计/重验三接缝复用 0021 表族（ai_session/ai_query_audit，
 * 不新建表）；本迁移补两表：
 *
 * - ai_runtime_event [接缝 4]：apps/ai 运行事件（会话/工具调用/生成轮次，events.jsonl
 *   改经 apps/api 端点持久化的落点）。承接方式为 apps/ai 主动 HTTP 转发（AR-08 方向
 *   不变——apps/api 不读 apps/ai 数据目录；AR-R2 不变——apps/ai 仍无生产库账号，
 *   SQL 只在接入层）。表注释须标注「运行留档，非业务账本」（AR-18 同则）；
 * - ai_im_binding_code [接缝 5]：网页端对已登录用户签发的一次性 IM 绑定码（IM-03
 *   绑定必须由用户主动发起并经验证）。只存 sha-256 摘要（code_hash），不存明文码；
 *   一次性（claimed 原子翻转）+ 有效期 + 可撤销。
 *
 * 两表均含 enterprise_id 隔离列（IT-S1/AQ-S4 同则）；不携带任何生产业务写路径。
 */
export const migration0030: Migration = {
  version: '0030',
  name: 'ai-seam-tables',
  up: /* sql */ `
    -- ============ apps/ai 运行事件留档（接缝 4；events.jsonl 经 api 端点持久化） ============
    CREATE TABLE ai_runtime_event (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      -- 插入序（IDENTITY 单调递增，重启后读回顺序稳定）
      seq bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
      session_id text NOT NULL,
      enterprise_id uuid REFERENCES org_node (id) ON DELETE RESTRICT,
      user_id uuid REFERENCES user_account (id) ON DELETE RESTRICT,
      request_id uuid,
      kind text NOT NULL CHECK (kind IN (
        'user_message', 'model_turn', 'tool_call', 'clarify', 'turn_outcome', 'cancel', 'session_lifecycle')),
      event_at timestamptz NOT NULL,
      event jsonb NOT NULL,
      received_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT ai_runtime_event_seq_unique UNIQUE (seq)
    );
    CREATE INDEX ai_runtime_event_session_idx ON ai_runtime_event (session_id, seq);
    CREATE INDEX ai_runtime_event_request_idx ON ai_runtime_event (request_id);
    COMMENT ON TABLE ai_runtime_event IS 'AI 运行事件留档，非业务账本（AR-18 同则：会话/工具调用/生成轮次归档，按 requestId 与 ai_query_audit 关联，AR-17）';

    -- ============ 一次性 IM 绑定码（接缝 5；IM-03 用户主动发起并经验证） ============
    CREATE TABLE ai_im_binding_code (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      enterprise_id uuid NOT NULL REFERENCES org_node (id) ON DELETE RESTRICT,
      user_id uuid NOT NULL REFERENCES user_account (id) ON DELETE RESTRICT,
      -- sha-256 摘要（hex）；明文码只在签发响应出现一次，不落库
      code_hash text NOT NULL,
      status text NOT NULL DEFAULT 'issued' CHECK (status IN ('issued', 'used', 'revoked', 'expired')),
      issued_at timestamptz NOT NULL DEFAULT now(),
      expires_at timestamptz NOT NULL,
      used_at timestamptz,
      used_channel text,
      used_platform_user_id text,
      revoked_at timestamptz,
      CONSTRAINT ai_im_binding_code_hash_unique UNIQUE (code_hash)
    );
    CREATE INDEX ai_im_binding_code_user_idx ON ai_im_binding_code (user_id, issued_at DESC);
    COMMENT ON TABLE ai_im_binding_code IS 'AI 问数审计/注册面，非业务账本（一次性 IM 绑定码：只存摘要与状态，绑定关系不是权限，IM-03/AQ-AUTH-02）';
  `,
  down: /* sql */ `
    DROP TABLE IF EXISTS ai_im_binding_code;
    DROP TABLE IF EXISTS ai_runtime_event;
  `,
}
