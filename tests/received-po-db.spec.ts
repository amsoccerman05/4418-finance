import { test, expect } from "@playwright/test";
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";

// Disposable PostgreSQL only. No project URL, credentials or production records.
const migration = "supabase/migrations/20261027204114_finance_po_received.sql";
const sql = (path: string) => readFileSync(path, "utf8");
const uid = (n: number) => `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
const ids = { student: uid(1), other: uid(2), finance: uid(3), coach: uid(4), submitter: uid(5), admin: uid(6), mentor: uid(7), financeAdmin: uid(8), lead: uid(9), readonly: uid(10), inactive: uid(11), missing: uid(12) };
type Person = keyof typeof ids;
const area = uid(100);
const base = { sheet_url: "https://docs.google.com/spreadsheets/d/ReceiptFixture/edit", vendor: "Fixture supplier", amount: 125.5, area_id: area, purpose: "Replacement parts", notes: "", needed_by: "" };
let db: PGlite;
let before: any;
let seeded: string;
async function owner() { await db.exec("reset role"); }
async function as(person: Person) { await db.exec(`reset role;select set_config('test.uid','${ids[person]}',false);set role authenticated`); }
async function call(action: string, p: Record<string, unknown> = {}) { return (await db.query<{ id: string }>("select public.finance_mutate($1,$2::jsonb) id", [action, JSON.stringify(p)])).rows[0].id; }
async function row(id: string) { return (await db.query<any>("select * from public.finance_purchase_orders where id=$1", [id])).rows[0]; }
async function act(person: Person, id: string, action: string, p: Record<string, unknown> = {}) {
  await owner(); const version = (await row(id)).version; await as(person); return call(action, { id, version, ...p });
}
async function create() { await as("student"); return call("create", base); }
async function approved(category?: string) {
  const id = await create(); await act("student", id, "submit");
  await act("finance", id, "approve", { slot: "finance_approver", ...(category ? { category_id: category } : {}) });
  await act("coach", id, "approve", { slot: "po_approver" }); return id;
}
async function schoolSubmitted(category?: string) { const id = await approved(category); await act("submitter", id, "school_submit", { reference: "SCHOOL-42", note: "Submitted to school" }); return id; }
async function facts(id: string) {
  await owner();
  return {
    po: await row(id),
    approvals: (await db.query("select * from public.finance_po_approvals where po_id=$1 order by id", [id])).rows,
    revisions: (await db.query("select * from public.finance_po_revisions where po_id=$1 order by revision", [id])).rows,
    history: (await db.query("select * from finance_private.history where po_id=$1 order by id", [id])).rows,
    notifications: (await db.query("select * from public.team_notifications where entity_id=$1 order by id", [id])).rows,
  };
}
async function catalog() {
  await owner();
  return {
    functions: (await db.query<any>(`select n.nspname||'.'||p.proname name,p.prosrc,p.proacl,p.prosecdef,p.proconfig from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in ('public','finance_private','notifications_private','team_private') order by 1`)).rows,
    policies: (await db.query("select * from pg_policies order by schemaname,tablename,policyname")).rows,
    relations: (await db.query("select n.nspname,c.relname,c.relrowsecurity,c.relacl from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname in ('public','finance_private','notifications_private') and c.relkind in ('r','v') order by 1,2")).rows,
  };
}
async function budget(action: string, p: Record<string, unknown> = {}) { return (await db.query<any>("select public.finance_budget_manage($1,$2::jsonb) id", [action, JSON.stringify(p)])).rows[0].id; }
async function context(season: string) { return (await db.query<any>("select public.finance_budget_context($1::uuid) value", [season])).rows[0].value; }
async function manage(season: string, action: string, p: Record<string, unknown> = {}) {
  await as("mentor"); const c = await context(season); return budget(action, { season_id: season, version: c.summary.season.version, reason: "Fixture review", ...p });
}
async function season() {
  await as("mentor"); const id = await budget("create_season", { name: "Receipt test season", starting_funds: 1000 });
  const category = await manage(id, "category", { name: "Parts", allocation: 700 });
  await manage(id, "activate", { confirmed: true }); return { id, category };
}

test.beforeEach(async ({}, testInfo) => {
  db = new PGlite();
  await db.exec(`create role anon;create role authenticated;create role service_role;create schema auth;
    create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('test.uid',true),'')::uuid$$;
    grant usage on schema auth to authenticated;grant execute on function auth.uid() to authenticated;
    create table public.areas(id uuid primary key,name text,active boolean,slug text unique default gen_random_uuid()::text);
    insert into public.areas(id,name,active) values('${area}','Build',true);
    create table public.profiles(id uuid primary key,display_name text,role text,active boolean,primary_area_id uuid,updated_at timestamptz default now());
    create table public.team_attendance_members(student_id uuid primary key,member_status text,team_area text default '');
    ${Object.entries(ids).filter(([name]) => name !== "missing").map(([name, id]) => `insert into public.profiles values('${id}','${name}','${["admin","mentor","lead","readonly"].includes(name) ? name : "student"}',${name !== "inactive"},'${area}',now());`).join("\n")}
  `);
  for (const path of [
    "supabase/migrations/202609120002_finance_v1.sql", "tests/fixtures/team_management_positions.sql",
    "supabase/migrations/202609120004_finance_notifications.sql", "supabase/migrations/202609190001_finance_notification_coverage.sql",
    "supabase/migrations/202609200001_finance_budget_core.sql", "supabase/migrations/202609200002_finance_workbook.sql",
    "supabase/migrations/20261007011342_allow_all_active_student_purchase_requests.sql",
    "supabase/migrations/20261018051306_finance_notification_delivery_authorization.sql",
  ]) await db.exec(sql(path));
  await db.exec("grant select on public.profiles to authenticated");
  await as("admin");
  for (const [person, position] of [["finance", "finance_lead"], ["coach", "lead_coach_1"]] as const) {
    await db.query("select public.team_manage('assign_position',$1::jsonb)", [JSON.stringify({ user_id: ids[person], position_key: position, reason: "Fixture assignment" })]);
  }
  for (const [person, capability] of [["submitter", "school_submitter"], ["financeAdmin", "finance_admin"]] as const) {
    await call("assignment", { user_id: ids[person], capability, active: true, reason: "Fixture assignment" });
  }
  seeded = await schoolSubmitted();
  before = { catalog: await catalog(), facts: await facts(seeded) };
  if (!testInfo.title.includes("source drift")) await db.exec(sql(migration));
});
test.afterEach(async () => { await db.close(); });

test("additive migration leaves existing PO facts, approval logic, policies and notification functions unchanged", async () => {
  const after = await facts(seeded);
  const { received_at, received_by, receipt_note, ...po } = after.po;
  expect(po).toEqual(before.facts.po);
  expect({ received_at, received_by, receipt_note }).toEqual({ received_at: null, received_by: null, receipt_note: "" });
  for (const key of ["approvals", "revisions", "history", "notifications"] as const) expect(after[key]).toEqual(before.facts[key]);
  const c = await catalog(); expect(c.policies).toEqual(before.catalog.policies); expect(c.relations).toEqual(before.catalog.relations);
  const old = before.catalog.functions.find((f: any) => f.name === "public.finance_mutate");
  const delegate = c.functions.find((f: any) => f.name === "finance_private.mutate_before_received");
  expect(delegate.prosrc).toBe(old.prosrc); expect(delegate.prosecdef).toBe(true); expect(delegate.proconfig).toEqual(old.proconfig);
  const changed = new Set(["public.finance_mutate", "public.finance_budget_manage", "public.finance_workbook_context"]);
  for (const f of before.catalog.functions.filter((f: any) => !changed.has(f.name))) expect(c.functions.find((n: any) => n.name === f.name)).toEqual(f);
  const budgetBefore = before.catalog.functions.find((f: any) => f.name === "public.finance_budget_manage");
  expect(c.functions.find((f: any) => f.name === budgetBefore.name)?.prosrc).toBe(budgetBefore.prosrc.replace("p.status not in ('submitted_to_school','cancelled')", "p.status not in ('submitted_to_school','received','cancelled')"));
});

test("receipt uses trusted actor/time, preserves school facts and approvals, and appends one audited transition", async () => {
  await act("submitter", seeded, "receive", { note: "  All parts arrived  ", received_by: ids.admin, received_at: "2000-01-01", status: "draft", revision: 99 });
  const after = await facts(seeded);
  expect(after.po).toMatchObject({ status: "received", received_by: ids.submitter, receipt_note: "All parts arrived", version: before.facts.po.version + 1, revision: before.facts.po.revision, school_reference: "SCHOOL-42" });
  expect(after.po.received_at).toBeTruthy(); expect(new Date(after.po.received_at).getFullYear()).toBeGreaterThan(2000);
  expect(after.po.school_submitted_at).toEqual(before.facts.po.school_submitted_at);
  expect(after.po.school_submitted_by).toBe(before.facts.po.school_submitted_by);
  expect(after.approvals).toEqual(before.facts.approvals); expect(after.revisions).toEqual(before.facts.revisions); expect(after.notifications).toEqual(before.facts.notifications);
  expect(after.history).toHaveLength(before.facts.history.length + 1);
  const event: any = after.history.at(-1);
  expect(event).toMatchObject({ action: "receive", actor_id: ids.submitter, revision: 1, details: { reason: "All parts arrived", before: { status: "submitted_to_school" }, after: { status: "received", received_by: ids.submitter } } });
  await as("student");
  const studentHistory = (await db.query<any>("select * from public.finance_po_history where po_id=$1 and action='receive'", [seeded])).rows[0];
  expect(studentHistory.details).toEqual({ reason: "All parts arrived" });
});

test("only submitted-to-school orders can advance, without bypassing either approval", async () => {
  const draft = await create(); await expect(act("admin", draft, "receive")).rejects.toThrow(/Only a submitted/);
  await act("student", draft, "submit"); await expect(act("admin", draft, "receive")).rejects.toThrow(/Only a submitted/);
  await act("finance", draft, "approve", { slot: "finance_approver" }); await expect(act("admin", draft, "receive")).rejects.toThrow(/Only a submitted/);
  await act("coach", draft, "request_changes", { slot: "po_approver", reason: "Clarify" }); await expect(act("admin", draft, "receive")).rejects.toThrow(/Only a submitted/);
  await act("student", draft, "cancel", { reason: "Cancelled" }); await expect(act("admin", draft, "receive")).rejects.toThrow(/Only a submitted/);
  const ready = await approved(); await expect(act("admin", ready, "receive")).rejects.toThrow(/Only a submitted/);
  // Owner-only corruption fixture verifies the receive RPC still requires both approvals.
  await owner(); await db.query("delete from public.finance_po_approvals where po_id=$1 and slot='finance_approver'", [seeded]);
  await expect(act("admin", seeded, "receive")).rejects.toThrow(/both current-revision approvals/);
});

test("requesters, approvers, leads, finance-only admins and inactive/readonly callers cannot receive", async () => {
  for (const person of ["student", "other", "finance", "coach", "financeAdmin", "lead", "readonly", "inactive", "missing"] as const) {
    await expect(act(person, seeded, "receive")).rejects.toThrow(/capability|unavailable/);
  }
  expect(await facts(seeded)).toEqual({ ...before.facts, po: { ...before.facts.po, received_by: null, received_at: null, receipt_note: "" } });
});

for (const person of ["submitter", "mentor", "admin"] as const) test(`${person} can receive with existing school-submission authority`, async () => {
  await act(person, seeded, "receive"); await as("student"); expect(await row(seeded)).toMatchObject({ status: "received", received_by: ids[person], receipt_note: "" });
});

test("revoked submission capability is rejected without receipt or audit writes", async () => {
  await as("admin"); await call("assignment", { user_id: ids.submitter, capability: "school_submitter", active: false, reason: "Fixture revocation" });
  await expect(act("submitter", seeded, "receive")).rejects.toThrow(/unavailable|capability/);
  const after = await facts(seeded); expect(after.po.status).toBe("submitted_to_school"); expect(after.history).toEqual(before.facts.history);
});

test("stale/repeated receipt and all further PO mutations fail without duplicate audit", async () => {
  const version = before.facts.po.version;
  await expect(act("submitter", seeded, "receive", { version: version - 1 })).rejects.toThrow(/Refresh/);
  await act("submitter", seeded, "receive"); const received = await facts(seeded);
  await expect(act("submitter", seeded, "receive", { version })).rejects.toThrow(/Refresh/);
  for (const action of ["receive", "edit", "submit", "cancel", "approve", "request_changes", "school_submit"]) {
    await expect(act("admin", seeded, action, { ...base, reason: "Fixture", slot: "finance_approver", override_reason: "Fixture" })).rejects.toThrow(/locked/);
  }
  expect(await facts(seeded)).toEqual(received);
});

test("receipt validation is atomic and callers cannot directly update receipt or audit fields", async () => {
  await expect(act("submitter", seeded, "receive", { note: "x".repeat(2001) })).rejects.toThrow(/2000/);
  await as("submitter");
  await expect(db.query("update public.finance_purchase_orders set received_by=$1 where id=$2", [ids.submitter, seeded])).rejects.toThrow(/permission denied/);
  await expect(db.query("insert into finance_private.history(po_id,action,actor_id) values($1,'receive',$2)", [seeded, ids.submitter])).rejects.toThrow(/permission denied/);
  await expect(db.query("select finance_private.mutate_before_received('cancel',$1::jsonb)", [JSON.stringify({ id: seeded, version: before.facts.po.version, reason: "Bypass" })])).rejects.toThrow(/permission denied/);
  await owner(); await db.exec("set role anon");
  await expect(call("receive", { id: seeded, version: before.facts.po.version })).rejects.toThrow(/permission denied/);
  const after = await facts(seeded); expect(after.po.status).toBe("submitted_to_school"); expect(after.history).toEqual(before.facts.history);
});

test("received rows retain the existing visibility boundaries", async () => {
  await act("submitter", seeded, "receive");
  await as("student"); expect((await row(seeded)).status).toBe("received");
  await as("other"); expect(await row(seeded)).toBeUndefined();
  expect((await db.query("select * from public.finance_po_history where po_id=$1", [seeded])).rows).toHaveLength(0);
  await as("lead"); expect((await row(seeded)).status).toBe("received");
  await owner(); await db.query("update public.profiles set primary_area_id=$1 where id=$2", [uid(999), ids.lead]);
  await as("lead"); expect(await row(seeded)).toBeUndefined();
});

test("receipt remains one spent impact, exports approval/receipt facts, and allows season close", async () => {
  const s = await season(); const id = await schoolSubmitted(s.category);
  await as("mentor"); const initial = await context(s.id);
  await act("submitter", id, "receive", { note: "Complete shipment" });
  await as("mentor"); const after = await context(s.id);
  for (const key of ["spent", "committed", "requested", "available"]) expect(after.summary[key]).toBe(initial.summary[key]);
  expect(after.summary.spent).toBe(125.5); expect(after.po_links.find((p: any) => p.po_id === id)).toMatchObject({ status: "received", bucket: "spent" });
  const workbook = (await db.query<any>("select public.finance_workbook_context($1::uuid) value", [s.id])).rows[0].value;
  const exported = workbook.purchase_orders.find((p: any) => p.id === id);
  expect(exported).toMatchObject({ status: "received", bucket: "spent", school_reference: "SCHOOL-42", received_by: ids.submitter, receipt_note: "Complete shipment" });
  expect(exported.approved_at).toBeTruthy(); expect(exported.received_at).toBeTruthy(); expect(exported.approvals).toHaveLength(2);
  await manage(s.id, "close"); expect((await context(s.id)).summary.season.status).toBe("closed");
});

test("closed-season lock remains in force and a failed receipt leaves all facts unchanged", async () => {
  const s = await season(); const id = await schoolSubmitted(s.category);
  await manage(s.id, "close"); const original = await facts(id);
  await expect(act("admin", id, "receive")).rejects.toThrow(/Closed season/);
  expect(await facts(id)).toEqual(original);
});


test("migration fails atomically on source drift instead of overwriting deployed reporting", async () => {
  for (const signature of ["public.finance_budget_manage(text,jsonb)", "public.finance_workbook_context(uuid)"]) {
    await owner();
    const original = (await db.query<any>("select pg_get_functiondef($1::regprocedure) definition", [signature])).rows[0].definition;
    // A harmless deployed customization must be reviewed, not silently replaced.
    await db.exec(original.replace("BEGIN", "BEGIN\n-- deployed customization"));
    // pg_get_functiondef preserves the lower-case source body in this fixture.
    const current = (await db.query<any>("select pg_get_functiondef($1::regprocedure) definition", [signature])).rows[0].definition;
    if (current === original) await db.exec(original.replace("begin", "begin\n-- deployed customization"));
    const preserved = await catalog();
    await expect(db.exec(sql(migration))).rejects.toThrow(/differs from reviewed source/);
    await db.exec("rollback");
    expect(await catalog()).toEqual(preserved);
    expect(await row(seeded)).toEqual(before.facts.po);
    await db.exec(original);
  }
});
