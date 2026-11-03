# apps/ai —— Cadenza AI 运行服务（独立进程，P4-B，DSH 路数）

冻结合同：`architecture/contracts/frozen/p4/dsh-edge.md`（DS-01～26）+
`frozen/p4/architecture.md`（AR-01～23/AR-R1～R6）。本 README 只写运行事实。

## 职责（DS-01~05）

会话编排、模型调用（首版 mock 适配器）、工具调用循环（唯一工具族=受控查询）、
澄清交互、超时/限额/取消管理、运行与会话记录存储（独立数据目录，AR-08）。
**无生产数据库账号、不执行 SQL、不挂生产数据目录（AR-R2）；无任何生产写通道（AR-R4）。**

## 构建与运行

```bash
apps/ai/build.sh                                   # 编译到 apps/ai/dist（CJS）
AI_RUNTIME_PORT=4300 AI_DATA_DIR=/tmp/ai-data \
AI_RUNTIME_INTERNAL_TOKEN=<token> \
  node apps/ai/dist/apps/ai/src/main.js
```

环境变量（`apps/ai/src/config.ts`）：

| 变量 | 缺省 | 说明 |
| --- | --- | --- |
| AI_RUNTIME_PORT | 4300 | 监听端口（127.0.0.1） |
| AI_RUNTIME_INTERNAL_TOKEN | dev 令牌 | 公开运行接口认证（接入层转发凭据） |
| AI_DATA_DIR | ./ai-runtime-data | 会话存储/运行记录独立目录（AR-08） |
| AI_CONTROLLED_QUERY_MODE | mock | mock=合同级回放（首版）；http=真实内部接口（L0 整合 AR-22 接通） |
| AI_CONTROLLED_QUERY_BASE_URL | http://127.0.0.1:3001/internal/aiquery | http 模式的 §4 端点基址 |
| AI_INTERNAL_QUERY_TOKEN | dev 令牌 | 调用 §4 内部接口的服务令牌（不构成权限来源） |
| AI_MOCK_SCENARIO_FILE | — | mock 场景 JSON（modelSteps/queryScript/capabilities，DS-13） |
| AI_TOOL_CALL_LIMIT / AI_SINGLE_QUERY_TIMEOUT_MS / AI_TURN_BUDGET_MS / AI_SESSION_IDLE_TIMEOUT_MS / AI_SWEEP_INTERVAL_MS | 8 / 15000 / 30000 / 1800000 / 60000 | RuntimeProfile 覆盖（DS-07/09） |
| AI_TENANT_LIMITS | — | 按租户限额覆盖 JSON：`{"<enterpriseId>":{"maxConcurrentTurns":1,"dailyTurnLimit":5,"perTurnBudgetMs":10000}}`（DS-10） |
| DATABASE_URL | — | **禁止出现**：检测到即拒绝启动（AR-07 运行身份分离） |

## HTTP 面（DS-23，仅此四条）

- `POST /ai-runtime/sessions` → 201（登记运行时会话索引，不赋权）
- `POST /ai-runtime/turns` → 200 `{ outcome: answer|clarify|unavailable|cancelled, message?, options?, answerRefs?, statusDetail }`
- `POST /ai-runtime/turns/:requestId/cancel` → 200 `{ status:'cancelled' }`
- `GET /ai-runtime/health` → 200 `{ status:'ok', runtime }`（无鉴权；UI「暂不可用」判定源）

除 health 外一律 `Authorization: Bearer <internal-token>`。

## 边界（红线）

- 不 import apps/api、不挂 AppModule（AR-03）；dsh 边缘包只被本进程与测试引用（DS-04）。
- 停本进程不影响任何生产命令路径与 apps/api `GET /health`（AR-06/AR-11，测试举证）。
- 真实 DSH 版本/真实模型/付费凭据 = SITE_PENDING，不接通（DS-25/AR-R6）。

[L0-整合标记] 见 `apps/ai/build.sh` 头注（workspace 注册与 B↔A 接线替换 mock 属 L0 动作，AR-22/23）。
