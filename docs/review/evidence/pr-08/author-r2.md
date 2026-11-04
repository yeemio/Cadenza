# PR08 R2 — DATE读取边界窄修

**状态：产品修正及有界回归源码已完成；当前21个SQL-client替身检查通过；完整persistence/test-source类型、项目Vitest及真实HTTP+PG补验NOT_RUN；等待主控接受。**

## 精确绑定

- 唯一父head：`d38fd52298586a3b225bc09d19a5c74ada952ffa`，原PR8分支 `codex/fix-08-operator-intent-calendar`。
- 父受测source：`67b8674e3799b192e6df4255ae5e887dce0a5bd6`。
- 原25源/测路径全部未变，fingerprint仍 `f10dab06df342ecfe8eb64778b2bfabe8245208f44ea0d4dc5b4edac621a98f3`。
- R2扩展为27路径：原25，加本次授权的execution-repositories.ts和新execution-date.unit.spec.ts；fingerprint为 `37f577673249a99a1bb262e7a8c0925b3affee6eb97846a6d54b5e182a068ffd`。
- 同范围可取得父文件的26路径fingerprint：`855324f72f2a60ce04f432581d3baf86c1c3af715fbb33c31707450c9c323690`。新增测试在父中不存在，不混作“同25路径”比较。

## 根因与修正

主控真实7HTTP+PG结果为5PASS/2FAIL/0skip。两失败均在报工详情shiftDate：库内SZ=2026-11-03、HF=2026-11-04，Asia/Shanghai进程中的pg DATE对象为前一天16:00Z；原dateStr取UTC日期导致早一天。准确父根因JSON和3606字节原始日志均已实际读取、校验并保留；未访问失败库。

唯一产品文件 `packages/persistence/src/execution-repositories.ts` 将DATE读取投影为：

```sql
to_char(shift_date::timestamp, 'YYYY-MM-DD') AS shift_date_text
```

session联表和分页查询使用限定列 `s.shift_date`。显式timestamp无时区转换保留日历字段，固定格式不依赖DateStyle；映射直接读取text，不再把DATE当UTC瞬间，也没有Date/string兼容fallback。material-consumption的nullable DATE仍映射为null。

四类仓储全部22个读取入口覆盖：session6、report7、material-consumption7、labor2。其中15个SELECT和7个RETURNING均只改返回列。所有11条INSERT/UPDATE语句在去掉本次返回列投影后与父逐字相等；写入列、参数、更新表达式、WHERE、排序/分页和授权路径不变。ISO业务及审计时间仍由原字节的iso()/isoOrNull()处理。ReportOutput整段及来源查询、订单回写、master-data查找与仓储组合尾部完整保留。

## 保护证明

- 原 `tests/pr08/intent-api.pg.spec.ts` 完整19496字节不变，SHA256 `ec8b5fcb42042bb5e0fb74ed5a3e2c9cbbe45dd2cd1cfe3180c5994073d46e97`。7场景、名称、所有断言、日期期望、时间fixture、账号/仓库种子完全未动。
- PR2R1/PR3R2夹具、本累计inventory-posting及原25源/测文件均与父相同。
- 1119个已物化父文件只有本次授权产品文件变化，其余1118相同；补丁路径检查同时约束新增测试与作者证据。这不是全仓重审或完整安装声明。
- process TZ、全局pg解析器、schema、历史迁移、冻结合同、角色权限未改。
- 原5/2日志、旧R0/R1作者和主控证据保持原字节。旧非空数据库未使用。

## 新增21个有界回归与实际执行

`tests/pr08/execution-date.unit.spec.ts` 含4类仓储×5个显式偏移/日期夹具，共20个检查，另加material-consumption nullable DATE的1个检查；覆盖全部22个读取/RETURNING方法。偏移包括UTC、+08、+09、+14、-10，含跨年和闰日。每次同时核对业务/审计时间戳ISO、原始driver Date未被修改，以及原有数量/归属字段。

