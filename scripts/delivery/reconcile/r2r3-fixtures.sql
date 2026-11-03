-- R2R3 合并演练期初样本（最小自备业务事实；与 R1 导入线产物解耦——PM-FINAL-RECEPTION R2 允许）。
-- 仅注入 cadenza_dops_* 演练临时库；先于本文件应用 deploy/drill/drill-fixtures.sql（库存事实链+接口账夹具）。
-- 本文件补齐报表投影核对所需的业务事实（对 metric_definition_revision 默认四族口径）：
--   采购批次单元（stock_stat 采购收货码键）+ 生产订单/工序/报工/投料（生产码键+班次指标事实）
--   + 在制单元（wip 事实）。
-- 全部幂等（WHERE NOT EXISTS）。数值口径（对账期望值，见 R2R3-RECOVERY-RELEASE-20261029.md）：
--   wip.quantity=130.0000（KG）；yield.qualified-rate=290/300→96.6600%（截取）；
--   loss.consumption-gap-rate=(250-300)/250→-20.0000%（超产为负）；
--   delivery.ontime-rate=1/2→50.0000%；库存统计投影键 2 个（采购 UNIT-DRILL-P0001=260、生产 UNIT-DRILL-0001×PO-DRILL-0001=380）。

-- ============ 采购批次（stock_stat purchase_receive 键） ============
INSERT INTO material_lot (lot_no, kind, material_id, material_code, supplier_lot_no, plant_id, enterprise_id, note, created_by)
SELECT 'LOT-DRILL-P0001', 'purchase', m.id, m.code, 'SUPP-DRILL-001', p.id, e.id, 'R2R3 演练采购批次', '演练夹具'
FROM material m, org_node p, org_node e
WHERE m.code='MAT-DRILL-0001' AND p.code='PLNT-SZ' AND p.kind='plant' AND e.code='ENT-HD' AND e.kind='enterprise'
  AND NOT EXISTS (SELECT 1 FROM material_lot WHERE lot_no='LOT-DRILL-P0001');

INSERT INTO inventory_unit (unit_no, material_id, material_code, lot_id, uom_id, uom_code, trace_mode, status, plant_id, enterprise_id, created_by)
SELECT 'UNIT-DRILL-P0001', m.id, m.code, l.id, u.id, u.code, 'quantity', 'in_stock', p.id, e.id, '演练夹具'
FROM material m, material_lot l, uom u, org_node p, org_node e
WHERE m.code='MAT-DRILL-0001' AND l.lot_no='LOT-DRILL-P0001' AND u.code='KG'
  AND p.code='PLNT-SZ' AND p.kind='plant' AND e.code='ENT-HD' AND e.kind='enterprise'
  AND NOT EXISTS (SELECT 1 FROM inventory_unit WHERE unit_no='UNIT-DRILL-P0001');

INSERT INTO stock_balance (unit_id, location_id, location_code, owner_id, owner_name, quantity, uom_id, uom_code, measurement_basis, quality_status, plant_id, enterprise_id, created_by)
SELECT un.id, s.id, s.code, le.id, le.name, 260.0000, u.id, u.code, 'net', 'qualified', p.id, e.id, '演练夹具'
FROM inventory_unit un, storage_location s, uom u, org_node p, org_node e, org_node le
WHERE un.unit_no='UNIT-DRILL-P0001' AND s.code='01010001' AND u.code='KG'
  AND p.code='PLNT-SZ' AND p.kind='plant' AND e.code='ENT-HD' AND e.kind='enterprise'
  AND le.code='LE-HDMIKE' AND le.kind='legal_entity'
  AND NOT EXISTS (SELECT 1 FROM stock_balance sb WHERE sb.unit_id=un.id);

-- ============ 在制单元（wip 事实；无报工 → 不进 stock_stat 生产键，进 wip 指标） ============
INSERT INTO material_lot (lot_no, kind, material_id, material_code, plant_id, enterprise_id, note, created_by)
SELECT 'LOT-DRILL-0002', 'production', m.id, m.code, p.id, e.id, 'R2R3 演练在制批次', '演练夹具'
FROM material m, org_node p, org_node e
WHERE m.code='MAT-DRILL-0001' AND p.code='PLNT-SZ' AND p.kind='plant' AND e.code='ENT-HD' AND e.kind='enterprise'
  AND NOT EXISTS (SELECT 1 FROM material_lot WHERE lot_no='LOT-DRILL-0002');

