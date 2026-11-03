-- 演练源库业务夹具（仅注入 cadenza_dops_* 演练临时库；模拟一套在运系统的最小业务数据，
-- 使三分对账有非平凡内容：库存事实链 + 接口账任务 + 隔离队列）
-- 依赖：迁移 0001–0010 + seed（组织 ENT-HD/PLNT-SZ/DEPT-SZ-WL）已就位。

INSERT INTO uom (code, name, is_custom, status, created_by)
SELECT 'KG', '千克', false, 'active', '演练夹具'
WHERE NOT EXISTS (SELECT 1 FROM uom WHERE code='KG' AND NOT is_custom AND status='active');

INSERT INTO warehouse (enterprise_id, plant_id, dept_id, code, name, warehouse_type, material_types, status, created_by)
SELECT e.id, p.id, d.id, '0101', '演练原料仓', 'WAREHOUSE', '{1,2,3}', 'active', '演练夹具'
FROM org_node e, org_node p, org_node d
WHERE e.code='ENT-HD' AND e.kind='enterprise' AND p.code='PLNT-SZ' AND p.kind='plant'
  AND d.code='DEPT-SZ-WL' AND d.kind='department'
  AND NOT EXISTS (SELECT 1 FROM warehouse WHERE code='0101' AND status='active');

INSERT INTO storage_location (enterprise_id, plant_id, warehouse_id, rack_id, location_kind, code, zone_code, status, created_by)
SELECT e.id, p.id, w.id, NULL, 'NORMAL', '01010001', NULL, 'active', '演练夹具'
FROM org_node e, org_node p, warehouse w
WHERE e.code='ENT-HD' AND e.kind='enterprise' AND p.code='PLNT-SZ' AND p.kind='plant'
  AND w.code='0101' AND w.status='active'
  AND NOT EXISTS (SELECT 1 FROM storage_location WHERE code='01010001' AND status='active');

INSERT INTO material (org_scope_id, code, name, material_type, base_uom, status, source_system, created_by)
SELECT e.id, 'MAT-DRILL-0001', '演练电缆料-铜导体', 1, 'KG', 'active', 'DRILL', '演练夹具'
FROM org_node e
WHERE e.code='ENT-HD' AND e.kind='enterprise'
  AND NOT EXISTS (SELECT 1 FROM material WHERE code='MAT-DRILL-0001' AND status='active');

INSERT INTO command_receipt (id, enterprise_id, command_type, operation_id, payload_digest, status, result)
SELECT gen_random_uuid(),
       (SELECT id::text FROM org_node WHERE code='ENT-HD' AND kind='enterprise'),
       'inventory.receive', 'DRILL-INIT-RECV-001', 'drill-fixture', 'COMMITTED', '{"status":"COMMITTED"}'::jsonb
WHERE NOT EXISTS (SELECT 1 FROM command_receipt WHERE operation_id='DRILL-INIT-RECV-001');

INSERT INTO command_receipt (id, enterprise_id, command_type, operation_id, payload_digest, status, result)
SELECT gen_random_uuid(),
       (SELECT id::text FROM org_node WHERE code='ENT-HD' AND kind='enterprise'),
       'inventory.issue', 'DRILL-INIT-ISSU-001', 'drill-fixture', 'COMMITTED', '{"status":"COMMITTED"}'::jsonb
WHERE NOT EXISTS (SELECT 1 FROM command_receipt WHERE operation_id='DRILL-INIT-ISSU-001');

INSERT INTO material_lot (lot_no, kind, material_id, material_code, plant_id, enterprise_id, note, created_by)
SELECT 'LOT-DRILL-0001', 'production', m.id, m.code, p.id, e.id, '演练夹具', '演练夹具'
FROM material m, org_node p, org_node e
WHERE m.code='MAT-DRILL-0001' AND p.code='PLNT-SZ' AND p.kind='plant' AND e.code='ENT-HD' AND e.kind='enterprise'
  AND NOT EXISTS (SELECT 1 FROM material_lot WHERE lot_no='LOT-DRILL-0001');

