import { test, expect } from '@playwright/test';
import { financeFixture, financeNav } from './fixtures/finance-visual';

// Fully intercepted local fixtures. These checks never access live financial data.
for (const width of [390, 700, 768, 1440]) {
  test(`Finance visual sweep and navigation ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 1000 });
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    const { budget, calls } = await financeFixture(page);
    const base = budget.summary.categories[0];
    budget.summary.categories.push(
      {...base,id:'travel',name:'Travel & competition',description:'Regional event costs',restricted:0,funded:850,allocation:850,forecast:800,requested:0,committed:150,spent:250,available:450},
      {...base,id:'outreach',name:'Outreach & team',description:'Community events',restricted:0,funded:350,allocation:350,forecast:300,requested:50,committed:0,spent:100,available:200},
    );
    Object.assign(budget.summary,{starting_funds:2000,received:500,actual_funding:2500,allocated:1900,unallocated:600,requested:150,committed:150,spent:650,available:1550});
    budget.income.push({id:'income-1',source:'Community sponsor',income_type:'Sponsorship',amount:500,status:'received',received_on:'2026-09-15',category_id:'parts',reference:'Season support',notes:'',version:1});
    budget.expenses.push({id:'expense-1',kind:'expense',payee:'Event supplies',category_id:'outreach',amount:100,occurred_on:'2026-09-20',reason:'Community demonstration materials'});
    const capture = async (name: string) => {
      await page.evaluate(() => document.fonts.ready);
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await page.screenshot({path: process.env.FINANCE_SCREENSHOT_DIR ? `${process.env.FINANCE_SCREENSHOT_DIR}/${name}-${width}.png` : testInfo.outputPath(`${name}-${width}.png`),fullPage:true});
    };
    await page.goto('/');
    await expect(page.getByRole('heading',{name:'2026–27 Finance',exact:true})).toBeVisible();
    await capture('dashboard');
    await financeNav(page,'Budget');
    await expect(page.getByRole('heading',{name:'Categories',exact:true})).toBeVisible();
    await capture('budget');
    await financeNav(page,'Expenses');
    await expect(page.getByRole('table',{name:'Manual expenses and credits'})).toBeVisible();
    await capture('expenses');
    await financeNav(page,'Reports');
    await expect(page.getByRole('button',{name:'Download Finance Workbook (.xlsx)'})).toBeVisible();
    await capture('reports');
    await financeNav(page,'Income');
    await expect(page.getByText('Community sponsor',{exact:true})).toBeVisible();
    await capture('income');
    await page.getByRole('button',{name:'+ Add income',exact:true}).click();
    await expect(page.getByLabel('Source / sponsor')).toBeVisible();
    await page.getByLabel('Source / sponsor').fill('Unsaved sponsor');
    await page.getByRole('button',{name:'Cancel',exact:true}).click();
    await expect(page.getByLabel('Source / sponsor')).toHaveCount(0);
    await page.getByRole('button',{name:'+ Add income',exact:true}).click();
    await expect(page.getByLabel('Source / sponsor')).toHaveValue('');
    await capture('income-form');
    await page.getByRole('button',{name:'Cancel',exact:true}).click();
    await financeNav(page,'Purchase Orders');
    await capture('orders');
    await page.getByRole('button',{name:'New purchase order',exact:true}).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await capture('order-form');
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.getByRole('button',{name:'New purchase order',exact:true})).toBeFocused();
    await page.getByRole('button',{name:'New purchase order',exact:true}).click();
    await page.getByRole('button',{name:'Close',exact:true}).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await page.goBack();
    await expect(page.getByRole('heading',{name:'Income',exact:true})).toBeVisible();
    await page.goForward();
    await expect(page.getByRole('heading',{name:'Purchase orders',exact:true})).toBeVisible();
    expect(calls).toEqual([]);
    expect(errors).toEqual([]);
  });
}

test('Approval queue selected state is clear without changing filter behavior', async ({ page }) => {
  const { calls } = await financeFixture(page);
  await page.goto('/#orders');
  const needsApproval = page.getByRole('button', { name: /Needs your approval/ });
  await needsApproval.click();
  await expect(needsApproval).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByLabel('Approval state')).toHaveValue('mine');
  await page.getByLabel('Approval state').selectOption('');
  await expect(needsApproval).toHaveAttribute('aria-pressed', 'false');
  await expect(page.getByRole('button', { name: /Robot vendor/ })).toBeVisible();
  expect(calls).toEqual([]);
});
