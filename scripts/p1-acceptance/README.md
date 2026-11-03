# P1 全链联调验收脚本（可重放）

以真实 api（`pnpm dev:api`，@3001）+ `docker exec psql` 直读共享 dev 库（cadenza-dev-pg @55433）
对 P1 主链 A01→A08→A11 做端到端验收与逐层对账。种子企业华东（苏州主线/合肥隔离反证）。

## 前置

```bash
docker compose up -d
pnpm db:migrate:up && pnpm db:seed   # 迁移 0001–0010 + 种子（admin 等 6 账号）
pnpm dev:api                          # api @3001
```

## 运行

```bash
node scripts/p1-acceptance/run.mjs                  # 全链（单一 run 标签）
node scripts/p1-acceptance/run.mjs --only a01,a02   # 分批（续用最近 state）
node scripts/p1-acceptance/run.mjs --tag mytag      # 指定 run 标签
```

退出码 0=全部断言通过；1=存在失败/缺口（不影响证据落盘）。

## 场景

| 场景 | 文件 | 覆盖 |
| --- | --- | --- |
| A01 | scenarios/a01.mjs | 工作中心/设备/仓库/库位/货架（真实命令）、料品 SQL 模拟 U9 同步、hfadmin01 跨厂 403 + 列表过滤 + 同码两厂隔离 |
| A02 | scenarios/a02.mjs | ERP 订单入站（五元组幂等）、分批扫码收货（需检）、四账一致、免检直收、质检判定（版本化）、价格复核只读投影、Outbox 合格任务 |
| A03 | scenarios/a03.mjs | 产品族/BOM/路线发布（版本冻结）、订单接收快照、推导复算（末道=产量×芯×绞合）、槽位双视图、硬校验拒绝、弱提醒 confirm、班次跨日 |
| A04 | scenarios/a04.mjs | 三入口报工（服务端同规则）、三账断言、末道待审→人工审核、同 operationId 重放、超产拒绝、单独投料（真实链路尝试） |
| A04-CONC | scenarios/a04-concurrency.mjs | 并发余额竞争（REWORK 补差）：100m 单元并发 70/50 恰一 200 一 409、库无负数、被拒方同键重放回原拒绝、胜者重放不重复扣 |
| A06 | scenarios/a06.mjs | 报工触发检验任务（真实事件源）、待检不可用、实测版本化、判定放行、入库任务生成、组单入库（真实链路尝试） |
| A07 | scenarios/a07.mjs | 同仓移库、调拨三段（出库→在途→接收）、在途两仓 Σ 断言、完成对账 |
| A08 | scenarios/a08.mjs | DC/PL 分段入站（幂等）、备货扫码（有轴行）、质量锁拒绝（待检单元）、打包绑定托码、确认出库、双回传独立、NOOP_NEEDED |
| A11 | scenarios/a11.mjs | 同 operationId 重放（总线幂等）+ 业务键幂等（五元组/单号）+ 回执单行性 + 接口账抽样 |
| A11-RELY | scenarios/a11-reliability.mjs | 附件受权（照片上传/读取、无许可 403、跨厂 404）、配置恢复（kill+重启 api：会话/授权/健康）、后台范围（真实 worker 单批：厂内行外发、越厂行 scope-skip 不外发）、A14 写路径范围证据索引 |

## 产出

- `out/evidence-<tag>.jsonl`：逐项证据（http 请求/响应摘要、SQL 对账输出、断言结果）。
- `out/state-<tag>.json`：跨场景共享状态（id/operationId），支持 `--only` 分批续跑。

数据说明：业务数据全部经真实 api 命令写入；料品/单位以直落 SQL 模拟 U9 同步
（MD-01：本系统无维护入口）。重跑以新 run 标签新建数据（不清理旧数据，dev 库语义）。
