# Cadenza 线缆行业 MOM

**本项目建设覆盖生产、质量、库存物流、设备维护与经营分析的线缆行业 MOM。** 以多组织、多工厂模型为基础，将订单、工艺版本、批次轴段、库存流水、质量放行和交付事实连接起来。

当前交付：**完整建设规划 v0.1，2026-10-27**。来源为本项目 45 份业务 PRD 和 1 份模板，并吸收 [Cadence-PM](thread://01a17d85-16ec-7c42-a86d-7d42711031a3?hostId=local) 的产品管理、架构和交付经验。原始输入完整保留；产品开发、外部系统接入和部署尚未启动。

## 从这里阅读

| 要了解什么 | 文档 |
| --- | --- |
| 为什么做、完整范围、岗位、业务链和验收条件 | [产品建设规划与产品合同](architecture/PRODUCT_CONTRACT.md) |
| 线缆对象怎么建模，如何处理数量、轴段、质量和修正 | [领域模型与业务一致性](architecture/DOMAIN_MODEL.md) |
| 技术栈、模块、数据库、外部集成、现场接入、部署及性能 | [系统架构与技术建设方案](architecture/SYSTEM_ARCHITECTURE.md) |
| 分几期做、人员投入、依赖、任务和验收 | [路线图与唯一任务表](architecture/ROADMAP.md) |
| 需求、工程、交付、试点、运营分别到了哪里 | [产品全生命周期地图](architecture/PRODUCT_LIFECYCLE_MAP.md) |
| 45 份原 PRD 分别落在哪个领域和任务 | [PRD 来源追溯](requirements/PRD_TRACEABILITY.md) |
| 旧系统已知问题、文档冲突和新系统的处理方案 | [PRD 问题归并](requirements/PRD_ISSUES.md) |

## 本次主要设计

- **业务完整：**现有 PRD 全部纳入，补齐工艺/BOM 版本、全过程质量、设备维护、原料领退耗、盘点、能耗和制造成本，形成 12 个业务领域。
- **线缆专用：**分离批次、库存单元、轴段、实物载具与客户轴号，处理芯倍数、绞合系数、米重、定尺分段、倒轴、分托、混批和谱系。
- **统一事实：**三个报工入口共用服务；订单与设备排程共用计划；两类入库入口共用库存流水；两种形态转换保留各自外部确认和恢复顺序。
- **技术可实施：**推荐 TypeScript／React／NestJS／PostgreSQL 的模块化单体，独立 worker 和工厂边缘适配，首期私有化部署；不先拆分业务微服务。
- **交付可判定：**规划 G0—G6 七个阶段、T00—T28 唯一任务表、A01—A14 业务验收场景；源码、安装、部署与真实业务分别接受。
- **问题不遗失：**54 条原文已知问题归并为 22 组，另登记 16 项跨文档语义差异。归并是规划结果，不表示缺陷已经修复。

## 建设节奏

先冻结领域与接口合同，完成主数据、权限、工艺和可信库存内核；然后贯通采购到生产、质量、仓储及发运的一条完整工程链；再覆盖所有 PRD 的异常分支和 MOM 扩展；最后完成首厂真实岗位验收与多厂推广。

在 8—10 人稳定核心团队和必要现场协作的假设下，首条完整工程链初估 12—16 周，完整单厂及业务交付 28—38 周，多厂验证 32—44 周。详见路线图的阶段、依赖及估算条件；这些不是已批准工期或当前进度。

## 需求来源与维护

- 原始归档：[PRD文档.zip](PRD文档.zip)。
- 原始文件：[requirements/source/PRD文档](requirements/source/PRD文档)，保持原路径和字节。
- 文件与归档指纹：[source-manifest.json](requirements/source-manifest.json)。
- 产品范围看产品合同，进度只更新 ROADMAP，阶段证据更新生命周期地图；需求变更保留来源并追加说明，不覆盖原始 PRD。
- 本地 Git 用于后续版本管理。本次未提交、推送或安装产品依赖；实施阶段创建应用时再固定运行时和依赖版本。

## 三个 ZCode 执行包

按 Owner 后续要求，全部规划已归入三个顺序交付包：[三包总览](architecture/task-packages/three-package-delivery-20261027/README.md)。P1覆盖基础与完整主链，P2覆盖线缆全量及异常闭环，P3覆盖完整MOM、多厂和最终整体验收；没有第四个必需功能包。当前仅制包完成，尚未启动。

## 安装与运行

P1 阶段 1 工程骨架（pnpm monorepo，Node 24 / pnpm 11 / TypeScript strict）。前置：Node ≥ 24（`.nvmrc`）、pnpm ≥ 11、Docker。

```bash
# 1. 开发数据库（postgres:17-alpine，容器 cadenza-dev-pg，宿主 127.0.0.1:55433）
docker compose up -d

# 2. 安装依赖并全量校验
pnpm install
pnpm typecheck && pnpm build && pnpm test

# 3. 数据库迁移（up / down 可往返）
pnpm db:migrate:up     # 应用 0001 平台迁移
pnpm db:migrate:down   # 回退最近一个版本（--all 经脚本参数不可用时直接用 packages/persistence/src/cli.ts）
```

日常开发（环境变量见 `.env.example`，均有同值默认）：

| 命令 | 说明 | 端口 |
| --- | --- | --- |
| `pnpm dev:api` | NestJS API（`/health` 含 DB ping、`/demo/contracts` 装配自证） | 127.0.0.1:3001 |
| `pnpm dev:worker` | outbox noop 认领进程（`WORKER_INTERVAL_MS` 可配，SIGTERM 优雅退出） | 无 HTTP |
| `pnpm dev:web` | 管理工作台前端壳（中文） | 127.0.0.1:5173 |
| `pnpm dev:pda` | 现场终端前端壳（中文） | 127.0.0.1:5174 |

端口说明：宿主 3000 与 55432 已被其他项目容器占用（启动前 `lsof` 检查后替换并记录于 `delivery/L1/stage1/DELIVERY.md`），故 API 用 3001、PostgreSQL 用 55433。

健康检查示例：`curl http://127.0.0.1:3001/health` 返回 `{"status":"ok","db":"ok",...}`。质量门：`pnpm lint`（含 domain→application/persistence/apps 依赖方向静态边界）、`npm run check`（RunKit 绑定完整性）。
