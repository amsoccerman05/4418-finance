import { test, expect, type Page } from "@playwright/test";
const student = "00000000-0000-0000-0000-000000000001",
  reviewer = "00000000-0000-0000-0000-000000000004";
async function mock(page: Page, capabilities: string[] = [], isAdmin = false) {
  const id = capabilities.length || isAdmin ? reviewer : student;
  const calls: any[] = [];
  const orders: any[] = [];
  const approvals: any[] = [];
  const history: any[] = [];
  const revisions: any[] = [];
  const context = {
    profile: {
      id,
      display_name: id === student ? "Alex Student" : "Finance Lead",
      role: "student",
    },
    can_create: true,
    is_admin: isAdmin,
    capabilities,
    areas: [{ id: "area", name: "Fabrication", active: true }],
    people: [
      { id: student, name: "Alex Student" },
      { id: reviewer, name: "Finance Lead" },
    ],
  };
  await page.addInitScript(
    ({ id }) =>
      localStorage.setItem(
        "4418-finance-auth",
        JSON.stringify({
          access_token: "fixture-token",
          refresh_token: "fixture-refresh",
          expires_at: 4000000000,
          token_type: "bearer",
          user: {
            id,
            aud: "authenticated",
            app_metadata: {},
            user_metadata: {},
            email: "fixture@example.invalid",
            created_at: "2026-01-01T00:00:00Z",
          },
        }),
      ),
    { id },
  );
  await page.route(
    "https://finance-test.supabase.invalid/**",
    async (route) => {
      const path = new URL(route.request().url()).pathname;
      let body: any;
      try {
        body = route.request().postDataJSON();
      } catch {}
      let data: any = [];
      if(path.endsWith("/finance_budget_context")) data={can_manage:false};
      else if(path.endsWith("/finance_budget_approval")) data={required:false,categories:[]};
      else if (path.endsWith("/finance_context")) data = context;
      else if (path.endsWith("/finance_purchase_orders")) data = orders;
      else if (path.endsWith("/finance_po_approvals")) data = approvals;
      else if (path.endsWith("/finance_po_history")) data = history;
      else if (path.endsWith("/finance_po_revisions")) data = revisions;
      else if (path.endsWith("/finance_assignments")) data = [];
      else if (path.endsWith("/finance_mutate")) {
        calls.push(body);
        const p = body.p;
        data = p.id || "po-1";
        if (body.action === "create")
          orders.push({
            ...p,
            id: data,
            po_number: 1,
            requester_id: id,
            status: "draft",
            revision: 0,
            version: 1,
            created_at: new Date().toISOString(),
            school_reference: "",
          });
        else {
          const po = orders.find((p) => p.id === body.p.id);
          if (body.action === "submit") {
            po.revision++;
            po.status = "awaiting_approval";
            revisions.push({
              po_id: po.id,
              revision: po.revision,
              metadata: { ...po },
              submitted_by: id,
              submitted_at: new Date().toISOString(),
            });
          }
          if (body.action === "approve") {
            approvals.push({
              id: "a-" + approvals.length,
              po_id: po.id,
              revision: po.revision,
              slot: p.slot,
              action: "approved",
              actor_id: id,
              acted_at: new Date().toISOString(),
              explanation: p.reason,
              override_reason: p.override_reason,
            });
            if (
              approvals.filter(
                (a) => a.po_id === po.id && a.revision === po.revision,
              ).length === 2
            )
              po.status = "approved";
          }
          if (body.action === "request_changes") {
            if (!p.reason) {
              await route.fulfill({
                status: 400,
                json: { message: "Explain the requested changes" },
              });
              return;
            }
            po.status = "changes_requested";
          }
          if (body.action === "edit") {
            Object.assign(po, p);
            po.status = "draft";
          }
          if (body.action === "school_submit") {
            po.status = "submitted_to_school";
            po.school_reference = p.reference;
            po.school_submitted_by = id;
            po.school_submitted_at = new Date().toISOString();
            po.school_note = p.note;
          }
          po.version++;
        }
        history.push({
          id: history.length + 1,
          po_id: data,
          revision: orders[0]?.revision || 0,
          action: body.action,
          actor_id: id,
          created_at: new Date().toISOString(),
          details: { reason: p.reason || "" },
        });
      } else if (path.endsWith("/logout")) data = {};
      else throw new Error("Unexpected fixture request " + path);
      await route.fulfill({ status: 200, json: data });
    },
  );
  return { orders, approvals, calls, context };
}
for (const width of [390, 1440])
  test(`student draft and submit, no duplicate sheet form, ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    const { calls } = await mock(page);
    await page.goto("/#orders");
    await page.getByRole("button", { name: "New purchase order" }).click();
    const dialog = page.getByRole("dialog");
    await dialog
      .getByLabel("Google Sheet URL")
      .fill("https://docs.google.com/spreadsheets/d/PO123/edit");
    await dialog.getByLabel("Vendor", { exact: true }).fill("Robot Supplier");
    await dialog.getByLabel("Total amount (USD)").fill("125.50");
    await dialog.getByLabel("Functional area").selectOption("area");
    await dialog
      .getByLabel("Purpose / short description")
      .fill("Replacement motor");
    await dialog.getByRole("button", { name: "Save draft" }).click();
    await expect(
      dialog.getByRole("link", { name: "Open Google Sheet ↗" }),
    ).toHaveAttribute("rel", "noopener noreferrer");
    await dialog
      .getByRole("button", { name: "Submit for approval", exact: true })
      .click();
    await expect(
      dialog.getByText("Awaiting Approval", { exact: true }),
    ).toBeVisible();
    await expect(
      dialog.getByRole("button", { name: "Approve & assign budget" }),
    ).toHaveCount(0);
    expect(calls.map((c) => c.action)).toEqual(["create", "submit"]);
    expect(
      await page.evaluate(() => document.body.scrollWidth <= innerWidth),
    ).toBe(true);
    await dialog.screenshot({ path: `test-results/student-${width}.png` });
    await dialog.getByRole("button", { name: "Close", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "My purchase orders" }),
    ).toBeVisible();
    await page.screenshot({
      path: `test-results/overview-${width}.png`,
      fullPage: true,
    });
  });
for (const width of [390, 1440])
  test(`approver actions and school submission ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    const { orders, approvals, calls } = await mock(page, [
      "finance_approver",
      "school_submitter",
    ]);
    orders.push({
      id: "po-1",
      po_number: 1,
      requester_id: student,
      area_id: "area",
      vendor: "Robot Supplier",
      amount: 125.5,
      purpose: "Replacement motor",
      sheet_url: "https://docs.google.com/spreadsheets/d/PO123/edit",
      status: "awaiting_approval",
      revision: 1,
      version: 2,
      school_reference: "",
      notes: "",
    });
    approvals.push({
      id: "po-a",
      po_id: "po-1",
      revision: 1,
      slot: "po_approver",
      action: "approved",
      actor_id: student,
      acted_at: new Date().toISOString(),
      explanation: "",
    });
    await page.goto("/#orders");
    await page.getByRole("button", { name: /Robot Supplier/ }).click();
    await page
      .getByRole("button", { name: "Approve & assign budget", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "Mark submitted to school" }),
    ).toBeVisible();
    await page
      .getByLabel("School PO / reference number (optional)")
      .fill("SCH-123");
    await page
      .getByRole("button", { name: "Mark submitted to school" })
      .click();
    await expect(
      page.getByRole("dialog").getByText("Reference: SCH-123"),
    ).toBeVisible();
    expect(calls.map((c) => c.action)).toEqual(["approve", "school_submit"]);
    await expect(
      page.getByRole("button", { name: "Edit purchase order" }),
    ).toHaveCount(0);
    await page
      .getByRole("dialog")
      .screenshot({ path: `test-results/approval-${width}.png` });
    expect(
      await page.evaluate(() => document.body.scrollWidth <= innerWidth),
    ).toBe(true);
  });
