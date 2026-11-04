# PR08 R1 Account Fix — 当前稳定完整增量

**当前有效候选：Cadenza-PR08-R1-Account-Fix。仓库、部门、库位及合成账号夹具修正完成；真实HTTP+PG7与变化测试完整类型NOT_RUN；等待主控工程验收。**

本文件和 `author-r1-account-fix.json` 是当前交付说明。`author-r1.json/.md` 与其检查输出原样保留，记录新增账号授权到达之前的已冻结仓库/库位版；其中的“账号尚待裁定”是历史状态，已被本次主控裁定及新候选取代，不能作为当前源码的验证记录。

## 准确父与候选身份

- 原PR8分支：`codex/fix-08-operator-intent-calendar`。
- 唯一准确父：`63eb1d7d508ff3028be725e1bbcf7b1294881665`。
- 父受测源/测：`27ceba11cc058a655aa2b57b5ab3e9704f931da1`。
- 父25路径fingerprint：`5eb3e7f69f3b0cfda8b143858af022eb0f8354774dcee93cc918fe4a4c229798`。
- 当前同25路径fingerprint：`f10dab06df342ecfe8eb64778b2bfabe8245208f44ea0d4dc5b4edac621a98f3`。
- 测试后像SHA256：`ec8b5fcb42042bb5e0fb74ed5a3e2c9cbbe45dd2cd1cfe3180c5994073d46e97`，19496字节。
- 已接受PR3 final `2b78fc41c4bb71a1da9f4c418f52500a323684da` 及其PR2前置已在准确父中，不另行带入或重放。

先前仓库/库位版已经冻结，原件原样保留：ZIP `Cadenza-PR08-R1.zip` / SHA256 `06a7f84e7156e4ecc44b823dfd3c1f87078df581af1d24a0a41c8e491244de79`；完整patch SHA256 `b8fe8d1e5177466dbd925b42d0246891e96bfea21c63548b1376c8815446be19`。该版尚未正式附件交付/上传，账号裁定到达后没有覆盖、改名或假称同一字节。

**当前提供另一份明确命名的完整补丁，直接应用在同一父63eb1d7上。不要先应用旧仓库版，再应用此完整补丁。**

## 唯一源码文件与8处具名替换

`tests/pr08/intent-api.pg.spec.ts` 是唯一变化源码。原7处仓库/部门/库位替换保持原样，再加本次明确授权的一处登录名表达式：

```diff
-    const login=`pr08-${code.toLowerCase()}`
+    const login=`pr08${code.toLowerCase()}`
```

实际生成 `pr08sz`、`pr08hf`，两者互异、与真实种子账号不同且满足现有字母数字约束。所有原login/f.login引用已贯穿独立账号INSERT、真实密码哈希与Auth登录、command ctx、operator/owner，故无需附加引用改写。角色、权限集合、工厂、部门和密码流程均保留；schema和认证规则不变。

| 工厂 | 真实种子部门 | 线边仓 / material_types | 成品仓 / material_types | NORMAL库位 | 独立账号 |
|---|---|---|---|---|---|
| SZ | DEPT-SZ-JZ | 8100 / [2,3] | 8101 / [3] | 81000001 | pr08sz |
| HF | DEPT-HF-JZ | 8102 / [2,3] | 8103 / [3] | 81020001 | pr08hf |

部门查询绑定同plant/enterprise，仓库补必填dept_id和material_types，原仓库名称保留。RACK010101和原入库目标不变。三处同步库位引用为receive-goods载荷、report_output夹具SQL参数、两厂feed/calendar场景内报工HTTP载荷。

报工HTTP载荷的纯库位值引用是describe正文中唯一变化位置；除该位置外，完整describe字节一致。全部7个场景的注册方式、名称和全部断言逐字节保留；真实Nest/Auth/HTTP、提交后丢响应、重载/重放流程不变。未修改产品、迁移、冻结合同、PR2/PR3或其他PR。

## 实际验证与准确边界

| 检查 | 本轮结果 | 说明 |
|---|---|---|
| 8处具名文本替换及全文件等式 | PASS，exit0 | 除所列8处外，原测试完整文件无差异 |
| 场景/断言保留 | PASS，exit0 | 7注册不变；全部断言不变；正文仅1处允许的库位引用 |
| 实际夹具表达式求值 | PASS，exit0 | 4个合法仓库码、2个合法NORMAL码；2个独立合法账号；不计业务场景PASS |
| Node原生TS语法转换及node --check | PASS，exit0 | 仅语法，未运行依赖导入、Auth、HTTP或PG |
| 变化测试完整语义类型检查 | NOT_RUN | TypeScript/Vitest/Nest缓存及tsc入口缺失，编译器未调用，exitCode=null |
| 真实HTTP+PG7 | NOT_RUN | runner未调用、业务执行0、runtimeSkip0、数据库创建0 |

实际命令、cwd、UTC起止时间、退出码和日志SHA见 `author-r1-account-fix-checks.json`。环境缺口见 `author-r1-account-fix-environment.json`，无猜测连接、替身服务或旧库重跑。

原26规则/日历+8jsdom组件共34本地有效证据，以及另属累计产品的C2 129/PR3 40真实PG（合计169）按父receipt精确复用，不重跑、不充作本轮新执行。app/persistence类型未变复用；旧full-test-source类型不得覆盖变化测试，仍需补验。

24个其余源/测文件未变，已接受PR2R1/PR3R2夹具与本累计inventory-posting引用修复保持准确父字节。所有旧R0作者/主控证据和首个冻结R1的8份作者证据都保留，不改写旧状态或失败记录。

## 主控应用后补验

先以当前完整patch的后像清单和25路径fingerprint确认候选，再在完整依赖环境执行：

```sh
node node_modules/typescript/bin/tsc -p tests/pr08/tsconfig.full.json --noEmit
node node_modules/vitest/vitest.mjs run --config tests/pr08/vitest.config.ts tests/pr08/intent-api.pg.spec.ts --reporter=verbose
```

PG只使用新的独占空 `cadenza_pr08_*` 库，连接通过 `CADENZA_PR08_TEST_DB_URL` 指定。7个实际HTTP+PG业务接受留待这次执行；没有真实浏览器、物理PDA、现场日历/安装外推。

全批按最新主控通知13/15 ACCEPT，仅PR8、PR9未闭合。PR7不重做，原总包不重制；PR9R1按自己的准确父独立接续。