INSERT INTO inventory_unit (unit_no, material_id, material_code, lot_id, uom_id, uom_code, trace_mode, status, plant_id, enterprise_id, created_by)
SELECT 'UNIT-DRILL-0001', m.id, m.code, l.id, u.id, u.code, 'quantity', 'in_stock', p.id, e.id, '演练夹具'
FROM material m, material_lot l, uom u, org_node p, org_node e
WHERE m.code='MAT-DRILL-0001' AND l.lot_no='LOT-DRILL-0001' AND u.code='KG'
  AND p.code='PLNT-SZ' AND p.kind='plant' AND e.code='ENT-HD' AND e.kind='enterprise'
  AND NOT EXISTS (SELECT 1 FROM inventory_unit WHERE unit_no='UNIT-DRILL-0001');

INSERT INTO stock_balance (unit_id, location_id, location_code, owner_id, owner_name, quantity, uom_id, uom_code, measurement_basis, quality_status, plant_id, enterprise_id, created_by)
SELECT un.id, s.id, s.code, le.id, le.name, 380.0000, u.id, u.code, 'net', 'qualified', p.id, e.id, '演练夹具'
FROM inventory_unit un, storage_location s, uom u, org_node p, org_node e, org_node le
WHERE un.unit_no='UNIT-DRILL-0001' AND s.code='01010001' AND u.code='KG'
  AND p.code='PLNT-SZ' AND p.kind='plant' AND e.code='ENT-HD' AND e.kind='enterprise'
  AND le.code='LE-HDMIKE' AND le.kind='legal_entity'
  AND NOT EXISTS (SELECT 1 FROM stock_balance sb WHERE sb.unit_id=un.id);

-- 事实链：receive 500（0→500）→ issue 120（500→380），分录链条与余额终值一致
WITH recv AS (
  INSERT INTO stock_transaction (command_receipt_id, line_no, movement_kind, unit_id, lot_id, to_location_id, to_location_code, quantity, uom_id, uom_code, measurement_basis, before_qty, after_qty, ref_type, reason, business_time, shift_date, plant_id, enterprise_id, created_by)
  SELECT cr.id, 1, 'receive', un.id, l.id, s.id, s.code, 500.0000, u.id, u.code, 'net', 0.0000, 500.0000, 'drill_fixture', '期初演练收货', now() - interval '2 hour', current_date, p.id, e.id, '演练夹具'
  FROM command_receipt cr, inventory_unit un, material_lot l, storage_location s, uom u, org_node p, org_node e
  WHERE cr.operation_id='DRILL-INIT-RECV-001' AND un.unit_no='UNIT-DRILL-0001' AND l.lot_no='LOT-DRILL-0001'
    AND s.code='01010001' AND u.code='KG' AND p.code='PLNT-SZ' AND p.kind='plant' AND e.code='ENT-HD' AND e.kind='enterprise'
  RETURNING id, unit_id, lot_id, to_location_id, to_location_code, quantity, plant_id, enterprise_id
)
INSERT INTO stock_entry (transaction_id, entry_no, balance_id, unit_id, location_id, location_code, owner_id, owner_name, lot_id, quantity_delta, before_qty, after_qty, purpose, plant_id, enterprise_id, created_by)
SELECT t.id, 1, sb.id, t.unit_id, t.to_location_id, t.to_location_code, sb.owner_id, sb.owner_name, t.lot_id, t.quantity, 0.0000, 500.0000, 'receive', t.plant_id, t.enterprise_id, '演练夹具'
FROM recv t, stock_balance sb WHERE sb.unit_id = t.unit_id;

