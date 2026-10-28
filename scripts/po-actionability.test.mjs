import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

// Execute the real service functions with a synthetic client. No network/auth.
const source = readFileSync(new URL('../src/service.ts', import.meta.url), 'utf8')
  .replaceAll('import.meta.env.VITE_SUPABASE_URL', '"https://fixture.invalid"')
  .replaceAll('import.meta.env.VITE_SUPABASE_ANON_KEY', '"fixture-public-key"');
const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
function service(rows = {}, error = null) {
  const queries = [];
  const client = {
    rpc: async () => ({ data: { profile: { id: 'viewer' } } }),
    from(table) {
      queries.push(table);
      const query = { select: () => query, order: () => query, range: async () => ({
        data: rows[table] || [], error: table === 'finance_po_actionability' ? error : null,
      }) };
      return query;
    },
  };
  const module = { exports: {} };
  vm.runInNewContext(code, { module, exports: module.exports, require: () => ({ createSuiteClient: () => client }) });
  return { ...module.exports, queries };
}
const { needsMe } = service();
const po = { id: 'po', status: 'awaiting_approval', requester_id: 'requester', revision: 3 };
const data = (capabilities = ['po_approver', 'finance_approver'], approvals = []) => ({ context: { profile: { id: 'viewer' }, capabilities }, approvals });
const approval = (slot, props = {}) => ({ po_id: 'po', revision: 3, slot, action: 'approved', actor_id: 'viewer', ...props });

test('approval queue excludes the current-revision approver even with both capabilities or a position change', () => {
  for (const slot of ['po_approver', 'finance_approver']) {
    const other = slot === 'po_approver' ? 'finance_approver' : 'po_approver';
    for (const capabilities of [[slot, other], [other]]) {
      assert.equal(needsMe(data(capabilities, [approval(slot)]), po), false);
    }
  }
});

test('new revisions and unrelated historical actions do not hide an eligible approval', () => {
  for (const record of [approval('po_approver', { revision: 2 }), approval('po_approver', { po_id: 'different' }), approval('po_approver', { actor_id: 'another-person' }), approval('po_approver', { action: 'changes_requested' })]) {
    assert.equal(needsMe(data(['finance_approver'], [record]), po), true);
  }
  assert.equal(needsMe(data(), po), true);
  assert.equal(needsMe(data(), { ...po, requester_id: 'viewer' }), false);
  assert.equal(needsMe(data([]), po), false);
  assert.equal(needsMe(data(['finance_approver'], [approval('finance_approver', { actor_id: 'other' })]), po), false);
  for (const status of ['draft', 'changes_requested', 'approved', 'submitted_to_school', 'received', 'cancelled']) assert.equal(needsMe(data(), { ...po, status }), false);
});

test('Finance loads the exact closed-season IDs from the visibility-filtered view', async () => {
  const { load, queries } = service({ finance_purchase_orders: [po], finance_po_actionability: [{ id: 'po', season_closed: true }, { id: 'other', season_closed: false }] });
  const result = await load();
  assert.deepEqual(Array.from(result.closedSeasonPOIds), ['po']);
  assert.ok(queries.includes('finance_po_actionability'));
});

test('an unavailable actionability read fails closed instead of assuming receiving is allowed', async () => {
  const failure = new Error('Actionability read unavailable');
  await assert.rejects(service({}, failure).load(), failure);
});
