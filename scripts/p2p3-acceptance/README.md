# P2/P3/P4-A 全链联调验收脚本（可重放）

以真实 api（`pnpm dev:api`，@3001）+ `docker exec psql` 直读共享 dev 库（cadenza-dev-pg @55433）
对 P2/P3 已注册域（迁移 0001–0021 全量）做端到端验收与逐层对账。模式完全照抄
`scripts/p1-acceptance/`（P1ACC）。种子企业华东（苏州）。

## 前置

```bash
docker compose up -d
pnpm db:migrate:up && pnpm db:seed   # 迁移 0001–0021 + 种子（含班次日历；seed 覆写已知副作用）
pnpm build                           # A12-OT 需 packages/edge/dist（模拟网关）
pnpm dev:api                         # api @3001
```

## 运行

```bash
node scripts/p2p3-acceptance/run.mjs --tag P23ACC-R1      # 全链（唯一 run 标签）
node scripts/p2p3-acceptance/run.mjs --only a05,a09       # 分批（续用最近 state）
```

退出码 0=全部断言通过；1=存在失败/缺口（不影响证据落盘）。

分批注意：`--only` 续跑共用最近 state，但场景间有事实依赖（第二轮补齐场景消费 S0/a12-cost 的
state：订单/备件单元/分摊版本；`a12-cost-ext` 须先于 `a12-ot-ext` 执行——后者引入第二报工会话，
会改变机时分摊的会话分母）。首轮取证以全链单标签跑。

## 场景

