# PR12 author R1 — 原生恢复兼容性在重建前拒绝

状态：**有界产品修正源码完成；55项本地检查 PASS；测试源码类型 PASS；真实双实例/原生 PG NOT_RUN；主控验收待定。**

## 精确绑定

- 唯一父 head：`0c951347f834d82afb4d7d573222cedd91883ea7`；原 PR12 / `codex/fix-12-backup-upgrade-safety`。
- 原受测源/测：`72facaaff169486f8d80eb5bd91ce40a3a3c0ebb`。
- 原18路径 fingerprint：`94b494190d806fe2a7785f902921a14a9706ec22a0e3181584d5c861d9094ea8`。
- R1扩展20路径 fingerprint：`d93d724b55bd43111a2ac4a3468d6848dff73c1a38fad60814977bb69e39d1b3`。集合保留原18路径，增加1个产品 helper与1个专项单测；逐路径列表在JSON，不能不说明集合变化直接比较两个摘要。

## 具体修正与边界

`restore.mjs` 从实际归档的 `pg_restore --list` 头读取源服务器/归档生成器版本，并读取实际 `pg_restore --version`。完成既有 Node/native 实例绑定后，在同一管理连接执行 `SHOW server_version_num`；必须先通过兼容判断，才能执行任何终止目标会话、DROP或CREATE。

新增 `native-compatibility.mjs` 明确支持稳定PostgreSQL10+同主版本的源库、归档pg_dump、当前pg_restore、目标服务器组合；小版本可不同。未知/缺失/重复/非稳定元数据拒绝，跨主版本拒绝；缺工具或不可读归档也在重建前拒绝。兼容预检只是一项必要门槛，不替代实际恢复、迁移指纹和对账。没有过滤SQL、修改归档或信任可手改manifest中的版本声称。普通无归档pg-ops recreate既有行为保留；所有runRestore路径都提供并检查版本资料。

唯一产品改动为上述2个路径。原唯一URL、Node/native实例、media哈希、库名白名单、准确目标确认、脱敏、迁移指纹和只读升级边界保留；未改迁移、schema、冻结合同、全局配置、权限或其它PR。

官方依据：[pg_dump版本兼容边界](https://www.postgresql.org/docs/16/app-pgdump.html)、[pg_restore归档目录语义](https://www.postgresql.org/docs/18/app-pgrestore.html)。自动恢复入口采用更窄的同主版本政策，不要求任意跨版本支持。

## 原场景与实际证据

原真实PG文件 **8,481字节完整前缀** 原样保留，SHA256 `9e7a97fa5af1cc2016dad1a77b331d8b7b38ad0c850ddb32aa0928132ec6a6e2`；原10注册、名称、断言不变。原41项安全测试源码不变；原18源/测/文档中15路径未变。所有旧作者和主控证据均未改写。

主控原10个实际PG为9 PASS /1 FAIL /0skip；18.6客户端生成的 `SET transaction_timeout=0` 在16.15目标触发42704，失败前目标已被重建。原失败日志 **8,727字节 / SHA256 `30d7267f1a40709e915f040d2c96c0387899557194854c9a1acd20c1dca614c3`** 已读取并与准确父Git blob一致。A/B源保留、失败目标空表、原归档/库/日志均为主控保存的原件；作者未访问或重复初始化。

本轮实跑：

- 新14项兼容性规则/实际coordinator端口替身：14 PASS /0fail/0skip，明确不是原生PG。
- 原41项安全检查对改动后源码重新运行：41 PASS /0fail/0skip。
- 测试源码 `tsc -p tests/pr12/tsconfig.json --noEmit`：PASS，退出0；2个改动产品JS语法检查：PASS。
- 合计55本地有效唯一，不称55PG；本轮真实PG执行0、实际runtime skip0。

初次helper缺右花括号的语法/收集/类型失败、41项回归当时40pass/1fail，以及随后新PG测试CLI参数的TS2322均保留原输出。修正后上述最终检查通过；不把这些失败改写成TDD或真实PG失败。

## 新增真实拒绝证明与主控补验

追加第11个实际PG场景：`newer pg_dump/pg_restore archive refuses before target recreation`。它使用本任务新源库/已正常恢复的新目标，用较新的真实pg_dump/pg_restore生成实际归档，再调用真实restore；要求 `RESTORE_NATIVE_VERSION_MISMATCH`，且目标OID/哨兵/迁移记录before=after、A/B源标记均保留。日志 `PR12_NATIVE_PREFLIGHT` 包含实际归档SHA、四方版本和目标前后查询。

此环境没有专属双实例URL和原生工具，**整层NOT_RUN**。主控须用新的空任务A/B/restore库，普通PATH配置与服务器同主版本的原生客户端（本次16.x）；通过 `CADENZA_PR12_INCOMPATIBLE_CLIENT_BIN` 指定第二套较新工具（本次18.x），只影响新增证明子进程PATH。缺前提报NOT_RUN，不skip，不访问原失败库。

若只跑受影响证明，可选择下面3项，保留真实backup→restore→拒绝的顺序和依赖：

```sh
node node_modules/vitest/vitest.mjs run --config tests/pr12/vitest.config.ts tests/pr12/backup-upgrade.pg.spec.ts -t 'actual custom-format backup|restore binds the intended target|newer pg_dump/pg_restore archive' --reporter=verbose
```

其余8项只是名称过滤排除，不是runtime skip或新业务执行。主控可按需要跑全11项。旧9个实际通过是否复用由主控对准确候选绑定；本轮不将其算作R1新执行。E02仍UNVERIFIED；合成旧版本元数据不关闭历史样本缺口。

只应用本父head上的本次增量，不重放原R0或原13总包。PR12尚未接受；全批按最新主控回报9/15接受（1、2、3、4、5、10、11、13、14）。PR6冻结补丁和其它候选未改。
