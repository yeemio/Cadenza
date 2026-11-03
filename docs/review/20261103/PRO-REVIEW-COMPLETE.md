# Capture provenance

Ordinary Chat Pro highest (5/5), https://chatgpt.com/c/6ae983a9-f128-83e8-a5b4-d5539c933fee . Original message 251dc441-5187-57d3-b3b1-1d28113c6ecc was truncated by the read API. Exact missing sections were supplied in messages 7e66d027-6e28-500c-82f8-9d3dffaeb84a and d5e5ce38-242b-59e5-884d-26187bb01139. Assembly removes overlapping I04 onward from the truncated capture; no conclusions added. No formal external independence claimed.

# Cadenza 整体实现审查与下一步规划

**总体判断：Cadenza 已有较广泛的业务实现，但当前仍不具备“整体可交付、可恢复、可由真实工厂接受”的完整证据。主导缺口是：同一笔业务经过不同入口时，事务原子性、对象所属工厂、质量隔离、库存可用量、实物与商业单据的对应关系，没有始终执行同一套规则。**

下一步应先修这些共同规则，再在同一个准确候选上贯通业务链、升级恢复和现场接受。继续扩展页面或单模块功能，暂时不能消除这些风险。

本次只完成审查和规划，**没有创建 Work 任务，没有修改仓库，没有启动服务、测试、部署或发布**。下文的实施包是可交接文本，未派发执行。

## 一、审查绑定、产品能力与证据结论

### 1. 审查对象与实际取得的源码

本报告绑定：

- 公开仓库：`yeemio/Cadenza`
- 审查提交：`cb25076d99cda0ac359151ff9eea65507de8cc4d`
- `PUBLICATION.json` 记载的本地主线来源：`86fe9fe9408f1d93e2fe3f562f51cd691efbc16d`
- 审查身份：**`same_family_external_advisory`**