test("failed approval action keeps error visible in dialog; search and filters remain scoped", async ({
  page,
}) => {
  const { orders } = await mock(page, ["finance_approver"]);
  orders.push({
    id: "po-1",
    po_number: 1,
    requester_id: student,
    area_id: "area",
    vendor: "Robot Supplier",
    amount: 125,
    purpose: "Motor",
    sheet_url: "https://docs.google.com/spreadsheets/d/PO123/edit",
    status: "awaiting_approval",
    revision: 1,
    version: 2,
    school_reference: "",
    notes: "",
  });
  await page.goto("/#orders");
  await page.getByRole("button", { name: /Robot Supplier/ }).click();
  await page
    .getByRole("button", { name: "Request changes", exact: true })
    .click();
  await expect(page.getByRole("dialog").getByRole("alert")).toContainText(
    "Explain the requested changes",
  );
  await page
    .getByLabel("Explanation / requested changes")
    .fill("Include shipping");
  await page
    .getByRole("button", { name: "Request changes", exact: true })
    .click();
  await expect(
    page.getByRole("dialog").getByText("Changes Requested", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await page.getByLabel("Search", { exact: true }).fill("missing");
  await expect(page.getByText(/No purchase orders in this view/)).toBeVisible();
  await page.getByLabel("Search", { exact: true }).fill("Alex Student");
  await expect(
    page.getByRole("button", { name: /Robot Supplier/ }),
  ).toBeVisible();
});

for (const code of ["42501", "PGRST202"]) {
  test(`initial RPC error settles loading: ${code}`, async ({ page }) => {
    await mock(page);
    await page.route("**/rpc/finance_context", route => route.fulfill({status: code === "42501" ? 403 : 404, json: {code, message:"Fixture RPC error"}}));
    await page.goto("/#orders");
    await expect(page.getByRole("heading", {name: code === "42501" ? "Finance access denied" : "Finance could not load"})).toBeVisible();
    await expect(page.getByText("Loading Finance…")).toHaveCount(0);
  });
}
test("stalled data request has a bounded error state", async ({ page }) => {
  await mock(page);
  await page.route("**/rpc/finance_context", () => new Promise(() => {}));
  await page.goto("/#orders");
  await expect(page.getByText("Finance data timed out. Reload to try again.")).toBeVisible({timeout:20000});
  await expect(page.getByText("Loading Finance…")).toHaveCount(0);
});
test("signed out users see sign-in", async ({page}) => {
 await page.route("https://team.frc4418.org/",r=>r.fulfill({contentType:"text/html",body:"<h1>Team sign in</h1>"}));
  await page.goto("/#orders");
  await expect(page).toHaveURL("https://team.frc4418.org/");
});
for(const width of [390,1440])test(`email deep link opens only a loaded permitted PO ${width}`,async({page})=>{
 await page.setViewportSize({width,height:900});const {orders}=await mock(page);const id='10000000-0000-0000-0000-000000000027';
 orders.push({id,po_number:27,requester_id:student,area_id:'area',vendor:'Linked supplier',amount:125.5,purpose:'Replacement motor',sheet_url:'https://docs.google.com/spreadsheets/d/PO123/edit',status:'awaiting_approval',revision:1,version:1,notes:'',created_at:'2026-09-12T00:00:00Z',updated_at:'2026-09-12T00:00:00Z'});
 await page.goto('/#po/'+id);await expect(page.getByRole('dialog',{name:'PO 27',exact:true})).toBeVisible();
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 await page.goto('/#po/10000000-0000-0000-0000-000000000099');await expect(page.getByRole('heading',{name:'Purchase orders',exact:true})).toBeVisible();await expect(page.getByRole('dialog')).toHaveCount(0);
});