INSERT INTO inventory_unit (unit_no, material_id, material_code, lot_id, uom_id, uom_code, trace_mode, status, plant_id, enterprise_id, created_by)
SELECT 'UNIT-DRILL-WIP0001', m.id, m.code, l.id, u.id, u.code, 'quantity', 'in_production', p.id, e.id, '演练夹具'
FROM material m, material_lot l, uom u, org_node p, org_node e
WHERE m.code='MAT-DRILL-0001' AND l.lot_no='LOT-DRILL-0002' AND u.code='KG'
  AND p.code='PLNT-SZ' AND p.kind='plant' AND e.code='ENT-HD' AND e.kind='enterprise'
  AND NOT EXISTS (SELECT 1 FROM inventory_unit WHERE unit_no='UNIT-DRILL-WIP0001');

INSERT INTO stock_balance (unit_id, location_id, location_code, owner_id, owner_name, quantity, uom_id, uom_code, measurement_basis, quality_status, plant_id, enterprise_id, created_by)
SELECT un.id, s.id, s.code, le.id, le.name, 130.0000, u.id, u.code, 'net', 'qualified', p.id, e.id, '演练夹具'
FROM inventory_unit un, storage_location s, uom u, org_node p, org_node e, org_node le
WHERE un.unit_no='UNIT-DRILL-WIP0001' AND s.code='01010001' AND u.code='KG'
  AND p.code='PLNT-SZ' AND p.kind='plant' AND e.code='ENT-HD' AND e.kind='enterprise'
  AND le.code='LE-HDMIKE' AND le.kind='legal_entity'
  AND NOT EXISTS (SELECT 1 FROM stock_balance sb WHERE sb.unit_id=un.id);

-- ============ 工作中心（org_node 有编码但 work_center 表为空——订单工序/工序定义 FK 需要表行） ============
INSERT INTO work_center (enterprise_id, plant_id, dept_id, code, name, status, created_by)
SELECT e.id, p.id, d.id, 'WC-SZ-JZ-01', '苏州厂-绞制一线', 'active', '演练夹具'
FROM org_node e, org_node p, org_node d
WHERE e.code='ENT-HD' AND e.kind='enterprise' AND p.code='PLNT-SZ' AND p.kind='plant'
  AND d.code='DEPT-SZ-JZ' AND d.kind='department'
  AND NOT EXISTS (SELECT 1 FROM work_center WHERE code='WC-SZ-JZ-01' AND status='active');

-- ============ 事实链补全：两个新余额各一条 receive 分录（0→260 / 0→130，链条与终值一致） ============
INSERT INTO command_receipt (id, enterprise_id, command_type, operation_id, payload_digest, status, result)
SELECT gen_random_uuid(),
       (SELECT id::text FROM org_node WHERE code='ENT-HD' AND kind='enterprise'),
       'inventory.receive', op, 'drill-fixture', 'COMMITTED', '{"status":"COMMITTED"}'::jsonb
FROM (VALUES ('DRILL-INIT-RECV-P1'),('DRILL-INIT-RECV-WIP')) AS t(op)
WHERE NOT EXISTS (SELECT 1 FROM command_receipt cr WHERE cr.operation_id = t.op);

WITH recv AS (
  INSERT INTO stock_transaction (command_receipt_id, line_no, movement_kind, unit_id, lot_id, to_location_id, to_location_code, quantity, uom_id, uom_code, measurement_basis, before_qty, after_qty, ref_type, reason, business_time, shift_date, plant_id, enterprise_id, created_by)
  SELECT cr.id,
         1,
         'receive', un.id, l.id, s.id, s.code,
         CASE cr.operation_id WHEN 'DRILL-INIT-RECV-P1' THEN 260.0000 ELSE 130.0000 END,
         u.id, u.code, 'net', 0.0000,
         CASE cr.operation_id WHEN 'DRILL-INIT-RECV-P1' THEN 260.0000 ELSE 130.0000 END,
         'drill_fixture', 'R2R3 期初样本收货',
         CASE cr.operation_id WHEN 'DRILL-INIT-RECV-P1' THEN now() - interval '4 hour' ELSE now() - interval '3 hour' + interval '30 minute' END,
         current_date, p.id, e.id, '演练夹具'
  FROM command_receipt cr, inventory_unit un, material_lot l, storage_location s, uom u, org_node p, org_node e
  WHERE cr.operation_id IN ('DRILL-INIT-RECV-P1','DRILL-INIT-RECV-WIP')
    AND un.unit_no = CASE cr.operation_id WHEN 'DRILL-INIT-RECV-P1' THEN 'UNIT-DRILL-P0001' ELSE 'UNIT-DRILL-WIP0001' END
    AND l.id = un.lot_id AND s.code='01010001' AND u.code='KG'
    AND p.code='PLNT-SZ' AND p.kind='plant' AND e.code='ENT-HD' AND e.kind='enterprise'
    AND NOT EXISTS (
      SELECT 1 FROM stock_transaction st
      WHERE st.unit_id = un.id AND st.movement_kind='receive' AND st.reason='R2R3 期初样本收货')
  RETURNING id, unit_id, lot_id, to_location_id, to_location_code, quantity, plant_id, enterprise_id
)
INSERT INTO stock_entry (transaction_id, entry_no, balance_id, unit_id, location_id, location_code, owner_id, owner_name, lot_id, quantity_delta, before_qty, after_qty, purpose, plant_id, enterprise_id, created_by)
SELECT t.id, 1, sb.id, t.unit_id, t.to_location_id, t.to_location_code, sb.owner_id, sb.owner_name, t.lot_id,
  t.quantity, 0.0000, t.quantity, 'receive', t.plant_id, t.enterprise_id, '演练夹具'
