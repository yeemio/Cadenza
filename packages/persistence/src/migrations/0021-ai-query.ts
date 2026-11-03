import type { Migration } from './index'

/**
 * 0021 AI 问数三表迁移（P4-A 受控问数查询层；capability-contract.md §7 AQ-S1～S4）。
 * **不注册共享 registry**（P2 包 §2 零共享规则）：本文件由 L0 整合步统一并入
 * migrations/registry.ts；测试侧以编程方式 migrateUp 单独应用（独立库 cadenza_query，
 * 每轮 DROP+CREATE，与共享 dev 库及并行 writer 独立库无表名/迁移号冲突）。
 *
 * 三表（AQ-S4：均含 enterprise_id 隔离列 IT-S1 同则；不携带任何生产业务写路径）：
 * - ai_capability_registry [AQ-S1]：能力注册表（只读查询能力；企业级隔离
 *   (enterprise_id, capability_id, version) 唯一 + 同能力至多一条 enabled 的
 *   partial unique 库层双保险，先例 0007 schedule_slot_identity_unique）；
 * - ai_query_audit [AQ-S2]：问数执行审计（UNIQUE (request_id, tool_call_seq) 幂等；
 *   params 只存过滤参数与对象引用，不存聊天正文；**不是业务账本**）；
 * - ai_session [AQ-S3]：会话身份绑定与审计锚点（只存谁/渠道/会话目标/起止状态，
 *   不存消息正文，AR-19）。
 */
export const migration0021: Migration = {
  version: '0021',
  name: 'ai-query',
  up: /* sql */ `
    -- ============ 会话身份绑定（AQ-S3：只存身份绑定与审计锚点，不存消息正文） ============
    CREATE TABLE ai_session (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      enterprise_id uuid NOT NULL REFERENCES org_node (id) ON DELETE RESTRICT,
      user_id uuid NOT NULL REFERENCES user_account (id) ON DELETE RESTRICT,
      channel text NOT NULL CHECK (channel IN ('web', 'pda', 'wecom', 'feishu', 'mock')),
      conversation_ref text,
      status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed', 'expired')),
      created_at timestamptz NOT NULL DEFAULT now(),
      last_active_at timestamptz NOT NULL DEFAULT now(),
      closed_at timestamptz
    );
    CREATE INDEX ai_session_user_idx ON ai_session (user_id);
    CREATE INDEX ai_session_enterprise_channel_idx ON ai_session (enterprise_id, channel);
    COMMENT ON TABLE ai_session IS 'AI 问数审计/注册面，非业务账本（AQ-S3：仅会话身份绑定与审计锚点，不存消息正文）';

    -- ============ 能力注册表（AQ-S1：只登记只读查询能力，AQ-REG-02） ============
    CREATE TABLE ai_capability_registry (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      enterprise_id uuid NOT NULL REFERENCES org_node (id) ON DELETE RESTRICT,
      capability_id text NOT NULL CHECK (capability_id <> ''),
      version integer NOT NULL CHECK (version >= 1),
      status text NOT NULL DEFAULT 'disabled' CHECK (status IN ('enabled', 'disabled')),
      -- §0 字段：inputSchema/requiredPermissions/allowedObjects[{table,fields}]/maxQueryRange/口径参数
      definition jsonb NOT NULL,
      remark text,
      created_at timestamptz NOT NULL DEFAULT now(),
      created_by text,
      updated_at timestamptz NOT NULL DEFAULT now(),
      updated_by text,
      -- AQ-REG-03：注册行企业级隔离，(enterprise_id, capability_id, version) 唯一
      CONSTRAINT ai_capability_registry_identity_unique UNIQUE (enterprise_id, capability_id, version)
    );
    -- AQ-REG-03：同 (enterprise_id, capability_id) 至多一条 enabled 版本（partial unique 库层双保险）
    CREATE UNIQUE INDEX ai_capability_registry_enabled_uidx
      ON ai_capability_registry (enterprise_id, capability_id) WHERE status = 'enabled';
    CREATE INDEX ai_capability_registry_enterprise_idx ON ai_capability_registry (enterprise_id);
    COMMENT ON TABLE ai_capability_registry IS 'AI 问数审计/注册面，非业务账本（AQ-S1：只读查询能力注册，启停由服务端管理动作完成）';

    -- ============ 执行审计（AQ-S2：requestId+toolCallSeq 幂等；不是业务账本） ============
    CREATE TABLE ai_query_audit (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      request_id uuid NOT NULL,
      tool_call_seq integer NOT NULL CHECK (tool_call_seq >= 1),
      session_id uuid NOT NULL REFERENCES ai_session (id) ON DELETE RESTRICT,
      capability_id text,
      capability_version integer,
      user_id uuid NOT NULL REFERENCES user_account (id) ON DELETE RESTRICT,
      enterprise_id uuid NOT NULL REFERENCES org_node (id) ON DELETE RESTRICT,
      channel text NOT NULL CHECK (channel IN ('web', 'pda', 'wecom', 'feishu', 'mock')),
      -- 脱敏载荷：只存过滤参数与对象引用，不存聊天正文
      params jsonb NOT NULL DEFAULT '{}'::jsonb,
      -- AQ-REG-07 七值
      result_status text NOT NULL CHECK (result_status IN (
        'ok_with_data', 'ok_no_records', 'no_permission', 'not_supported',
        'source_not_ready', 'timeout', 'failed')),
      row_count integer NOT NULL DEFAULT 0,
      truncated boolean NOT NULL DEFAULT false,
      duration_ms integer NOT NULL DEFAULT 0,
      -- 模型/插件版本 + usage 或字面 "unknown"（用量未知如实标记，不估数，AR-16）
      model_info jsonb NOT NULL DEFAULT '"unknown"'::jsonb,
      sent_result_status text CHECK (sent_result_status IN ('sent', 'send_unknown', 'failed', 'not_sent')),
      created_at timestamptz NOT NULL DEFAULT now(),
      -- AQ-S2/DS-22：同一 (request_id, tool_call_seq) 幂等——重复执行返回既有审计结果
      CONSTRAINT ai_query_audit_request_seq_unique UNIQUE (request_id, tool_call_seq)
    );
    CREATE INDEX ai_query_audit_enterprise_created_idx ON ai_query_audit (enterprise_id, created_at);
    CREATE INDEX ai_query_audit_session_idx ON ai_query_audit (session_id);
    CREATE INDEX ai_query_audit_user_idx ON ai_query_audit (user_id);
    COMMENT ON TABLE ai_query_audit IS 'AI 问数审计/注册面，非业务账本（AQ-S2：审计锚点与结果状态，不落完整聊天内容，AR-17）';
  `,
  down: /* sql */ `
    DROP TABLE IF EXISTS ai_query_audit;
    DROP TABLE IF EXISTS ai_capability_registry;
    DROP TABLE IF EXISTS ai_session;
  `,
}
