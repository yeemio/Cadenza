/**
 * 工作单元端口：一个业务命令 = 一个 UoW。
 * 域内各聚合变更与 Outbox 写入在同一事务内提交（SYSTEM_ARCHITECTURE §4.2）。
 */
export interface UnitOfWork {
    begin(): Promise<void>;
    commit(): Promise<void>;
    rollback(): Promise<void>;
    /** 事务内登记出站任务（随 commit 原子写入 outbox 平台表） */
    collectOutbox(intent: OutboxIntent): void;
}
/** 出站任务意图（复合身份：聚合类型 + 聚合 ID + 任务种类；载荷为业务时点快照）。 */
export interface OutboxIntent {
    aggregateType: string;
    aggregateId: string;
    taskKind: string;
    /** 业务时点快照：重试不得改推当前值（02-external-interface-facts §C.3） */
    payload: Record<string, unknown>;
}