已实际取得并读取指定的 [STATUS-20261103.md](https://github.com/yeemio/Cadenza/blob/cb25076d99cda0ac359151ff9eea65507de8cc4d/docs/review/STATUS-20261103.md) 和 [PRODUCT_CONTRACT.md](https://github.com/yeemio/Cadenza/blob/cb25076d99cda0ac359151ff9eea65507de8cc4d/architecture/PRODUCT_CONTRACT.md)，没有用摘要替代这两份源码证据。

本轮主审取得了 **143 个文件的正文**，并沿关键调用逐段核查。其中，`PUBLICATION.json` 所列的 **142 个文件全部与其 SHA-256 一致，零不匹配**；清单本身不在自己的文件列表内。仓库树有 1,350 个文件，清单列出其中 1,349 个。这个核对证明已取得文件与发布清单一致，**不等于逐文件验证了整个仓库，也不等于独立访问了本地主线工作区**。来源关联见 [PUBLICATION.json:1–7](https://github.com/yeemio/Cadenza/blob/cb25076d99cda0ac359151ff9eea65507de8cc4d/PUBLICATION.json#L1-L7)。

以下源码链接全部固定到上述提交。

### 2. 产品目标仍然合理，现有架构可以继续承载

产品合同定义的是多组织、多工厂的线缆行业 MOM：以订单为起点，以批次、库存单元、轴段和载具为现场对象，贯通生产、质量、库存物流、设备维护与经营分析。ERP／SAP／U9、DC 的商业事实和主数据权责，需要按组织明确；MOM 负责可追溯的现场执行事实。财务总账和设备安全控制不属于其重建范围。[PRODUCT_CONTRACT.md:5–34](https://github.com/yeemio/Cadenza/blob/cb25076d99cda0ac359151ff9eea65507de8cc4d/architecture/PRODUCT_CONTRACT.md#L5-L34)

现有“模块化单体交易核心＋PostgreSQL＋Outbox/worker＋工厂边缘接入”的方向适合继续推进。当前问题主要发生在共享规则的使用方式和模块组合处；修正重点应是统一库存记账、对象授权、质量与可用量计算、事件消费和结果确认。[SYSTEM_ARCHITECTURE.md:5–52](https://github.com/yeemio/Cadenza/blob/cb25076d99cda0ac359151ff9eea65507de8cc4d/architecture/SYSTEM_ARCHITECTURE.md#L5-L52)

### 3. 实际能力已超过“只有设计或菜单”，但模块存在不等于整链接受

从控制器、应用处理器、领域规则、PG 仓储及组合根可以确认，采购、投料报工、质量、仓储、发运、倒轴、逆向处理和转换都有实际业务处理路径。下面的问题表正是从这些真实写入路径中发现的。

扩展 MOM 能力也已有具体实现：

| 能力 | 源码能够支持的判断 | 当前不能据此推出的结论 |
|---|---|---|
| 设备维护 | 维修建单会修改设备状态、建立停机事实并发布能力变化事件；存在维修、备件和复机处理。 | 维护事实已经完整贯通排程、现场维修流程已被岗位接受。 |
| SPC／校准 | 有样本准入、校准时点判断、控制规则计算及处置记录。 | 真实检测仪已经接通，或失控信号可以自动替代人工质量判定。 |
| 成本／能源 | 有订单、分摊版本、价格版本、班次及截止点绑定，读取物料、工时、产出、OT 等事实进行归集。 | 已形成完整财务成本系统，或已证明经营改善效果。 |
| AI／IM | 有会话、受控查询、结构化结果和内部渠道接缝。 | 真实模型、企业渠道、生产身份绑定及外部行为已经验收。 |

相关实现见 [maintenance-handlers.ts:164–217](https://github.com/yeemio/Cadenza/blob/cb25076d99cda0ac359151ff9eea65507de8cc4d/packages/application/src/maintenance-handlers.ts#L164-L217)、[spc-handlers.ts:699–815](https://github.com/yeemio/Cadenza/blob/cb25076d99cda0ac359151ff9eea65507de8cc4d/packages/application/src/spc-handlers.ts#L699-L815)、[cost-handlers.ts:324–399](https://github.com/yeemio/Cadenza/blob/cb25076d99cda0ac359151ff9eea65507de8cc4d/packages/application/src/cost-handlers.ts#L324-L399)、[im.composition.ts:23–39](https://github.com/yeemio/Cadenza/blob/cb25076d99cda0ac359151ff9eea65507de8cc4d/apps/api/src/aiquery/im/im.composition.ts#L23-L39)。

### 4. 五层证据分别下结论

| 证据层 | 本次结论 |
|---|---|
| **源码** | 已确认较广泛的实现，以及下文具名的代码缺陷和能力缺口。结论来自固定版本静态调用链核查；没有本轮真实 PG 复现。 |
| **构建** | 已发布日志支持本次 workspace build 完成，API、worker、Web、PDA 及列入构建的包均有成功输出。它不覆盖业务测试、运行启动、独立 AI 与嵌套 IM 的完整冷构建。 |
| **本地 SIM** | 保留已有接受声明及其限定；本轮没有重新执行，也未取得可独立复算全部 65 次尝试的原始控制账本和完整运行证据。 |
| **组合运行** | 本轮未启动真实 PG、API、worker、Web/PDA，也未复现并发、进程中断、升级和恢复。不能给当前整合候选新增运行时 PASS。 |
| **真实现场接受** | 未取得真实 SAP、模型、企业渠道、设备、岗位连续运行、恢复 SLA 或具名业务接受证据。当前不能判定完成。 |

构建结论依据 [BUILD-20261103.log:1–47](https://github.com/yeemio/Cadenza/blob/cb25076d99cda0ac359151ff9eea65507de8cc4d/docs/review/BUILD-20261103.log#L1-L47)。其余证据边界与 [STATUS:9–15](https://github.com/yeemio/Cadenza/blob/cb25076d99cda0ac359151ff9eea65507de8cc4d/docs/review/STATUS-20261103.md#L9-L15) 一致。

本地 SIM 的保留口径具体为：

- **56 个原始事件键、65 次尝试，62 精确＋3 显式语义等价；21 个对象，19 个预期数量＋2 UNKNOWN。**
- GC2 的 MOM 1800／SIM 2000、REWORK200 的 MOM 200／SIM 0 属于保留的分类差异；GK2 质量差异仍保留。
- T0 只支持 Owner 批准的显式因果顺序修正后的结论，原时序失败不得改写为通过。
- N1 阶段子单扩展、N2 四根合格 500m 轴及等分处理、UNKNOWN 故障前置均有 SIM 范围限定。
- N2 的独立业务留置继续成立；诊断库存不能把 UNKNOWN 变成已确认。
- 0031 仅在新独占库验证，旧库与旧 reference hash 升级尚未证明；业务留置仅建立／保持。[STATUS:11–13](https://github.com/yeemio/Cadenza/blob/cb25076d99cda0ac359151ff9eea65507de8cc4d/docs/review/STATUS-20261103.md#L11-L13)

公开快照中存在部分历史测试和接受材料；缺的是最新完整执行链的原始证据，不能概括成“仓库没有任何日志”。

---

## 二、Critical／Important／Minor 问题表

这里的严重度是项目交付判断，不是 CVSS：

- **Critical**：会破坏主账、质量阻断或数据隔离，进入相关业务试点前应关闭。
- **Important**：阻断相关功能、恢复交付或多厂接受；部分同样是上线门禁。
- **Minor**：当前主要影响交付清晰度或性能优化，尚未证明破坏主账。

“代码缺陷”表示源码控制流足以确认缺少相应保证；**不表示已经在本轮真实 PostgreSQL 或现场复现**。

### 2.1 Critical：核心交易与隔离

| 编号／分类 | 准确源码依据 | 触发与影响 | 修正建议 |
|---|---|---|---|
| **C1：成立，Critical。业务拒绝仍提交此前业务写入。** 代码缺陷 | [pg-command-bus.ts:123–142](https://github.com/yeemio/Cadenza/blob/cb25076d99cda0ac359151ff9eea65507de8cc4d/packages/persistence/src/pg-command-bus.ts#L123-L142)；[shipping-handlers.ts:68–75](https://github.com/yeemio/Cadenza/blob/cb25076d99cda0ac359151ff9eea65507de8cc4d/packages/application/src/shipping-handlers.ts#L68-L75)、[783–829](https://github.com/yeemio/Cadenza/blob/cb25076d99cda0ac359151ff9eea65507de8cc4d/packages/application/src/shipping-handlers.ts#L783-L829) | 两轴发运：第一轴完成扣账，第二轴因**业务留置或活动预留**抛出被捕获的规则异常，handler 返回 `BUSINESS_REJECTION`；总线照常写回执并 `COMMIT`。结果可成为“整单拒绝，第一轴已出账”。 | 在共同命令边界保证拒绝回滚全部业务写入，同时保留可重放拒绝回执。可用保存点隔离业务写集；前置校验只能辅助，不能代替原子性。 |
| **C2：成立，Critical。按 ID 操作未统一绑定对象真实企业／工厂。** 代码缺陷 | [scope.guard.ts:36–65](https://github.com/yeemio/Cadenza/blob/cb25076d99cda0ac359151ff9eea65507de8cc4d/apps/api/src/auth/scope.guard.ts#L36-L65)；[quality-handlers.ts:268–291](https://github.com/yeemio/Cadenza/blob/cb25076d99cda0ac359151ff9eea65507de8cc4d/packages/application/src/quality-handlers.ts#L268-L291)、[464–495](https://github.com/yeemio/Cadenza/blob/cb25076d99cda0ac359151ff9eea65507de8cc4d/packages/application/src/quality-handlers.ts#L464-L495)；[purchase-handlers.ts:397–423](https://github.com/yeemio/Cadenza/blob/cb25076d99cda0ac359151ff9eea65507de8cc4d/packages/application/src/purchase-handlers.ts#L397-L423) | 有操作许可的 A 厂用户提供 B 厂检验单／隔离 ID，可进入缺少实际对象范围检查的放行／恢复路径。采购先检查载荷 plantId，再按裸 `orderLineId` 锁行，未核对该行实际属于该厂。直接库存发料也有同类缺口。 | 授权必须以服务端加载的对象企业、工厂及关联关系为准；在加锁后的写入路径执行。增加同角色、异厂、异企业、遗漏／伪填 plantId 的拒绝矩阵，并核对所有表无副作用。 |
| **C3：成立，Critical。合格检验投影可覆盖仍活动的质量隔离。** 代码缺陷 | [quality-handlers.ts:86–100](https://github.com/yeemio/Cadenza/blob/cb25076d99cda0ac359151ff9eea65507de8cc4d/packages/application/src/quality-handlers.ts#L86-L100)、[397–425](https://github.com/yeemio/Cadenza/blob/cb25076d99cda0ac359151ff9eea65507de8cc4d/packages/application/src/quality-handlers.ts#L397-L425)；[shipping-handlers.ts:799–815](https://github.com/yeemio/Cadenza/blob/cb25076d99cda0ac359151ff9eea65507de8cc4d/packages/application/src/shipping-handlers.ts#L799-L815) | 先建立活动 `quality_hold` 并置 suspect，后续合格检验／放行直接将余额投影改为 qualified；发运检查余额状态，没有重新核对这张活动质量隔离记录。恢复路径还会回填旧 `previousQualityStatus`，可能覆盖更新的判定。 | 分开保存检验结论、隔离、让步和业务留置，统一计算最终可用状态；恢复必须依据当前事实重算。最终出库检查不能只信被覆盖的单字段投影。 |
| **C7：新增，Critical。预留量被当成质量限制的豁免。** 代码缺陷 | [availability.ts:22–41](https://github.com/yeemio/Cadenza/blob/cb25076d99cda0ac359151ff9eea65507de8cc4d/packages/domain/src/inventory/availability.ts#L22-L41)；[inventory-posting.ts:517–569](https://github.com/yeemio/Cadenza/blob/cb25076d99cda0ac359151ff9eea65507de8cc4d/packages/application/src/inventory-posting.ts#L517-L569)、[1248–1260](https://github.com/yeemio/Cadenza/blob/cb25076d99cda0ac359151ff9eea65507de8cc4d/packages/application/src/inventory-posting.ts#L1248-L1260) | 合格库存先预留 10，之后转为 suspect；可用量函数返回 0，但发料又把该 reservation 的 10 加回来，可继续扣量。新建预留也只比较毛量，未以真实质量可用量为上限。这个路径不依赖 C3。 | 质量准入先于数量分配，任何预留都不能覆盖隔离；核对预留持有人及业务归属。覆盖“预留后质量恶化”、过期／他人预留、无预留等组合。 |
| **C4：两部分均成立，Critical。补码可无库存发运；指定行可绕过实际归属匹配。** 代码缺陷 | [shipping-handlers.ts:581–623](https://github.com/yeemio/Cadenza/blob/cb25076d99cda0ac359151ff9eea65507de8cc4d/packages/application/src/shipping-handlers.ts#L581-L623)、[797–900](https://github.com/yeemio/Cadenza/blob/cb25076d99cda0ac359151ff9eea65507de8cc4d/packages/application/src/shipping-handlers.ts#L797-L900)、[435–475](https://github.com/yeemio/Cadenza/blob/cb25076d99cda0ac359151ff9eea65507de8cc4d/packages/application/src/shipping-handlers.ts#L435-L475) | ①补码计入已扫件数，却写 `inventoryUnitId:null`；发运跳过该行，仍可将 PL 标为 shipped、`postedUnits=0`。②普通扫码只验证所给 line 属于 PL，没有把实际库存料品、销售订单行与该 line 比较。 | 出库前建立实物与商业行的完整对应，并校验料品、销售归属、数量和段长。无法解析库存身份的补码不能直接完成出库；历史业务特殊映射另按明确合同处理。 |
| **C5：条件成立，Critical。裸 requestId 可覆盖轮次所有者并复用旧信封。** 代码缺陷 | [aiquery.turn-context.ts:36–76](https://github.com/yeemio/Cadenza/blob/cb25076d99cda0ac359151ff9eea65507de8cc4d/apps/api/src/aiquery/aiquery.turn-context.ts#L36-L76)；[aiquery.turns.controller.ts:74–162](https://github.com/yeemio/Cadenza/blob/cb25076d99cda0ac359151ff9eea65507de8cc4d/apps/api/src/aiquery/aiquery.turns.controller.ts#L74-L162)、[219–229](https://github.com/yeemio/Cadenza/blob/cb25076d99cda0ac359151ff9eea65507de8cc4d/apps/api/src/aiquery/aiquery.turns.controller.ts#L219-L229) | A 的结果仍在同一 API 进程缓存时，B 使用自己的合法会话、复用已知 requestId；注册覆盖 owner，但旧信封未清。若本轮没有新的工具引用，fallback 可返回 A 的旧信封。 | 轮次绑定企业／用户／会话；同 ID 异归属直接拒绝。缓存、澄清、取消、审计和结果回放使用同一身份约束，返回前核验信封归属及当前权限。 |

这六项需要保留以下精确限定：

- **C1 不能笼统使用“第二轴质量不合格”作为复现条件。** `ShippingRuleViolation`、`InventoryRuleViolation` 被转换为业务拒绝，但当前 `QualityRuleViolation` 会向外抛出，从而进入总线回滚。明确可用的触发是第二轴业务留置或活动预留。
- **C1 已扩散到倒轴冲销。** 子轴先执行反向扣账，之后才检查源轴留存量；源轴留存已被合法消耗时，可能晚拒绝并提交此前子轴扣账。下游检查只查子轴，参数 `_sourceUnitId` 被忽略。因此首包应修共同总线，不能只改发运循环。[rework-handlers.ts:469–507](https://github.com/yeemio/Cadenza/blob/cb25076d99cda0ac359151ff9eea65507de8cc4d/packages/application/src/rework-handlers.ts#L469-L507)、[rework-repositories.ts:1335–1353](https://github.com/yeemio/Cadenza/blob/cb25076d99cda0ac359151ff9eea65507de8cc4d/packages/persistence/src/rework-repositories.ts#L1335-L1353)
- C2 并非所有质量入口都缺授权：新增 `suspectReview` 有实际企业／工厂检查，恰好说明相邻入口没有统一执行。[quality-handlers.ts:449–457](https://github.com/yeemio/Cadenza/blob/cb25076d99cda0ac359151ff9eea65507de8cc4d/packages/application/src/quality-handlers.ts#L449-L457)
- C3 的 `quality_hold` 与 0031 的 `inventory_business_hold` 是不同机制。发运仍检查后者，所以不能声称 N2 独立业务留置已经被绕过。
- C5 需要已知／复用 requestId 和缓存仍存在等前提。没有证明 UUID 可猜测、实际用户数据已经泄露，或受控查询本身绕过了 SQL 授权。零工具调用的 answer／refuse 分支确实存在。[orchestrator.ts:355–381](https://github.com/yeemio/Cadenza/blob/cb25076d99cda0ac359151ff9eea65507de8cc4d/apps/ai/src/orchestrator.ts#L355-L381)

### 2.2 Important：业务链、多厂运行与经营事实

| 编号／分类 | 准确源码依据 | 触发与影响 | 修正建议及可观察结果 |
|---|---|---|---|
| **I01 并发采购退货重复扣订单已收量**；代码缺陷 | [purchase-handlers.ts:961–986](https://github.com/yeemio/Cadenza/blob/cb25076d99cda0ac359151ff9eea65507de8cc4d/packages/application/src/purchase-handlers.ts#L961-L986)、[1063–1104](https://github.com/yeemio/Cadenza/blob/cb25076d99cda0ac359151ff9eea65507de8cc4d/packages/application/src/purchase-handlers.ts#L1063-L1104) | 不同 operationId 并发读取同一未锁批次；第二请求等待库存锁后可能跳过已无余额单元，却继续按旧批次数量扣订单已收量并登记退货意图。**不是已证明库存余额被扣两次**，而是批次、订单累计量与外发事实可能失配。 | 锁批次／状态条件更新保证业务转移一次；统一锁序。真 PG 双连接交错，核对批次、订单、库存、流水、outbox。 |
| **I02 PDA 未知结果重试换 operationId**；代码缺陷 | [ui/api/client.ts:599–620](https://github.com/yeemio/Cadenza/blob/cb25076d99cda0ac359151ff9eea65507de8cc4d/packages/ui/src/api/client.ts#L599-L620)；[FeedScanPage.tsx:65–81](https://github.com/yeemio/Cadenza/blob/cb25076d99cda0ac359151ff9eea65507de8cc4d/apps/pda/src/pages/FeedScanPage.tsx#L65-L81) | 服务端已提交、响应丢失后，页面保留原行重试；未传入原 opId，客户端生成新键。余量仍足够时可形成第二次投料。 | 每个操作意图持久绑定 opId 和载荷；未知结果先查询／同键重试，明确新意图才换键。验收必须丢弃真实 API 提交后的响应。 |
| **I03 PDA／Web 仍携带演示归属**；代码缺陷／现场能力缺口 | [FeedScanPage.tsx:44–81](https://github.com/yeemio/Cadenza/blob/cb25076d99cda0ac359151ff9eea65507de8cc4d/apps/pda/src/pages/FeedScanPage.tsx#L44-L81)；[PutawayScanPage.tsx:65–74](https://github.com/yeemio/Cadenza/blob/cb25076d99cda0ac359151ff9eea65507de8cc4d/apps/pda/src/pages/PutawayScanPage.tsx#L65-L74)；[execution-handlers.ts:453–487](https://github.com/yeemio/Cadenza/blob/cb25076d99cda0ac359151ff9eea65507de8cc4d/packages/application/src/execution-handlers.ts#L453-L487) | 投料提交固定销售单号／行号，默认选首工序；上架使用固定厂、所有者等演示值。后端部分归属只检查非空后采用。可产生错误归属，或真实工厂无法正常操作。 | 从已授权任务、订单和工序解析归属；服务端复核；演示配置与业务入口分离。用两个真实不同订单、不同工厂验证，不允许自动继承旧任务。 |
| **I04 reverse 跨厂接收仍保留源厂库存归属**；代码缺陷 | [reverse-handlers.ts:334–359](https://github.com/yeemio/Cadenza/blob/cb25076d99cda0ac359151ff9eea65507de8cc4d/packages/application/src/reverse-handlers.ts#L334-L359)、[430–484](https://github.com/yeemio/Cadenza/blob/cb25076d99cda0ac359151ff9eea65507de8cc4d/packages/application/src/reverse-handlers.ts#L430-L484) | A→B 接收后，目标单据和库位归 B，目标余额、接收分录仍用源 unit 的 plant；unit 仅改状态。造成实际保管位置与工厂账／权限范围不一致。 | 统一跨厂接收内核，区分所有权与保管工厂。主库存入口已有目标工厂处理，reverse 应满足同一合同；两个入口分别验收。 |
| **I05 扫入半数即可完成调拨接收**；代码缺陷 | [reverse-handlers.ts:1678–1737](https://github.com/yeemio/Cadenza/blob/cb25076d99cda0ac359151ff9eea65507de8cc4d/packages/application/src/reverse-handlers.ts#L1678-L1737)；[transfer-in-rules.ts:134–159](https://github.com/yeemio/Cadenza/blob/cb25076d99cda0ac359151ff9eea65507de8cc4d/packages/domain/src/reverse/transfer-in-rules.ts#L134-L159) | 已扫量与“剩余未扫量”比较。两轴各 100，只扫一轴即满足 100≥100，整单 completed，余轴仍在途且后续扫码受 completed 限制。 | 与应收总量／必收行比较；若合同允许部分完成，必须保留可继续接收的残余单据。验证 1/2、2/2、多料品与重复扫码。 |
| **I06 worker 跨厂认领后使合法任务停止正常重试**；代码缺陷 | [outbox-claim.ts:18–26](https://github.com/yeemio/Cadenza/blob/cb25076d99cda0ac359151ff9eea65507de8cc4d/apps/worker/src/outbox-claim.ts#L18-L26)、[147–155](https://github.com/yeemio/Cadenza/blob/cb25076d99cda0ac359151ff9eea65507de8cc4d/apps/worker/src/outbox-claim.ts#L147-L155)；[handlers.ts:142–151](https://github.com/yeemio/Cadenza/blob/cb25076d99cda0ac359151ff9eea65507de8cc4d/apps/worker/src/handlers.ts#L142-L151) | 先全局 claim，后检查工厂；异厂任务被置 `FAILED + next_retry_at=NULL`，正确工厂 worker 也不会正常领取。没有证明越厂外发，已证明会越厂改变队列可处理状态。 | 范围进入 claim SQL，异厂任务不锁、不增加 attempt、不改状态。两厂 worker 并发、单厂离线均要验证。 |
| **I07 CN／KR 业务日口径不一致**；实现／配置缺口 | [domain/inventory/time.ts:35–44](https://github.com/yeemio/Cadenza/blob/cb25076d99cda0ac359151ff9eea65507de8cc4d/packages/domain/src/inventory/time.ts#L35-L44)；[inventory-posting.ts:96–120](https://github.com/yeemio/Cadenza/blob/cb25076d99cda0ac359151ff9eea65507de8cc4d/packages/application/src/inventory-posting.ts#L96-L120)；[ui/i18n/time.ts:54–83](https://github.com/yeemio/Cadenza/blob/cb25076d99cda0ac359151ff9eea65507de8cc4d/packages/ui/src/i18n/time.ts#L54-L83) | 后端库存业务日默认 UTC+8，UI 通过工厂名称等判断 KR 并用 UTC+9。默认零点切班时，15:30Z 可显示不同业务日，影响班次及报表归属。 | 明确工厂时区与班次日历，由服务端统一提供。此项包含既有 SITE_PENDING 边界；不能宣称已验收韩国业务日。 |
| **I08 订单转换重试把 unknown／遗漏 outcome 当成功**；代码缺陷 | [conversion-handlers.ts:639–681](https://github.com/yeemio/Cadenza/blob/cb25076d99cda0ac359151ff9eea65507de8cc4d/packages/application/src/conversion-handlers.ts#L639-L681) | 已完成但 sync_failed 的转换，重试仅把字面 `failure` 当失败，其余记 success，随后可写 DISPATCHED／synced。UNKNOWN 被错误确认。 | 严格枚举及可信外部回执；UNKNOWN 保留未知并走查询／人工处置。与库存转换已存在的未知语义统一，禁止为重试再次改本地账。 |
| **I09 AI 可用库存未扣独立业务留置**；查询一致性缺陷 | [aiquery-service.ts:1113–1158](https://github.com/yeemio/Cadenza/blob/cb25076d99cda0ac359151ff9eea65507de8cc4d/packages/application/src/aiquery-service.ts#L1113-L1158)；对照 [inventory-queries.ts:159–177](https://github.com/yeemio/Cadenza/blob/cb25076d99cda0ac359151ff9eea65507de8cc4d/packages/application/src/inventory-queries.ts#L159-L177) | AI 按质量＋预留算可用量，而库存查询会将 business hold 单元可用量置零。同一实物得到不同答案。此项是读口径问题，不能说已绕过发运写入闸门。 | 复用统一可用性查询，返回不可用原因。合格但业务留置的同一单元，在库存、AI、齐套和交易准入中结果一致。 |
| **I10 集团齐套入口固定返回 empty**；实际能力未实现 | [group-handlers.ts:110–139](https://github.com/yeemio/Cadenza/blob/cb25076d99cda0ac359151ff9eea65507de8cc4d/packages/application/src/group-handlers.ts#L110-L139) | 无订单／BOM／可用库存查询，直接保存 `orderId:null`、`checkStatus:empty`、空 shortageLines。已有订单也不能得到真实齐套判断。 | 接入订单版本、BOM、单位换算和真实可用量；明确“缺资料／未计算／齐套／短缺”。不能把 empty 计作已实现或零短缺。 |
| **I11 维护／校准与排程仍有独立事实表**；跨域实现缺口 | [csw-repositories.ts:707–715](https://github.com/yeemio/Cadenza/blob/cb25076d99cda0ac359151ff9eea65507de8cc4d/packages/persistence/src/csw-repositories.ts#L707-L715)、[824–829](https://github.com/yeemio/Cadenza/blob/cb25076d99cda0ac359151ff9eea65507de8cc4d/packages/persistence/src/csw-repositories.ts#L824-L829)；[csw-handlers.ts:709–723](https://github.com/yeemio/Cadenza/blob/cb25076d99cda0ac359151ff9eea65507de8cc4d/packages/application/src/csw-handlers.ts#L709-L723) | 排程约束读取 CSW 自有校准／停机表，代码仍标注等待 T23 数据源。共享设备维修状态已有部分作用，但停机区间、校准及恢复提示未形成完整事实链。 | 直接读 T19/T23，或建立可重放、可对账的正式投影。仅通过维修／校准业务入口改变事实，排程须看到约束和恢复，不手工补影子表。 |
| **I12 单设备 OEE 使用全厂产出，停机窗口计算也不完整**；数值缺陷 | [cost-queries.ts:238–273](https://github.com/yeemio/Cadenza/blob/cb25076d99cda0ac359151ff9eea65507de8cc4d/packages/application/src/cost-queries.ts#L238-L273)；[cost-repositories.ts:1341–1349](https://github.com/yeemio/Cadenza/blob/cb25076d99cda0ac359151ff9eea65507de8cc4d/packages/persistence/src/cost-repositories.ts#L1341-L1349) | 设备 A 的停机／速度配上全厂产出和合格量；B 生产可改变 A 的 OEE。停机仅筛开始时间在窗口内，并累加完整时长，漏算或多算跨窗停机。 | 同设备、同单位、同时间窗取事实；停机按区间相交裁剪。缺归属／分母时显示缺项。用两设备与跨窗停机给出可复算数值。 |

I04 中主库存入口已有相对正确的目标工厂处理，说明某一已接受跨厂路径不能推广为所有入口正确。[inventory-posting.ts:969–1008](https://github.com/yeemio/Cadenza/blob/cb25076d99cda0ac359151ff9eea65507de8cc4d/packages/application/src/inventory-posting.ts#L969-L1008)

### 2.3 Important：构建、升级、恢复与采集

| 编号／分类 | 准确源码依据 | 触发与影响 | 修正建议及可观察结果 |
|---|---|---|---|
| **C6／I13：成立，Important。备份、恢复使用不同实例定位方式。** 代码缺陷 | [backup.sh:40–85](https://github.com/yeemio/Cadenza/blob/cb25076d99cda0ac359151ff9eea65507de8cc4d/deploy/backup/backup.sh#L40-L85)；[restore.sh:41–76](https://github.com/yeemio/Cadenza/blob/cb25076d99cda0ac359151ff9eea65507de8cc4d/deploy/backup/restore.sh#L41-L76) | `DATABASE_URL` 指 A、`PG_CONTAINER` 指 B 且同名库时，dump/restore 经 B 容器，元数据、重建和校验经 A。可备份 B 数据配 A 元数据；恢复可先重建 A，却向 B 导入。 | 一份规范连接贯穿全部步骤，副作用前核对实例身份。双实例同名库不同标记：配置不一致必须在 dump／重建前拒绝。 |
| **I14 “只读”升级预检默认执行迁移**；代码与手册缺陷 | [upgrade-compat-check.mjs:67–109](https://github.com/yeemio/Cadenza/blob/cb25076d99cda0ac359151ff9eea65507de8cc4d/scripts/delivery/upgrade-compat-check.mjs#L67-L109)；[升级手册:20–25](https://github.com/yeemio/Cadenza/blob/cb25076d99cda0ac359151ff9eea65507de8cc4d/deploy/upgrade/MANUAL-%E5%8D%87%E7%BA%A7%E6%89%8B%E5%86%8C.md#L20-L25) | 默认检查先积累失败，再执行 `applyMigrations`，最后才判失败。0030 库可能被提交到 0031，然后检查退出失败。 | 默认只读；不支持路径先拒绝；重入测试在克隆库做。旧库、最新库、未知迁移、降级目标检查前后，schema／数据／迁移表摘要应相同。 |
| **I15 备份“脱敏配置”未遮盖 TOKEN**；条件触发的代码缺陷 | [backup.sh:72–76](https://github.com/yeemio/Cadenza/blob/cb25076d99cda0ac359151ff9eea65507de8cc4d/deploy/backup/backup.sh#L72-L76)；[apps/ai/src/config.ts:83–89](https://github.com/yeemio/Cadenza/blob/cb25076d99cda0ac359151ff9eea65507de8cc4d/apps/ai/src/config.ts#L83-L89) | 过滤 PASSWORD／SECRET／KEY，却支持并可能保留 `AI_RUNTIME_INTERNAL_TOKEN`、`AI_INTERNAL_QUERY_TOKEN` 原值。未观察到实际秘密泄露。 | 非秘密配置白名单导出，秘密只记引用。用合成哨兵值检查备份全部文件，不能残留任何原值。 |
| **I16 AI／IM 未进入完整标准构建图**；确定的集成缺口，冷构建结果未评估 | [apps/ai/build.sh:7–11](https://github.com/yeemio/Cadenza/blob/cb25076d99cda0ac359151ff9eea65507de8cc4d/apps/ai/build.sh#L7-L11)；[integrations/im/package.json:5–10](https://github.com/yeemio/Cadenza/blob/cb25076d99cda0ac359151ff9eea65507de8cc4d/packages/integrations/im/package.json#L5-L10)；[im.composition.ts:23–39](https://github.com/yeemio/Cadenza/blob/cb25076d99cda0ac359151ff9eea65507de8cc4d/apps/api/src/aiquery/im/im.composition.ts#L23-L39) | apps/ai 故意没有 package.json；嵌套 IM 不属于标准 workspace，而 API 静态导入其 dist。现有 workspace 成功不能证明全新检出可完整安装启动。 | 收编构建图、依赖及启动入口；无遗留 dist 的全新检出完成安装、全部目标构建及启动。AI 关闭时核心业务可运行也须明确验证。 |
| **I17 模拟网关无送达仍清积压**；源码缺陷，限定模拟网关 | [gateway.ts:128–168](https://github.com/yeemio/Cadenza/blob/cb25076d99cda0ac359151ff9eea65507de8cc4d/packages/edge/src/gateway.ts#L128-L168)；[buffer.ts:81–85](https://github.com/yeemio/Cadenza/blob/cb25076d99cda0ac359151ff9eea65507de8cc4d/packages/edge/src/buffer.ts#L81-L85) | transport 为 null 时仍 drain 并保存空 checkpoint；overflow 统计在发送前已取走，发送失败后丢失该统计。等待发送期间新样本被全量 drain 还存在静态可达风险。 | 未确认不清除，只删除已确认批次的事件 ID；overflow 采用读取／确认分离。覆盖无 transport、发送失败、发送中新样本、重启与重复送达。 |

两处严重度修正必须明确：

1. **C6 不应写成“任意生产库可能被直接删除”。** 下层 DROP／CREATE 限制 `cadenza_dops_*` 演练库并保护系统库。当前确定的是演练恢复路径的实例错配，以及生产恢复能力尚未获证。[db.mjs:26–35、54–68](https://github.com/yeemio/Cadenza/blob/cb25076d99cda0ac359151ff9eea65507de8cc4d/scripts/delivery/lib/db.mjs#L26-L68)
2. **I14 的问题入口是默认单独调用预检。** `upgrade.sh` 已传 `--no-reentrancy`，其这一预检步骤不应被一并指控为默认迁移。[upgrade.sh:47–50](https://github.com/yeemio/Cadenza/blob/cb25076d99cda0ac359151ff9eea65507de8cc4d/deploy/upgrade/upgrade.sh#L47-L50)

### 2.4 Minor 与证据缺口

| 编号／级别／性质 | 依据 | 判断及处理 |
|---|---|---|
| **M01 Minor：Web／PDA 包体较大** | [BUILD:23–40](https://github.com/yeemio/Cadenza/blob/cb25076d99cda0ac359151ff9eea65507de8cc4d/docs/review/BUILD-20261103.log#L23-L40) | 主 JS 分别约 1,473.61／1,059.41 kB，gzip 425.42／319.36 kB。是构建警告；未测真实 PDA 首屏、内存或交互延迟。后续按真实设备测量，再做路由懒加载和依赖拆分。 |
| **M02 Minor：规划／发行元数据落后于当前源码** | [ROADMAP:31–59](https://github.com/yeemio/Cadenza/blob/cb25076d99cda0ac359151ff9eea65507de8cc4d/architecture/ROADMAP.md#L31-L59)；[RELEASE-ANCHOR.json:33](https://github.com/yeemio/Cadenza/blob/cb25076d99cda0ac359151ff9eea65507de8cc4d/deploy/release/RELEASE-ANCHOR.json#L33) | 旧规划仍写未启动，发行锚仅到 0021，而当前已有 0031。保留历史规划，补候选级实施／接受矩阵和准确发行锚；不要把旧状态整表机械改为完成。 |
| **E01 Important：最新 SIM 完整原始证据缺口** | [STATUS:9–15](https://github.com/yeemio/Cadenza/blob/cb25076d99cda0ac359151ff9eea65507de8cc4d/docs/review/STATUS-20261103.md#L9-L15) | 已接收的 77 路径增量、摘要和当前构建，不构成全仓业务接受。需要准确候选、事件／尝试账、输入、差异解释、原始输出和接受记录；暂不重写既有 SIM 结论。 |
| **E02 Important：旧库／旧 hash／0031 升级未证明** | [STATUS:13](https://github.com/yeemio/Cadenza/blob/cb25076d99cda0ac359151ff9eea65507de8cc4d/docs/review/STATUS-20261103.md#L13)；[sap-sim-engine-service.ts:947–962](https://github.com/yeemio/Cadenza/blob/cb25076d99cda0ac359151ff9eea65507de8cc4d/packages/application/src/sap-sim-engine-service.ts#L947-L962) | 新库规范化摘要测试不证明历史持久化引用链升级。需要带旧 master hash、receipt、库存、未决 outbox 和 UNKNOWN 的旧库副本。**没有证据判定已发生升级损坏。** |
| **E03 Important：测试移植与必跑门禁不足** | [r5-reference-digest.spec.ts:11](https://github.com/yeemio/Cadenza/blob/cb25076d99cda0ac359151ff9eea65507de8cc4d/tests/sol-sap-engine/r5-reference-digest.spec.ts#L11)；[command-idempotency.spec.ts:38–45、96–98](https://github.com/yeemio/Cadenza/blob/cb25076d99cda0ac359151ff9eea65507de8cc4d/tests/integration/command-idempotency.spec.ts#L38-L98) | 有绝对本地路径，DB 不可达可 skip。开发跳过机制不能作为正式接受结果；正式门禁必须记录 executed／skipped／failed，并要求必跑场景零跳过。独占库保护应保留。 |
| **E04 Important：R6 独立接受材料不完整** | [STATUS:13](https://github.com/yeemio/Cadenza/blob/cb25076d99cda0ac359151ff9eea65507de8cc4d/docs/review/STATUS-20261103.md#L13) | 原始全文及接收身份未取得。本次同模型谱系咨询，包括分域分析，均不能关闭该项。 |
| **未评估：真实部署、外部系统及现场** | 本轮无对应执行证据；范围见 [STATUS:13–15](https://github.com/yeemio/Cadenza/blob/cb25076d99cda0ac359151ff9eea65507de8cc4d/docs/review/STATUS-20261103.md#L13-L15) | 真实 SAP／U9／DC、模型、企业渠道、设备、打印硬件、持续负载、故障切换和岗位连续作业，保留未评估。不能把缺证据自动写成故障，也不能写成通过。 |

## 三、下一步总体规划：复用现有 T01–T28、A01–A14

原 ROADMAP 的业务依赖仍有价值，但“未启动”状态已不能表示当前实现。应增加准确候选的实施／接受矩阵，继续沿用 T、A 编号，记录“代码存在、源码缺陷、组合验证、外部验证、岗位接受”各自状态。45 份 PRD 的映射不应换算为完成率。[ROADMAP:25–71](https://github.com/yeemio/Cadenza/blob/cb25076d99cda0ac359151ff9eea65507de8cc4d/architecture/ROADMAP.md#L25-L71)

以下是建议的实施分组，**不是本轮新建的任务系统**。

### 1. 依赖顺序、交付物与接受条件

| 顺序／优先级 | 对应既有任务与主要包 | 必须交付的结果 | 可观察验收条件 |
|---|---|---|---|
| **0．候选与证据基线，立即准备** | T01、T25、T26；`docs/review`、`requirements`、`tests/scripts` | 当前候选清单；T/A—实现—测试—证据映射；可移植合成夹具；旧结论与本轮结论分开登记。 | 每个 PASS 能追到准确候选、输入、命令、实际执行数、原始输出和接受人；缺项明确标记，不由摘要补齐。 |
| **1．P0：命令原子性，首包** | T06，关联 T10/T14/T15；`persistence`、必要应用处理器及组合测试 | 修复 C1，共同拒绝语义、回执幂等和事务内 outbox 保证。 | 真实 PG 中发运晚拒绝、倒轴冲销晚拒绝均无部分业务写入；成功和并发重放仍只入账一次。 |
| **2．P0：对象范围、质量与实物对应** | T03/T06/T08/T11/T12/T14；`domain/application/persistence/api` | C2/C3/C7/C4；统一对象授权和有效可用性；采购批次业务幂等 I01。 | 异厂 ID 拒绝且无副作用；活动隔离不能被检验／预留覆盖；每一发运行均有合法实物和对应库存动作；同批并发退货只改变一次业务累计量。 |
| **3．P0：AI 轮次归属，可与 1、2 隔离准备** | P4/AI 接受范围；`apps/api/aiquery`、`apps/ai`、相关持久化 | C5 与 I09；统一 owner、缓存、澄清、取消、审计及可用库存口径。 | 两用户、同用户两会话、不同企业、相同 requestId、零工具回复、权限撤销均不复用他人或过期信封；合法澄清仍可用。 |
| **4．P1：现场操作与多厂整链** | T09–T18、T20、T07；`ui/web/pda/application/worker` | I02–I08；真实上下文、原 opId 重试、两条跨厂接收路径、工厂业务日、worker 路由、转换 UNKNOWN。 | 同候选贯通 A02/A04–A09/A11/A14；两个工厂、至少两个订单；覆盖成功、拒绝、响应丢失、并发、部分接收和恢复。 |
| **5．P1：完整构建、升级与恢复；准备可提前并行** | T07/T25/T26；workspace 配置、`apps/ai`、IM、`deploy/scripts/tests` | I13–I16、E02/E03；完整冷构建；只读预检；实例绑定备份；秘密导出策略；旧库／旧 hash 升级与恢复证据。 | 全新检出无旧 dist 可构建启动；必跑测试零跳过；旧库升级及恢复后三份对账成立；实例错配在副作用前拒绝；备份无秘密哨兵值。 |
| **6．P1：补齐 MOM 联动和可信指标** | T19–T24、T20；维护、CSW、SPC、成本、group、edge | I10–I12、I17；真实齐套计算；维护／校准进入排程；正确设备指标；网关确认式清积压。 | A03/A10/A12 的预期数值可复算；不手工复制影子事实；每个采集样本“仍待发送”或“有接受证据”；缺资料不伪装为正常值。 |
| **7．外部验证与现场接受** | T02/T07/T21/T25–T28 | 获准的真实 SAP／DC／设备等适配验证；首厂岗位剧本、恢复演练、差异处置和具名接受；之后第二工厂复用。 | T27 采用准确候选和实际岗位，记录失败与绕行；业务账、接口账、投影分别核对；T28 在首厂接受后证明配置复用及多厂交接。 |

### 2. 并行边界与门禁

可以提前并行准备 AI 归属修复、冷构建、可移植夹具、旧库样本和外部接口样例。**共享库存、质量、采购、发运及命令事务文件应有单一整合责任，避免各分支重新发明一份规则。**

每个分组的验证都要回到**同一合并候选**。分支 A 的库存成功、分支 B 的 AI 成功、旧候选的恢复成功，不能拼成当前候选的整体接受。这与现有 ROADMAP 的接受分层一致。[ROADMAP:89–100](https://github.com/yeemio/Cadenza/blob/cb25076d99cda0ac359151ff9eea65507de8cc4d/architecture/ROADMAP.md#L89-L100)

恢复验收应继续使用现有三分对账：

1. **业务账**：单据、库存余额、流水、留置、在途和未决量。
2. **接口账**：外部已确认集合、待发任务、UNKNOWN；恢复后不重复外发。
3. **投影**：重建后与事实一致，不触发二次业务执行。

RPO≤15 分钟、RTO≤2 小时是现有规划目标，未经目标环境实测不能填 PASS。[delivery-ops.md:40–56](https://github.com/yeemio/Cadenza/blob/cb25076d99cda0ac359151ff9eea65507de8cc4d/architecture/contracts/frozen/p3/delivery-ops.md#L40-L56)

当前不宜把旧规划中的人周直接当作余下工期。先完成首包及关键组合回归，获得实际返工范围、测试可运行性和外部等待条件后，再给余下工作估算。

### 3. 真正需要 Owner 裁定的事项

| 事项 | 需要裁定的具体内容 |
|---|---|
| **首厂及首个接受范围** | 法人、工厂、产品族、代表性路线、岗位、具名接受人；哪些能力属于首次正式接受。既有 G3/G4 范围若调整，需要明确记录。 |
| **升级责任** | 首次交付是否允许仅新安装；若要求升级，哪一个旧版本是正式起点，能否提供获准隔离副本及旧 hash／未决接口样本。工程不能自行把“未验证”改成“不支持”。 |
| **现场集成权责** | 各厂实际使用的 ERP／SAP／U9／DC、字段主权、接口负责人、结果查询能力及真实联调范围。 |
| **部署与恢复责任** | 共用中心实例或工厂独立实例，现场网络／数据条件，恢复目标、备份介质、留存和切换窗口。 |
| **尚未定义的业务例外** | 独立业务留置的解除权限和证据；若无库存身份的历史补码确有合法场景，其实物映射和出库合同如何定义。当前保持阻断，不能由工程增加自动解除。 |
| **独立接受材料** | 补回 R6 原始全文和接收身份；如无法补回，由 Owner 确认符合原独立性要求的重审方式。本次咨询不能改名替代。 |
| **真实 AI／企业渠道范围** | 若纳入首次交付，明确真实模型、渠道、身份、可使用业务数据及外部调用授权。 |

原子提交、实际对象授权、秘密不进入脱敏备份、未知结果不记成功、无送达不清积压，已经有明确的工程和产品依据，**不需要再作为业务取舍交给 Owner 决定**。

---

## 四、首个可直接交给实施者的完整任务包

### 任务名称

**修复业务拒绝的事务原子性，并保留准确的幂等回执**

**优先级：P0。**  
关联：T06，及 T10/T14/T15；A04/A05/A08/A11。  
本包仅为交接文本，未启动实施。

### 1. 基线与目标

基线绑定公开提交：

`cb25076d99cda0ac359151ff9eea65507de8cc4d`

来源映射为本地主线：

`86fe9fe9408f1d93e2fe3f562f51cd691efbc16d`

若在本地主线实施，应先核对来源映射和实际工作树差异，记录实施基线；不得以移动 main 或未说明的已有改动替代。

完成后必须满足：

- 整体命令返回 `BUSINESS_REJECTION` 或版本冲突时，**业务写集全部回滚**：余额、库存流水、分录、单元状态、业务单据、谱系、成功审计及成功 outbox 均不得部分留存。
- 拒绝结果可以持久化为准确回执；同一企业、命令种类、operationId、载荷再次请求时返回原结果。
- 成功时，业务事实、回执和 outbox 同事务完成。
- SQL／未知异常不会产生假的成功回执或残留部分业务写入。
- 已明确约定的草稿、隔离登记、逐行结果等合法持久行为按原合同保留，不能被笼统当成整体失败删除。

产品依据是库存扣减和最终发运默认原子提交，以及未知结果查询原 operationId。[SYSTEM_ARCHITECTURE.md:84–94](https://github.com/yeemio/Cadenza/blob/cb25076d99cda0ac359151ff9eea65507de8cc4d/architecture/SYSTEM_ARCHITECTURE.md#L84-L94)

### 2. 非目标

本包不同时解决 C2/C3/C4/C5/C7，也不扩展库存业务规则、质量政策、补码合同、现场时区或 AI 能力。

不执行旧库迁移、生产部署、真实 SAP／模型／渠道调用；不改变历史 SIM 预期以获得绿色结果；不宣称完成整体上线接受。

### 3. 允许修改路径

核心允许范围：

- `packages/persistence/src/pg-command-bus.ts`
- `packages/application/src/command-bus.ts`：仅必要的结果／事务语义说明或类型调整
- `packages/application/src/shipping-handlers.ts`
- `packages/application/src/rework-handlers.ts`
- `apps/api/src/shipping/shipping.composition.ts`
- `apps/api/src/rework/rework.composition.ts`：两处组合根仅限事务工具、outbox 或验证所必需的调整
- `tests/integration/command-idempotency.spec.ts`
- 对应 shipping／rework 集成测试、API 测试及本包新增的具名夹具／测试文件
- `docs/review/` 下本包的接受说明与经过脱敏的原始验证输出

只读检查范围可以扩展到其他命令 handler 和组合根，以确认共同语义。

不应修改既有迁移历史、冻结业务合同、发布来源清单、生产配置或无关 UI。若完成修复必须超出上述写入范围，应先报告具体原因和最小扩展范围。

### 4. 实施前依赖

- 可用的真实 PostgreSQL 隔离测试库，保留独占库／白名单护栏。
- 能从仓库或显式夹具参数取得测试数据，不依赖个人绝对路径。
- 实际应用 handler、PG 仓储和组合根参与测试；纯替身 handler 只能补充测试总线协议，不能代替业务复现。
- 先审计 `HandlerOutcome` 的现有状态及合法持久拒绝／隔离行为，明确哪些属于“命令成功登记了一项隔离事实”，哪些属于“整笔命令被拒绝”。

### 5. 建议技术路线与风险

建议在幂等键／回执占位之后、业务处理之前设置事务保存点。整体业务拒绝时回滚到保存点，再持久化拒绝回执，最后提交外层事务。

这是一条可行路线，接受标准以行为为准。实施时须处理：

- 数据库错误导致事务进入失败状态后，不能直接继续写回执。
- 事务内 outbox 和审计不能成为脱离事务的未等待写入。
- 拒绝回执不得混入此前已回滚的“成功数据”。
- 保存点回滚、并发幂等键、锁释放及异常重试必须协调。
- 合法草稿、隔离登记和已有逐行合同不能因统一回滚而丢失。
- 仅把所有检查挪到循环前面不足以关闭 C1：未来其他 handler 仍可能发生晚拒绝。

### 6. 必须完成的真实 PG 验收场景

| 场景 | 必须观察到的结果 |
|---|---|
| **发运晚拒绝：第二轴业务留置** | 第一轴原本可发，第二轴被留置；整单拒绝，两个库存单元、余额、流水、PL、outbox 均无业务变化，只留下允许的拒绝回执／拒绝审计。 |
| **发运晚拒绝：第二轴活动预留** | 与上项相同，证明不是只对 business hold 特判。 |
| **倒轴冲销晚拒绝** | 源轴留存已被合法消耗、子轴无其他下游；冲销拒绝后子轴不得被扣回，源单、余额、谱系和流水不变。 |
| **现有质量异常回滚路径** | 第二轴质量闸门抛错后无部分库存变化；不得因修总线使原本回滚的路径变差。 |
| **合法多轴成功发运** | 应有的库存动作、单据状态和两类回传意图各发生一次；不缺项、不重复。 |
| **同 operationId 并发、同载荷** | 仅一个业务执行，其他请求回放同一结果；核对真实库中流水与 outbox 数量。 |
| **同 operationId、不同载荷** | 明确载荷冲突，业务无变化，原回执不被覆盖。 |
| **拒绝后同键重试** | 即使后来解除阻断，同键仍返回原拒绝；新的明确操作意图才能使用新键。 |
| **提交前异常与提交后丢响应** | 前者回滚且无假成功；后者同键查询／重试获得原结果，业务只发生一次。 |
| **合法持久隔离／草稿回归** | 已明确允许保存的事实仍存在，证明没有把所有非最终入账状态一并误删。 |

测试报告必须包含准确候选、命令、数据库身份、实际执行／跳过／失败数量，以及关键表的前后查询结果。必跑场景因 DB 不可用而 skip，不得算完成。

### 7. 停止条件

发生以下任一情况，停止扩大实施并报告：

- 无法确定源码基线或工作区存在未归属的冲突修改。
- 无真实隔离 PG，或者测试只能借替身／跳过完成。
- 原版本最小真实场景未按静态分析触发：先记录反证并重判，不改变业务前提来强行制造失败。
- 修复需要改变冻结业务语义、重写历史数据／迁移或扩大到未允许模块。
- 发现外部副作用不在事务控制内，现有边界无法保证回滚。
- 需要连接真实业务库、生产系统或执行部署。

### 8. 完成定义

交付：

1. 最小代码差异及新的准确提交；
2. 上述真实 PG 场景的原始结果；
3. 受影响表和 outbox 的前后核对；
4. 结果状态语义说明，以及保留的例外行为；
5. 未解决项清单。

**首包完成只关闭 C1 的接受范围。** C2/C3/C4/C5/C7、交付恢复及独立 R6 材料仍按各自门禁处理。

---

## 五、实际覆盖范围与最终接受边界

| 模块／材料 | 本轮实际覆盖 | 未覆盖或不能下结论的部分 |
|---|---|---|
| **产品、架构、领域与需求** | 指定状态文件、产品合同、系统架构、领域模型、ROADMAP、PRD 追溯／问题表及关键冻结合同。 | 未逐篇重新验收全部 45 份原始 PRD；`frozen` 目录名不等于已取得全部签发／接收原件。 |
| **API／权限／事务** | 关键控制器、ScopeGuard、命令总线、部分组合根；沿请求进入真实 handler 和 PG 仓储。 | 不是全 API 安全审计；全部导出、附件、管理员边界、会话安全及 RLS 实际部署未全面验证。 |
| **domain／application／persistence** | 深查库存、采购、投料、质量、发运、倒轴、逆向、转换和 SAP 模拟相关路径；抽查维护、排程、SPC、成本及集团查询。 | 未逐函数覆盖所有分支、全部迁移、索引、SQL 性能及所有下游引用类型。 |
| **worker／edge** | 认领、范围、状态迁移、默认路由、缓冲、发送及 checkpoint。 | 无真实 PG 多 worker 运行，无设备协议、真实网关断电／断网实测。 |
| **AI／IM** | 轮次 owner、缓存、澄清／返回路径、受控查询部分口径、构建和内部接缝。 | 无真实模型效果、真实渠道验签解密／发送、完整企业身份部署接受。 |
| **Web／PDA／UI** | 共享 API 客户端、投料／上架关键页面、业务时间处理、齐套入口及构建输出。 | 未遍历所有页面；无真实 PDA、扫码枪、打印机、弱网 UX、无障碍或性能实测。 |
| **tests／scripts／deploy** | 幂等、worker、SAP 历史测试、夹具定位、构建日志、升级预检、备份恢复与版本锚。 | 本轮未重新执行测试、安装、迁移、恢复或故障注入。 |
| **本地与现场证据** | 读取公开状态声明和已发布材料。 | 最新本地控制账本、数据库、完整执行归档、R6 原文／接收身份及真实现场接受未取得。 |

**最终接受判断如下：**

- **源码：**实现范围较广，存在必须优先修复的共同交易与隔离缺陷。
- **构建：**已发布的 workspace 构建成功成立；完整冷构建和启动资格尚未建立。
- **本地 SIM：**保留既有 56／65、62＋3、19＋2 及全部例外边界；不能外推为当前全仓、真实 SAP 或现场通过。
- **运行时：**本轮没有新增真实 PG／组合运行接受证据。
- **真实现场：**尚不能判定完成接受。
- **审查身份：****`same_family_external_advisory`**，不能替代缺失的独立 R6 原始审查及接收身份。

据此，建议首先交付上述“命令拒绝原子性”包，随后关闭对象范围、质量可用性和发运实物对应，再以同一候选完成完整构建、整链运行与恢复验证，按原 T27／T28 顺序进入获准的首厂和第二工厂接受。
