# inventory —— 库存记账内核（骨架占位）

职责（对齐 DOMAIN_MODEL §4.2 / §5 / §6，规则等 L2 冻结合同后实现）：

- 数量十进制定点：接口十进制字符串（DecimalString，scale 4），同存 uom + measurement_basis + conversion_revision；禁全局固定换算。
- 库存余额/可用性在主事务内更新（唯一约束 + 预期版本 + 行锁）；预留、隔离、任务占用独立记录；长作业用带有效期的作业预留。
- 库存流水幂等（command_receipt + line_no）；同码多任务消费唯一约束拦截；库存域唯一维护数量/库位/所有权/预留，其它域经库存命令进同一 UoW。

边界：只依赖 `@cadenza/contracts`。
