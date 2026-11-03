#!/usr/bin/env python3
"""Read-only preparation: operational input -> intended legal MOM commands.
No DB, HTTP, subprocess, expected balance reads, or historical driver imports.
"""
import csv
import hashlib
import json
from collections import Counter
from pathlib import Path

SOURCE = Path('/Users/yeemio/AI/gitrep/Cadenza/delivery/company-simulation/group-sap-cn-kr-20261029/CBL01G_SAP_CN_KR_20261029')
OUT = Path(__file__).resolve().parents[2] / 'delivery/sol-rework-20261031/sap-recon/input-plan.json'
def rows(name):
    with (SOURCE / 'data/csv' / name).open(encoding='utf-8-sig', newline='') as f:
        return list(csv.DictReader(f))
def select(row, names):
    return {name: row[name] for name in names if name in row}

targets = [select(r, ['object_id', 'material_id', 'owner_entity_id', 'current_plant_id', 'unit', 'basis']) for r in rows('sap_reconciliation.csv')]
stock_objects = {r['id']: select(r, ['id', 'wire_code', 'material_id', 'issuer_plant_id', 'original_order_id', 'supplier_lot', 'physical_kind', 'unit', 'basis']) for r in rows('stock_objects.csv')}
receipts = [select(r, ['id', 'object_id', 'purchase_order_id', 'receipt_document_id', 'plant_id', 'supplier_lot', 'original_receipt_qty', 'unit']) for r in rows('purchase_batches.csv')]
issues = [select(r, ['id', 'order_id', 'object_id', 'material_id', 'qty_kg', 'document_id', 'at']) for r in rows('raw_issues.csv')]
outputs = [select(r, ['id', 'report_id', 'object_id', 'qty', 'unit', 'customer_axis', 'segment_m', 'saved_at']) for r in rows('report_axes.csv')]
events = rows('inventory_events.csv')
selected = [select(r, ['id', 'object_id', 'action', 'delta', 'unit', 'document_id', 'at_utc', 'plant_context_id']) for r in events]
inputs = ['sap_reconciliation.csv', 'stock_objects.csv', 'purchase_batches.csv', 'raw_issues.csv', 'report_axes.csv', 'inventory_events.csv', 'feeds.csv', 'messages.csv', 'message_attempts.csv', 'transfer_lines.csv']
plan = {
    'assignment': 'SOL-SAP-RECON-1031', 'status': 'PREPARED_NOT_EXECUTED', 'actual_connection': False,
    'source': str(SOURCE), 'side_effects': ['writes this plan only'],
    'prohibitions': ['No expected balances as inputs', 'No oracle DB writes', 'No old run state import', 'No shared database reset'],
    'denominators': {'prd': 45, 'negative': 18, 'branches': 12, 'messages': 56, 'attempts': 65, 'reconciliation_objects': 21},
    'observed_input_counts': {'messages': len(rows('messages.csv')), 'attempts': len(rows('message_attempts.csv')), 'targets': len(targets)},
    'source_sha256': {name: hashlib.sha256((SOURCE / 'data/csv' / name).read_bytes()).hexdigest() for name in inputs},
    'targets_identity_only': targets, 'object_identities': stock_objects,
    'purchase_receipt_inputs': receipts, 'raw_issue_inputs': issues, 'report_output_inputs': outputs,
    'operation_events_without_before_after': selected,
    'operation_counts': dict(Counter(r['action'] for r in events)),
    'feeds': rows('feeds.csv'), 'transfers': rows('transfer_lines.csv'),
    'execution_dependencies': ['controller-provided stable engine', 'approved per-operation MOM driver bindings', 'new exclusive DB', 'same-run object -> returned unit/lot -> operation manifest'],
    'required_special_cases': ['RAW-JKBAD 125kg pending inspection from main receipt', 'GK-2 scrap retains physical custody and source conservation', 'N2-3/N2-4 external UNKNOWN stays UNKNOWN', 'No independently executed branches merged into main ledger'],
}
assert len(targets) == 21
assert plan['observed_input_counts']['messages'] == 56
assert plan['observed_input_counts']['attempts'] == 65
OUT.parent.mkdir(parents=True, exist_ok=True)
OUT.write_text(json.dumps(plan, ensure_ascii=False, indent=2) + '\n')
print(json.dumps({'output': str(OUT), 'status': plan['status'], 'counts': plan['observed_input_counts']}))
