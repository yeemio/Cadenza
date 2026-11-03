import type { Migration } from './index'

/**
 * 0029 模拟 SAP 侧独立事实源（SAP-SIM-REWORK R1）。
 *
 * 与 MOM 业务表物理分离：全部 sim_sap_* 前缀；模拟器读写这些表产生单据号/
 * 结果/查询答案，MOM 业务表不受本组表影响；MOM 侧仅经 outbox/inbox 交换。
 * actual_connection=false：本地模拟事实 ≠ 真实 SAP。
 */
export const migration0029: Migration = {
  version: '0029',
  name: 'sap-sim-facts',
  up: /* sql */ `
    -- 模拟侧生产订单（PRODUCTION_RELEASE / PRODUCTION_REVISION / 返工指令）
    CREATE TABLE IF NOT EXISTS sim_sap_order (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_code text NOT NULL CHECK (organization_code <> ''),
      plant_code text NOT NULL CHECK (plant_code <> ''),
      order_no text NOT NULL CHECK (order_no <> ''),
      order_kind text NOT NULL DEFAULT 'PRODUCTION'
        CHECK (order_kind IN ('PRODUCTION', 'REWORK')),
      source_event_key text NOT NULL UNIQUE,
      order_version integer NOT NULL,
      parent_version integer,
      qty numeric,
      unit text,
      material_id text,
      produced_qty numeric NOT NULL DEFAULT 0,
      status text NOT NULL DEFAULT 'RELEASED'
        CHECK (status IN ('RELEASED', 'REVISED', 'PRODUCED', 'CANCELLED')),
      payload jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT sim_sap_order_identity_unique
        UNIQUE (organization_code, plant_code, order_no, order_version)
    );
    CREATE INDEX IF NOT EXISTS sim_sap_order_org_plant_idx ON sim_sap_order (organization_code, plant_code, order_no);

    -- 模拟侧单据事实（物料凭证/确认/交票/对账等；单据号由模拟器生成）
    CREATE TABLE IF NOT EXISTS sim_sap_document (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      doc_type text NOT NULL
        CHECK (doc_type IN (
          'MATERIAL_DOCUMENT', 'PRODUCTION_CONFIRMATION', 'DELIVERY_CONFIRM',
          'SCRAP_CONFIRM', 'QTY_RECONCILIATION', 'BUNDLE_LINE_ACK',
          'MASTER_BUNDLE', 'QUALITY_NOTICE', 'REJECT_NOTICE'
        )),
      doc_no text NOT NULL UNIQUE,
      organization_code text NOT NULL CHECK (organization_code <> ''),
      plant_code text NOT NULL CHECK (plant_code <> ''),
      source_event_key text NOT NULL,
      business_key text,
      line_no integer NOT NULL DEFAULT 0,
      status text NOT NULL DEFAULT 'COMMITTED' CHECK (status IN ('COMMITTED', 'REVERSED')),
      reversal_of uuid REFERENCES sim_sap_document (id) ON DELETE RESTRICT,
      material_id text,
      qty numeric,
      unit text,
      payload jsonb NOT NULL DEFAULT '{}'::jsonb,
      receipt jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT sim_sap_document_key_line_unique UNIQUE (source_event_key, line_no)
    );
    CREATE INDEX IF NOT EXISTS sim_sap_document_plant_idx ON sim_sap_document (organization_code, plant_code);
    CREATE INDEX IF NOT EXISTS sim_sap_document_type_idx ON sim_sap_document (doc_type);

    -- 模拟侧库存事实（按 企业+工厂+物料+单位；仅模拟器写入）
    CREATE TABLE IF NOT EXISTS sim_sap_stock (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_code text NOT NULL CHECK (organization_code <> ''),
      plant_code text NOT NULL CHECK (plant_code <> ''),
      material_id text NOT NULL CHECK (material_id <> ''),
      unit text NOT NULL CHECK (unit <> ''),
      qty numeric NOT NULL DEFAULT 0,
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT sim_sap_stock_identity_unique
        UNIQUE (organization_code, plant_code, material_id, unit)
    );

    -- 模拟侧集团在途（调拨发出→收到；内部转移不新增集团库存）
    CREATE TABLE IF NOT EXISTS sim_sap_in_transit (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      transfer_key text NOT NULL CHECK (transfer_key <> ''),
      organization_code text NOT NULL CHECK (organization_code <> ''),
      from_plant text NOT NULL,
      to_plant text NOT NULL,
      material_id text NOT NULL,
      unit text NOT NULL,
      qty numeric NOT NULL DEFAULT 0,
      status text NOT NULL DEFAULT 'IN_TRANSIT' CHECK (status IN ('IN_TRANSIT', 'RECEIVED')),
      issue_doc_id uuid REFERENCES sim_sap_document (id) ON DELETE RESTRICT,
      receipt_doc_id uuid REFERENCES sim_sap_document (id) ON DELETE RESTRICT,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT sim_sap_in_transit_key_unique UNIQUE (transfer_key, material_id, unit)
    );

    -- 模拟侧到达/结局台账：每次到达的事实推导结局（查询/幂等的依据）
    CREATE TABLE IF NOT EXISTS sim_sap_event_outcome (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      source_event_key text NOT NULL CHECK (source_event_key <> ''),
      arrival_seq integer NOT NULL,
      topic text NOT NULL,
      payload_sha256 text NOT NULL,
      outcome text NOT NULL,
      message_state text,
      doc_no text,
      applied boolean NOT NULL DEFAULT false,
      detail jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT sim_sap_event_outcome_arrival_unique UNIQUE (source_event_key, arrival_seq)
    );
    CREATE INDEX IF NOT EXISTS sim_sap_event_outcome_key_idx ON sim_sap_event_outcome (source_event_key);

    -- 故障注入场景（配置 + 剩余次数 + 乱序缓冲；持久化以支持重启恢复）
    CREATE TABLE IF NOT EXISTS sim_sap_fault_scenario (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      scenario_no text NOT NULL UNIQUE,
      fault_type text NOT NULL
        CHECK (fault_type IN (
          'MESSAGE_LOST', 'RESPONSE_LOST', 'DELAY', 'DUPLICATE', 'REORDER',
          'QUERY_UNAVAILABLE', 'BUSINESS_REJECT', 'NETWORK_DOWN'
        )),
      match_event_key text,
      match_topic text,
      remaining_count integer NOT NULL DEFAULT 0,
      total_count integer NOT NULL DEFAULT 0,
      delay_ms integer CHECK (delay_ms IS NULL OR delay_ms >= 0),
      reorder_keys jsonb,
      pending jsonb NOT NULL DEFAULT '[]'::jsonb,
      active boolean NOT NULL DEFAULT true,
      payload jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );

    COMMENT ON TABLE sim_sap_order IS '模拟 SAP 侧生产订单事实（R1；actual_connection=false；≠ MOM process_order）';
    COMMENT ON TABLE sim_sap_document IS '模拟 SAP 侧单据/确认事实；单据号由模拟器业务规则产生，不由调用方申报';
    COMMENT ON TABLE sim_sap_stock IS '模拟 SAP 侧库存事实；仅模拟器写入，与 MOM stock_balance 物理分离';
    COMMENT ON TABLE sim_sap_event_outcome IS '模拟侧到达/结局台账：输出由事实推导，expected_outcome 输入被拒绝';
    COMMENT ON TABLE sim_sap_fault_scenario IS '故障注入场景配置：输入是故障条件，注入点与次数在此，不改产品通过结论';
  `,
  down: /* sql */ `
    DROP TABLE IF EXISTS sim_sap_fault_scenario;
    DROP TABLE IF EXISTS sim_sap_event_outcome;
    DROP TABLE IF EXISTS sim_sap_in_transit;
    DROP TABLE IF EXISTS sim_sap_stock;
    DROP TABLE IF EXISTS sim_sap_document;
    DROP TABLE IF EXISTS sim_sap_order;
  `,
}
