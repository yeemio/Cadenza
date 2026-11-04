# PR08 R1 — 部门、仓库与库位夹具增量

状态：**本次授权的仓库/部门/库位修正已完成；完整增量可应用。新增发现的既有登录名夹具约束阻塞尚待主控具名裁定；变化测试类型及真实HTTP+PG7均NOT_RUN。PR8未接受。**

## 精确父与前置

- 父head：`63eb1d7d508ff3028be725e1bbcf7b1294881665`；原PR8分支 `codex/fix-08-operator-intent-calendar`。
- 父受测source：`27ceba11cc058a655aa2b57b5ab3e9704f931da1`。
- 父25路径fingerprint：`5eb3e7f69f3b0cfda8b143858af022eb0f8354774dcee93cc918fe4a4c229798`。
- R1同25路径fingerprint：`df54f1cbe1aff0a4fa3189a6423f8774ddd3a932a0ce563a030462e110cfa646`，24路径字节未变。
- 已接受PR3 final `2b78fc41c4bb71a1da9f4c418f52500a323684da` 及其PR2前置已包含。精确保留PR2R1、PR3R2测试夹具和当前累计inventory-posting的R2引用修复，不重新应用依赖或旧总包。

## 已完成的具名修正

唯一源码改动：`tests/pr08/intent-api.pg.spec.ts`。

| 真实种子工厂 | 部门 | 线边仓 / 类型 | 成品仓 / 类型 | NORMAL库位 |
|---|---|---|---|---|
| PLNT-SZ | DEPT-SZ-JZ | 8100 / [2,3] | 8101 / [3] | 81000001 |
| PLNT-HF | DEPT-HF-JZ | 8102 / [2,3] | 8103 / [3] | 81020001 |

部门查询限定kind、parent_kind、同厂parent_id和同enterprise_id。仓库INSERT同时写入此deptId及非空integer[] material_types；线边仓承接夹具已有类型2和3物料，成品仓接收类型3。原仓库名称保留，不再把名称当编码。NORMAL库位使用4位实际仓库码加0001，RACK010101夹具和所有入库目标引用原样保留。

新增Factory.locationCode，并同步三处现有夹具引用：

1. receive-goods载荷locationCode。
2. report_output.target_location_code参数；后续owner/stock参数同步顺延，值和归属不变。
3. 两厂feed/calendar场景内报工HTTP载荷的targetLocationCode。

第3项确实改变了describe正文中的一个源码位置，故**不声明业务正文全部逐字节不变**。只将这一fixture引用从P08-LINE换成f.locationCode后，其他完整describe字节与父一致。全部7场景的名称/注册方式和全部断言保持原字节；真实Nest/Auth/HTTP、提交后丢响应、存储重载和重放路径均保留。没有产品、schema、权限、迁移、冻结合同、PR2/PR3或其他PR代码变化。

## 新发现的确定阻塞：既有login夹具（未越权改写）

原beforeAll仍生成 `pr08-sz`、`pr08-hf`。准确父 `packages/persistence/src/migrations/0002-org-auth.ts` 中：

```sql
CONSTRAINT user_account_login_charset_ck CHECK (login_name ~ '^[A-Za-z0-9]+$')
```

两个值都不满足该约束，user_account INSERT又早于warehouse INSERT。本轮未实际运行PG；这是准确父schema和实际fixture生成值的静态确定证据，不冒称新的运行时23514日志。后续迁移没有解除该约束。

当前明确合同只授权部门、仓库、库位及相应引用，未包含登录名生成行。该行原样保留，新增证据 `author-r1-scope-finding.json` 将根因和最小后续差集交主控裁定。最小修正只需把 `pr08-${code.toLowerCase()}` 改成 `pr08${code.toLowerCase()}`；f.login现已贯穿登录、ctx和owner引用，无需更换Auth流程或放宽schema。**不建议先创建新库运行这个已知会被login约束阻断的候选。** 本轮源码不包含此未获本次具名授权的行改动。

## 实际检查与证据复用

- 字节保留/实际夹具编码表达式/种子组织和canonical约束核对：退出0。完整文件等于7处具名文本替换；检查脚本和完整原始输出均附在本目录。4个仓库码互异且4位数字，2个NORMAL库位码互异且8位数字并以前述线边仓码开头。该本地检查不计业务PASS。
- Node24.22.1原生TS语法转换及 `node --check`：退出0。仅证明语法，未执行模块导入/Nest/HTTP/PG，不称完整类型或build通过。
- 完整test-source类型：**NOT_RUN_MISSING_PROJECT_DEPENDENCIES**。旧共享TypeScript/Vitest/Nest缓存入口和主runtime的tsc不存在，PATH也没有tsc；编译器未启动，exitCode=null。未伪造声明或以语法替代类型。
- 真实HTTP+PG7：**NOT_RUN，runner未调用，业务执行0、实际runtimeSkip0、创建数据库0**。没有专属连接/本地PG，也保留了上述未解决login约束证据。
- 原26规则/日历+8jsdom组件共34本地有效证据精确复用，均未重跑。原application/persistence类型复用；原full-test-source类型因测试改变不得冒充R1的新类型结果。
- 原C2真实129和PR3真实40（合计169）属于未变累计产品回归，按父receipt复用；不算新执行，也不算PR8自有7HTTP+PG。
- R0静态检查、全部旧作者/主控日志、失败记录、数据库/媒体均未改动或访问。机械校验1100个本地物化父文件中，仅此1个测试源码变化；其余1099一致。这是精确绑定/保留检查，不是重新全仓审查或完整安装证明。

## 主控后续

先裁定新增login夹具根因，由本Chat同一作者给出精确绑定的最小后续增量。解决后，在完整依赖环境补：

```sh
node node_modules/typescript/bin/tsc -p tests/pr08/tsconfig.full.json --noEmit
node node_modules/vitest/vitest.mjs run --config tests/pr08/vitest.config.ts tests/pr08/intent-api.pg.spec.ts --reporter=verbose
```

PG只使用另一个任务专属全新空 `cadenza_pr08_*` 库，通过 `CADENZA_PR08_TEST_DB_URL` 指定；既有空库守卫和全部7业务断言保留。无真实浏览器/物理PDA/现场日历配置接受外推。

最新主控通知13/15接受，PR7已闭合；仅PR8、PR9剩余。PR9R1仍按独立准确父另行完成，不重做已接受PR或原总包。
