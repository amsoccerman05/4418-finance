import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const source = readFileSync(new URL('../src/po-next-step.ts', import.meta.url), 'utf8');
const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const module = { exports: {} };
vm.runInNewContext(code, { module, exports: module.exports });
const { poNextStep, selfApprovalBlocked } = module.exports;
const po = (status = 'awaiting_approval', props = {}) => ({ id: 'po', requester_id: 'requester', status, revision: 3, ...props });
const data = (props = {}) => ({
  context: { profile: { id: 'viewer', role: 'student' }, capabilities: [], is_admin: false, ...props.context },
  approvals: props.approvals || [],
});
const approval = (slot, actor_id = 'approver', props = {}) => ({ po_id: 'po', revision: 3, slot, actor_id, action: 'approved', ...props });
const roles = ['student', 'lead', 'mentor', 'admin'];
const slots = ['po_approver', 'finance_approver'];
const next = (status, props = {}, poProps = {}) => poNextStep(data(props), po(status, poProps));

test('self-approval waiting explanation follows the current assigned slot, not Finance administration', () => {
  const own = po('awaiting_approval', { requester_id: 'viewer' });
  const context = { profile: { id: 'viewer', role: 'lead' }, capabilities: ['finance_approver', 'finance_admin'], is_admin: true };
  const d = data({ context, approvals: [approval('po_approver', 'coach')] });
  assert.equal(selfApprovalBlocked(d, own), true);
  assert.match(poNextStep(d, own).description, /different mentor or admin who has not already approved this revision/);
  assert.match(poNextStep(d, own).description, /explicit override reason and two different approvers/);
  assert.equal(selfApprovalBlocked(data({ context, approvals: [approval('finance_approver')] }), own), false);
  for (const stale of [approval('finance_approver', 'mentor', { revision: 2 }), approval('finance_approver', 'mentor', { po_id: 'other' }), approval('finance_approver', 'mentor', { action: 'changes_requested' })]) {
    assert.equal(selfApprovalBlocked(data({ context, approvals: [stale] }), own), true);
  }
  for (const status of ['draft', 'changes_requested', 'approved', 'submitted_to_school', 'received', 'cancelled']) {
    assert.equal(selfApprovalBlocked(d, { ...own, status }), false);
  }
  for (const role of ['mentor', 'admin']) assert.equal(selfApprovalBlocked(data({ context: { ...context, profile: { id: 'viewer', role } } }), own), false);
  assert.equal(selfApprovalBlocked(data({ context: { ...context, capabilities: ['finance_admin'] } }), own), false);
  assert.equal(selfApprovalBlocked(d, po()), false);
});

test('every known state has an explicit non-mutating next step', () => {
  for (const status of ['draft', 'awaiting_approval', 'changes_requested', 'approved', 'submitted_to_school', 'received', 'cancelled']) {
    const result = next(status);
    assert.ok(result.title && result.description);
    assert.ok(result.target === null || /^(owner-actions|approval-(po_approver|finance_approver)|school-submission|receiving)$/.test(result.target));
    assert.equal(result.target === null, result.actionLabel === null);
  }
});

test('draft and change-request summaries distinguish owner and Finance administrator from read-only viewers', () => {
  for (const status of ['draft', 'changes_requested']) {
    assert.equal(next(status).target, null);
    assert.equal(next(status, {}, { requester_id: 'viewer' }).target, 'owner-actions');
    assert.equal(next(status, { context: { is_admin: true } }).target, 'owner-actions');
    for (const role of roles) {
      assert.equal(next(status, { context: { profile: { id: 'viewer', role } } }).target, null);
    }
  }
  assert.match(next('draft').description, /before approvals can begin/);
  assert.match(next('changes_requested', {}, { requester_id: 'viewer' }).description, /resubmit for both approvals/);
});

test('waiting copy names exactly the missing current-revision slots', () => {
  assert.match(next('awaiting_approval').title, /Lead Coach and Finance Lead/);
  assert.equal(next('awaiting_approval', { approvals: [approval('po_approver')] }).title, 'Waiting for Finance Lead');
  assert.equal(next('awaiting_approval', { approvals: [approval('finance_approver')] }).title, 'Waiting for Lead Coach');
  for (const stale of [
    approval('po_approver', 'viewer', { revision: 2 }),
    approval('po_approver', 'viewer', { po_id: 'another-po' }),
    approval('po_approver', 'viewer', { action: 'changes_requested' }),
  ]) assert.match(next('awaiting_approval', { approvals: [stale] }).title, /Lead Coach and Finance Lead/);
});

