# material-master 模拟适配器（IF-01）

`route_key=material_master`。提供 `normalizeU9SimMaterial` / `normalizeSapSimMaterial`，
将模拟上游字段别名规范为 `POST /integrations/material-master/sync` 命令载荷。

**不连接真实 SAP/U9。** GAP-B9（删除/停用、增量/全量）不在本适配器范围。
