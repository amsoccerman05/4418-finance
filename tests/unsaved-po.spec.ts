import { test, expect, type Page, type Locator } from '@playwright/test';

async function fixture(page: Page) {
  let userId = '00000000-0000-0000-0000-000000000001';
  let token = 0;
  const user = () => ({ id: userId, aud: 'authenticated', email: 'fixture@example.invalid', app_metadata: {}, user_metadata: {}, created_at: '2026-01-01T00:00:00Z' });
  const session = () => ({ access_token: `fixture-token-${token++}`, refresh_token: 'fixture-refresh', expires_in: 3600, expires_at: 4000000000, token_type: 'bearer', user: user() });
  const orders: any[] = [];
  const calls: any[] = [];
  await page.addInitScript(session => localStorage.setItem('4418-finance-auth', JSON.stringify(session)), session());
  await page.route('https://finance-test.supabase.invalid/**', async route => {
    const path = new URL(route.request().url()).pathname;
    let result: any = [];
    if (path.endsWith('/finance_context')) result = {
      profile: { id: userId, display_name: 'Student', role: 'student' },
      can_create: true, is_admin: false, capabilities: [],
      areas: [{ id: 'area', name: 'Fabrication', active: true }], people: [{ id: userId, name: 'Student' }],
    };
    else if (path.endsWith('/finance_budget_context')) result = { can_manage: false };
    else if (path.endsWith('/finance_purchase_orders')) result = orders;
    else if (path.endsWith('/finance_mutate')) {
      const body = route.request().postDataJSON();
      calls.push(body);
      result = body.p.id || '00000000-0000-0000-0000-000000000100';
      if (body.action === 'create') orders.push({ ...body.p, id: result, po_number: 1, requester_id: userId, status: 'draft', revision: 0, version: 1, school_reference: '', created_at: '2026-10-27T12:00:00Z' });
      else if (body.action === 'edit') {
        const order = orders.find(order => order.id === result);
        Object.assign(order, body.p, { status: 'draft', version: order.version + 1 });
      } else throw new Error(`Unexpected approval action: ${body.action}`);
    } else if (path === '/auth/v1/token') result = session();
    else if (path === '/auth/v1/user') result = user();
    else if (path === '/auth/v1/logout') result = {};
    await route.fulfill({ json: result });
  });
  return { calls, orders, switchUser() { userId = '00000000-0000-0000-0000-000000000002'; } };
}

const editor = (page: Page) => page.getByRole('dialog', { name: 'Purchase order details', exact: true });
const confirmation = (page: Page) => page.getByRole('dialog', { name: 'Save your purchase order?', exact: true });
async function fillDraft(form: Locator) {
  await form.getByLabel('Google Sheet URL').fill('https://docs.google.com/spreadsheets/d/Draft123/edit');
  await form.getByLabel('Vendor', { exact: true }).fill('Unfinished supplier');
  await form.getByLabel('Total amount (USD)').fill('125.50');
  await form.getByLabel('Functional area').selectOption('area');
  await form.getByLabel('Purpose / short description').fill('Replacement motor');
}
const unloadAllowed = (page: Page) => page.evaluate(() => window.dispatchEvent(new Event('beforeunload', { cancelable: true })));

