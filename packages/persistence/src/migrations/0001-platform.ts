import type { Migration } from './index'

/**
 * 0001 平台迁移：命令回执 / 出站任务 / 入站收件 / 审计四张平台表。
 *
 * 设计依据：
 * - SYSTEM_ARCHITECTURE §4.1（幂等键：企业+命令种类+operationId；结果与业务事务共同持久化）；
 * - 02-external-interface-facts-T02 §C（outbox 多态状态、聚合+任务种类复合身份、载荷时点快照、
 *   外部未知态；inbox 四元组唯一、隔离态；外部修订号显式引入且允许空值）；
 * - 01-foundation-rules D 节（uuid 主键 gen_random_uuid、时间 timestamptz、数量列 numeric——
 *   平台表暂无数量列；业务表迁移由后续 WorkItem 落地）。
 *
 * 只落平台机制，不落任何未冻结业务规则。
 */
export const migration0001: Migration = {
  version: '0001',
  name: 'platform-command-outbox-inbox-audit',
  up: /* sql */ `
    -- 命令回执：幂等键 (enterprise_id, command_type, operation_id) 唯一；
    -- 相同键相同载荷返回原结果，不同载荷拒绝（payload_digest 摘要比对）。
    CREATE TABLE command_receipt (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      enterprise_id text NOT NULL,
      command_type text NOT NULL,
      operation_id text NOT NULL,
      payload_digest text NOT NULL,
      status text NOT NULL,
      result jsonb NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT command_receipt_idem_unique UNIQUE (enterprise_id, command_type, operation_id)
    );
    CREATE INDEX command_receipt_enterprise_operation_idx
      ON command_receipt (enterprise_id, operation_id);
    CREATE INDEX command_receipt_status_idx ON command_receipt (status);

    -- 出站任务：单聚合可有多条并行回传流（合格+退货、实发轴+发货状态），
    -- 身份 = event_id；业务定位 = (aggregate_type, aggregate_id, task_kind) 复合；
    -- 状态多态（02§C.1）：PENDING / DISPATCHED / FAILED / NOOP_NEEDED（无需同步不是失败）/
    --   SYNC_FAILED / EXTERNAL_UNKNOWN（外部优先协议的外部结果未知中间态）；
    -- payload 为业务时点快照（重试不得改推当前值）；next_retry_at 驱动认领。
    CREATE TABLE outbox (
      event_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      aggregate_type text NOT NULL,
      aggregate_id text NOT NULL,
      task_kind text NOT NULL,
      status text NOT NULL DEFAULT 'PENDING'
        CHECK (status IN ('PENDING', 'DISPATCHED', 'FAILED', 'NOOP_NEEDED', 'SYNC_FAILED', 'EXTERNAL_UNKNOWN')),
      payload jsonb NOT NULL,
      external_ref text,
      request_digest text,
      attempt_count integer NOT NULL DEFAULT 0,
      next_retry_at timestamptz,
      last_error text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX outbox_claim_idx ON outbox (status, next_retry_at);
    CREATE INDEX outbox_aggregate_idx ON outbox (aggregate_type, aggregate_id, task_kind);

    -- 入站收件：四元组 (source_system, organization_code, external_key, entity_type) 唯一；
    -- external_revision 显式引入、允许空值（外部修订号原文无字段，合同须显式定义，02§C.5）；
    -- QUARANTINED 隔离态：缺组织/单位/工作中心映射的入站数据进隔离队列，人工补绑，非普通重试。
    CREATE TABLE inbox (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      source_system text NOT NULL,
      organization_code text NOT NULL,
      external_key text NOT NULL,
      entity_type text NOT NULL,
      external_revision text,
      payload jsonb,
      status text NOT NULL DEFAULT 'PENDING'
        CHECK (status IN ('PENDING', 'PROCESSED', 'QUARANTINED', 'FAILED')),
      quarantine_reason text,
      processed_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT inbox_unique UNIQUE (source_system, organization_code, external_key, entity_type)
    );
    CREATE INDEX inbox_pending_idx ON inbox (status, created_at) WHERE status = 'PENDING';
    CREATE INDEX inbox_quarantine_idx ON inbox (quarantine_reason, created_at) WHERE status = 'QUARANTINED';

    -- 审计：每命令写操作者/动作/对象/前后状态/理由（高影响操作强制理由由业务层校验）。
    CREATE TABLE audit_entry (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      actor text NOT NULL,
      action text NOT NULL,
      subject_type text NOT NULL,
      subject_id text NOT NULL,
      before jsonb,
      after jsonb,
      reason text,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX audit_entry_subject_idx ON audit_entry (subject_type, subject_id, created_at);
    CREATE INDEX audit_entry_actor_idx ON audit_entry (actor, created_at);
  `,
  down: /* sql */ `
    DROP TABLE IF EXISTS audit_entry;
    DROP TABLE IF EXISTS inbox;
    DROP TABLE IF EXISTS outbox;
    DROP TABLE IF EXISTS command_receipt;
  `,
}
