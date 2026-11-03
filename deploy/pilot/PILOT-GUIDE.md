# 首厂影子试点与切换指南（T27，DO-26～DO-32）

版本：2026-10-28｜工具：`scripts/delivery/pilot-exit-check.mjs`

## 1. 进入条件（DO-26）

- 具名工厂与数据授权书是**前提**（→ GAP-E34）：`records/authorization.json` 登记 `factory`、`data_authorization_doc`（授权书文件引用）、`authorization_date`，且 `derived_from_prd` 必须为 `false`。
- **不得从 PRD 公司名称（河北华通）或文档提及推导接入授权**——检查器对该字段命中即拒绝，且无授权时全部按 DO-32 输出 SITE_PENDING，不产生任何 PASS。

## 2. 试点记录（DO-27，不可删）

约定范围内业务的失败与人工绕行**必须记录**（任务、原因、处置、时长）；未记录绕行的试点证据不合格。记录走哈希链账本（`records/pilot-ledger.jsonl` + `ledger-anchor.json` 锚——删改/截断任一历史事件都会被检出）：

```bash
node scripts/delivery/pilot-exit-check.mjs --records deploy/pilot/records \
  --append-record '{"playbook_id":"pb-P04-A04","position_id":"P04","task":"PDA 投料报工",
    "outcome":"manual_workaround","reason":"PDA 弱网","disposition":"改 Web 入口补录并重推",
    "duration_minutes":12,"training_feedback":"需弱网操作培训"}'
```

outcome 取值：`completed_in_system`（系统内完成）／`manual_workaround`（人工绕行）／`failure`（失败）；后两者必须带 `disposition`（处置）。

## 3. 岗位采用五元组（DO-25）

**应执行任务、系统内完成、人工绕行、失败原因、培训反馈**——由账本事件按任务集聚合，保留分母，不以完成率单值汇报。聚合口径：分母=约定范围剧本的应执行任务数；系统内完成/绕行/失败按事件计数；失败原因与培训反馈逐条保留。

## 4. 双轨核对（DO-28）

- 双轨＝**记录并行＋对账**，不是双主账：同一业务事实同一时段只有一个记账入账方（单写入方原则，SA §7.2）。
- `records/single-writer.json` 登记 `ledger_owner`（`MOM` 或 `legacy`）与 `legacy_stop_booking_commitment: true`（切换后旧系统停止记账承诺）。
- 双轨对账维度（账实、接口、指标口径）与并行周期 → GAP-E35。

## 5. 影子→正式切换退出标准（DO-29，全部满足方可切换）

| # | 标准 | 证据记录 |
| --- | --- | --- |
| ① | 约定范围剧本全部可执行，失败项有处置或豁免记录 | pilot-ledger.jsonl 事件 |
| ② | 期初对账差异清零或获业务负责人书面接受 | initial-reconciliation.json（`final_state: zero_diff|accepted`＋`accepted_by`） |
| ③ | 外部接口对账差异可解释 | interface-reconciliation.json（`all_explained`＋`unexplained[]`） |
| ④ | 恢复演练（DO-16）通过 | drill-reference.json（指向演练记录） |
| ⑤ | 切换窗口、恢复源与回退方案获批 | switch-plan.json（`window/restore_source/rollback_plan/approved_by`） |

一键判定：

```bash
node scripts/delivery/pilot-exit-check.mjs --records deploy/pilot/records --check
```

## 6. 切换执行（DO-30）与业务接受（DO-31）

- 切换按获批窗口执行：**冻结点（DO-11）→ 期初导入核对 → 增量补齐 → 开账**；不能从测试环境推导生产就绪；切换后旧系统停止记账（单写入方）。
- 业务接受：真实岗位完成约定业务且账实可解释；`records/acceptance.json` 具名登记（接受人、范围、保留项 `reservations[]`、边界、观察周期天数）——未提供的现场条件明确保留，**不冒充接受**。

## 7. 无授权边界（DO-32）

授权未到时，试点/迁移/切换项保持 **SITE_PENDING／BLOCKED_EXTERNAL**：不删除等待项、不另造第四功能包、不以 mock 伪造 SITE_ACCEPT。检查器在授权缺失/无效时以专用退出码（3）输出 SITE_PENDING 报告。
