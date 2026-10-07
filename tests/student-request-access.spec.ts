import { test, expect } from "@playwright/test";
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";

// Exercise the production RPC/RLS contracts in an isolated PostgreSQL engine.
// Shared suite prerequisites and mirrored position logic are fixtures;
// Finance migrations execute directly from the repository, including the delta.
const migration = "supabase/migrations/20261007011342_allow_all_active_student_purchase_requests.sql";
const sql = (path: string) => readFileSync(path, "utf8");
const uid = (n: number) => `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
const ids = {
  registered: uid(1), prospective: uid(2), missingAttendance: uid(3),
  inactiveAttendance: uid(4), finance: uid(5), coach: uid(6),
  submitter: uid(7), admin: uid(8), lead: uid(9), mentor: uid(10),
  readonly: uid(11), inactive: uid(12), noProfile: uid(13),
};
type Person = keyof typeof ids;
const newlyAllowed = ["prospective", "missingAttendance", "inactiveAttendance"] as const;
const area = uid(100), season = uid(200), category = uid(201);
const base = {
  sheet_url: "https://docs.google.com/spreadsheets/d/StudentRequestFixture/edit",
  vendor: "Fixture supplier", amount: 125.5, area_id: area,
  purpose: "Replacement parts", notes: "Requester note", needed_by: "",
};
let db: PGlite;
let securityBefore: unknown;
let dataBefore: unknown;
let creatorBefore: any;

async function owner() { await db.exec("reset role"); }
async function as(person: Person) {
  await db.exec(`reset role; select set_config('test.uid','${ids[person]}',false); set role authenticated`);
}
async function call(action: string, payload: Record<string, unknown> = {}) {
  return (await db.query<{ id: string }>("select public.finance_mutate($1,$2::jsonb) id", [action, JSON.stringify(payload)])).rows[0].id;
}
async function row(id: string) {
  return (await db.query<any>("select * from public.finance_purchase_orders where id=$1", [id])).rows[0];
}
async function context() {
  return (await db.query<any>("select public.finance_context() value")).rows[0].value;
}
async function create(person: Person, patch: Record<string, unknown> = {}) {
  await as(person);
  return call("create", { ...base, ...patch });
}
async function act(person: Person, id: string, action: string, patch: Record<string, unknown> = {}) {
  await as(person);
  return call(action, { id, version: (await row(id)).version, ...patch });
}
async function submitted(person: Person = "prospective") {
  const id = await create(person);
  await act(person, id, "submit");
  return id;
}
async function approved(person: Person = "prospective") {
  const id = await submitted(person);
  await act("finance", id, "approve", { slot: "finance_approver" });
  await act("coach", id, "approve", { slot: "po_approver" });
  return id;
}
async function creatorCatalog() {
  await owner();
  return (await db.query<any>(`select oid,proowner,proacl,prosecdef,provolatile,proconfig,prosrc
    from pg_proc where oid='finance_private.creator()'::regprocedure`)).rows[0];
}
async function securitySnapshot() {
  await owner();
  return {
    functions: (await db.query(`select p.oid,p.proowner,p.proacl,pg_get_functiondef(p.oid) definition
      from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname in ('public','finance_private','team_private','pit_private')
        and p.oid<>'finance_private.creator()'::regprocedure order by p.oid`)).rows,
    relations: (await db.query(`select c.oid,c.relowner,c.relacl,c.relrowsecurity,c.relforcerowsecurity
      from pg_class c join pg_namespace n on n.oid=c.relnamespace
      where n.nspname in ('public','finance_private','team_private','pit_private') order by c.oid`)).rows,
    policies: (await db.query("select * from pg_policies order by schemaname,tablename,policyname")).rows,
  };
}
async function dataSnapshot() {
  await owner();
  const result: Record<string, unknown> = {};
  const tables = (await db.query<{ name: string }>(`select quote_ident(schemaname)||'.'||quote_ident(tablename) name
    from pg_tables where schemaname in ('public','finance_private','team_private','pit_private') order by 1`)).rows;
  for (const { name } of tables) {
    result[name] = (await db.query<any>(`select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text),'[]') value from ${name} t`)).rows[0].value;
  }
  return result;
}
async function poSnapshot(id: string) {
  await owner();
  return {
    po: await row(id),
    revisions: (await db.query("select * from finance_po_revisions where po_id=$1 order by revision", [id])).rows,
    approvals: (await db.query("select * from finance_po_approvals where po_id=$1 order by id", [id])).rows,
    history: (await db.query("select * from finance_private.history where po_id=$1 order by id", [id])).rows,
    notifications: (await db.query("select * from team_notifications where entity_id=$1 order by id", [id])).rows,
  };
}

test.beforeEach(async () => {
  db = new PGlite();
  await db.exec(`create role anon; create role authenticated; create role service_role;
    create schema auth;
    create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('test.uid',true),'')::uuid$$;
    grant usage on schema auth to authenticated; grant execute on function auth.uid() to authenticated;
    create table public.areas(id uuid primary key,name text,active boolean,slug text unique default gen_random_uuid()::text);
    insert into public.areas(id,name,active) values('${area}','Build',true);
    create table public.profiles(id uuid primary key,display_name text,role text,active boolean,primary_area_id uuid,updated_at timestamptz default now());
    create table public.team_attendance_members(student_id uuid primary key,member_status text,team_area text default '');
    ${Object.entries(ids).filter(([person]) => person !== "noProfile").map(([person, id]) => `
      insert into public.profiles values('${id}','${person}','${["admin", "mentor", "lead", "readonly"].includes(person) ? person : "student"}',${person !== "inactive"},'${area}',now());
      ${person === "missingAttendance" ? "" : `insert into public.team_attendance_members values('${id}','${person === "prospective" ? "prospective" : person === "inactiveAttendance" ? "inactive" : "registered"}','');`}
    `).join("\n")}
    -- A roster row without a profile must not grant Finance access.
    insert into public.team_attendance_members values('${ids.noProfile}','registered','');
  `);
  for (const path of [
    "supabase/migrations/202609120002_finance_v1.sql",
    "tests/fixtures/team_management_positions.sql",
    "supabase/migrations/202609120004_finance_notifications.sql",
    "supabase/migrations/202609190001_finance_notification_coverage.sql",
    "supabase/migrations/202609200001_finance_budget_core.sql",
    "supabase/migrations/202609200002_finance_workbook.sql",
    "tests/fixtures/pit_operations.sql",
    "supabase/migrations/20261005235435_finance_repair_po_links.sql",
  ]) await db.exec(sql(path));
  await db.exec("grant select on public.profiles to authenticated");
  await as("admin");
  for (const [person, position] of [["finance", "finance_lead"], ["coach", "lead_coach_1"]] as const) {
    await db.query("select public.team_manage('assign_position',$1::jsonb)", [JSON.stringify({ user_id: ids[person], position_key: position, reason: "Local fixture assignment" })]);
  }
  await call("assignment", { user_id: ids.submitter, capability: "school_submitter", active: true, reason: "Local fixture assignment" });
  creatorBefore = await creatorCatalog();
  securityBefore = await securitySnapshot();
  dataBefore = await dataSnapshot();
  await db.exec(sql(migration));
});
test.afterEach(async () => { await db.close(); });

for (const person of newlyAllowed) {
  test(`${person} can create, submit, revise and resubmit with trusted ownership`, async () => {
    await as(person);
    expect(await context()).toMatchObject({ profile: { id: ids[person], role: "student" }, can_create: true, is_admin: false, capabilities: [] });
    const forged = { requester_id: ids.admin, submitted_by: ids.admin, actor_id: ids.admin, status: "approved", revision: 42 };
    const id = await call("create", { ...base, ...forged });
    expect(await row(id)).toMatchObject({ requester_id: ids[person], status: "draft", revision: 0, version: 1 });
    await act(person, id, "submit", forged);
    expect(await row(id)).toMatchObject({ requester_id: ids[person], status: "awaiting_approval", revision: 1 });
    await act("finance", id, "approve", { slot: "finance_approver" });
    await act("coach", id, "request_changes", { slot: "po_approver", reason: "Include shipping" });
    await act(person, id, "edit", { ...base, ...forged, amount: 140 });
    expect(await row(id)).toMatchObject({ requester_id: ids[person], status: "draft", revision: 1, amount: "140.00" });
    await act(person, id, "submit", forged);
    expect(await row(id)).toMatchObject({ requester_id: ids[person], status: "awaiting_approval", revision: 2 });
    const revisions = (await db.query<any>("select * from finance_po_revisions where po_id=$1 order by revision", [id])).rows;
    expect(revisions).toHaveLength(2);
    expect(revisions.map(r => r.submitted_by)).toEqual([ids[person], ids[person]]);
    expect(revisions.map(r => r.metadata.requester_id)).toEqual([ids[person], ids[person]]);
    expect(revisions.map(r => r.metadata.amount)).toEqual([125.5, 140]);
    const decisions = (await db.query<any>("select action,revision from finance_po_approvals where po_id=$1", [id])).rows;
    expect(decisions).toHaveLength(2);
    expect(decisions.every(d => d.revision === 1)).toBe(true);
    await expect(act("submitter", id, "school_submit")).rejects.toThrow(/Both current-revision approvals/);
    await as(person);
    const history = (await db.query<any>("select * from finance_po_history where po_id=$1 order by id", [id])).rows;
    expect(history.filter(h => ["created", "submit", "edit"].includes(h.action)).every(h => h.actor_id === ids[person])).toBe(true);
    expect(history.every(h => h.details.before === undefined && h.details.after === undefined)).toBe(true);
    await owner();
    const notices = (await db.query<any>("select * from team_notifications where entity_id=$1 and event='approval_needed'", [id])).rows;
    expect(notices).toHaveLength(4);
    expect(notices.every(n => [ids.finance, ids.coach].includes(n.recipient_id))).toBe(true);
  });
}

test("registered students and existing leadership retain create access", async () => {
  for (const person of ["registered", "lead", "mentor", "admin"] as const) {
    await as(person);
    expect((await context()).can_create).toBe(true);
    const id = await call("create", base);
    await act(person, id, "submit");
    expect(await row(id)).toMatchObject({ requester_id: ids[person], status: "awaiting_approval" });
  }
});

for (const person of ["prospective", "missingAttendance"] as const) {
  test(`${person} sees and acts on own POs only`, async () => {
    const own = await approved(person), other = await approved("registered"), hiddenDraft = await create("registered");
    await as(person);
    expect((await db.query<any>("select id from finance_purchase_orders")).rows.map(p => p.id)).toEqual([own]);
    for (const table of ["finance_po_revisions", "finance_po_approvals", "finance_po_history"]) {
      const visible = (await db.query<any>(`select po_id from public.${table}`)).rows;
      expect(visible.length).toBeGreaterThan(0);
      expect(visible.every(r => r.po_id === own)).toBe(true);
    }
    expect((await context()).people.map((p: any) => p.id)).not.toContain(ids.registered);
    for (const id of [other, hiddenDraft, uid(999)]) {
      for (const action of ["edit", "submit", "cancel", "approve", "request_changes", "school_submit"]) {
        await expect(call(action, { ...base, id, version: 1, reason: "Not authorized", slot: "finance_approver", requester_id: ids[person] }))
          .rejects.toMatchObject({ code: "42501", message: "Purchase order unavailable" });
      }
    }
    await expect(db.exec("select * from finance_private.history")).rejects.toMatchObject({ code: "42501" });
  });

  test(`${person} gains no approval, school-submit or privilege-management authority`, async () => {
    const id = await submitted(person);
    const before = await poSnapshot(id);
    for (const action of ["approve", "request_changes"]) {
      for (const slot of ["finance_approver", "po_approver"]) {
        await expect(act(person, id, action, { slot, reason: "Forged decision", override_reason: "Forged override", actor_id: ids.admin }))
          .rejects.toMatchObject({ code: "42501" });
      }
    }
    await as(person);
    for (const capability of ["finance_admin", "school_submitter"]) {
      await expect(call("assignment", { user_id: ids[person], capability, active: true, reason: "Escalation attempt" }))
        .rejects.toMatchObject({ code: "42501" });
    }
    for (const position_key of ["finance_lead", "lead_coach_1"]) {
      await expect(db.query("select team_manage('assign_position',$1::jsonb)", [JSON.stringify({ user_id: ids[person], position_key, reason: "Escalation attempt" })]))
        .rejects.toMatchObject({ code: "42501" });
    }
    await expect(db.query("select team_manage('member',$1::jsonb)", [JSON.stringify({ user_id: ids[person], role: "admin", active: true, reason: "Escalation attempt" })]))
      .rejects.toMatchObject({ code: "42501" });
    for (const statement of [
      "insert into finance_purchase_orders default values", "update finance_purchase_orders set status='approved'", "delete from finance_purchase_orders",
      "insert into finance_po_revisions default values", "insert into finance_po_approvals default values", "insert into finance_private.history default values",
      "insert into finance_assignments default values", "insert into team_member_positions default values", "update profiles set role='admin'",
    ]) await expect(db.exec(statement)).rejects.toMatchObject({ code: "42501" });
    expect(await poSnapshot(id)).toEqual(before);
    await act("finance", id, "approve", { slot: "finance_approver" });
    await act("coach", id, "approve", { slot: "po_approver" });
    await expect(act(person, id, "school_submit", { submitted_by: ids.submitter, reference: "Forged submission" }))
      .rejects.toMatchObject({ code: "42501", message: "School submission capability required" });
    expect((await row(id)).status).toBe("approved");
  });

  test(`${person} repeated submit attempts create no duplicate revisions, audit or notifications`, async () => {
    const id = await create(person);
    const payload = { id, version: (await row(id)).version };
    const results = await Promise.allSettled([call("submit", payload), call("submit", payload)]);
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter(r => r.status === "rejected")).toHaveLength(1);
    const before = await poSnapshot(id);
    expect(before.revisions).toHaveLength(1);
    expect(before.history).toHaveLength(2);
    expect(before.notifications).toHaveLength(2);
    await as(person);
    await expect(call("submit", payload)).rejects.toThrow(/changed/);
    await expect(act(person, id, "submit")).rejects.toThrow(/Only drafts/);
    expect(await poSnapshot(id)).toEqual(before);
  });
}

test("students cannot read or manage populated budget records or export a workbook", async () => {
  await owner();
  await db.exec(`insert into finance_seasons(id,name,status,starting_funds,created_by) values('${season}','Fixture season','active',1000,'${ids.admin}');
    insert into finance_budget_categories(id,season_id,name,allocation) values('${category}','${season}','Parts',700);
    insert into finance_income(season_id,source,income_type,amount,status,created_by) values('${season}','Fixture donor','Grant',100,'expected','${ids.admin}');
    insert into finance_expenses(season_id,category_id,kind,amount,occurred_on,reason,created_by) values('${season}','${category}','expense',50,current_date,'Fixture expense','${ids.admin}');`);
  const id = await submitted("prospective");
  await owner();
  const tables = ["finance_seasons", "finance_budget_categories", "finance_income", "finance_po_budget", "finance_expenses"];
  for (const table of tables) expect((await db.query(`select * from public.${table}`)).rows.length).toBeGreaterThan(0);
  const before = await dataSnapshot();
  for (const person of newlyAllowed) {
    await as(person);
    expect((await db.query<any>("select finance_budget_context($1::uuid) value", [season])).rows[0].value).toEqual({ can_manage: false });
    for (const table of tables) {
      expect((await db.query(`select * from public.${table}`)).rows).toEqual([]);
      await expect(db.exec(`delete from public.${table}`)).rejects.toMatchObject({ code: "42501" });
    }
    await expect(db.query("select finance_workbook_context($1::uuid)", [season])).rejects.toMatchObject({ code: "42501" });
    await expect(db.query("select finance_budget_approval($1::uuid)", [id])).rejects.toMatchObject({ code: "42501" });
    for (const action of ["create_season", "category", "income", "expense", "categorize_po", "classify_position"]) {
      await expect(db.query("select finance_budget_manage($1,$2::jsonb)", [action, JSON.stringify({ season_id: season, po_id: id, name: "Unauthorized", reason: "Unauthorized" })]))
        .rejects.toMatchObject({ code: "42501", message: "Budget leadership required" });
    }
  }
  expect(await dataSnapshot()).toEqual(before);
});

test("readonly creation/non-owner actions and inactive, missing-profile, unauthenticated access remain denied", async () => {
  const id = await submitted("registered");
  const before = await dataSnapshot();
  for (const person of ["readonly", "inactive", "noProfile"] as const) {
    await as(person);
    expect((await db.query<any>("select finance_private.creator() value")).rows[0].value).toBe(false);
    if (person === "readonly") expect((await context()).can_create).toBe(false);
    else await expect(context()).rejects.toMatchObject({ code: "42501" });
    await expect(call("create", { ...base, requester_id: ids.registered })).rejects.toMatchObject({ code: "42501" });
    for (const action of ["edit", "submit", "cancel", "approve", "school_submit"]) {
      await expect(call(action, { ...base, id, version: 2, slot: "finance_approver", reason: "Unauthorized" })).rejects.toMatchObject({ code: "42501" });
    }
    expect((await db.query("select * from finance_purchase_orders")).rows).toEqual([]);
  }
  await db.exec("reset role;select set_config('test.uid','',false);set role authenticated");
  await expect(context()).rejects.toMatchObject({ code: "42501" });
  await expect(call("create", base)).rejects.toMatchObject({ code: "42501" });
  // Even a lingering student uid cannot grant the anonymous database role RPC access.
  await db.exec(`reset role;select set_config('test.uid','${ids.prospective}',false);set role anon`);
  await expect(context()).rejects.toMatchObject({ code: "42501" });
  await expect(call("create", base)).rejects.toMatchObject({ code: "42501" });
  await expect(call("submit", { id, version: 2 })).rejects.toMatchObject({ code: "42501" });
  await expect(db.exec("select * from finance_purchase_orders")).rejects.toMatchObject({ code: "42501" });
  expect(await dataSnapshot()).toEqual(before);
});

test("profile deactivation immediately removes newly allowed requester access", async () => {
  const id = await submitted("missingAttendance");
  await owner();
  await db.query("update profiles set active=false where id=$1", [ids.missingAttendance]);
  const before = await poSnapshot(id);
  await as("missingAttendance");
  await expect(context()).rejects.toMatchObject({ code: "42501" });
  await expect(call("create", base)).rejects.toMatchObject({ code: "42501" });
  await expect(call("edit", { ...base, id, version: 2 })).rejects.toMatchObject({ code: "42501" });
  await expect(call("submit", { id, version: 2 })).rejects.toMatchObject({ code: "42501" });
  expect(await row(id)).toBeUndefined();
  expect(await poSnapshot(id)).toEqual(before);
});

test("creator-only change preserves the existing readonly-owner continuation exception", async () => {
  const id = await create('missingAttendance');
  await owner();
  await db.query("update profiles set role='readonly' where id=$1", [ids.missingAttendance]);
  await as('missingAttendance');
  expect((await context()).can_create).toBe(false);
  await expect(call('create', base)).rejects.toMatchObject({ code: '42501' });
  // Existing active owners can continue their own unlocked POs after a role
  // downgrade. Tightening that separate policy is outside this migration.
  await act('missingAttendance', id, 'edit', { ...base, amount: 130 });
  await act('missingAttendance', id, 'submit');
  expect(await row(id)).toMatchObject({ requester_id: ids.missingAttendance, status: 'awaiting_approval', revision: 1 });
  await act('missingAttendance', id, 'cancel', { reason: 'Local baseline regression fixture' });
  expect((await row(id)).status).toBe('cancelled');
});

test("two distinct current-revision approvals remain mandatory, including after resubmission", async () => {
  // Give one reviewer both configured positions to test the independent-people rule.
  await as("admin");
  await db.query("select team_manage('assign_position',$1::jsonb)", [JSON.stringify({ user_id: ids.finance, position_key: "lead_coach_2", reason: "Local dual-position regression fixture" })]);
  const id = await submitted("missingAttendance");
  await expect(act("submitter", id, "school_submit")).rejects.toThrow(/Both current-revision approvals/);
  await act("finance", id, "approve", { slot: "finance_approver" });
  expect((await row(id)).status).toBe("awaiting_approval");
  await expect(act("finance", id, "approve", { slot: "po_approver" })).rejects.toThrow(/Two distinct people/);
  await expect(act("submitter", id, "school_submit")).rejects.toThrow(/Both current-revision approvals/);
  await act("coach", id, "approve", { slot: "po_approver" });
  expect((await row(id)).status).toBe("approved");
  await act("missingAttendance", id, "edit", { ...base, amount: 150 });
  await act("missingAttendance", id, "submit");
  expect(await row(id)).toMatchObject({ status: "awaiting_approval", revision: 2 });
  await expect(act("submitter", id, "school_submit")).rejects.toThrow(/Both current-revision approvals/);
  await act("coach", id, "approve", { slot: "po_approver" });
  expect((await row(id)).status).toBe("awaiting_approval");
  await act("finance", id, "approve", { slot: "finance_approver" });
  expect((await row(id)).status).toBe("approved");
  const decisions = (await db.query<any>("select revision,slot,actor_id from finance_po_approvals where po_id=$1", [id])).rows;
  for (const revision of [1, 2]) {
    const current = decisions.filter(d => d.revision === revision);
    expect(current).toHaveLength(2);
    expect(new Set(current.map(d => d.actor_id)).size).toBe(2);
    expect(new Set(current.map(d => d.slot)).size).toBe(2);
  }
  await act("submitter", id, "school_submit", { reference: "Fixture school receipt" });
  expect(await row(id)).toMatchObject({ status: "submitted_to_school", school_submitted_by: ids.submitter });
  await expect(act("missingAttendance", id, "edit", base)).rejects.toThrow(/locked/);
});

test("migration changes only creator body, preserves ACL/RLS/data and can be repeated", async () => {
  const current = await creatorCatalog();
  expect(creatorBefore.prosrc).toContain("team_attendance_members");
  expect(current.prosrc).not.toContain("team_attendance_members");
  expect({ ...current, prosrc: undefined }).toEqual({ ...creatorBefore, prosrc: undefined });
  expect(current).toMatchObject({ prosecdef: true, provolatile: "s", proconfig: ['search_path=""'] });
  expect(await securitySnapshot()).toEqual(securityBefore);
  expect(await dataSnapshot()).toEqual(dataBefore);
  for (const role of ["anon", "authenticated", "service_role"]) {
    expect((await db.query<any>("select has_function_privilege($1,'finance_private.creator()','execute') value", [role])).rows[0].value)
      .toBe(role === "authenticated");
  }
  const id = await submitted("missingAttendance");
  const data = await dataSnapshot();
  await db.exec(sql(migration));
  await db.exec(sql(migration));
  expect(await creatorCatalog()).toEqual(current);
  expect(await securitySnapshot()).toEqual(securityBefore);
  expect(await dataSnapshot()).toEqual(data);
  await as("missingAttendance");
  expect((await context()).can_create).toBe(true);
  expect(await row(id)).toMatchObject({ requester_id: ids.missingAttendance, status: "awaiting_approval", revision: 1 });
});