test('each assigned approval is offered only to a non-requester who has not approved this revision', () => {
  for (const slot of slots) {
    for (const role of ['student', 'lead']) {
      const context = { profile: { id: 'viewer', role }, capabilities: [slot] };
      const result = next('awaiting_approval', { context });
      assert.equal(result.target, `approval-${slot}`);
      assert.equal(result.actionLabel, 'Review approval');
      assert.doesNotMatch(result.title, /override/);
      const self = next('awaiting_approval', { context }, { requester_id: 'viewer' });
      assert.equal(self.title, 'A mentor must review your request');
      assert.notEqual(self.actionLabel, 'Review approval');
      assert.match(self.description, /cannot approve it yourself/);
    }
  }
});

test('two approval capabilities never authorize the viewer to complete both approvals', () => {
  for (const role of roles) {
    for (const slot of slots) {
      const other = slots.find(candidate => candidate !== slot);
      const result = next('awaiting_approval', {
        context: { profile: { id: 'viewer', role }, capabilities: slots },
        approvals: [approval(slot, 'viewer')],
      });
      assert.equal(result.title, 'Waiting for another approver');
      assert.equal(result.target, `approval-${other}`);
      assert.equal(result.actionLabel, 'View approval status');
      assert.match(result.description, /different person/);
    }
  }
});

test('mentor and admin override guidance preserves the reason and distinct-person requirements', () => {
  for (const role of ['mentor', 'admin']) {
    const context = { profile: { id: 'viewer', role }, capabilities: [] };
    const unassigned = next('awaiting_approval', { context });
    assert.match(unassigned.title, /with an override/);
    assert.match(unassigned.description, /are not assigned this approval/);
    assert.match(unassigned.description, /Two different people/);
    const assigned = next('awaiting_approval', { context: { ...context, capabilities: ['finance_approver'] } });
    assert.equal(assigned.target, 'approval-finance_approver');
    assert.doesNotMatch(assigned.title, /override/);
    const self = next('awaiting_approval', { context: { ...context, capabilities: slots } }, { requester_id: 'viewer' });
    assert.match(self.title, /with an override/);
    assert.match(self.description, /because you requested this PO/);
  }
});

test('Finance-only administrators cannot gain override, school-submission, or receiving guidance', () => {
  const props = { context: { is_admin: true, capabilities: ['finance_admin'] } };
  assert.equal(next('awaiting_approval', props).actionLabel, 'View approval status');
  assert.equal(next('approved', props).title, 'Waiting for school submission');
  assert.equal(next('submitted_to_school', props).title, 'Waiting for delivery confirmation');
});

test('school submission and receiving guidance match designated submitter and mentor/admin authority', () => {
  for (const role of roles) {
    for (const capabilities of [[], ['school_submitter'], ['finance_approver'], ['po_approver']]) {
      const props = { context: { profile: { id: 'viewer', role }, capabilities } };
      const allowed = ['mentor', 'admin'].includes(role) || capabilities.includes('school_submitter');
      const submitted = next('approved', props);
      const receiving = next('submitted_to_school', props);
      assert.equal(submitted.target, 'school-submission');
      assert.equal(receiving.target, 'receiving');
      assert.equal(submitted.title, allowed ? 'Send the approved Sheet to school' : 'Waiting for school submission');
      assert.equal(receiving.title, allowed ? 'Confirm delivery when everything arrives' : 'Waiting for delivery confirmation');
      if (allowed) {
        assert.match(submitted.description, /does not send the document/);
        assert.match(receiving.description, /entire order/);
        assert.match(receiving.description, /without changing Inventory stock or adding another expense/);
      }
    }
  }
});

test('completed and cancelled orders never ask for another approval or receiving action', () => {
  for (const role of roles) {
    const props = { context: { profile: { id: 'viewer', role }, is_admin: true, capabilities: [...slots, 'school_submitter'] } };
    const received = next('received', props);
    assert.equal(received.title, 'Purchase order complete');
    assert.equal(received.actionLabel, 'View receiving record');
    assert.match(received.description, /No further/);
    const cancelled = next('cancelled', props);
    assert.equal(cancelled.title, 'Request cancelled');
    assert.equal(cancelled.target, null);
    assert.equal(cancelled.actionLabel, null);
    assert.match(cancelled.description, /cannot be submitted or marked received/);
  }
});

test('inconsistent and unknown statuses fail closed instead of suggesting a new action', () => {
  const both = next('awaiting_approval', { approvals: slots.map(slot => approval(slot)) });
  assert.equal(both.title, 'Check the latest approval status');
  assert.equal(both.actionLabel, 'View approvals');
  assert.match(both.description, /Refresh Finance/);
  assert.equal(next('future_unknown_status').target, null);
});

test('helper does not mutate the supplied PO, context, or approval records', () => {
  const d = data({ approvals: [approval('po_approver')], context: { capabilities: ['finance_approver'] } });
  const p = po();
  const before = JSON.stringify({ d, p });
  for (let i = 0; i < 3; i++) poNextStep(d, p);
  assert.equal(JSON.stringify({ d, p }), before);
});
