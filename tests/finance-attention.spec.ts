import { test, expect, type Page } from '@playwright/test';

const viewer = '00000000-0000-0000-0000-000000000001';
async function fixture(page: Page, options: { self?: boolean; status?: string; budget?: 'none' | 'empty'; capabilities?: string[]; coachApproved?: boolean } = {}) {
  const calls: unknown[] = [];
  const order = {
    id: '00000000-0000-0000-0000-000000000101', po_number: 42,
    requester_id: options.self === false ? 'requester' : viewer,
    area_id: 'area', vendor: 'Fixture supplier', amount: 125, purpose: 'Fixture parts',
    status: options.status || 'awaiting_approval', revision: 2, version: 3,
    sheet_url: 'https://docs.google.com/spreadsheets/d/Fixture123/edit',
    notes: '', school_reference: '', school_submitted_at: null, school_submitted_by: null,
  };
  const capabilities = options.capabilities ?? ['finance_approver', 'finance_admin'];
  const approvals = options.coachApproved === false ? [] : [{
    id: 'fixture-approval', po_id: order.id, revision: 2, slot: 'po_approver', action: 'approved',
    actor_id: 'coach', acted_at: '2026-01-02T12:00:00Z', explanation: '', override_reason: '',
  }];
  await page.addInitScript(viewer => localStorage.setItem('4418-finance-auth', JSON.stringify({
    access_token: 'fixture-token', refresh_token: 'fixture-refresh', expires_at: 4000000000, token_type: 'bearer',
    user: { id: viewer, aud: 'authenticated', email: 'fixture@example.invalid', app_metadata: {}, user_metadata: {}, created_at: '2026-01-01T00:00:00Z' },
  })), viewer);
  await page.route('https://finance-test.supabase.invalid/**', async route => {
    const path = new URL(route.request().url()).pathname;
    let result: unknown = [];
    if (path.endsWith('/finance_context')) result = {
      profile: { id: viewer, display_name: 'Fixture Finance Lead', role: 'lead' },
      can_create: true, is_admin: capabilities.includes('finance_admin'), capabilities,
      areas: [{ id: 'area', name: 'Fixture area', active: true }],
      people: [{ id: viewer, name: 'Fixture Finance Lead' }, { id: 'coach', name: 'Fixture Coach' }],
    };
    else if (path.endsWith('/finance_budget_context')) result = options.budget === 'none' ? { can_manage: false } : {
      can_manage: true, can_classify: false, seasons: [], summary: null, income: [], expenses: [],
      history: [], po_links: [], uncategorized: [], positions: [],
    };
    else if (path.endsWith('/finance_purchase_orders')) result = [order];
    else if (path.endsWith('/finance_po_approvals')) result = approvals;
    else if (path.endsWith('/finance_budget_approval')) result = { required: false };
    else if (path.endsWith('/finance_mutate') || path.endsWith('/finance_budget_manage')) {
      calls.push(route.request().postDataJSON());
      await route.fulfill({ status: 403, json: { message: 'No mutation authorized by this navigation test' } });
      return;
    }
    await route.fulfill({ json: result });
  });
  return { calls, order, approvals };
}

for (const width of [390, 1440]) {
  test(`Finance Lead sees why their own pending PO is waiting, without self-approval ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const { calls } = await fixture(page);
    await page.goto('/#dashboard');
    const attention = page.getByRole('region', { name: 'Needs attention', exact: true });
    await expect(attention).toBeVisible();
    await expect(attention).toContainText('No purchase orders currently need an approval or school submission from you.');
    await expect(attention.getByRole('heading', { name: 'Waiting for independent review' })).toBeVisible();
    await expect(attention).toContainText('different mentor or admin who has not already approved this revision');
    await expect(attention.getByRole('button', { name: /Review purchase/ })).toHaveCount(0);
    await attention.getByRole('button', { name: 'PO 42 · Fixture supplier · View approval status', exact: true }).click();
    const detail = page.getByRole('dialog').first();
    await expect(detail).toContainText('A mentor must review your request');
    await expect(detail).toContainText('explicit override reason and two different approvers');
    await expect(detail.getByRole('button', { name: /^Approve/ })).toHaveCount(0);
    await expect(detail.getByRole('button', { name: 'Request changes', exact: true })).toHaveCount(0);
    await detail.getByRole('button', { name: '← Back to results', exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await page.evaluate(() => { location.hash = '#dashboard'; });
    await page.reload();
    await expect(attention.getByRole('heading', { name: 'Waiting for independent review' })).toBeVisible();
    expect(calls).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await attention.screenshot({ path: `test-results/finance-independent-review-${width}.png` });
  });
}

test('actionable approval remains visible without budget access and is not an independent-review warning', async ({ page }) => {
  const { calls } = await fixture(page, { self: false, budget: 'none' });
  await page.goto('/#dashboard');
  const attention = page.getByRole('region', { name: 'Needs attention', exact: true });
  await expect(attention.getByRole('button', { name: 'PO 42 · Fixture supplier · Review purchase' })).toBeVisible();
  await expect(attention.getByRole('heading', { name: 'Waiting for independent review' })).toHaveCount(0);
  await attention.getByRole('button').click();
  await expect(page.getByRole('button', { name: 'Approve & assign budget', exact: true })).toBeVisible();
  expect(calls).toEqual([]);
});

test('Finance administration alone does not offer school submission', async ({ page }) => {
  const { calls } = await fixture(page, { status: 'approved' });
  await page.goto('/#dashboard');
  const attention = page.getByRole('region', { name: 'Needs attention', exact: true });
  await expect(attention).toContainText('No purchase orders currently need an approval or school submission from you.');
  await expect(attention.getByRole('button')).toHaveCount(0);
  await attention.getByRole('link', { name: 'Open purchase orders', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Purchase orders', exact: true })).toBeVisible();
  expect(calls).toEqual([]);
});

test('designated school submitter keeps the existing submission queue', async ({ page }) => {
  await fixture(page, { status: 'approved', capabilities: ['school_submitter'], budget: 'none' });
  await page.goto('/#dashboard');
  await expect(page.getByRole('region', { name: 'Needs attention', exact: true }).getByRole('button', { name: 'PO 42 · Fixture supplier · Submit to school' })).toBeVisible();
});

test('completed Finance approval removes the blocked-self explanation after reload', async ({ page }) => {
  const { approvals, calls } = await fixture(page);
  await page.goto('/#dashboard');
  await expect(page.getByRole('heading', { name: 'Waiting for independent review' })).toBeVisible();
  approvals.push({ ...approvals[0], id: 'second-fixture-approval', slot: 'finance_approver', actor_id: 'different-mentor' });
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Needs attention', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Waiting for independent review' })).toHaveCount(0);
  expect(calls).toEqual([]);
});
