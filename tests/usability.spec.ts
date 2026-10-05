import { test, expect, type Route } from '@playwright/test';
import { financeFixture, financeNav } from './fixtures/finance-visual';

for (const width of [390, 700, 1440]) {
  test(`Purchase-order filters stay compact, discoverable and resettable ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const { calls } = await financeFixture(page);
    await page.goto('/#orders');
    await expect(page.getByLabel('Search', { exact: true })).toBeVisible();
    await expect(page.getByLabel('Approval state')).toBeVisible();
    await expect(page.getByLabel('Area', { exact: true })).toBeHidden();
    await page.locator('.secondary-filters > summary').click();
    await page.getByLabel('Area', { exact: true }).selectOption('area');
    await expect(page.locator('.secondary-filters > summary')).toContainText('1 applied');
    await page.locator('.secondary-filters > summary').click();
    await page.getByLabel('Search', { exact: true }).fill('missing');
    await expect(page.getByRole('heading', { name: 'No purchase orders in this view.' })).toBeVisible();
    await page.getByRole('button', { name: 'Clear filters', exact: true }).click();
    await expect(page.getByLabel('Search', { exact: true })).toHaveValue('');
    await expect(page.getByLabel('Area', { exact: true })).toHaveValue('');
    await expect(page.getByRole('button', { name: /Robot vendor/ })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Clear filters', exact: true })).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(calls).toEqual([]);
  });
}

test('Saving feedback is visible, errors preserve input, and retry confirms success', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const { calls } = await financeFixture(page);
  let release!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  let attempts = 0;
  const failOnce = async (route: Route) => {
    attempts++;
    await waiting;
    await route.fulfill({ status: 409, json: { message: 'Fixture save failed. Please try again.' } });
  };
  await page.route('**/rpc/finance_budget_manage', failOnce);
  await page.goto('/#income');
  await page.getByRole('button', { name: '+ Add income', exact: true }).click();
  await page.getByLabel('Source / sponsor').fill('Retry sponsor');
  await page.getByLabel('Amount', { exact: true }).fill('500');
  await page.getByLabel('Reason for change').fill('Record sponsorship');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('Saving changes…');
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
  const feedback = await page.locator('.finance-feedback').boundingBox();
  expect(feedback).not.toBeNull();
  expect(feedback!.y).toBeGreaterThanOrEqual(0);
  expect(feedback!.y + feedback!.height).toBeLessThanOrEqual(844);
  await expect.poll(() => attempts).toBe(1);
  release();
  await expect(page.getByRole('alert')).toContainText('Fixture save failed');
  await expect(page.getByLabel('Source / sponsor')).toHaveValue('Retry sponsor');
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeEnabled();
  await page.unroute('**/rpc/finance_budget_manage', failOnce);
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('Finance updated');
  await expect(page.getByRole('alert')).toHaveCount(0);
  expect(calls).toHaveLength(1);
  await page.getByRole('button', { name: 'Dismiss update' }).click();
  await expect(page.locator('.finance-feedback')).toHaveCount(0);
});

test('Student dashboard actions retain create permissions and home navigation', async ({ page }) => {
  const { calls } = await financeFixture(page, false);
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'New purchase order', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'New purchase order', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(page.getByRole('button', { name: 'New purchase order', exact: true })).toBeFocused();
  await page.getByRole('link', { name: 'View purchase orders', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Purchase orders', exact: true })).toBeVisible();
  await financeNav(page, 'Dashboard');
  await expect(page.getByRole('navigation', { name: 'Finance workspace' }).getByRole('link', { name: 'Team Hub / Home', exact: true })).toHaveAttribute('href', 'https://team.frc4418.org/');
  await page.route('**/rpc/finance_context', route => route.fulfill({json:{profile:{id:'student',display_name:'Read-only student',role:'student'},can_create:false,is_admin:false,capabilities:[],areas:[],people:[]}}));
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Your purchase orders', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'New purchase order', exact: true })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'View purchase orders', exact: true })).toBeVisible();
  expect(calls).toEqual([]);
});
