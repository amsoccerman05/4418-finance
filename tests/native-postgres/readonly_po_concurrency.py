#!/usr/bin/env python3
"""Real lock-wait/demotion tests in an owned disposable localhost cluster only."""
import os
import sys

# Refuse rather than silently consume ambient production/service configuration.
for key in os.environ:
    if key == 'DATABASE_URL' or key.startswith(('SUPABASE_', 'VITE_SUPABASE_')) or (key.startswith('PG') and key != 'PG_BIN_DIR'):
        raise SystemExit(f'Refusing external database configuration: {key}')

import concurrent.futures
import json
import unittest
import uuid
import repair_po_concurrency as native

ROOT = native.ROOT
MIGRATION = ROOT / 'supabase/migrations/20261028160500_finance_student_roles_readonly_privacy.sql'

class ReadonlyConcurrency(unittest.TestCase):
    cluster = None
    connect = native.BridgeConcurrency.connect
    tearDown = native.BridgeConcurrency.tearDown
    snapshot = native.BridgeConcurrency.snapshot
    wait_blocked = native.BridgeConcurrency.wait_blocked
    create_po = native.BridgeConcurrency.create_po

    def setUp(self):
        self.database = 'readonly_fixture_' + uuid.uuid4().hex
        self.cluster.admin.query(f'create database {self.database}')
        self.connections = []
        self.pool = concurrent.futures.ThreadPoolExecutor(max_workers=3)
        self.owner = self.connect()
        native.setup_fixture(self.owner)
        self.owner.query("alter table public.profiles add constraint profiles_role_check check(role in ('readonly','student','lead','mentor','admin'))")
        for path in [
            'supabase/migrations/202609200002_finance_workbook.sql',
            'supabase/migrations/20261007011342_allow_all_active_student_purchase_requests.sql',
            'supabase/migrations/20261018051306_finance_notification_delivery_authorization.sql',
            'supabase/migrations/20261027204114_finance_po_received.sql',
            'supabase/migrations/20261028033326_finance_po_actionability.sql',
            'tests/fixtures/student-role-position-eligibility.sql',
        ]:
            self.owner.query((ROOT/path).read_text())
        self.owner.query(MIGRATION.read_text())

    def mutate(self, connection, action, payload):
        return connection.scalar('select public.finance_mutate($1,$2::jsonb)', [action, json.dumps(payload)])

    def barrier(self, action):
        po = self.create_po('student') if action != 'create' else None
        blocker, waiter = self.connect(), self.connect('student')
        blocker.query('begin')
        if po:
            blocker.query('select id from public.finance_purchase_orders where id=$1 for update', [po])
        else:
            blocker.query('select pg_advisory_xact_lock(4418,20)')
        payload = dict(area_id=native.AREA, sheet_url='https://docs.google.com/spreadsheets/d/NativeFixture/edit', vendor='Native fixture', amount=125, purpose='Synthetic only')
        if po:
            payload.update(id=po, version=1)
        before = self.snapshot()
        future = self.pool.submit(self.mutate, waiter, action, payload)
        self.wait_blocked(waiter, blocker, future)
        # Independently committed profile demotion while the request is blocked.
        self.owner.query("update public.profiles set role='readonly' where id=$1", [native.IDS['student']])
        blocker.query('commit')
        with self.assertRaises(native.DatabaseError) as failure:
            future.result(timeout=16)
        self.assertEqual(failure.exception.code, '42501')
        self.assertEqual(self.snapshot(), before)
        if po:
            self.assertEqual(waiter.scalar('select count(*) from public.finance_purchase_orders where id=$1', [po]), '1')
            self.assertGreater(int(waiter.scalar('select count(*) from public.finance_po_history where po_id=$1', [po])), 0)

    def test_create_denied_after_advisory_lock_demotion(self): self.barrier('create')
    def test_edit_denied_after_row_lock_demotion(self): self.barrier('edit')
    def test_submit_denied_after_row_lock_demotion(self): self.barrier('submit')

    def budget_barrier(self, target):
        mentor = self.connect('mentor')
        def budget(connection, action, payload):
            return connection.scalar('select public.finance_budget_manage($1,$2::jsonb)', [action, json.dumps(payload)])
        season = budget(mentor, 'create_season', dict(name='Native budget fixture', starting_funds=1000))
        category = budget(mentor, 'category', dict(season_id=season, version=1, name='Parts', allocation=500, reason='Synthetic fixture'))
        budget(mentor, 'activate', dict(season_id=season, version=2, confirmed=True, reason='Synthetic fixture'))
        po = self.create_po('student')
        version = int(self.owner.scalar('select version from public.finance_seasons where id=$1', [season]))
        blocker, waiter = self.connect(), self.connect('finance')
        blocker.query('begin')
        if target == 'season':
            blocker.query('select id from public.finance_seasons where id=$1 for update', [season])
            action, payload = 'season', dict(season_id=season, version=version, name='Must not save', starting_funds=1000, reserve_target=0, reason='Synthetic fixture')
        else:
            blocker.query('select id from public.finance_purchase_orders where id=$1 for update', [po])
            action, payload = 'categorize_po', dict(season_id=season, version=version, po_id=po, category_id=category, reason='Synthetic fixture')
        before = self.snapshot()
        future = self.pool.submit(budget, waiter, action, payload)
        self.wait_blocked(waiter, blocker, future)
        self.owner.query("update public.profiles set role='readonly' where id=$1", [native.IDS['finance']])
        blocker.query('commit')
        with self.assertRaises(native.DatabaseError) as failure:
            future.result(timeout=16)
        self.assertEqual(failure.exception.code, '42501')
        self.assertEqual(self.snapshot(), before)

    def test_budget_demotion_during_season_row_wait_denies_every_business_write(self): self.budget_barrier('season')
    def test_budget_demotion_during_po_row_wait_denies_category_and_audit_writes(self): self.budget_barrier('po')

if __name__ == '__main__':
    with native.Cluster() as cluster:
        ReadonlyConcurrency.cluster = cluster
        result = unittest.TextTestRunner(verbosity=2).run(unittest.defaultTestLoader.loadTestsFromTestCase(ReadonlyConcurrency))
    sys.exit(not result.wasSuccessful())
