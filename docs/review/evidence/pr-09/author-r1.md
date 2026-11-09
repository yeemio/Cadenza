# PR09 R1 — foreign 仓库与库位夹具修正

**稳定源码增量已就绪；变化测试完整类型及 16 项真实 PG 均 NOT_RUN，等待原总控验证。**

## 候选绑定

- 原 PR9 / 分支：codex/fix-09-group-kitting。
- 唯一准确父：9d261c274291e4aa17c31200e84572f81acf2e63。
- 父受测源/测：a198d13b3aab72e32bd78f0a11760803c5134c14。
- 父 8 路径 fingerprint：3669c18adb85a2b62ab714474f3de9fc1cf809640d6c34add62d683973d00eba。
- 当前同 8 路径 fingerprint：30533aac3558acea38fda9c862e574334c7c1c53e594f28c1a64b37aa4812c7a。
- 唯一变化源码：tests/pr09/kitting.pg.spec.ts。
- 测试完整后像：13319 字节，SHA256 a304980932f96cd0acff1d65592111de8a21a2ae0eb643d0236477d8c1abd622。
- 已接受 PR3 final 2b78fc41c4bb71a1da9f4c418f52500a323684da 及其 PR2 前置已在准确父内，无需再次合入。

## 四处具名夹具变更

1. 定义仓库码 9309 与派生 NORMAL 库位码 93090001，分别符合现有四位、八位数字规则；NORMAL 保留仓库码前缀。
2. stock() 的 foreign 分支引用同一 LOC_B_CODE。原库位 UUID、同厂分支、真实入库命令、actor 与重放断言保持原样。
3. 查询真实种子 DEPT-HF-JZ，同时绑定 department/plant 类型、parent_id=plantB 和 enterprise_id=fx.enterpriseId；向仓库 INSERT 补 dept_id、合法 code 和 material_types=ARRAY[1]。foreign 库存组件原 material_type 为 1；仓库名称 P09-B 保留。
4. foreign NORMAL 库位 INSERT 使用同一合法派生编码，仍绑定原企业、HF 工厂与新仓库。

以上四处替换能够从准确父逐字节重建完整测试后像。全部业务 describe 的 5864 字节完整一致，SHA256 6717a9b2a1e60364092a42b647af641832c7b85fc35e5c10c7b0d2444f511335。13 个普通 it 加一个三行 it.each，合计 16 个原场景，注册、名称、所有断言和 afterAll 均不变。

产品、迁移、冻结合同、权限、真实 command bus、BOM/库存/换算数学口径不变。没有直写最终结果代替业务路径。其余 7 个源/测文件、已接受 PR2/PR3 夹具及 inventory-posting 均与准确父一致；本地已读取的其余 1091 个父文件逐字节保留。

## 实际验证

| 检查 | 本轮结果 | 边界 |
|---|---|---|
| 四处替换与完整文件等式、16 注册和全部断言保留 | PASS，exit 0 | 静态字节/结构证明 |
| 实际编码常量表达式求值 | PASS，exit 0 | Node 得到 9309 / 93090001；无 SQL 执行 |
| Node v24.22.1 原生 TS 转换及 node --check | PASS，exit 0 | 仅语法；ExperimentalWarning 原样保留，不是语义类型或业务 PASS |
| 变化测试完整 TypeScript 检查 | NOT_RUN | 项目 TypeScript/Vitest 依赖缺失；compilerInvoked=false，exitCode=null |
| 16 项实际 PostgreSQL 业务场景 | NOT_RUN | 无专属 PR09 连接；runner 调用 0、业务执行 0、runtimeSkip 0、新库创建 0 |

实际命令、cwd、UTC 起止、退出码和日志 SHA 见 author-r1-checks.json；静态检查源码和完整输出随本增量提供。未猜测连接、访问旧库或将语法/替身计为 PG。

父 receipt 已确认的 28 项计算单测、application/persistence 类型按相同输入与日志 SHA 精确复用，本轮没有重跑。旧 test-source 类型证据原样保留，但不覆盖变化 PG 测试；新类型证明仍待主控补验。R0 是已知静态初始化阻塞，PG 原本 0 执行、0 runtimeSkip，没有把它改写为实际失败或通过。

父目录内 16 份旧作者/主控证据逐字节保留。PR8 R2 的冻结包与源码未纳入此增量；没有重制总包或重做已接受 PR。

## 主控补验入口

在准确父应用完整增量并核对后像、8 路径 fingerprint 后执行：

```sh
node node_modules/typescript/bin/tsc -p tests/pr09/tsconfig.json --noEmit
node node_modules/vitest/vitest.mjs run --config tests/pr09/vitest.config.ts tests/pr09/kitting.pg.spec.ts --reporter=verbose
```

PG 仅使用通过 CADENZA_PR09_TEST_DB_URL 指定的另一个全新独占空 cadenza_pr09_* 库；保留原拒绝非空数据库入口。主控承担真实 16 项验证及原 PR 发布/接受；本交付不宣称工程 ACCEPT。
