import { test, expect, type Page } from '@playwright/test';
const firstUser = '00000000-0000-0000-0000-000000000001';
const otherUser = '00000000-0000-0000-0000-000000000002';
const contextKey = '4418-finance-po-list-v1';
async function fixture(page: Page, signedIn = true, canCreate = true) {
  let userId = firstUser;
  let token = 0;
  const user = () => ({ id: userId, aud: 'authenticated', email: 'fixture@example.invalid', app_metadata: {}, user_metadata: {}, created_at: '2026-01-01T00:00:00Z' });
  const session = () => ({ access_token: `fixture-token-${token++}`, refresh_token: 'fixture-refresh', expires_in: 3600, expires_at: 4000000000, token_type: 'bearer', user: user() });
  if (signedIn) await page.addInitScript(session => localStorage.setItem('4418-finance-auth', JSON.stringify(session)), session());
  const calls: any[] = [];
  const orders = Array.from({ length: 32 }, (_, i) => ({
    id: `00000000-0000-0000-0000-${String(100 + i).padStart(12, '0')}`, po_number: i + 1,
    requester_id: firstUser, area_id: 'area', vendor: 'Robot supplier', amount: 125,
    purpose: `Motor request ${i + 1}`, status: 'draft', revision: 0, version: 1,
    sheet_url: 'https://docs.google.com/spreadsheets/d/Example123/edit', notes: '', school_reference: '',
    school_submitted_at: null, school_submitted_by: null, received_at: null, received_by: null,
  }));
  const profile = { role: 'student', capabilities: [] as string[] };
  await page.route('https://finance-test.supabase.invalid/**', async route => {
    const path = new URL(route.request().url()).pathname;
    let result: any = [];
    if (path.endsWith('/finance_context')) result = {
      profile: { id: userId, display_name: 'Fixture member', role: profile.role },
      can_create: canCreate, is_admin: false, capabilities: profile.capabilities,
      areas: [{ id: 'area', name: 'Fabrication', active: true }], people: [{ id: firstUser, name: 'Requester' }, { id: otherUser, name: 'Other member' }],
    };
    else if (path.endsWith('/finance_budget_context')) result = { can_manage: false };
    else if (path.endsWith('/finance_purchase_orders')) result = orders;
    else if (path.endsWith('/finance_mutate')) { calls.push(route.request().postDataJSON()); throw new Error('Navigation tests must not mutate purchase orders'); }
    else if (path === '/auth/v1/token') result = session();
    else if (path === '/auth/v1/user') result = user();
    else if (path === '/auth/v1/logout') result = {};
    await route.fulfill({ json: result });
  });
  return { calls, orders, profile, switchUser() { userId = otherUser; } };
}
const dialog = (page: Page) => page.getByRole('dialog').first();
const result = (page: Page, number: number) => page.getByRole('button', { name: new RegExp(`PO ${number} Robot supplier`) });
for (const width of [390, 1440]) {
  test(`list filters, expanded controls and position survive PO, workspace and reload ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const { calls } = await fixture(page);
    await page.goto('/#orders');
    await page.getByLabel('Search', { exact: true }).fill('Motor');
    await page.getByLabel('Status', { exact: true }).selectOption('draft');
    await page.locator('.secondary-filters > summary').click();
    await page.getByLabel('Area', { exact: true }).selectOption('area');
    await result(page, 12).scrollIntoViewIfNeeded();
    const position = await page.evaluate(() => scrollY);
    expect(position).toBeGreaterThan(300);
    await result(page, 12).click();
    await expect(dialog(page).locator('.po-next-step')).toContainText('Finish and submit this request');
    await dialog(page).screenshot({ path: `test-results/finance-next-step-draft-${width}.png` });
    await dialog(page).getByRole('button', { name: 'Review draft actions', exact: true }).click();
    await expect(dialog(page).locator('#owner-actions')).toBeFocused();
    await dialog(page).getByRole('button', { name: '← Back to results', exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => scrollY)).toBeCloseTo(position, -1);
    await expect(page.getByLabel('Search', { exact: true })).toHaveValue('Motor');
    await page.reload();
    await expect(page.getByLabel('Search', { exact: true })).toHaveValue('Motor');
    await expect(page.getByLabel('Status', { exact: true })).toHaveValue('draft');
    await expect(page.getByLabel('Area', { exact: true })).toHaveValue('area');
    await expect(page.locator('.secondary-filters')).toHaveAttribute('open', '');
    await expect.poll(() => page.evaluate(() => scrollY)).toBeCloseTo(position, -1);
    await page.evaluate(() => { location.hash = '#dashboard'; });
    await expect(page.getByRole('heading', { name: 'Dashboard', exact: true })).toBeVisible();
    await page.goBack();
    await expect(page.getByLabel('Search', { exact: true })).toHaveValue('Motor');
    await expect.poll(() => page.evaluate(() => scrollY)).toBeCloseTo(position, -1);
    await page.screenshot({ path: `test-results/finance-list-context-${width}.png`, fullPage: false });
    expect(calls).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
  test(`purchase shortcut waits for sign-in, opens once and keeps dirty guards ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const { calls } = await fixture(page, false);
    await page.goto('/?action=request-purchase');
    await expect(page.getByRole('heading', { name: 'Finance sign in' })).toBeVisible();
    await expect(page).toHaveURL(/action=request-purchase/);
    await page.getByLabel('Email', { exact: true }).fill('fixture@example.invalid');
    await page.getByLabel('Password', { exact: true }).fill('fixture-password');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Purchase order details', exact: true })).toBeVisible();
    await expect(page).toHaveURL(/\/#orders$/);
    await dialog(page).getByLabel('Vendor', { exact: true }).fill('Do not persist form text');
    await dialog(page).getByRole('button', { name: '← Back to results', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Save your purchase order?', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Keep editing', exact: true }).click();
    await expect(dialog(page).getByLabel('Vendor', { exact: true })).toHaveValue('Do not persist form text');
    expect(await page.evaluate(() => JSON.stringify(sessionStorage))).not.toContain('Do not persist form text');
    await dialog(page).getByRole('button', { name: '← Back to results', exact: true }).click();
    await page.getByRole('button', { name: 'Discard changes', exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Purchase orders', exact: true })).toBeVisible();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await page.evaluate(() => { location.hash = '#dashboard'; });
    await page.goBack();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    expect(calls).toEqual([]);
  });
}
test('purchase shortcut is permission gated and never mutates a request', async ({ page }) => {
  const { calls } = await fixture(page, true, false);
  await page.goto('/?action=request-purchase');
  await expect(page.getByText('Your account cannot create a purchase request. Contact a mentor for help.')).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page).toHaveURL(/\/#orders$/);
  await page.reload();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(calls).toEqual([]);
});
test('account change and sign-out clear saved list context and old form content', async ({ page }) => {
  const { switchUser, calls } = await fixture(page);
  await page.goto('/#orders');
  await page.getByLabel('Search', { exact: true }).fill('Old account query');
  await expect.poll(() => page.evaluate(key => sessionStorage.getItem(key), contextKey)).toContain('Old account query');
  switchUser();
  await page.evaluate(async () => { const path = '/src/service.ts'; const { client } = await import(path); await client.auth.signInWithPassword({ email: 'fixture@example.invalid', password: 'fixture-password' }); });
  await expect(page.getByLabel('Search', { exact: true })).toHaveValue('');
  expect(await page.evaluate(key => sessionStorage.getItem(key), contextKey)).not.toContain('Old account query');
  await page.getByLabel('Search', { exact: true }).fill('Second account query');
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Finance sign in' })).toBeVisible();
  expect(await page.evaluate(key => sessionStorage.getItem(key), contextKey)).toBeNull();
  expect(calls).toEqual([]);
});
test('all PO states have a truthful summary beside navigation to their existing action', async ({ page }) => {
  const { orders, profile, calls } = await fixture(page);
  profile.role = 'mentor';
  const states = [
    ['draft', 'Finish and submit this request', 'Review draft actions', 'owner-actions'],
    ['changes_requested', 'Update and resubmit this request', 'Review request actions', 'owner-actions'],
    ['awaiting_approval', 'Review the Lead Coach approval with an override', 'Review approval', 'approval-po_approver'],
    ['approved', 'Send the approved Sheet to school', 'Review submission', 'school-submission'],
    ['submitted_to_school', 'Confirm delivery when everything arrives', 'Review receiving', 'receiving'],
    ['received', 'Purchase order complete', 'View receiving record', 'receiving'],
    ['cancelled', 'Request cancelled', '', ''],
  ];
  for (const [status, title, action, target] of states) {
    orders[0].status = status;
    await page.goto(`/?fixture-state=${status}#po/${orders[0].id}`);
    await expect(dialog(page).locator('.po-next-step')).toContainText(title);
    if (status === 'draft') await expect(dialog(page).getByText('Not Submitted', { exact: true })).toHaveCount(2);
    if (status === 'cancelled') await expect(dialog(page).getByText('Not Required', { exact: true })).toHaveCount(2);
    if (status === 'changes_requested') await expect(dialog(page).getByText('Awaiting Resubmission', { exact: true })).toHaveCount(2);
    await dialog(page).screenshot({ path: `test-results/finance-next-step-summary-${status}.png` });
    if (action) {
      await dialog(page).getByRole('button', { name: action, exact: true }).click();
      await expect(dialog(page).locator(`#${target}`)).toBeFocused();
    }
    if (status === 'cancelled') await expect(dialog(page).getByText('This request is cancelled; no approval is needed.')).toHaveCount(2);
    await page.screenshot({ path: `test-results/finance-next-step-${status}.png` });
    await dialog(page).getByRole('button', { name: '← Back to results', exact: true }).click();
    await expect(page).toHaveURL(/#orders$/);
  }
  expect(calls).toEqual([]);
});

test('account change cancels a not-yet-loaded purchase shortcut, including after reload', async ({ page }) => {
  const { switchUser, calls } = await fixture(page);
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  let initialLoad = true;
  await page.route('**/rpc/finance_context', async route => {
    if (initialLoad) { initialLoad = false; await pending; }
    await route.fallback();
  });
  await page.goto('/?action=request-purchase&source=hub');
  await expect(page.getByText('Loading Finance…')).toBeVisible();
  switchUser();
  await page.evaluate(async () => { const path = '/src/service.ts'; const { client } = await import(path); await client.auth.signInWithPassword({ email: 'fixture@example.invalid', password: 'fixture-password' }); });
  await expect(page).toHaveURL(/\?source=hub$/);
  release();
  await expect(page.getByRole('heading', { name: 'Dashboard', exact: true })).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Dashboard', exact: true })).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(calls).toEqual([]);
});