本环境缺项目TypeScript/Vitest依赖。为执行同一份回归正文，`author-r2-run-date-checks.mjs` 使用Node24.22.1原生TS转换，仅将测试注册import从Vitest换成node:test，并将仓储import指向同一真实产品源码的转换结果。**测试正文和断言未改，SQL客户端明确为替身。最终实际21PASS/0FAIL/0skip，退出0；不称Vitest或真实PG通过。** 产品和测试输入SHA、转换结果SHA、完整TAP原文均有记录。

运行进程观察到 `Asia/Tokyo`，从未设置或修改TZ。五个偏移是显式Date构造夹具，不冒称启动了五种真实OS时区/pg环境。SQL本身尚待主控真实PG补验。

冻结前为新测试分页辅助函数补充明确的total属性存在检查，之后同21个用例及字节检查重新绑定最终测试。前一次本地成功日志保留，但有效唯一仍21，绝不累计成42；这不是一次实际TypeScript报错修复，也不宣称编译器运行过。

## 类型与真实PG边界

- 当前有界本地回归：21/21 PASS，SQL-client doubles / Node runner。
- 当前字节/范围/写入保护检查：PASS，退出0。
- persistence完整类型：**NOT_RUN**，缺tsc/项目依赖，编译器未启动，exitCode=null。
- full-test-source完整类型：**NOT_RUN**，同上；旧R1完整类型PASS保留为历史，不能替代新增spec及修改仓储的当前类型证明。
- 项目Vitest入口：**NOT_RUN**，缺项目依赖。
- 两原失败HTTP+PG补验：**NOT_RUN**，业务执行0、runtimeSkip0、runner未调用、数据库创建0；无专属PG连接/本地PG工具。

实际命令、UTC时间、退出码及原始日志哈希见 `author-r2-checks.json`。没有以语法检查或SQL替身结果替代真实HTTP/数据库接受。

## 影响与复用

新变化仅在上述DATE返回值，原写入与权限行为未改变。原5个有效HTTP场景的测试/夹具输入、响应丢失/重放和归属处理不变；原34本地测试不读取此仓储DATE映射。C2/C7库存ledger/质量路径与全部测试输入未变，ReportOutput来源查询整段也未变。按主控有界计划，5有效R1、34本地及另129+40累计PG回归保留复用，不机械全套重跑。

修改了persistence读取实现，故其旧类型证据不能直接复用；application源码未变。新增21个映射检查和两原失败HTTPcase承担当前读边界验证，不用新唯一计数覆盖旧失败历史。

## 主控补验命令

在准确父应用本增量、核对全部后像和27路径fingerprint后，完整依赖环境执行：

```sh
node node_modules/typescript/bin/tsc -p packages/persistence/tsconfig.json --noEmit
node node_modules/typescript/bin/tsc -p tests/pr08/tsconfig.full.json --noEmit
node node_modules/vitest/vitest.mjs run --config tests/pr08/vitest.config.ts tests/pr08/execution-date.unit.spec.ts --reporter=verbose
```

再以另一个全新独占空 `cadenza_pr08_*` 库的 `CADENZA_PR08_TEST_DB_URL`，只补两原失败case：

```sh
node node_modules/vitest/vitest.mjs run --config tests/pr08/vitest.config.ts tests/pr08/intent-api.pg.spec.ts --testNamePattern 'factory [01]: dropped committed feed response / reload / second operation / trusted sales / calendar' --reporter=verbose
```

名称过滤未选中的5项不冒称runtime skip。保留原失败库及5/2日志；不设置TZ=UTC，不改日期期望。

本R2不代表PR8已接受；全批仍13/15 ACCEPT。PR9R1按原父 `9d261c274291e4aa17c31200e84572f81acf2e63` 独立继续，不重制旧总包或重做其余13个已接受PR。
