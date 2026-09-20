import { test, expect, type Page } from "@playwright/test";
const uid = "00000000-0000-0000-0000-000000000007",
  poid = "00000000-0000-0000-0000-000000000101";
async function fixture(page: Page, allowed = true) {
  const calls: any[] = [];
  const season = {
    id: "season",
    name: "2026–27",
    status: "active",
    version: 1,
    starting_funds: 1000,
    reserve_target: 100,
  };
  const category = {
    id: "parts",
    name: "Robot Parts",
    description: "Robot purchases",
    display_order: 0,
    active: true,
    allocation: 700,
    forecast: 650,
    restricted: 500,
    expected: 200,
    funded: 1200,
    requested: 100,
    committed: 0,
    spent: 300,
    available: 800,
  };
  const budget: any = {
    can_manage: allowed,
    can_classify: allowed,
    seasons: [season],
    summary: {
      season,
      starting_funds: 1000,
      received: 500,
      expected: 200,
      restricted: 500,
      actual_funding: 1500,
      allocated: 1200,
      unallocated: 300,
      requested: 100,
      committed: 0,
      spent: 300,
      credits: 0,
      available: 1100,
      categories: [category],
    },
    income: [],
    expenses: [],
    history: [],
    po_links: [],
    uncategorized: [],
    positions: [{ key: "software_lead", name: "Software Lead", enabled: true }],
  };
  const order = {
    id: poid,
    po_number: 42,
    requester_id: "student",
    area_id: "area",
    vendor: "Robot vendor",
    amount: 1084.32,
    purpose: "Spare motor",
    status: "awaiting_approval",
    revision: 1,
    version: 2,
    sheet_url: "https://docs.google.com/spreadsheets/d/PO123/edit",
    notes: "",
    school_reference: "",
  };
  await page.addInitScript(
    ({ uid }) =>
      localStorage.setItem(
        "4418-finance-auth",
        JSON.stringify({
          access_token: "test",
          refresh_token: "test",
          expires_at: 4000000000,
          token_type: "bearer",
          user: {
            id: uid,
            aud: "authenticated",
            app_metadata: {},
            user_metadata: {},
            email: "test@example.invalid",
            created_at: "2026-01-01T00:00:00Z",
          },
        }),
      ),
    { uid },
  );
  await page.route("https://finance-test.supabase.invalid/**", async (r) => {
    const path = new URL(r.request().url()).pathname;
    let body: any;
    try {
      body = r.request().postDataJSON();
    } catch {}
    let data: any = [];
    if (path.endsWith("/finance_context"))
      data = {
        profile: {
          id: uid,
          display_name: "Budget leader",
          role: allowed ? "mentor" : "student",
        },
        can_create: true,
        is_admin: allowed,
        capabilities: allowed ? ["finance_approver"] : [],
        areas: [{ id: "area", name: "Power", active: true }],
        people: [{ id: uid, name: "Budget leader" }],
      };
    else if (path.endsWith("/finance_budget_context"))
      data = allowed ? budget : { can_manage: false };
    else if (path.endsWith("/finance_purchase_orders")) data = [order];
    else if (path.endsWith("/finance_budget_approval"))
      data = {
        required: true,
        season_id: "season",
        categories: [{ ...category, projected_available: -284.32 }],
      };
    else if (path.endsWith("/finance_budget_manage")) {
      calls.push(body);
      data = "new-id";
      if (budget.summary) budget.summary.season.version++;
    } else if (path.endsWith("/finance_mutate")) {
      calls.push(body);
      data = poid;
      order.version++;
    }
    await r.fulfill({ status: 200, json: data });
  });
  return { calls, budget };
}
async function nav(page: Page, name: string) {
  if (
    await page
      .getByRole("button", { name: "Finance menu", exact: true })
      .isVisible()
  )
    await page
      .getByRole("button", { name: "Finance menu", exact: true })
      .click();
  await page
    .getByRole("navigation", { name: "Finance workspace" })
    .getByRole("link", { name, exact: true })
    .click();
}
for (const width of [390, 1440]) {
  test(`Budget core workspaces forms and navigation ${width}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 844 });
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    const { calls } = await fixture(page);
    await page.goto("/");
    await expect(
      page.getByRole("heading", { name: "2026–27 Finance", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText("Expected income · planning only"),
    ).toBeVisible();
    await expect(page.locator(".available-hero").getByText("$1,100.00", { exact: true })).toBeVisible();
    await nav(page, "Budget");
    await expect(
      page.getByRole("heading", { name: "Categories", exact: true }),
    ).toBeVisible();
    await page.getByText("Move funds", { exact: true }).click();
    const transfer = page
      .locator("details.budget-editor")
      .filter({ has: page.locator("summary", { hasText: "Move funds" }) });
    await transfer
      .getByRole("combobox", { name: "From", exact: true })
      .selectOption("parts");
    await transfer.getByLabel("Amount", { exact: true }).fill("50");
    await transfer
      .getByLabel("Reason", { exact: true })
      .fill("Free funds for travel");
    await transfer.getByRole("button", { name: "Save", exact: true }).click();
    await expect.poll(() => calls.length).toBe(1);
    expect(calls[0]).toMatchObject({
      action: "transfer",
      p: {
        from_id: "parts",
        to_id: "",
        amount: "50",
        reason: "Free funds for travel",
        version: 1,
      },
    });
    await page.screenshot({
      path: `test-results/budget-${width}.png`,
      fullPage: true,
    });
    await nav(page, "Income");
    await expect(
      page.getByRole("heading", { name: "No income recorded yet" }),
    ).toBeVisible();
    await page.getByText("+ Add income", { exact: true }).click();
    await page.getByLabel("Source / sponsor").fill("Team sponsor");
    await page.getByLabel("Amount", { exact: true }).fill("500");
    await page.getByLabel("Restricted to").selectOption("parts");
    await page.getByLabel("Reason for change").fill("Pledge");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect.poll(() => calls.length).toBe(2);
    expect(calls[1].p).toMatchObject({
      category_id: "parts",
      status: "expected",
    });
    await nav(page, "Expenses");
    await expect(
      page.getByRole("heading", { name: "No manual expenses" }),
    ).toBeVisible();
    await page.getByText("+ Add credit", { exact: true }).click();
    const credit = page.locator("details[open]").filter({has:page.locator("summary",{hasText:"+ Add credit"})});
    await credit.getByLabel("Amount", { exact: true }).fill("40");
    await credit.getByLabel("Date", { exact: true }).fill("2026-09-20");
    await credit.getByLabel("Reason / notes").fill("Returned unused part");
    await credit.getByRole("button", { name: "Save", exact: true }).click();
    await expect.poll(() => calls.length).toBe(3);
    expect(calls[2].action).toBe("credit");
    await nav(page, "Admin / Settings");
    await expect(
      page.getByText("Amend season settings", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Finance assignments", exact: true }),
    ).toBeVisible();
    await nav(page, "Purchase Orders");
    await expect(
      page.getByRole("heading", { name: "Purchase orders", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "New purchase order", exact: true }),
    ).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    expect(errors).toEqual([]);
  });
  test(`Finance approval preview and PO deep link ${width}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 844 });
    const { calls } = await fixture(page);
    await page.goto("/#po/" + poid);
    const d = page.getByRole("dialog", { name: "PO 42", exact: true });
    await expect(d).toBeVisible();
    await d
      .getByRole("combobox", { name: "Budget category", exact: true })
      .selectOption("parts");
    await expect(d.getByRole("alert")).toContainText(
      "exceeds the Robot Parts available budget by $284.32",
    );
    await d.getByLabel("Budget override explanation").fill("Essential repair");
    await d
      .getByRole("button", { name: "Approve & assign budget", exact: true })
      .click();
    await expect.poll(() => calls.length).toBe(1);
    expect(calls[0]).toMatchObject({
      action: "approve",
      p: {
        category_id: "parts",
        budget_reason: "Essential repair",
        slot: "finance_approver",
      },
    });
    expect(await d.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(
      true,
    );
    await d.screenshot({ path: `test-results/budget-approval-${width}.png` });
  });
}
test("normal students cannot navigate to full budget; direct route remains private", async ({
  page,
}) => {
  await fixture(page, false);
  await page.goto("/#budget");
  await expect(
    page.getByText("Budget access is available to designated team leadership."),
  ).toBeVisible();
  await expect(
    page
      .getByRole("navigation")
      .getByRole("link", { name: "Budget", exact: true }),
  ).toHaveCount(0);
  await expect(page.getByText("$1,100.00", { exact: true })).toHaveCount(0);
});
test("blank season setup is available with no existing budget", async ({
  page,
}) => {
  const { budget, calls } = await fixture(page);
  budget.seasons = [];
  budget.summary = null;
  await page.goto("/");
  await expect(page.getByRole("heading", {name:"Dashboard",exact:true})).toBeVisible();
  await expect(page.getByRole("heading", {name:"No active budget"})).toBeVisible();
  await nav(page,"Budget");
  await expect(
    page.getByRole("heading", { name: "No active budget" }),
  ).toBeVisible();
  await page.getByText("Create season", { exact: true }).click();
  await page.getByLabel("Season name", { exact: true }).fill("2027–28");
  await page.getByRole("button", { name: "Create draft season" }).click();
  await expect.poll(() => calls.length).toBe(1);
  expect(calls[0]).toMatchObject({
    action: "create_season",
    p: { name: "2027–28", copy_season: "", copy_allocations: false },
  });
});

