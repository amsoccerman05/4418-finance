import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
const source = readFileSync(new URL('../src/po-list-context.ts', import.meta.url), 'utf8');
const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const module = { exports: {} };
vm.runInNewContext(code, { module, exports: module.exports });
const { createPOListContextStore, emptyPOListContext, PO_LIST_CONTEXT_KEY } = module.exports;
function fixture() {
  const items = new Map();
  const storage = { getItem: key => items.get(key) ?? null, setItem: (key, value) => items.set(key, value), removeItem: key => items.delete(key) };
  return { items, store: createPOListContextStore(() => storage), storage };
}
test('same user reload restores only allowlisted list metadata', () => {
  const { items, store, storage } = fixture();
  store.setUser('one');
  store.save('one', { ...emptyPOListContext(), search: 'motor', status: 'received', moreFilters: true, scrollY: 742, notes: 'PRIVATE', sheet_url: 'PRIVATE', purpose: 'PRIVATE', token: 'PRIVATE' });
  const reload = createPOListContextStore(() => storage); reload.setUser('one');
  assert.equal(reload.read('one').search, 'motor');
  assert.equal(reload.read('one').status, 'received');
  assert.equal(reload.read('one').scrollY, 742);
  assert.equal(reload.read('one').moreFilters, true);
  assert.equal(items.get(PO_LIST_CONTEXT_KEY).includes('PRIVATE'), false);
  assert.equal(items.size, 1);
});
test('signout/account switch synchronously clear context and reject old-account callbacks', () => {
  const { store, items } = fixture();
  store.setUser('one'); store.save('one', { ...emptyPOListContext(), search: 'one-only' });
  store.setUser('two');
  assert.equal(store.read('two').search, '');
  store.save('one', { ...emptyPOListContext(), search: 'late-old-write' });
  assert.equal(items.size, 0);
  store.save('two', { ...emptyPOListContext(), search: 'two-only' });
  store.setUser(null);
  assert.equal(items.size, 0);
  store.save('two', { ...emptyPOListContext(), search: 'late-signout-write' });
  store.setUser('one');
  assert.equal(store.read('one').search, '');
  assert.equal(items.size, 0);
});
test('initial load for a different user drops stored prior-account context', () => {
  const { store, storage, items } = fixture();
  store.setUser('one'); store.save('one', { ...emptyPOListContext(), search: 'private query' });
  const next = createPOListContextStore(() => storage); next.setUser('two');
  assert.equal(items.size, 0); assert.equal(next.read('two').search, '');
});
test('corrupt/invalid storage and unavailable storage do not break navigation', () => {
  const { store, storage, items } = fixture();
  storage.setItem(PO_LIST_CONTEXT_KEY, '{bad json'); store.setUser('one');
  assert.equal(store.read('one').search, ''); assert.equal(items.size, 0);
  store.save('one', { search: 'x'.repeat(400), status: 'fake', approval: 'fake', scrollY: -9, moreFilters: 'yes' });
  assert.equal(store.read('one').search.length, 200);
  assert.equal(store.read('one').status, ''); assert.equal(store.read('one').approval, '');
  assert.equal(store.read('one').scrollY, 0); assert.equal(store.read('one').moreFilters, false);
  for (const getStorage of [() => null, () => { throw new Error('Storage blocked'); }]) {
    const blocked = createPOListContextStore(getStorage);
    assert.doesNotThrow(() => { blocked.setUser('one'); blocked.save('one', emptyPOListContext()); blocked.read('one'); blocked.setUser(null); });
  }
});