FROM recv t JOIN stock_balance sb ON sb.unit_id = t.unit_id
WHERE NOT EXISTS (SELECT 1 FROM stock_entry se WHERE se.transaction_id = t.id);

-- ============ 工序定义（订单工序 FK；依赖上方 work_center 表行） ============
INSERT INTO operation_definition (enterprise_id, plant_id, dept_id, work_center_id, company_org_code, code, name, status, created_by)
SELECT e.id, p.id, d.id, wc.id, 'DRILL-CO', 'OPJ01', '绞制', 'active', '演练夹具'
FROM org_node e, org_node p, org_node d, work_center wc
WHERE e.code='ENT-HD' AND e.kind='enterprise' AND p.code='PLNT-SZ' AND p.kind='plant'
  AND d.code='DEPT-SZ-JZ' AND d.kind='department' AND wc.code='WC-SZ-JZ-01'
  AND NOT EXISTS (SELECT 1 FROM operation_definition WHERE code='OPJ01' AND status='active' AND plant_id=p.id);

-- ============ 生产订单 ×3（准时 1 / 延期 1 / 未完成 1——准时率 50%） ============
INSERT INTO production_order (enterprise_id, plant_id, order_no, material_id, material_snapshot, production_dept_id, production_qty, uom, order_status, planned_start_at, planned_finish_at, actual_start_at, actual_finish_at, created_by)
SELECT e.id, p.id, 'PO-DRILL-0001', m.id, '{"code":"MAT-DRILL-0001"}'::jsonb, d.id, 600.0000, 'KG', 'closed',
  now() - interval '10 hour', now() - interval '6 hour', now() - interval '9 hour', now() - interval '7 hour', '演练夹具'
FROM material m, org_node p, org_node e, org_node d
WHERE m.code='MAT-DRILL-0001' AND p.code='PLNT-SZ' AND p.kind='plant' AND e.code='ENT-HD' AND e.kind='enterprise'
  AND d.code='DEPT-SZ-JZ' AND d.kind='department'
  AND NOT EXISTS (SELECT 1 FROM production_order WHERE order_no='PO-DRILL-0001');

INSERT INTO production_order (enterprise_id, plant_id, order_no, material_id, material_snapshot, production_dept_id, production_qty, uom, order_status, planned_start_at, planned_finish_at, actual_start_at, actual_finish_at, created_by)
SELECT e.id, p.id, 'PO-DRILL-0002', m.id, '{"code":"MAT-DRILL-0001"}'::jsonb, d.id, 300.0000, 'KG', 'closed',
  now() - interval '10 hour', now() - interval '7 hour', now() - interval '9 hour', now() - interval '6 hour', '演练夹具'
FROM material m, org_node p, org_node e, org_node d
WHERE m.code='MAT-DRILL-0001' AND p.code='PLNT-SZ' AND p.kind='plant' AND e.code='ENT-HD' AND e.kind='enterprise'
  AND d.code='DEPT-SZ-JZ' AND d.kind='department'
  AND NOT EXISTS (SELECT 1 FROM production_order WHERE order_no='PO-DRILL-0002');

INSERT INTO production_order (enterprise_id, plant_id, order_no, material_id, material_snapshot, production_dept_id, production_qty, uom, order_status, planned_start_at, created_by)
SELECT e.id, p.id, 'PO-DRILL-0003', m.id, '{"code":"MAT-DRILL-0001"}'::jsonb, d.id, 150.0000, 'KG', 'in_progress',
  now() - interval '2 hour', '演练夹具'
FROM material m, org_node p, org_node e, org_node d
WHERE m.code='MAT-DRILL-0001' AND p.code='PLNT-SZ' AND p.kind='plant' AND e.code='ENT-HD' AND e.kind='enterprise'
  AND d.code='DEPT-SZ-JZ' AND d.kind='department'
  AND NOT EXISTS (SELECT 1 FROM production_order WHERE order_no='PO-DRILL-0003');

