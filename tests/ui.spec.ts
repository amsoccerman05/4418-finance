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
          if (body.action === "receive") {
            po.status = "received";
            po.received_by = id;
            po.received_at = "2026-10-27T12:00:00Z";
            po.receipt_note = p.note;
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
  return { orders, approvals, calls, context, history, revisions };
}

function submittedOrder(overrides: Record<string, unknown> = {}) {
  return {
    id: "po-receiving", po_number: 42, requester_id: student, area_id: "area",
    vendor: "Receiving supplier", amount: 125.5, purpose: "Replacement motor",
    sheet_url: "https://docs.google.com/spreadsheets/d/Receiving_123/edit",
    status: "submitted_to_school", revision: 2, version: 5, notes: "Keep dry",
    submitted_at: "2026-10-20T12:00:00Z", school_submitted_at: "2026-10-21T12:00:00Z",
    school_submitted_by: reviewer, school_reference: "SCH-42", school_note: "Sent by school portal",
    received_by: null, received_at: null, receipt_note: "", ...overrides,
  };
}

for (const width of [390, 820, 1440]) {
  test(`received PO preserves facts, retries safely and moves to separate table ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const { orders, approvals, calls, history } = await mock(page, ["school_submitter"]);
    orders.push(submittedOrder());
    for (const [slot, actor] of [["po_approver", student], ["finance_approver", reviewer]]) {
      approvals.push({ id: slot, po_id: "po-receiving", revision: 2, slot, action: "approved", actor_id: actor, acted_at: "2026-10-21T10:00:00Z", explanation: "" });
    }
    history.push({ id: 1, po_id: "po-receiving", revision: 2, action: "school_submit", actor_id: reviewer, created_at: "2026-10-21T12:00:00Z", details: {} });
    const previousApprovals = JSON.stringify(approvals);
    let attempts = 0;
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    await page.route("**/rpc/finance_mutate", async route => {
      if (route.request().postDataJSON().action !== "receive") return route.fallback();
      attempts++;
      if (attempts === 1) return route.fulfill({ status: 409, json: { message: "Receipt could not be saved. Try again." } });
      await pending;
      await route.fallback();
    });
    await page.goto("/#orders");
    await expect(page.getByText("No purchase orders have been marked received yet.")).toBeVisible();
    await page.getByRole("button", { name: /Receiving supplier/ }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Receipt note (optional)").fill("All cartons arrived intact");
    const receive = dialog.getByRole("button", { name: "Mark received", exact: true });
    await receive.click();
    await expect(dialog.getByRole("alert")).toContainText("Receipt could not be saved. Try again.");
    await expect(dialog.getByLabel("Receipt note (optional)")).toHaveValue("All cartons arrived intact");
    expect(orders[0].status).toBe("submitted_to_school");
    await receive.click();
    await expect(receive).toBeDisabled();
    await expect(dialog.getByRole("button", { name: "Close", exact: true })).toBeDisabled();
    await receive.evaluate((button: HTMLButtonElement) => button.click());
    await page.keyboard.press("Escape");
    await expect(dialog).toBeVisible();
    release();
    await expect(dialog.getByText("All cartons arrived intact", { exact: true })).toBeVisible();
    await expect(dialog.getByText("Reference: SCH-42", { exact: true })).toBeVisible();
    await expect(dialog.getByText("Sent by school portal", { exact: true })).toBeVisible();
    await expect(dialog.getByText("Submitted To School", { exact: true })).toBeVisible();
    await expect(dialog.getByRole("button", { name: /Mark received|Edit purchase order|Submit for approval|Cancel purchase order|Approve/ })).toHaveCount(0);
    expect(attempts).toBe(2);
    expect(calls).toEqual([{ action: "receive", p: { id: "po-receiving", version: 5, note: "All cartons arrived intact" } }]);
    expect(orders[0].revision).toBe(2);
    expect(orders[0].version).toBe(6);
    expect(JSON.stringify(approvals)).toBe(previousApprovals);
    expect(history.map(entry => entry.action)).toEqual(["school_submit", "receive"]);
    await dialog.getByRole("button", { name: "Close", exact: true }).click();
    const table = page.getByRole("table", { name: "Received purchase orders", exact: true });
    await expect(table).toBeVisible();
    await expect(table.getByRole("columnheader")).toHaveCount(5);
    await expect(table).toContainText("SCH-42");
    await expect(table).toContainText("$125.50");
    await expect(table).toContainText("Alex Student");
    await expect(table).toContainText("Finance Lead");
    await expect(page.locator(".po-list")).toHaveCount(0);
    const opener = table.getByRole("button", { name: "PO 42 · Receiving supplier", exact: true });
    await opener.click();
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(opener).toBeFocused();
    await opener.click();
    await dialog.getByRole("button", { name: "Close", exact: true }).click();
    await expect(opener).toBeFocused();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: `test-results/received-po-${width}.png`, fullPage: true });
  });

  test(`received PO table sorts latest first and respects shared filters ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const { orders } = await mock(page, ["school_submitter"]);
    orders.push(
      submittedOrder({ id: "older", po_number: 99, vendor: "Older delivery", status: "received", received_at: "2026-10-25T12:00:00Z", received_by: reviewer }),
      submittedOrder({ id: "newer", po_number: 41, vendor: "Newer delivery", status: "received", received_at: "2026-10-26T12:00:00Z", received_by: reviewer }),
      submittedOrder({ id: "still-submitted", po_number: 43, vendor: "Still awaiting delivery" }),
    );
    await page.goto("/#orders");
    const table = page.getByRole("table", { name: "Received purchase orders", exact: true });
    await expect(table.getByRole("button")).toHaveText(["PO 41 · Newer delivery", "PO 99 · Older delivery"]);
    await expect(page.locator(".po-list")).toContainText("Still awaiting delivery");
    await expect(page.locator(".po-list")).not.toContainText("Newer delivery");
    await page.getByRole("button", { name: "Received 2", exact: true }).click();
    await expect(page.getByLabel("Approval state", { exact: true })).toHaveValue("received");
    await expect(page.locator(".po-list")).toHaveCount(0);
    await expect(table.getByRole("button")).toHaveCount(2);
    await page.getByLabel("Search", { exact: true }).fill("Newer");
    await expect(table.getByRole("button")).toHaveText(["PO 41 · Newer delivery"]);
    await page.getByLabel("Search", { exact: true }).fill("missing");
    await expect(page.getByText("No received purchase orders match these filters.")).toBeVisible();
    await page.getByRole("button", { name: "Clear filters", exact: true }).click();
    await page.getByLabel("Status", { exact: true }).selectOption("received");
    await expect(table.getByRole("button")).toHaveCount(2);
    await page.getByLabel("Status", { exact: true }).selectOption("submitted_to_school");
    await expect(table).toHaveCount(0);
    await expect(page.locator(".po-list")).toContainText("Still awaiting delivery");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}

for (const actor of ["student", "finance_approver", "finance_admin", "mentor", "admin"]) {
  test(`received action follows existing school-submission authority for ${actor}`, async ({ page }) => {
    const privileged = actor === "mentor" || actor === "admin";
    const { orders, context, calls } = await mock(page, actor.startsWith("finance_") ? [actor] : [], privileged || actor === "finance_admin");
    context.profile.role = privileged ? actor : "student";
    orders.push(submittedOrder());
    await page.goto("/#orders");
    await page.getByRole("button", { name: /Receiving supplier/ }).click();
    const receive = page.getByRole("dialog").getByRole("button", { name: "Mark received", exact: true });
    if (privileged) await expect(receive).toBeVisible();
    else {
      await expect(receive).toHaveCount(0);
      await expect(page.getByText("Waiting for a designated school submitter or mentor/admin to confirm receipt.")).toBeVisible();
    }
    expect(calls).toEqual([]);
  });
}

for (const width of [390, 1440])
  test(`active student without registration or a position can submit and resubmit once ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    // Finance uses the server's can_create decision. It must not require an
    // attendance record, registration flag, or leadership position in the UI.
    const { orders, calls, context } = await mock(page);
    expect(context.profile.role).toBe('student');
    expect(context.capabilities).toEqual([]);
    let release!: () => void;
    let pendingAction = 'create';
    let pending = new Promise<void>(resolve => { release = resolve; });
    await page.route('**/rpc/finance_mutate', async route => {
      if (route.request().postDataJSON().action === pendingAction) await pending;
      await route.fallback();
    });

    await page.goto('/');
    await page.getByRole('button', { name: 'New purchase order', exact: true }).click();
    let dialog = page.getByRole('dialog');
    await dialog.getByLabel('Google Sheet URL').fill('https://docs.google.com/spreadsheets/d/StudentRequest/edit');
    await dialog.getByLabel('Vendor', { exact: true }).fill('Student supplier');
    await dialog.getByLabel('Total amount (USD)').fill('125.50');
    await dialog.getByLabel('Functional area').selectOption('area');
    await dialog.getByLabel('Purpose / short description').fill('Student robot request');
    const save = dialog.getByRole('button', { name: 'Save draft', exact: true });
    await save.click();
    await expect(save).toBeDisabled();
    await save.evaluate((button: HTMLButtonElement) => button.click());
    release();
    await expect(dialog.getByRole('button', { name: 'Submit for approval', exact: true })).toBeVisible();
    expect(calls.filter(call => call.action === 'create')).toHaveLength(1);

    pendingAction = 'submit';
    pending = new Promise<void>(resolve => { release = resolve; });
    const submit = dialog.getByRole('button', { name: 'Submit for approval', exact: true });
    await submit.click();
    await expect(submit).toBeDisabled();
    await submit.evaluate((button: HTMLButtonElement) => button.click());
    release();
    await expect(dialog.getByText('Awaiting Approval', { exact: true })).toBeVisible();
    expect(calls.filter(call => call.action === 'submit')).toHaveLength(1);
    await expect(dialog.getByRole('button', { name: /Approve|Mark submitted to school|Request changes/ })).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Budget', exact: true })).toHaveCount(0);

    // Simulate a reviewer's response in the intercepted fixture, then exercise
    // the unchanged requester edit/resubmission path in the actual browser UI.
    orders[0].status = 'changes_requested';
    orders[0].version++;
    pendingAction = '';
    await page.goto('/#orders');
    await page.reload();
    await page.getByRole('button', { name: /Student supplier/ }).click();
    dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('button', { name: 'Resubmit for approval', exact: true })).toBeVisible();
    await dialog.getByRole('button', { name: 'Edit purchase order', exact: true }).click();
    await dialog.getByLabel('Total amount (USD)').fill('140.50');
    await dialog.getByRole('button', { name: 'Save draft', exact: true }).click();
    await dialog.getByRole('button', { name: 'Resubmit for approval', exact: true }).click();
    await expect(dialog.getByText('Awaiting Approval', { exact: true })).toBeVisible();
    expect(calls.map(call => call.action)).toEqual(['create', 'submit', 'edit', 'submit']);
    expect(orders[0].revision).toBe(2);
    expect(calls.every(call => !('requester_id' in call.p))).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await dialog.screenshot({ path: `test-results/active-student-request-${width}.png` });
  });

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
  await page.goto("/#orders");
  await expect(page.getByRole("heading", {name: "Finance sign in"})).toBeVisible();
  await expect(page).toHaveURL(/\/#orders$/);
  await expect(page.locator(".suite-header")).toHaveCount(0);
});
for(const width of [390,1440])test(`email deep link opens only a loaded permitted PO ${width}`,async({page})=>{
 await page.setViewportSize({width,height:900});const {orders}=await mock(page);const id='10000000-0000-0000-0000-000000000027';
 orders.push({id,po_number:27,requester_id:student,area_id:'area',vendor:'Linked supplier',amount:125.5,purpose:'Replacement motor',sheet_url:'https://docs.google.com/spreadsheets/d/PO123/edit',status:'awaiting_approval',revision:1,version:1,notes:'',created_at:'2026-09-12T00:00:00Z',updated_at:'2026-09-12T00:00:00Z'});
 await page.goto('/#po/'+id);await expect(page.getByRole('dialog',{name:'PO 27',exact:true})).toBeVisible();
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 await page.goto('/#po/10000000-0000-0000-0000-000000000099');await expect(page.getByRole('heading',{name:'Purchase orders',exact:true})).toBeVisible();await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('Finance Lead sees why their own PO has no approval action',async({page})=>{
 const {orders,context,calls}=await mock(page,['finance_approver']);context.profile.role='lead';
 orders.push({id:'po-1',po_number:1,requester_id:reviewer,area_id:'area',vendor:'Own request',amount:125.5,purpose:'Parts',sheet_url:'https://docs.google.com/spreadsheets/d/PO123/edit',status:'awaiting_approval',revision:1,version:2,school_reference:'',notes:''});
 await page.goto('/#orders');await page.getByRole('button',{name:/Own request/}).click();
 await expect(page.getByText('You requested this PO, so you cannot approve it yourself.',{exact:false})).toBeVisible();
 await expect(page.getByRole('button',{name:'Approve & assign budget'})).toHaveCount(0);expect(calls).toEqual([]);
});
