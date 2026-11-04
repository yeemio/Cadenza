# PR06 R1 — 仅过期预留夹具时间修正

状态：**夹具源码完成；改动后的测试类型 PASS；真实目标 PG NOT_RUN；主控验收待定。**

## 准确绑定

- 原 PR6 / `codex/fix-06-reverse-stock-lifecycle`。
- 唯一准确父 head：`6d16bb040599e35013abaf9eed098e20a0ff7273`。
- 原 parent：`e48b2e78f27785f49016f2c0f0e86847267e6ff5`；主控真实合入接受的 PR2 后累计 parent：`41311cf63cf531d44cc2fa367d3600e3c5953767`。
- R0受测源/测：`13add18e9c73c112c5648335d80be304d97ffa5f`；R0 fingerprint：`a8dce41bb20dcb880516cce6e6c275287562c8c019e17cacf39065cfc2d63c93`。
- 已接受 PR2 `0df991eac99a61132e50c10d8931d3532945dab2` 已在父候选中，其 R1测试夹具 SHA256 `a3837bda73906e216c31c04ecb2912da98ef31afb1a0749fc5d76069bad1f0b1` 原样保留。
- R1源/测 fingerprint：`bd4094ff51a0df984adcf0d0b2a1b938c8604ca4faf0b8a04e45f1f170922bad`。集合仍为原8路径（4产品源码+4测试/配置），其中7路径未变；本轮未创建Git提交。

## 失败与唯一修正

主控 R0真实新PG为14 PASS / 1 FAIL / 0 skip。唯一失败 `final reservation-expired mismatch leaves every business table unchanged` 在夹具 UPDATE 阶段触发 SQLSTATE23514：只把 `valid_until` 改到过去，却保留更晚的刚创建 `acquired_at`，违反原 `reservation_valid_until_ck CHECK(valid_until > acquired_at)`；该场景尚未进入业务过期拒绝断言。

仅将 `tests/pr06/lifecycle.pg.spec.ts` 原第144行的 SQL 字面量改为同时设置：

```sql
acquired_at = statement_timestamp() - interval '2 seconds',
valid_until = statement_timestamp() - interval '1 second'
```

两个表达式使用同一条SQL语句的时间 t，因此 `acquired_at=t-2秒 < valid_until=t-1秒 < t`：预留确已过期，且原CHECK仍合法。未增加等待；未改schema、产品、权限、冻结合同、PR2或其它PR。

## 保留证明

机械校验 `after == before.replace(oldSql,newSql)`，且替换位置唯一。该 SQL 字面量之外的全部测试字节不变，场景名称与注册表达式不变；静态枚举仍15场景，26个 expect 调用及其外层断言文本逐字节相同。未增加 skip/only/todo。

6项 mismatch 共用一个回调，故不声称包含修改分支的整个共享回调文本未变；准确边界是：只有 `reservation-expired` 条件分支内的 SQL 字面量变化，其余5个 mismatch 分支、共同断言与所有其它场景源码未变。

R0自有17后像中的其余16个均精确保留；7个未变源/测、已接受PR2夹具、共享inventory-posting、对象授权实现和canonical0004迁移均与准确父树一致。全部旧作者/主控证据不在增量改动路径内。

原完整PG失败日志已实际读取，并复算 **474,270字节 / SHA256 `e12ba1425fca2c124bb0afa6fed7fab972d2730cd2bc37fda5d153da2dac4f8b`**，Git blob与准确父树一致。原14/1/0、5custody/11拒绝/1并发退货观察和失败数据库名称保留；未删除或改写失败原件，未访问原库。

## 实际验证与复用边界

- 新执行 `node node_modules/typescript/bin/tsc -p tests/pr06/tsconfig.json --noEmit`：**PASS，退出0**。原始stdout/stderr为空日志，命令、时间、退出码和受测文件SHA在JSON receipt中。
- 静态保留检查：PASS；仅证明源码差集、注册和断言未弱化，不计业务PASS。
- 真实PR06目标PG：**NOT_RUN**。本环境无专属URL或postgres/psql/docker；未调用runner，没有业务执行或实际runtime skip。
- R0有效14个真实PG场景、累计C2的129 PASS及123实际查询，按未变产品和执行分支保留，供主控精确绑定复用；本轮不重跑、不计成新执行。
- 11条规则单测及未变application/persistence类型证据复用；变化test-source类型单独新执行。

## 主控仅补验一个目标

在另一个全新空 `cadenza_pr06_*` 库设置 `CADENZA_PR06_TEST_DB_URL` 后，按同一源码运行：

```sh
node node_modules/vitest/vitest.mjs run --config tests/pr06/vitest.config.ts tests/pr06/lifecycle.pg.spec.ts -t 'final reservation-expired mismatch leaves every business table unchanged' --reporter=verbose
```

保留原15个注册；其余14个名称过滤排除不称为runtime skip，不把过滤汇总改写为14个新执行。只有主控真实目标通过后，才可将1个新证明与14个有效旧场景组合为完整15覆盖。

交付包包含完整增量patch、4个完整后像、POSTIMAGES.sha256与DELIVERY-MANIFEST.json。只在准确父 `6d16bb040599e35013abaf9eed098e20a0ff7273` 上应用；不重放R0/PR2前置，不使用R0失败非空库。PR6尚未接受；全批仍6/15接受（#1、#2、#3、#4、#5、#14）。
