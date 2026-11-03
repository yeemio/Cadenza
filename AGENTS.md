# Cadenza 项目入口

项目根为 `/Users/yeemio/AI/gitrep/Cadenza`。全局规则继续适用。

- 产品范围：`architecture/PRODUCT_CONTRACT.md`、`architecture/SYSTEM_ARCHITECTURE.md`、`architecture/DOMAIN_MODEL.md`、`architecture/ROADMAP.md`；原件在 `requirements/source/`，追溯与冲突见 `requirements/PRD_TRACEABILITY.md`、`requirements/PRD_ISSUES.md`。
- 原三包与其冻结参考保持原样：`architecture/task-packages/three-package-delivery-20261027/`。当前启动与按线归属增量见 `architecture/control/startup-binding-20261027/STARTUP-BINDING.md`。
- 本地 RunKit 固定 `owlrunkit@0.23.0`。使用本项目 `npx --no-install owlrunkit ... --workspace /Users/yeemio/AI/gitrep/Cadenza`；完整技能位于 `node_modules/owlrunkit/integrations/codex/skills/owlcoda-runkit/SKILL.md`。
- 唯一执行总控为「Cadenza 总控 1031 · Astra-max」`01a190b9-6bd9-7500-bfa7-d1aca5fd6fe0`（Owner 明确指定 `gpt-6-astra / max`）；自 `architecture/control/controller-transfer-20261031/RELEASE.json` 生效起独占 `.owlcoda/runkit/` 控制写入，负责后续推进、派工、返工、工程接受与已授权整合。Cadenza-PM `01a17da5-3a71-7910-abab-cbfb024c368a` 回归产品合同、需求范围、业务语义与接受标准，不再执行派工或写 RunKit。ZCode L0 继续负责原实施链的整合协调，各线只写获分配路径；不增加第二总控。
- `project status --json` 是领取与依赖的事实源。新增线须有可识别的真实接收会话、实际模型和隔离路径；角色别名不是会话 ID，assignment 也不等于已经运行。
- 项目已有本地提交；2026-10-31 交接时 HEAD 为 `4490846e70b23fca0323dd40a82c01daad331671`，SAPSTD/P4 等新增源码仍有未提交改动，准确候选须绑定对应冻结清单和工作区差集。原始资料、规划、三个 ZIP、旧候选和全部既有未提交内容受保护；未经当前明确授权不得 commit/push/reset/clean、修改共享配置、访问生产或增加付费调用。
- RunKit 的 `startup-binding-integrity` 仅验证原件保存和本地依赖绑定，不证明任何 MOM 功能实现。产品检查由相应实现候选提供，不能用该检查替代构建、业务行为、数据库或 UI 验证。
- P2 依赖 P1 的准确累计候选、DS 审查和 PM 接收；P3 同理。GLM-5.3 的实施或内部审查不能自动代替真实 DS provider/model 及其审查原件。现场接受与功能接受分开。
- 仅当前 Owner 指定的外部 ZCode 执行使用 GLM-5.3；此规则不改变 Codex 模型，也不授权在这里新增子代理或外部付费调用。

- 最新控制职责与现有交付入口见 `architecture/control/controller-transfer-20261031/HANDOFF.md`、`RELEASE.json` 和新总控的 `TAKEOVER-ACK.md`。旧包中的 PM 控制/接收称谓是历史状态；工程接受与控制责任按本次交接执行，既有产品范围、接受证据和独立性边界不因此重做或提高。

- 2026-10-31 Owner 随后明确要求总控综合评定并派 Sol 并行完成后续工作。本次 SAPSTD S1–S5 与 P4-R1–R3 已由原稳定 ZCode 候选转交三个原生 Sol 隔离执行者，覆盖上述原 writer/手动投递限制；准确范围、实际接收身份、入口快照和接受状态见 `architecture/control/sol-rework-20261031/DISPATCH.md`、`LAUNCH.json` 及接受记录。总控仍是主工作区整合与 RunKit 唯一 writer，不新增外部付费、Git 或生产权限。
