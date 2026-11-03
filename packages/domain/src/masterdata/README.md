# masterdata —— 工厂主数据域（骨架占位）

职责（对齐 DOMAIN_MODEL §2，规则等 L2 冻结合同后实现）：

- 料品（U9/ERP 同步写入，换算行版本化 conversion_revision，被收货引用即 immutable）。
- 设备、工作中心、仓库/库位/货架、组织对照与工作中心对照；唯一键按文档口径（设备/工作中心编码全局唯一；仓库/库位/货架按 (plant, code)）。
- 主数据引用保护：FK RESTRICT + active/retired 状态列；被库存余额或流水引用拒退役；逻辑删除用状态列 + partial unique index，不物理删行。

边界：只依赖 `@cadenza/contracts`。
