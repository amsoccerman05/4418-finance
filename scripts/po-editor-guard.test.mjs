import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const source = readFileSync(new URL('../src/po-editor-guard.ts', import.meta.url), 'utf8');
const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const module = { exports: {} };
vm.runInNewContext(code, { module, exports: module.exports, FormData });
const { createPOEditorGuard, preservesPOEditor } = module.exports;
const unload = guard => {
  const event = { prevented: false, returnValue: undefined, preventDefault() { this.prevented = true; } };
  guard.beforeUnload(event);
  return event;
};

test('untouched and reverted forms leave without confirmation or unload warning', () => {
  const guard = createPOEditorGuard();
  let leaves = 0;
  guard.requestLeave(() => leaves++);
  assert.equal(leaves, 1);
  assert.equal(guard.confirming, false);
  assert.equal(unload(guard).prevented, false);
  guard.setDirty(true);
  guard.setDirty(false);
  guard.requestLeave(() => leaves++);
  assert.equal(leaves, 2);
});

test('Keep editing cancels repeated leave requests and keeps unload protection', () => {
  const guard = createPOEditorGuard();
  let leaves = 0;
  guard.setDirty(true);
  guard.requestLeave(() => leaves++);
  guard.requestLeave(() => leaves++);
  assert.equal(guard.confirming, true);
  assert.equal(leaves, 0);
  guard.keepEditing();
  assert.equal(guard.confirming, false);
  assert.equal(guard.dirty, true);
  assert.equal(leaves, 0);
  assert.equal(unload(guard).prevented, true);
  assert.equal(unload(guard).returnValue, '');
});

test('Discard clears the guard before leaving and cannot repeat the action', () => {
  const guard = createPOEditorGuard();
  let leaves = 0;
  guard.setDirty(true);
  guard.requestLeave(() => { assert.equal(unload(guard).prevented, false); leaves++; });
  guard.discard();
  guard.discard();
  assert.equal(leaves, 1);
  assert.equal(guard.dirty, false);
});

test('Save draft never leaves until confirmed success and only leaves once', () => {
  const guard = createPOEditorGuard();
  let leaves = 0;
  guard.setDirty(true);
  guard.requestLeave(() => leaves++);
  guard.beginSaveAndLeave();
  assert.equal(guard.confirming, false);
  assert.equal(leaves, 0);
  assert.equal(unload(guard).prevented, true);
  guard.saved()?.();
  guard.saved()?.();
  assert.equal(leaves, 1);
  assert.equal(guard.dirty, false);
});

test('failed or invalid save keeps edits protected and cancels stale navigation', () => {
  const guard = createPOEditorGuard();
  let leaves = 0;
  guard.setDirty(true);
  guard.requestLeave(() => leaves++);
  guard.beginSaveAndLeave();
  guard.saveFailed();
  assert.equal(guard.dirty, true);
  assert.equal(unload(guard).prevented, true);
  // A later normal Save draft shows the draft; it must not unexpectedly leave.
  assert.equal(guard.saved(), null);
  assert.equal(leaves, 0);
});

test('account reset removes pending continuation and old-account unload warnings', () => {
  const guard = createPOEditorGuard();
  let leaves = 0;
  guard.setDirty(true);
  guard.requestLeave(() => leaves++);
  guard.beginSaveAndLeave();
  guard.reset();
  assert.equal(guard.saved(), null);
  assert.equal(guard.confirming, false);
  assert.equal(unload(guard).prevented, false);
  assert.equal(leaves, 0);
});

test('only same-user session refresh/refocus preserves an editor', () => {
  for (const event of ['SIGNED_IN', 'TOKEN_REFRESHED', 'USER_UPDATED']) {
    assert.equal(preservesPOEditor(event, 'student', 'student'), true);
    assert.equal(preservesPOEditor(event, 'student', 'other-student'), false);
    assert.equal(preservesPOEditor(event, null, 'student'), false);
    assert.equal(preservesPOEditor(event, 'student', null), false);
  }
  for (const event of ['SIGNED_OUT', 'PASSWORD_RECOVERY', 'INITIAL_SESSION']) {
    assert.equal(preservesPOEditor(event, 'student', 'student'), false);
  }
});