-- ============ 订单工序（每单 seq 1） ============
INSERT INTO order_operation (enterprise_id, plant_id, order_id, seq, operation_definition_id, operation_code, operation_name, core_multiple, offline_qty, work_center_id, work_center_code, work_center_name, uom, production_dept_id, created_by)
SELECT e.id, p.id, po.id, 1, od.id, od.code, od.name, 1, 0.0000, wc.id, wc.code, wc.name, 'KG', d.id, '演练夹具'
FROM production_order po, operation_definition od, work_center wc, org_node e, org_node p, org_node d
WHERE po.order_no IN ('PO-DRILL-0001','PO-DRILL-0002','PO-DRILL-0003') AND od.code='OPJ01' AND od.status='active'
  AND wc.code='WC-SZ-JZ-01' AND e.code='ENT-HD' AND e.kind='enterprise' AND p.code='PLNT-SZ' AND p.kind='plant'
  AND d.code='DEPT-SZ-JZ' AND d.kind='department'
  AND NOT EXISTS (SELECT 1 FROM order_operation oo WHERE oo.order_id=po.id AND oo.seq=1);

-- ============ 报工会话+报工单+产出行（审核通过：产出 300/合格 290） ============
-- R1（PO-DRILL-0001）：产出 200 合格 190，产出挂 UNIT-DRILL-0001（生产码投影键）
INSERT INTO execution_session (enterprise_id, plant_id, order_id, source, order_operation_id, operation_seq, operator_user_id, operator_login, shift_date, status, business_time, created_by)
SELECT e.id, p.id, po.id, 'workbench', oo.id, 1, u.id, u.login_name, current_date, 'submitted', now() - interval '2 hour', '演练夹具'
FROM production_order po, order_operation oo, user_account u, org_node e, org_node p
WHERE po.order_no='PO-DRILL-0001' AND oo.order_id=po.id AND oo.seq=1 AND u.login_name='admin'
  AND e.code='ENT-HD' AND e.kind='enterprise' AND p.code='PLNT-SZ' AND p.kind='plant'
  AND NOT EXISTS (SELECT 1 FROM execution_session es WHERE es.order_id=po.id AND es.source='workbench' AND es.business_time > now() - interval '1 day');

INSERT INTO production_report (enterprise_id, plant_id, session_id, order_id, order_operation_id, operation_seq, source, status, review_status, operator_user_id, operator_login, business_time, shift_date, reviewed_at, reviewed_by, created_by)
SELECT e.id, p.id, es.id, po.id, oo.id, 1, 'workbench', 'submitted', 'auto_approved', u.id, u.login_name,
  now() - interval '2 hour', current_date, now() - interval '1 hour', 'admin', '演练夹具'
FROM execution_session es, production_order po, order_operation oo, user_account u, org_node e, org_node p
WHERE po.order_no='PO-DRILL-0001' AND es.order_id=po.id AND es.source='workbench' AND es.business_time > now() - interval '1 day'
  AND oo.order_id=po.id AND oo.seq=1 AND u.login_name='admin'
  AND e.code='ENT-HD' AND e.kind='enterprise' AND p.code='PLNT-SZ' AND p.kind='plant'
  AND NOT EXISTS (SELECT 1 FROM production_report pr WHERE pr.session_id=es.id);

INSERT INTO report_output (enterprise_id, plant_id, report_id, line_no, quantity, qualified_qty, uom_id, uom_code, target_location_id, target_location_code, owner_id, owner_name, measurement_basis, stock_unit_id, created_by)
SELECT e.id, p.id, pr.id, 1, 200.0000, 190.0000, u2.id, u2.code, s.id, s.code, le.id, le.name, 'nominal', un.id, '演练夹具'
FROM production_report pr, execution_session es, production_order po, inventory_unit un, uom u2, storage_location s, org_node e, org_node p, org_node le
WHERE po.order_no='PO-DRILL-0001' AND es.order_id=po.id AND es.source='workbench' AND es.business_time > now() - interval '1 day'
  AND pr.session_id=es.id AND un.unit_no='UNIT-DRILL-0001' AND u2.code='KG' AND s.code='01010001'
  AND e.code='ENT-HD' AND e.kind='enterprise' AND p.code='PLNT-SZ' AND p.kind='plant' AND le.code='LE-HDMIKE' AND le.kind='legal_entity'
  AND NOT EXISTS (SELECT 1 FROM report_output ro WHERE ro.report_id=pr.id AND ro.line_no=1);

