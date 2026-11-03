-- 演示环境引导（仅 --with-demo 使用；生产安装默认不含演示数据，DO-03）
-- 幂等：NOT EXISTS 守卫。依赖 db:seed 的组织种子（华东电缆集团/苏州线缆厂/物流部）。
INSERT INTO uom (code, name, is_custom, status, created_by)
SELECT 'KG', '千克', false, 'active', '演示引导'
WHERE NOT EXISTS (SELECT 1 FROM uom WHERE code='KG' AND NOT is_custom AND status='active');

INSERT INTO warehouse (enterprise_id, plant_id, dept_id, code, name, warehouse_type, material_types, status, created_by)
SELECT e.id, p.id, d.id, '0101', '演示原料仓', 'WAREHOUSE', '{1,2,3}', 'active', '演示引导'
FROM org_node e, org_node p, org_node d
WHERE e.code='ENT-HD' AND e.kind='enterprise'
  AND p.code='PLNT-SZ' AND p.kind='plant'
  AND d.code='DEPT-SZ-WL' AND d.kind='department'
  AND NOT EXISTS (SELECT 1 FROM warehouse WHERE code='0101' AND status='active');

INSERT INTO storage_location (enterprise_id, plant_id, warehouse_id, rack_id, location_kind, code, zone_code, status, created_by)
SELECT e.id, p.id, w.id, NULL, 'NORMAL', '01010001', NULL, 'active', '演示引导'
FROM org_node e, org_node p, warehouse w
WHERE e.code='ENT-HD' AND e.kind='enterprise'
  AND p.code='PLNT-SZ' AND p.kind='plant'
  AND w.code='0101' AND w.status='active'
  AND NOT EXISTS (SELECT 1 FROM storage_location WHERE code='01010001' AND status='active');

INSERT INTO storage_location (enterprise_id, plant_id, warehouse_id, rack_id, location_kind, code, zone_code, status, created_by)
SELECT e.id, p.id, w.id, NULL, 'NORMAL', '01010002', NULL, 'active', '演示引导'
FROM org_node e, org_node p, warehouse w
WHERE e.code='ENT-HD' AND e.kind='enterprise'
  AND p.code='PLNT-SZ' AND p.kind='plant'
  AND w.code='0101' AND w.status='active'
  AND NOT EXISTS (SELECT 1 FROM storage_location WHERE code='01010002' AND status='active');