for (const width of [390, 1440]) {
  test(`Close/Escape protect edits; Keep editing and Discard restore focus ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const { calls } = await fixture(page);
    await page.goto('/#orders');
    const start = page.getByRole('button', { name: 'New purchase order', exact: true });
    await start.click();
    await editor(page).getByRole('button', { name: 'Close', exact: true }).click();
    await expect(confirmation(page)).toHaveCount(0);
    await expect(start).toBeFocused();
    await start.click();
    await editor(page).getByLabel('Vendor', { exact: true }).fill('Keep these edits');
    await page.keyboard.press('Escape');
    await expect(confirmation(page)).toBeVisible();
    await expect(confirmation(page).getByRole('button', { name: 'Keep editing' })).toBeFocused();
    await confirmation(page).screenshot({ path: `test-results/unsaved-po-confirm-${width}.png` });
    await page.keyboard.press('Escape');
    await expect(confirmation(page)).toHaveCount(0);
    await expect(editor(page).getByLabel('Vendor', { exact: true })).toHaveValue('Keep these edits');
    await expect(editor(page).getByLabel('Vendor', { exact: true })).toBeFocused();
    await editor(page).getByRole('button', { name: 'Close', exact: true }).click();
    await confirmation(page).getByRole('button', { name: 'Keep editing' }).click();
    await expect(editor(page).getByRole('button', { name: 'Close', exact: true })).toBeFocused();
    await editor(page).getByRole('button', { name: 'Close', exact: true }).click();
    await confirmation(page).getByRole('button', { name: 'Discard changes' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(start).toBeFocused();
    expect(await unloadAllowed(page)).toBe(true);
    expect(calls).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });

  test(`Save on leave creates only a draft that can be resumed ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const { calls } = await fixture(page);
    await page.goto('/#orders');
    await page.getByRole('button', { name: 'New purchase order', exact: true }).click();
    await fillDraft(editor(page));
    await editor(page).getByRole('button', { name: 'Close', exact: true }).click();
    await confirmation(page).getByRole('button', { name: 'Save draft', exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await page.getByRole('button', { name: /Unfinished supplier/ }).click();
    await page.getByRole('button', { name: 'Resume draft', exact: true }).click();
    await expect(editor(page).getByLabel('Vendor', { exact: true })).toHaveValue('Unfinished supplier');
    const draftStatus = editor(page).locator('.po-draft-actions').getByRole('status');
    await expect(draftStatus).toHaveText('No unsaved changes');
    await editor(page).getByLabel('Needed by (optional)').fill('2026-12-01');
    await expect(draftStatus).toHaveText('Unsaved changes');
    await editor(page).getByLabel('Needed by (optional)').fill('');
    await expect(draftStatus).toHaveText('No unsaved changes');
    await editor(page).getByText('Optional notes', { exact: true }).click();
    await editor(page).getByLabel('Notes', { exact: true }).fill('Handle with care');
    await editor(page).getByRole('button', { name: 'Close', exact: true }).click();
    await confirmation(page).getByRole('button', { name: 'Save draft', exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    expect(calls.map(call => call.action)).toEqual(['create', 'edit']);
    expect(calls[1].p).toMatchObject({ notes: 'Handle with care', version: 1 });
    expect(await unloadAllowed(page)).toBe(true);
    await page.getByRole('button', { name: /Unfinished supplier/ }).click();
    await page.getByRole('button', { name: 'Resume draft', exact: true }).click();
    await editor(page).getByLabel('Vendor', { exact: true }).fill('Discard this edit');
    await editor(page).getByRole('button', { name: 'Close', exact: true }).click();
    await confirmation(page).getByRole('button', { name: 'Discard changes' }).click();
    await page.getByRole('button', { name: /Unfinished supplier/ }).click();
    await page.getByRole('button', { name: 'Resume draft', exact: true }).click();
    await expect(editor(page).getByLabel('Vendor', { exact: true })).toHaveValue('Unfinished supplier');
    await editor(page).getByRole('button', { name: 'Close', exact: true }).click();
    await expect(confirmation(page)).toHaveCount(0);
    expect(calls.map(call => call.action)).toEqual(['create', 'edit']);
  });
}

test('invalid and failed saves retain inputs and protection; retry saves once', async ({ page }) => {
  const { calls } = await fixture(page);
  await page.goto('/#orders');
  await page.getByRole('button', { name: 'New purchase order', exact: true }).click();
  await editor(page).getByLabel('Vendor', { exact: true }).fill('Incomplete draft');
  await editor(page).getByRole('button', { name: 'Close', exact: true }).click();
  await confirmation(page).getByRole('button', { name: 'Save draft', exact: true }).click();
  await expect(confirmation(page)).toHaveCount(0);
  await expect(editor(page).getByLabel('Google Sheet URL')).toBeFocused();
  await expect(editor(page).getByLabel('Vendor', { exact: true })).toHaveValue('Incomplete draft');
  expect(calls).toEqual([]);
  expect(await unloadAllowed(page)).toBe(false);
  await fillDraft(editor(page));
  await editor(page).getByLabel('Google Sheet URL').fill('https://example.invalid/not-a-sheet');
  await editor(page).getByRole('button', { name: 'Close', exact: true }).click();
  await confirmation(page).getByRole('button', { name: 'Save draft', exact: true }).click();
  await expect(editor(page).getByRole('alert')).toContainText('docs.google.com');
  expect(calls).toEqual([]);
  await editor(page).getByLabel('Google Sheet URL').fill('https://docs.google.com/spreadsheets/d/Draft123/edit');
  let attempts = 0;
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/rpc/finance_mutate', async route => {
    if (++attempts === 1) {
      await pending;
      await route.fulfill({ status: 409, json: { message: 'Fixture save failed. Please try again.' } });
    } else await route.fallback();
  });
  await editor(page).getByRole('button', { name: 'Close', exact: true }).click();
  await confirmation(page).getByRole('button', { name: 'Save draft', exact: true }).click();
  await expect(editor(page).getByRole('button', { name: 'Save draft', exact: true })).toBeDisabled();
  await expect(editor(page).getByRole('button', { name: 'Close', exact: true })).toBeDisabled();
  await editor(page).getByRole('button', { name: 'Save draft', exact: true }).evaluate((button: HTMLButtonElement) => button.click());
  release();
  await expect(editor(page).getByRole('alert')).toContainText('Fixture save failed');
  await expect(editor(page).getByLabel('Vendor', { exact: true })).toHaveValue('Unfinished supplier');
  expect(await unloadAllowed(page)).toBe(false);
  await editor(page).getByRole('button', { name: 'Save draft', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Resume draft', exact: true })).toBeVisible();
  expect(calls.map(call => call.action)).toEqual(['create']);
  expect(attempts).toBe(2);
});

test('Sheet opens separately; same-document Back/Forward retain the editor and native reload can be canceled', async ({ page, context }) => {
  const { calls } = await fixture(page);
  await context.route('https://docs.google.com/**', route => route.fulfill({ contentType: 'text/html', body: '<h1>Fixture sheet</h1>' }));
  await page.goto('/#orders');
  await page.getByRole('button', { name: 'New purchase order', exact: true }).click();
  await fillDraft(editor(page));
  const link = editor(page).getByRole('link', { name: 'Open Google Sheet in a new tab ↗' });
  await expect(link).toHaveAttribute('target', '_blank');
  await expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  const popupPromise = page.waitForEvent('popup');
  await link.click();
  const popup = await popupPromise;
  await expect(popup.getByRole('heading', { name: 'Fixture sheet' })).toBeVisible();
  await popup.close();
  await page.evaluate(() => { location.hash = '#dashboard'; });
  await expect(page).toHaveURL(/#dashboard$/);
  await page.goBack();
  await expect(page).toHaveURL(/#orders$/);
  await page.goForward();
  await expect(page).toHaveURL(/#dashboard$/);
  await expect(editor(page).getByLabel('Vendor', { exact: true })).toHaveValue('Unfinished supplier');
  const documentStarted = await page.evaluate(() => performance.timeOrigin);
  const warningPromise = page.waitForEvent('dialog');
  // A dismissed beforeunload intentionally never commits a navigation. Do not
  // await page.reload(), which waits for that nonexistent load until timeout.
  await page.evaluate(() => { setTimeout(() => location.reload(), 0); });
  const warning = await warningPromise;
  expect(warning.type()).toBe('beforeunload');
  await warning.dismiss();
  await expect(editor(page).getByLabel('Vendor', { exact: true })).toHaveValue('Unfinished supplier');
  expect(await page.evaluate(() => performance.timeOrigin)).toBe(documentStarted);
  expect(await page.evaluate(() => Object.keys(localStorage))).toEqual(['4418-finance-auth']);
  expect(await page.evaluate(() => Object.keys(sessionStorage))).toEqual([]);
  expect(calls).toEqual([]);
});

test('same-user token refresh and sign-in retain edits; an actual account change clears them', async ({ page }) => {
  const { calls, switchUser } = await fixture(page);
  await page.goto('/#orders');
  await page.getByRole('button', { name: 'New purchase order', exact: true }).click();
  await editor(page).getByLabel('Vendor', { exact: true }).fill('Do not lose on refocus');
  await page.evaluate(async () => {
    const path = '/src/service.ts';
    const { client } = await import(path);
    await client.auth.refreshSession();
    await client.auth.signInWithPassword({ email: 'fixture@example.invalid', password: 'fixture-password' });
  });
  await expect(editor(page).getByLabel('Vendor', { exact: true })).toHaveValue('Do not lose on refocus');
  expect(await unloadAllowed(page)).toBe(false);
  switchUser();
  await page.evaluate(async () => {
    const path = '/src/service.ts';
    const { client } = await import(path);
    await client.auth.signInWithPassword({ email: 'fixture@example.invalid', password: 'fixture-password' });
  });
  await expect(editor(page)).toHaveCount(0);
  expect(await unloadAllowed(page)).toBe(true);
  expect(calls).toEqual([]);
});

test('same-user reauthentication retries an initial Finance load failure', async ({ page }) => {
  await fixture(page);
  let attempts = 0;
  await page.route('**/rpc/finance_context', async route => {
    if (++attempts === 1) await route.fulfill({ status: 503, json: { message: 'Fixture initial load failed' } });
    else await route.fallback();
  });
  await page.goto('/#orders');
  await expect(page.getByRole('heading', { name: 'Finance could not load', exact: true })).toBeVisible();
  await page.evaluate(async () => {
    const path = '/src/service.ts';
    const { client } = await import(path);
    await client.auth.signInWithPassword({ email: 'fixture@example.invalid', password: 'fixture-password' });
  });
  await expect(page.getByRole('button', { name: 'New purchase order', exact: true })).toBeVisible();
  expect(attempts).toBeGreaterThan(1);
});

test('sign-out during a pending save clears the editor; late success cannot reopen it', async ({ page }) => {
  await fixture(page);
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/rpc/finance_mutate', async route => {
    await pending;
    await route.fulfill({ json: '00000000-0000-0000-0000-000000000100' });
  });
  await page.goto('/#orders');
  await page.getByRole('button', { name: 'New purchase order', exact: true }).click();
  await fillDraft(editor(page));
  await editor(page).getByRole('button', { name: 'Save draft', exact: true }).click();
  await expect(editor(page).getByRole('button', { name: 'Save draft', exact: true })).toBeDisabled();
  await page.evaluate(async () => {
    const path = '/src/service.ts';
    const { client } = await import(path);
    await client.auth.signOut();
  });
  await expect(page.getByRole('heading', { name: 'Finance sign in', exact: true })).toBeVisible();
  release();
  await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeEnabled();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(await unloadAllowed(page)).toBe(true);
});