for (const width of [390, 1440]) test(`draft builder and progressive income ${width}`, async ({page}) => {
 await page.setViewportSize({width,height:844});const {budget,calls}=await fixture(page);budget.summary.season.status="draft";
 await page.goto('/#budget');await expect(page.getByRole('heading',{name:'1. Funding',exact:true})).toBeVisible();
 await expect(page.getByLabel('Starting / rollover funds',{exact:true})).toBeVisible();
 await expect(page.getByLabel('Robot Parts category name',{exact:true})).toBeVisible();
 const funding=page.locator('details').filter({has:page.locator('summary',{hasText:'Starting funds & reserve'})});
 await funding.getByLabel('Starting / rollover funds',{exact:true}).fill('2500');await funding.getByRole('button',{name:'Save funding'}).click();
 await expect.poll(()=>calls.length).toBe(1);expect(calls[0]).toMatchObject({action:'season',p:{name:'2026–27',starting_funds:'2500',reserve_target:'100',version:1}});
 const review=page.locator('.budget-review');await expect(review.getByRole('button',{name:'Activate season'})).toBeVisible();
 await expect.poll(()=>page.evaluate(()=>{const a=document.querySelector('.allocation-progress'),r=document.querySelector('.budget-review');return !!(a&&r&&(a.compareDocumentPosition(r)&Node.DOCUMENT_POSITION_FOLLOWING))})).toBe(true);
 page.once('dialog',dialog=>dialog.dismiss());await review.getByRole('button',{name:'Activate season'}).click();expect(calls.length).toBe(1);
 await page.screenshot({path:`test-results/draft-builder-${width}.png`,fullPage:true});
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 await nav(page,'Income');await expect(page.getByLabel('Source / sponsor')).not.toBeVisible();await page.getByText('+ Add income',{exact:true}).click();
 await expect(page.getByLabel('Reason for change')).toHaveCount(0);
 await expect(page.getByLabel('Expected date',{exact:true})).toBeVisible();await expect(page.getByLabel('Received date',{exact:true})).not.toBeVisible();
 await page.getByLabel('Source / sponsor').fill('Team sponsor');await page.getByLabel('Amount',{exact:true}).fill('200');
 await page.getByLabel('Expected date',{exact:true}).fill('2026-10-01');
 await page.getByLabel('Income status').selectOption('received');await expect(page.getByLabel('Expected date',{exact:true})).not.toBeVisible();
 await expect(page.getByLabel('Received date',{exact:true})).toHaveAttribute('required','');await page.getByLabel('Received date',{exact:true}).fill('2026-10-02');
 await page.getByLabel('Income status').selectOption('canceled');await expect(page.getByLabel('Received date',{exact:true})).not.toBeVisible();
 await page.getByLabel('Income status').selectOption('received');await expect(page.getByLabel('Received date',{exact:true})).toHaveValue('2026-10-02');
 await page.getByRole('button',{name:'Save',exact:true}).click();await expect.poll(()=>calls.length).toBe(2);
 expect(calls[1]).toMatchObject({action:'income',p:{status:'received',expected_on:'2026-10-01',received_on:'2026-10-02'}});expect(calls[1].p).not.toHaveProperty('reason');
 await nav(page,'Budget');await page.getByLabel('Robot Parts allocation',{exact:true}).fill('800');await page.getByLabel('Robot Parts forecast',{exact:true}).fill('750');await page.getByRole('button',{name:'Save category',exact:true}).click();await expect.poll(()=>calls.length).toBe(3);expect(calls[2]).toMatchObject({action:'category',p:{id:'parts',name:'Robot Parts',allocation:'800',forecast:'750',active:true,description:'Robot purchases',display_order:0}});
});

