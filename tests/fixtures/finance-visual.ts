import { type Page } from "@playwright/test";
const uid = "00000000-0000-0000-0000-000000000007",
  poid = "00000000-0000-0000-0000-000000000101";
export async function financeFixture(page: Page, allowed = true) {
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
export async function financeNav(page: Page, name: string) {
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
