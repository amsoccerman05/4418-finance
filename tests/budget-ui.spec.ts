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
      page.getByRole("heading", { name: "Dashboard", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText("Expected income · planning only"),
    ).toBeVisible();
    await expect(page.getByText("$1,100.00", { exact: true })).toBeVisible();
    await nav(page, "Budget");
    await expect(
      page.getByRole("heading", { name: "Categories", exact: true }),
    ).toBeVisible();
    await page.getByText("Move funds", { exact: true }).click();
    const transfer = page
      .locator("details")
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
    await page.getByText("Add income", { exact: true }).click();
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
    await page.getByText("Record refund / credit", { exact: true }).click();
    const credit = page.locator("details[open]");
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
  await page.goto("/#budget");
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
