import { test, expect } from "@playwright/test";
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";

// Disposable PostgreSQL only. No project URL, credentials or production records.
const migration = "supabase/migrations/20261028033326_finance_po_actionability.sql";
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

test.beforeEach(async () => {
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
  await owner();
  await db.exec(sql("supabase/migrations/20261027204114_finance_po_received.sql"));
  before = { catalog: await catalog(), facts: await facts(seeded) };
  await db.exec(sql(migration));
});
test.afterEach(async () => { await db.close(); });

async function actionability(id?: string) {
  return (await db.query<{ id: string; season_closed: boolean }>(
    "select * from public.finance_po_actionability" + (id ? " where id=$1" : " order by id"), id ? [id] : [],
  )).rows;
}

test("actionability adds only a read-only security-barrier view and preserves existing data, functions, grants and RLS", async () => {
  expect(await facts(seeded)).toEqual(before.facts);
  const after = await catalog();
  expect(after.functions.filter((f: any) => f.name !== "finance_private.po_season_closed")).toEqual(before.catalog.functions);
  const lookup = after.functions.find((f: any) => f.name === "finance_private.po_season_closed");
  expect(lookup.prosecdef).toBe(true);
  expect(lookup.proconfig).toEqual(['search_path=""']);
  expect(after.policies).toEqual(before.catalog.policies);
  expect(after.relations.filter((r: any) => r.relname !== "finance_po_actionability")).toEqual(before.catalog.relations);
  const view = (await db.query<any>("select reloptions from pg_class where oid='public.finance_po_actionability'::regclass")).rows[0];
  expect(view.reloptions).toContain("security_barrier=true");
  expect(view.reloptions).toContain("security_invoker=true");
  await as("student");
  const privileges = (await db.query<any>("select has_table_privilege(current_user, 'public.finance_po_actionability', 'SELECT') readable, has_table_privilege(current_user, 'public.finance_po_actionability', 'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') writable")).rows[0];
  expect(privileges).toEqual({ readable: true, writable: false });
  expect(await actionability(seeded)).toEqual([{ id: seeded, season_closed: false }]);
  for (const command of ["delete from public.finance_po_actionability", "update public.finance_po_actionability set id=id", `insert into public.finance_po_actionability(id) values('${uid(999)}')`]) {
    await expect(db.exec(command)).rejects.toThrow(/permission denied/);
  }
});

test("actionability returns exactly existing visible PO IDs, not unrelated, inactive or anonymous records", async () => {
  const draft = await create();
  for (const person of Object.keys(ids) as Person[]) {
    await as(person);
    const visible = (await db.query<{ id: string }>("select id from public.finance_purchase_orders order by id")).rows.map(p => p.id);
    const results = await actionability();
    expect(results.map(p => p.id), person).toEqual(visible);
    for (const result of results) expect(Object.keys(result).sort()).toEqual(["id", "season_closed"]);
    if (["other", "inactive", "missing", "readonly"].includes(person)) expect(results).toEqual([]);
  }
  await as("submitter"); expect(await actionability(draft)).toEqual([]);
  await as("student"); expect(await actionability(draft)).toEqual([{ id: draft, season_closed: false }]);
  await owner(); await db.query("update public.profiles set primary_area_id=$1 where id=$2", [uid(999), ids.lead]);
  await as("lead"); expect(await actionability(seeded)).toEqual([]);
  await owner(); await db.exec("set role anon");
  await expect(actionability()).rejects.toThrow(/permission denied/);
});

test("existing visible requester and submitter learn only the closed-season fact without gaining budget access or receipt authority", async () => {
  const s = await season(); const id = await schoolSubmitted(s.category);
  await as("submitter"); expect(await actionability(id)).toEqual([{ id, season_closed: false }]);
  await manage(s.id, "close"); const original = await facts(id);
  for (const person of ["student", "submitter"] as const) {
    await as(person);
    expect(await actionability(id)).toEqual([{ id, season_closed: true }]);
    expect(await actionability(seeded)).toEqual([{ id: seeded, season_closed: false }]);
    expect((await db.query("select * from public.finance_seasons")).rows).toEqual([]);
    expect((await db.query("select * from public.finance_po_budget")).rows).toEqual([]);
    expect(await context(s.id)).toEqual({ can_manage: false });
  }
  await as("other"); expect(await actionability(id)).toEqual([]);
  await expect(act("submitter", id, "receive")).rejects.toThrow(/Closed season/);
  await expect(act("student", id, "receive")).rejects.toThrow(/capability/);
  expect(await facts(id)).toEqual(original);
});


test("private lookup independently denies invisible, nonexistent, revoked and unsigned callers", async () => {
  const lookup = async (id: string | null) => (await db.query<any>("select finance_private.po_season_closed($1::uuid) value", [id])).rows[0].value;
  for (const person of ["other", "inactive", "missing", "readonly"] as const) { await as(person); expect(await lookup(seeded)).toBeNull(); }
  await as("student"); expect(await lookup(seeded)).toBe(false); expect(await lookup(uid(999))).toBeNull(); expect(await lookup(null)).toBeNull();
  await as("submitter"); expect(await lookup(seeded)).toBe(false);
  await as("admin"); await call("assignment", { user_id: ids.submitter, capability: "school_submitter", active: false, reason: "Fixture revocation" });
  await as("submitter"); expect(await lookup(seeded)).toBeNull(); expect(await actionability(seeded)).toEqual([]);
  await owner(); await db.exec("select set_config('test.uid','',false);set role authenticated"); expect(await lookup(seeded)).toBeNull(); expect(await actionability()).toEqual([]);
  await owner(); await db.exec("set role anon"); await expect(lookup(seeded)).rejects.toThrow(/permission denied/);
});