| 场景 | 文件 | 覆盖 |
| --- | --- | --- |
| S0 | scenarios/setup.mjs | 环境自足：域许可合并、仓库/库位/货架/设备/工序（真实命令）、料品 SQL 模拟 U9、订单×4、扫码报工（显式 businessTime 制造会话窗）+ 末道人工审核 + 工时 8h、收货单元（协议A 载具码 + 归属 SQL 造数、协议B 仓内×2、备件） |
| A05 | scenarios/a05.mjs | 倒轴守恒（1,000=600+390+10，SQL 四列+子段余额）、守恒拒绝、带客户轴号全量倒出两条独立拒绝（RS-05）、回撤受阻（子段投料消耗后冲销拒 RS-12）、分托（装入锁定/未选库位拒/确认改绑+移库）→解绑（清托码位置不变）、轴号修正核权重分配（无理由拒→占用清空+改值+扣减→回撤恢复）、跨域四账 |
| A09 | scenarios/a09.mjs | 订单式（本地先执行后同步：建单/R 码拒/扫码/重复拒/完成归属调整+Outbox/外部失败登记/重试成功不重复）、库存式（外部先成功再本地：派发/成功回执/本地失败注入/重新同步不推 U9）、外部未知中间态（盲重发拒/重复派发拒/核对回填成功）、FC-16 字段差异（改码表无项目号列）、跨域四账 |
| A10 | scenarios/a10.mjs | 报修→分派→处理→待复机→复机关闭状态机全链、待复机取消拒、停机开/闭起止原子、状态流水 WEB、备件消耗同事务记账（issue 扣前/扣后）、能力事件 down/restored 成对、详情四链对齐、A3-3 维修设备拒新增正数排产→复机后排产恢复（scheduling 联证）、跨域四账 |
| A12-SPC | scenarios/a12-spc.mjs | 规则集创建/发布/重复版本拒、受控项目、器具+校准（valid）、控制限版本化（building v1→基线 3 样本→active v2 ±3σ→规则集变更重算 v3）、历史判定不改标（仍绑 v2）、新样本按 v3 |
| A12-OT | scenarios/a12-ot.mjs | 网关/设备/点位/质量码（真实命令）、packages/edge 模拟网关断网缓冲 3 tick→HTTP 补传入池、同批重传去重（duplicates/行数不变/去重计数）、工序关联 auto_bound（真实报工会话窗）、分钟汇总、入池零 Outbox（遥测只读） |
| A12-COST | scenarios/a12-cost.mjs | 分摊版本 v1/v2+公式枚举拒、价格版本、归集首跑（CE-02 库存零写入、CA-12 工时主源 labor_record 8h 金额 null、机时参考 ot_sample 3h 金额 null、无 BOM 估算缺项）、重复首跑拒、工时核对（8h vs 3h 偏差 0.625 open、不改写报工）、显式重算换 v2（recalc_of+对照+旧 run 零改写+缺理由拒）、跨域四账 |
| A11 | scenarios/a11.mjs | P2 域 2 命令同 operationId 重放原结果（conversion.order.create + maintenance.order.create：同 id 回放/单据恰 1 行/回执恰 1 行/停机不重复开；新 operationId 触发真实守卫 MT-09）；用例工单走完关闭不残留 |
| A13 | scenarios/a13.mjs | 点检计划 v1/v2 版本化（周期反例/超期提示→执行后消隐）、fail 轮次（异常说明必填+建议报修不自动建单）、异常上报（equ- 前缀宽容/PDA 流水/关联建单 MT-13）、MT-09 在途停机守卫、状态机+MT-14 取消拒、备件消耗对账（MT-11）、复机六写+restored、A3-3 新日期排产拒→复机后成功+设备视图可见、跨域四账 |
| A12-SPC-EXT | scenarios/a12-spc-ext.mjs | 失控判定（超限样本 out_of_control+OOC 任务 qualityDoubtHint+Outbox 检出事件+quality_hold 零新增/质量投影不变＝CA-9 不直接改合格结论）、处置→无在控样本复控拒→在控样本→复控确认（PE-12 闭环）、OOC 任务行 DELETE 拒、失准圈定（校准过期器具→expired 准入拒 calibration_suspect/可排产判定 false/圈定含被拒样本/逐项处置进度推进 PE-16～19） |
| A12-COST-EXT | scenarios/a12-cost-ext.mjs | 表计配置（车间级电表+人工抄表+防双源反例 CE-09）、两次抄表（用量=读数差 50）、显式重算（能源行实测 50×机时占比、来源=首读数可回算、旧 run 零改写 CE-11）、能源单耗/覆盖率读面（metered 50/estimated 0/coverage 1）、OEE 缺项展示（std_rate 未数值化 GAP-S1→missing 不出假百分比；执行设备无停机→downtime_missing 并列 CE-10） |
| A12-OT-EXT | scenarios/a12-ot-ext.mjs | 第二报工会话（真实命令，同设备时间窗重叠）→重叠窗样本 pending_confirm、窗口外样本 unlinked、时钟偏差样本（ahead）不自动绑定、坏点（质量码 bad）is_bad+原因可见；人工绑定/纠错（ot.session.link manual_bound→unlinked 留痕）；分钟汇总 good/bad/skew 分列；机时口径同款 SQL 复证（坏点/偏差不入成本机时 OT-21） |
| A14 | scenarios/a14-cross.mjs | csw 外协一段（在途位→发送两段交接/所有权保留→在外 sent→回厂余额强制待检＝CA-15 默认全检→检验→关闭+结算事实两时点）；reverse 盘点差异调整单（开盘锁仓拦截移库 WR-24→点数盘亏→调整单原因+去向+adjust 流水扣前扣后→关盘解锁）；disposition 让步（不合格单元→concession 审批人+范围、质量投影 qualified、原收货不合格事实保留 QD-23）；reporting 班次快照（默认四族注册→重算→良率分子/分母与原单据同条件 SQL 对账 RP-22→幂等重算不重复行）；aiquery AQ-C1 真实问数往返（会话登记→execute 六段信封：来源/口径/完整性标注+五量 SQL 对照+审计行）；末尾跨域四账 |

## 产出

- `out/evidence-<tag>.jsonl`：逐项证据（http 请求/响应摘要、SQL 对账输出、断言结果）。
- `out/state-<tag>.json`：跨场景共享状态（id/operationId），支持 `--only` 分批续跑。

数据说明：业务数据全部经真实 api 命令写入。直落 SQL 仅两类环境事实造数（p1acc 先例）：
① 料品模拟 U9 同步（MD-01 本系统无维护入口）；② 轴号事实 axis_no_state 与报工归属
report_output（产品报工链只产 PRDU- 内部单元号，非 10 位 E/F/M/P 载具码——conversion/rework
线交付同款造数口径，ACCEPTANCE-REPORT 如实登记）。重跑以新 run 标签新建数据（不清理旧数据，dev 库语义）。
