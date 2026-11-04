# PR07 R2 — 两处真实PG夹具初始化窄修

状态：**夹具源码完成；字节保留/编码检查PASS；变化测试完整类型NOT_RUN（缺TypeScript依赖）；真实PG20 NOT_RUN；主控验收待定。**

## 精确绑定

- 唯一父head：`e3c1c2d2af1c206be6abd66ee6c39a248df6ec0c`。
- 父受测源/测：`fa0aa1df78e9d1aa8d369f6be182ebb25300ce77`；原11路径fingerprint：`f42b4823ce3fe2768bcd9f73e4f490955abf42b8451ce6355eff3d88bd772177`。
- R2同11路径fingerprint：`9b538d2eb60dc7f4f750b616109d0bdfdfcd27876c07cef23f4cceae15a5fc55`；其中10路径未变。
- 已接受PR2 `0df991eac99a61132e50c10d8931d3532945dab2` 已包含；其R1测试夹具SHA256 `a3837bda73906e216c31c04ecb2912da98ef31afb1a0749fc5d76069bad1f0b1` 与准确父Git blob一致并原样保留。不重放前置。

## 仅修fixture generation

`tests/pr07/confirmation.pg.spec.ts` 新增两个仅供夹具使用的递增序号：

- plants() 给每个新工厂填写 `P07 + 7位数字` 的plant_code（10字符），通过新增第4个参数写入。既有parent_id、parent_kind、path、depth、enterprise_id来源和R1祖先关联修复均保留。9个worker场景所需18个工厂码互不相同。
- completedConversion() 将非法P07-UUID改为 `PE + 8位数字`，11次初始化互不相同。每个码10字符、第二字符E，符合现有FC-07。原unitNo变量继续供receive-goods的unitNo/lotNo与scan使用，无需改动业务测试体内引用。

原真实receive→归属fixture→create→scan→complete→sync-retry流程不变，不直接seed最终转换状态，不放宽FC-07。没有产品、授权、schema、迁移或冻结合同变化。

## 保留证明与真实旧失败

机械证明完整文件仅有JSON中列出的6个准确文本替换；除此之外全部字节一致。两段describe共 **6507字节**完整不变，beforeAll/afterAll及全部场景、注册、名称和断言不变。父主控实跑已注册20个，本轮保持这20个，没有删除、改名、skip或改替身。

主控上一轮实际PG0PASS/20FAIL/0skip，9个plant_code约束失败、11个FC-07初始化失败，目标语义均未到达。原失败日志已读取并复算 **37,103字节，SHA256 `d03867eba8ca3711829fe42b18d80689edca82b27e97bfbafb151ffba23aa45a`**，与准确父Git blob一致。原失败数据库和全部旧作者/主控证据均保留，作者未访问或重跑非空库。

## 本轮检查的准确边界

- 本地字节保留和夹具表达式检查：退出0。实际求值18个plant_code并核对1..10长度/唯一性；实际求值11个carrier码并调用本候选未修改的FC-07纯函数与断言，全部接受。这不是18/11个真实PG场景。
- Node内置类型擦除及node --check：退出0，仅语法检查，不称TypeScript完整类型或build PASS。
- `node node_modules/typescript/bin/tsc -p tests/pr07/tsconfig.json --noEmit`：两次启动实际退出1，找不到TypeScript入口，编译器未执行，完整类型标为 **NOT_RUN_MISSING_TYPESCRIPT_DEPENDENCY**。原来共享缓存目标现已不存在，未伪造类型声明或安装证明。
- 同期验证脚本的依赖启动失败，以及其后额外括号/JS替换字符串处理错误的原始输出也保留。纠正的是验证脚本，PG候选源码SHA一直为 `9270c764520a05abfef1138168ae3a78bf1560f7ff8f0a22e70202a960a783f8`；最终本地检查退出0。
- 未变20规则单测及worker/application/persistence类型证据按主控准确hash复用，本轮未重跑、不计新执行。
- 真实PG：**NOT_RUN，runner未调用，业务执行0、实际runtime skip0**。无专属连接、无本地PG工具，未猜连接或访问旧库。

## 主控补验

在具备完整项目依赖的R2工作区先补变化测试类型：

```sh
node node_modules/typescript/bin/tsc -p tests/pr07/tsconfig.json --noEmit
```

设置另一个全新空 `cadenza_pr07_*` 库的 `CADENZA_PR07_TEST_DB_URL`，再执行完整20个缺失业务场景：

```sh
node node_modules/vitest/vitest.mjs run --config tests/pr07/vitest.config.ts tests/pr07/confirmation.pg.spec.ts --reporter=verbose
```

真实worker锁/异厂隔离/并发/重试/UNKNOWN与转换确认业务接受只能来自这次真实PG。合法码的纯函数检查不替代它；外部U9/SAP等调用仍未发生。

PR7尚未接受；全批按最新主控通知10/15接受（1、2、3、4、5、6、10、11、13、14）。PR6闭合，PR12/PR15冻结包不重发；PR8/PR9后续分别交付。