-- R2（PO-DRILL-0002）：产出 100 合格 100（不挂单元——不新增生产码键）
INSERT INTO execution_session (enterprise_id, plant_id, order_id, source, order_operation_id, operation_seq, operator_user_id, operator_login, shift_date, status, business_time, created_by)
SELECT e.id, p.id, po.id, 'workbench', oo.id, 1, u.id, u.login_name, current_date, 'submitted', now() - interval '2 hour' + interval '5 minute', '演练夹具'
FROM production_order po, order_operation oo, user_account u, org_node e, org_node p
WHERE po.order_no='PO-DRILL-0002' AND oo.order_id=po.id AND oo.seq=1 AND u.login_name='admin'
  AND e.code='ENT-HD' AND e.kind='enterprise' AND p.code='PLNT-SZ' AND p.kind='plant'
  AND NOT EXISTS (SELECT 1 FROM execution_session es WHERE es.order_id=po.id AND es.source='workbench' AND es.business_time > now() - interval '1 day');

INSERT INTO production_report (enterprise_id, plant_id, session_id, order_id, order_operation_id, operation_seq, source, status, review_status, operator_user_id, operator_login, business_time, shift_date, reviewed_at, reviewed_by, created_by)
SELECT e.id, p.id, es.id, po.id, oo.id, 1, 'workbench', 'submitted', 'auto_approved', u.id, u.login_name,
  now() - interval '2 hour' + interval '5 minute', current_date, now() - interval '1 hour', 'admin', '演练夹具'
FROM execution_session es, production_order po, order_operation oo, user_account u, org_node e, org_node p
WHERE po.order_no='PO-DRILL-0002' AND es.order_id=po.id AND es.source='workbench' AND es.business_time > now() - interval '1 day'
  AND oo.order_id=po.id AND oo.seq=1 AND u.login_name='admin'
  AND e.code='ENT-HD' AND e.kind='enterprise' AND p.code='PLNT-SZ' AND p.kind='plant'
  AND NOT EXISTS (SELECT 1 FROM production_report pr WHERE pr.session_id=es.id);

INSERT INTO report_output (enterprise_id, plant_id, report_id, line_no, quantity, qualified_qty, uom_id, uom_code, target_location_id, target_location_code, owner_id, owner_name, measurement_basis, created_by)
SELECT e.id, p.id, pr.id, 1, 100.0000, 100.0000, u2.id, u2.code, s.id, s.code, le.id, le.name, 'nominal', '演练夹具'
FROM production_report pr, execution_session es, production_order po, uom u2, storage_location s, org_node e, org_node p, org_node le
WHERE po.order_no='PO-DRILL-0002' AND es.order_id=po.id AND es.source='workbench' AND es.business_time > now() - interval '1 day'
  AND pr.session_id=es.id AND u2.code='KG' AND s.code='01010001'
  AND e.code='ENT-HD' AND e.kind='enterprise' AND p.code='PLNT-SZ' AND p.kind='plant' AND le.code='LE-HDMIKE' AND le.kind='legal_entity'
  AND NOT EXISTS (SELECT 1 FROM report_output ro WHERE ro.report_id=pr.id AND ro.line_no=1);

-- ============ 投料（250 KG，当日班次——损耗率 (250-300)/250 = -20%） ============
INSERT INTO material_consumption (enterprise_id, plant_id, order_id, order_operation_id, operation_seq, report_id, feed_type, inventory_unit_id, unit_no, quantity, before_qty, after_qty, uom_id, uom_code, operator_user_id, operator_login, business_time, shift_date, command_receipt_id, created_by)
SELECT e.id, p.id, po.id, oo.id, 1, NULL, 'standalone', un.id, un.unit_no, 250.0000, 380.0000, 130.0000, u2.id, u2.code,
  u.id, u.login_name, now() - interval '3 hour', current_date, cr.id, '演练夹具'
FROM production_order po, order_operation oo, inventory_unit un, uom u2, user_account u, command_receipt cr, org_node e, org_node p
WHERE po.order_no='PO-DRILL-0001' AND oo.order_id=po.id AND oo.seq=1 AND un.unit_no='UNIT-DRILL-0001' AND u2.code='KG'
  AND u.login_name='admin' AND cr.operation_id='DRILL-INIT-ISSU-001'
  AND e.code='ENT-HD' AND e.kind='enterprise' AND p.code='PLNT-SZ' AND p.kind='plant'
  AND NOT EXISTS (SELECT 1 FROM material_consumption mc WHERE mc.order_id=po.id AND mc.quantity=250.0000 AND mc.shift_date=current_date);
