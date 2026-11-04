# PR8 controller R1 — REWORK

Account Fix 完整增量绑定父63eb1d7，17后像/25源测fingerprint一致；合法部门/库位/账号修正及必要引用符合授权，全部7场景和断言保留，产品和接受前置未变。完整测试源码类型新PASS。

全新cadenza_pr08_intent_r1_20261104真实HTTP+PG：5 PASS / 2 FAIL / 0 SKIP。投料已提交响应丢弃/重载幂等、可信订单第二工序、库存和排程日期检查已通过；两厂均在最后报工详情GET的shiftDate失败，分别预期11-03/11-04而收到11-02/11-03。其余5个完整业务场景有效，不冒充两失败场景通过。

同库只读因果探针证实：PostgreSQL DATE文本实际正确，OID1082被真实pg解析为本地午夜Date；Asia/Shanghai转UTC ISO后前移一天。执行仓储原dateStr函数体复现错误，调用点mapReport/GET确定。没有改库、改TZ或重跑入口。controller-r1-date-cause.json含原始值和源码SHA。

同作者窄R2应修packages/persistence/src/execution-repositories.ts的DATE读取/映射语义及必要有界回归，不改业务日期预期、fixture时间、时区配置、历史schema/迁移或ISO时间戳合同。R1原5/2和原R0静态NOT_RUN均保留。原34本地和169共享PG证据输入未变，可复用；R2按影响补证明。
