# org —— 组织与权限域（骨架占位）

职责（对齐 DOMAIN_MODEL §2 / §3.1 与 SYSTEM_ARCHITECTURE §8，规则等 L2 冻结合同后实现）：

- 组织树：enterprise → legal_entity → plant → department/work_center；机构编码全局唯一；parent 无环；业务表冗余组织快照，组织变更不回写历史。
- 用户、角色、岗位操作许可与企业/工厂/车间数据范围（scope_grant）；一切业务命令、查询、导出、后台任务服务端核权。
- 外部主数据去重五元组：source_system + organization_code + object_type + external_id + line_no。

边界：本目录为纯业务规则，只依赖 `@cadenza/contracts`；禁止依赖 application/persistence/integrations/ui/apps（eslint no-restricted-imports 强制）。
