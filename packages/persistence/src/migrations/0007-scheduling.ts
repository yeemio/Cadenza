import type { Migration } from './index'

/**
 * 0007 生产排程迁移（L1-P1-SERVER T09 排程块）。
 *
 * 本域尚无冻结合同：规则来源为咨询底稿 architecture/contracts/prep/p1/
 * 03-production-chain-rules-T05T09T10T11.md 的 A3/A4 节与 B11/S10 裁定，
 * 及 requirements/source/PRD文档/生产管理/{订单排程,设备排程}.md、
 * requirements/source/PRD文档/排产计划/排产计划.md；
 * 逐条对照见 delivery/L1/server-scheduling/DELIVERY.md §6。
 *
 * 表清单（三表，全部含审计四列 created_at/by + updated_at/by 与 plant_id 隔离）：
 * - schedule_slot 排产槽位（[底稿 A3-1] 唯一键：同订单+同订单工序+同标准工序+同设备+
 *   同生产日期至多一条有效排产——五元组 UNIQUE 库层双保险；计划量改 0 = 删槽不落行，
 *   planned_qty CHECK > 0 保证有效槽恒正；三个编辑入口共用同一提交能力）；
 * - capacity_calendar 设备日产能（[底稿 A3-2w] 数值 + 单位；(设备, 生产日期) 唯一；
 *   行存在即已配置（含 0=零产能），行不存在 = 未配置不参与超产能比较）；
 * - shift_parameter 班次参数（[底稿 A4-1] 白班起点 HH:MM；工厂级 plant_id 唯一）。
 *
 * 全部 FK ON DELETE RESTRICT（MD-S7 同型：被槽位引用的订单/工序/设备不物理删除）。
 *
 * 注意：本迁移文件在 L0 整合步统一注册进 registry.ts 前不随 `pnpm db:migrate:up` 应用；
 * 本块测试以 migrateUp(pool, [...migrations, migration0007]) 在独立库（cadenza_sch）应用
 * （模式照 process-test-env，每轮 DROP+CREATE），共享 dev 库保持注册表推导口径不变；
 * 与并行 writer（0008 执行域、0009 质量/仓储）迁移号不冲突。
 */
export const migration0007: Migration = {
  version: '0007',
  name: 'scheduling',
  up: /* sql */ `
    -- ============ 排产槽位（订单 × 订单工序 × 标准工序 × 设备 × 生产日期） ============
    -- [底稿 A3-1] 同键至多一条有效排产（唯一键 UNIQUE 五元组，命令层 planSlotSave 替换语义双保险）；
    -- 计划量改 0 保存 = 删除该槽位（不落行），故 planned_qty 恒 > 0；
    -- uom 为订单工序单位快照（回写链投影直接展示，无换算）。
    CREATE TABLE schedule_slot (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      enterprise_id uuid NOT NULL REFERENCES org_node (id) ON DELETE RESTRICT,
      plant_id uuid NOT NULL REFERENCES org_node (id) ON DELETE RESTRICT,
      order_id uuid NOT NULL REFERENCES production_order (id) ON DELETE RESTRICT,
      order_operation_id uuid NOT NULL REFERENCES order_operation (id) ON DELETE RESTRICT,
      operation_definition_id uuid NOT NULL REFERENCES operation_definition (id) ON DELETE RESTRICT,
      equipment_id uuid NOT NULL REFERENCES equipment (id) ON DELETE RESTRICT,
      production_date date NOT NULL,
      planned_qty numeric(14,4) NOT NULL CHECK (planned_qty > 0),
      uom text NOT NULL CHECK (uom <> ''),
      remark text CHECK (remark IS NULL OR length(remark) <= 255),
      created_at timestamptz NOT NULL DEFAULT now(),
      created_by text,
      updated_at timestamptz NOT NULL DEFAULT now(),
      updated_by text,
      CONSTRAINT schedule_slot_identity_unique
        UNIQUE (order_id, order_operation_id, operation_definition_id, equipment_id, production_date)
    );
    CREATE INDEX schedule_slot_plant_idx ON schedule_slot (plant_id);
    CREATE INDEX schedule_slot_order_idx ON schedule_slot (order_id);
    CREATE INDEX schedule_slot_order_operation_idx ON schedule_slot (order_operation_id);
    CREATE INDEX schedule_slot_equipment_date_idx ON schedule_slot (equipment_id, production_date);
    CREATE INDEX schedule_slot_operation_definition_idx ON schedule_slot (operation_definition_id);

    -- ============ 设备日产能（capacity_calendar：设备 × 生产日期，数值 + 单位） ============
    -- [底稿 A3-2w] 弱提醒比较输入：行存在即已配置（含 capacity=0 零产能，任何正数均超）；
    -- 行不存在 = 未配置（空）不参与比较、不弹确认（OS §2.2、ES §2.1）。
    CREATE TABLE capacity_calendar (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      enterprise_id uuid NOT NULL REFERENCES org_node (id) ON DELETE RESTRICT,
      plant_id uuid NOT NULL REFERENCES org_node (id) ON DELETE RESTRICT,
      equipment_id uuid NOT NULL REFERENCES equipment (id) ON DELETE RESTRICT,
      production_date date NOT NULL,
      capacity numeric(14,4) NOT NULL CHECK (capacity >= 0),
      uom text,
      created_at timestamptz NOT NULL DEFAULT now(),
      created_by text,
      updated_at timestamptz NOT NULL DEFAULT now(),
      updated_by text,
      CONSTRAINT capacity_calendar_equipment_date_unique UNIQUE (equipment_id, production_date)
    );
    CREATE INDEX capacity_calendar_plant_idx ON capacity_calendar (plant_id);
    CREATE INDEX capacity_calendar_equipment_idx ON capacity_calendar (equipment_id);

    -- ============ 班次参数（shift_parameter：白班起点，工厂级唯一） ============
    -- [底稿 A4-1] PRD 现状仅单参数「白班开始时间」（工厂级）；DM §5 工厂日历/时区/跨午夜
    -- 班次属后续报工域合同（C4 缺口），本表预留唯一参数位 day_shift_start。
    CREATE TABLE shift_parameter (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      enterprise_id uuid NOT NULL REFERENCES org_node (id) ON DELETE RESTRICT,
      plant_id uuid NOT NULL REFERENCES org_node (id) ON DELETE RESTRICT,
      day_shift_start time NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      created_by text,
      updated_at timestamptz NOT NULL DEFAULT now(),
      updated_by text,
      CONSTRAINT shift_parameter_plant_unique UNIQUE (plant_id)
    );
  `,
  down: /* sql */ `
    DROP TABLE IF EXISTS shift_parameter;
    DROP TABLE IF EXISTS capacity_calendar;
    DROP TABLE IF EXISTS schedule_slot;
  `,
}