WITH issu AS (
  INSERT INTO stock_transaction (command_receipt_id, line_no, movement_kind, unit_id, lot_id, from_location_id, from_location_code, quantity, uom_id, uom_code, measurement_basis, before_qty, after_qty, ref_type, reason, business_time, shift_date, plant_id, enterprise_id, created_by)
  SELECT cr.id, 1, 'issue', un.id, l.id, s.id, s.code, 120.0000, u.id, u.code, 'net', 500.0000, 380.0000, 'drill_fixture', '演练领料', now() - interval '1 hour', current_date, p.id, e.id, '演练夹具'
  FROM command_receipt cr, inventory_unit un, material_lot l, storage_location s, uom u, org_node p, org_node e
  WHERE cr.operation_id='DRILL-INIT-ISSU-001' AND un.unit_no='UNIT-DRILL-0001' AND l.lot_no='LOT-DRILL-0001'
    AND s.code='01010001' AND u.code='KG' AND p.code='PLNT-SZ' AND p.kind='plant' AND e.code='ENT-HD' AND e.kind='enterprise'
  RETURNING id, unit_id, lot_id, from_location_id, from_location_code, quantity, plant_id, enterprise_id
)
INSERT INTO stock_entry (transaction_id, entry_no, balance_id, unit_id, location_id, location_code, owner_id, owner_name, lot_id, quantity_delta, before_qty, after_qty, purpose, plant_id, enterprise_id, created_by)
SELECT t.id, 1, sb.id, t.unit_id, t.from_location_id, t.from_location_code, sb.owner_id, sb.owner_name, t.lot_id, -t.quantity, 500.0000, 380.0000, 'issue', t.plant_id, t.enterprise_id, '演练夹具'
FROM issu t, stock_balance sb WHERE sb.unit_id = t.unit_id;

-- 接口账夹具（outbox 无 created_by 列）
INSERT INTO outbox (aggregate_type, aggregate_id, task_kind, status, payload, attempt_count, next_retry_at)
SELECT 'shipment_order', 'drill-agg-001', 'drill.pending-due', 'PENDING', '{"fixture":true}'::jsonb, 0, NULL
WHERE NOT EXISTS (SELECT 1 FROM outbox WHERE task_kind='drill.pending-due');

INSERT INTO outbox (aggregate_type, aggregate_id, task_kind, status, payload, attempt_count, next_retry_at)
SELECT 'shipment_order', 'drill-agg-001', 'drill.pending-notdue', 'PENDING', '{"fixture":true}'::jsonb, 0, now() + interval '1 day'
WHERE NOT EXISTS (SELECT 1 FROM outbox WHERE task_kind='drill.pending-notdue');

INSERT INTO outbox (aggregate_type, aggregate_id, task_kind, status, payload, attempt_count)
SELECT 'shipment_order', 'drill-agg-001', 'drill.confirmed-a', 'DISPATCHED', '{"fixture":true}'::jsonb, 1
WHERE NOT EXISTS (SELECT 1 FROM outbox WHERE task_kind='drill.confirmed-a');

INSERT INTO outbox (aggregate_type, aggregate_id, task_kind, status, payload, attempt_count)
SELECT 'shipment_order', 'drill-agg-002', 'drill.confirmed-b', 'DISPATCHED', '{"fixture":true}'::jsonb, 1
WHERE NOT EXISTS (SELECT 1 FROM outbox WHERE task_kind='drill.confirmed-b');

INSERT INTO outbox (aggregate_type, aggregate_id, task_kind, status, payload, attempt_count, last_error)
SELECT 'shipment_order', 'drill-agg-003', 'drill.sync-failed', 'SYNC_FAILED', '{"fixture":true}'::jsonb, 2, '演练注入的外部失败'
WHERE NOT EXISTS (SELECT 1 FROM outbox WHERE task_kind='drill.sync-failed');

INSERT INTO inbox (source_system, organization_code, external_key, entity_type, payload, status, quarantine_reason)
SELECT 'ERP-DRILL', 'UNMAPPED-ORG', 'DRILL-QUAR-001', 'drill_doc', '{"fixture":true}'::jsonb, 'QUARANTINED', '缺组织映射（演练注入）'
WHERE NOT EXISTS (SELECT 1 FROM inbox WHERE external_key='DRILL-QUAR-001');

INSERT INTO inbox (source_system, organization_code, external_key, entity_type, payload, status)
SELECT 'ERP-DRILL', 'SZ0001', 'DRILL-PEND-001', 'drill_doc', '{"fixture":true}'::jsonb, 'PENDING'
WHERE NOT EXISTS (SELECT 1 FROM inbox WHERE external_key='DRILL-PEND-001');