for(const width of [390, 900, 1440])test(`V2B populated charts and record tables ${width}`,async({page})=>{
 await page.setViewportSize({width,height:900});const {budget,calls}=await fixture(page);
 budget.po_links=[{po_id:'spent-po',po_number:14,vendor:'Supplier',category_id:'parts',amount:1000,revision:2,bucket:'spent',status:'submitted_to_school'}];
 budget.history=[{id:2,po_id:'spent-po',revision:2,action:'school_submit',actor_name:'Mentor',created_at:'2026-08-15T12:00:00Z',details:{after:{school_submitted_at:'2026-08-15T12:00:00Z'}}},{id:1,po_id:'spent-po',revision:1,action:'school_submit',actor_name:'Mentor',created_at:'2026-07-01T12:00:00Z',details:{after:{school_submitted_at:'2026-07-01T12:00:00Z'}}}];
 budget.expenses=[{id:'expense',kind:'expense',category_id:'parts',amount:50,payee:'Hardware store',occurred_on:'2026-09-01',reason:'Fasteners'},{id:'credit',kind:'credit',category_id:'parts',amount:100,payee:'Supplier',occurred_on:'2026-09-02',reason:'Returned spare'}];
 budget.income=[{id:'sponsor',source:'Team sponsor',income_type:'Sponsorship',amount:500,status:'received',received_on:'2026-08-01',category_id:'parts',notes:'',reference:''},{id:'pledge',source:'Expected grant',income_type:'Grant',amount:200,status:'expected',expected_on:'2026-08-01',category_id:null,notes:'',reference:''}];
 const c=budget.summary.categories[0];c.spent=950;c.available=150;budget.summary.spent=950;budget.summary.available=450;
 budget.summary.categories.push({...c,id:'travel',name:'Travel',allocation:400,funded:400,restricted:0,spent:500,requested:0,committed:0,available:-100,forecast:null},{...c,id:'credit-category',name:'Credit balance',allocation:0,funded:0,restricted:0,spent:-25,requested:0,committed:0,available:25,forecast:null});
 await page.goto('/');await expect(page.getByRole('heading',{name:'2026–27 Finance'})).toBeVisible();
 await expect(page.getByRole('region',{name:'Category budget chart'})).toContainText('$100.00 over budget');await expect(page.getByText('$25.00 net credit',{exact:false})).toBeVisible();
 await expect(page.getByRole('region',{name:'Monthly operational spending'})).toContainText('Aug 2026');await expect(page.getByRole('region',{name:'Monthly operational spending'})).not.toContainText('Jul 2026');
 await expect(page.getByText('PO #14 submitted to school',{exact:true}).first()).toBeVisible();
 const months=await page.evaluate(async(b)=>{const m=await import('/src/finance-reporting.ts');return m.spendingMonths({...b,po_links:[...b.po_links,{po_id:'pending',bucket:'requested',amount:8000},{po_id:'reserved',bucket:'committed',amount:9000}]},'','2026-09-20')},budget);
 expect(months).toEqual({months:[{month:'2026-08',amount:1000},{month:'2026-09',amount:-50}],missing:0,outside:0});
 await page.screenshot({path:`test-results/v2b-dashboard-${width}.png`,fullPage:true});
 await nav(page,'Budget');await expect(page.getByRole('table',{name:'Category balances'})).toBeVisible();await expect(page.getByRole('table')).toContainText('Category totals');
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await page.screenshot({path:`test-results/v2b-budget-${width}.png`,fullPage:true});
 await nav(page,'Income');await expect(page.getByRole('table',{name:'Income records'})).toContainText('Team sponsor');await expect(page.getByLabel('Source / sponsor').first()).not.toBeVisible();
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await page.screenshot({path:`test-results/v2b-income-${width}.png`,fullPage:true});
 await page.getByRole('button',{name:'Edit Team sponsor',exact:true}).click();await expect(page.getByLabel('Received date',{exact:true}).last()).toBeVisible();
 const editor=page.locator('.editor-row');await editor.getByLabel('Amount',{exact:true}).fill('600');await editor.getByLabel('Reason for change').fill('Correct sponsor amount');await editor.getByRole('button',{name:'Save',exact:true}).click();await expect.poll(()=>calls.length).toBe(1);expect(calls[0]).toMatchObject({action:'income',p:{id:'sponsor',amount:'600',status:'received',reason:'Correct sponsor amount'}});
 await nav(page,'Expenses');await expect(page.getByRole('table',{name:'Manual expenses and credits'})).toContainText('Returned spare');await page.getByText('+ Add expense',{exact:true}).click();
 const form=page.locator('details.budget-editor').filter({has:page.locator('summary',{hasText:'+ Add expense'})});await form.getByLabel('Amount',{exact:true}).fill('25');await form.getByLabel('Vendor / payee').fill('Shop');await form.getByLabel('Date',{exact:true}).fill('2026-09-20');await form.getByLabel('Reason / notes').fill('Consumables');await form.getByRole('button',{name:'Save',exact:true}).click();await expect.poll(()=>calls.length).toBe(2);expect(calls[1].action).toBe('expense');
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 await nav(page,'Reports');await expect(page.getByRole('region',{name:'Category budget chart'})).toBeVisible();await page.getByLabel('Chart category').selectOption('parts');await expect(page.getByRole('region',{name:'Category budget chart'})).not.toContainText('Travel');
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
});
test('V2B empty season and missing dates stay honest',async({page})=>{
 const {budget}=await fixture(page);budget.summary.categories=[];budget.summary.spent=0;budget.po_links=[{po_id:'undated',category_id:null,amount:10,bucket:'spent',revision:1}];
 await page.goto('/#reports');await expect(page.getByText('No active categories to show yet.')).toBeVisible();await expect(page.getByText('No dated spending recorded yet.')).toBeVisible();await expect(page.getByText('1 record(s) lack a verified spending date and are not plotted.')).toBeVisible();
 const result=await page.evaluate(async(b)=>{const m=await import('/src/finance-reporting.ts');return m.spendingMonths({...b,expenses:[{kind:'expense',amount:50,occurred_on:'2099-01-01'}]},'','2026-09-20')},budget);expect(result.missing).toBe(1);expect(result.outside).toBe(1);expect(result.months).toEqual([]);
});
