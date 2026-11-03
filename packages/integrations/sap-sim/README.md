# SAP_SIM 适配（WI-L1-SAP-SIM-ADAPTER / OUTBOX-INBOX-HTTP）

- **target**: `SAP_SIM`
- **actual_connection**: `false`（永不连真实 SAP；无真实 URL/凭据）
- **HTTP**：
  - `GET /integrations/sap-sim` — 适配健康/边界/可发现路由
  - `POST /integrations/sap-sim/messages` — 抽象信封投递 → 平台 `outbox`
  - `GET /integrations/sap-sim/messages/:id`
  - `GET|POST /integrations/outbox`
  - `GET|POST /integrations/inbox`
- **≠** 域内 `/shipping/*/inbound`、`/purchase/orders/sync`、`/conversion/order/sync-retry`（不得冒充关闭本 GAP）
- **≠** 真实 SAP、56/65 全量剧本、MATERIAL-SYNC、RECON、OFFLINE（本 WI 入口子集）
