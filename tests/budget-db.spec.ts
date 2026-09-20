import { test, expect } from "@playwright/test";
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
let db: PGlite;
const uid = (n: number) =>
  `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
const ids = {
  student: uid(1),
  other: uid(2),
  lead: uid(3),
  finance: uid(4),
  po: uid(5),
  submitter: uid(6),
  admin: uid(7),
  readonly: uid(8),
  inactive: uid(9),
  prospective: uid(10),
  coach2: uid(11),
  mentor: uid(12),
};
const area = uid(101),
  otherArea = uid(102);
async function as(who: keyof typeof ids) {
  await db.exec(
    `reset role;select set_config('test.uid','${ids[who]}',false);set role authenticated;`,
  );
}
async function call(action: string, p: Record<string, unknown> = {}) {
  return (
    await db.query<{ id: string }>(
      "select public.finance_mutate($1,$2::jsonb) id",
      [action, JSON.stringify(p)],
    )
  ).rows[0].id;
}
async function row(id: string) {
  return (
    await db.query<any>(
      "select * from public.finance_purchase_orders where id=$1",
      [id],
    )
  ).rows[0];
}
const base = {
  sheet_url: "https://docs.google.com/spreadsheets/d/Sheet_123/edit",
  vendor: "Robot Supplier",
  amount: 125.5,
  area_id: area,
  purpose: "Motor replacement",
  notes: "",
  needed_by: "",
};
async function create() {
  await as("student");
  return call("create", base);
}
async function act(
  who: keyof typeof ids,
  id: string,
  action: string,
  p: Record<string, unknown> = {},
) {
  await as(who);
  const r = await row(id);
  return call(action, { id, version: r.version, ...p });
}
async function submitted() {
  const id = await create();
  await act("student", id, "submit");
  return id;
}
async function fullApproved() {
  const id = await submitted();
  await act("finance", id, "approve", { slot: "finance_approver" });
  await act("po", id, "approve", { slot: "po_approver" });
  return id;
}
test.beforeEach(async () => {
  db = new PGlite();
  await db.exec(`create role anon;create role authenticated;create role service_role;create schema auth;create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('test.uid',true),'')::uuid$$;grant usage on schema auth to authenticated;grant execute on function auth.uid() to authenticated;
create table public.areas(id uuid primary key,name text,active boolean,slug text unique default gen_random_uuid()::text);insert into public.areas(id,name,active) values('${area}','Fabrication',true),('${otherArea}','Power',true);
create table public.profiles(id uuid primary key,display_name text,role text,active boolean,primary_area_id uuid,updated_at timestamptz default now());
create table public.team_attendance_members(student_id uuid primary key,member_status text,team_area text default '');
${Object.entries(ids)
  .map(
    ([name, id]) =>
      `insert into public.profiles values('${id}','${name}','${name === "admin" ? "admin" : name === "mentor" ? "mentor" : name === "lead" ? "lead" : name === "readonly" ? "readonly" : "student"}',${name !== "inactive"},'${area}',now());insert into public.team_attendance_members values('${id}','${name === "prospective" ? "prospective" : "registered"}','');`,
  )
  .join("\n")}`);
  await db.exec(
    readFileSync("supabase/migrations/202609120002_finance_v1.sql", "utf8"),
  );
  await db.exec("grant select on public.profiles to authenticated");
  await db.exec(
    readFileSync("tests/fixtures/team_management_positions.sql", "utf8"),
  );
  await db.exec(
    readFileSync(
      "supabase/migrations/202609120004_finance_notifications.sql",
      "utf8",
    ),
  );
  await db.exec(
    readFileSync(
      "supabase/migrations/202609190001_finance_notification_coverage.sql",
      "utf8",
    ),
  );
  await db.exec(
    "insert into public.team_positions(key,name) values ('software_lead','Software Lead'),('custom_lead','Custom lead')",
  );
  await db.exec(
    readFileSync(
      "supabase/migrations/202609200001_finance_budget_core.sql",
      "utf8",
    ),
  );
  await db.exec(readFileSync("supabase/migrations/202609200002_finance_workbook.sql", "utf8"));
  await as("admin");
  for (const [who, position_key] of [
    ["finance", "finance_lead"],
    ["po", "lead_coach_1"],
    ["coach2", "lead_coach_2"],
  ] as const) {
    await db.query("select public.team_manage('assign_position',$1::jsonb)", [
      JSON.stringify({
        user_id: ids[who],
        position_key,
        reason: "Season assignment",
      }),
    ]);
  }
  await call("assignment", {
    user_id: ids.submitter,
    capability: "school_submitter",
    active: true,
    reason: "School submission assignment",
  });
});
test.afterEach(async () => {
  await db.close();
});
async function budget(action: string, p: any = {}) {
  return (
    await db.query<any>(
      "select public.finance_budget_manage($1,$2::jsonb) id",
      [action, JSON.stringify(p)],
    )
  ).rows[0].id;
}
async function context(id?: string) {
  return (
    await db.query<any>("select public.finance_budget_context($1::uuid) c", [
      id || null,
    ])
  ).rows[0].c;
}
async function manage(s: string, action: string, p: any = {}) {
  await as("mentor");
  const c = await context(s);
  return budget(action, {
    season_id: s,
    version: c.summary.season.version,
    reason: "Reviewed by leadership",
    ...p,
  });
}
async function season(active = true) {
  await as("mentor");
  const s = await budget("create_season", {
    name: "2026–27",
    starting_funds: 1000,
    reserve_target: 100,
  });
  const cat = await manage(s, "category", {
    name: "Robot parts",
    allocation: 700,
    forecast: 650,
  });
  if (active) await manage(s, "activate", { confirmed: true });
  return { s, cat };
}
async function summary(s: string) {
  await as("mentor");
  return (await context(s)).summary;
}
test("blank/copy seasons copy structure and optional allocations, never activity", async () => {
  const { s, cat } = await season(false);
  await manage(s, "income", {
    source: "Sponsor",
    income_type: "Grant",
    amount: 200,
    status: "expected",
    category_id: cat,
  });
  await as("mentor");
  for (const copy of [false, true]) {
    const n = await budget("create_season", {
      name: "Next",
      copy_season: s,
      copy_allocations: copy,
    });
    const c = await context(n);
    expect(c.summary.season.status).toBe("draft");
    expect(c.summary.categories[0]).toMatchObject({
      name: "Robot parts",
      allocation: copy ? 700 : 0,
      forecast: 650,
    });
    expect(c.income).toEqual([]);
    expect(c.po_links).toEqual([]);
    expect(c.summary.starting_funds).toBe(0);
  }
});
test("only one active, explicit activation and closed mutations rejected", async () => {
  const { s } = await season();
  await as("mentor");
  const n = await budget("create_season", { name: "Next" });
  await expect(manage(n, "activate", { confirmed: true })).rejects.toThrow(
    /active season/,
  );
  await manage(s, "close");
  await expect(manage(s, "category", { name: "Blocked" })).rejects.toThrow(
    /Closed/,
  );
  await expect(manage(n, "activate", { confirmed: false })).rejects.toThrow(
    /confirm/,
  );
  await manage(n, "activate", { confirmed: true });
  expect((await summary(n)).season.status).toBe("active");
});
test("expected/received/canceled restricted income and funds remain separate", async () => {
  const { s, cat } = await season();
  const otherCategory = await manage(s, "category", {name:"Travel",allocation:0});
  let id = await manage(s, "income", {
    source: "Sponsor",
    income_type: "Sponsorship",
    amount: 500,
    status: "expected",
    category_id: cat,
  });
  let q = await summary(s);
  expect(q).toMatchObject({
    received: 0,
    expected: 500,
    unallocated: 300,
    available: 1000,
  });
  expect(q.categories.find((c: any) => c.id === cat).available).toBe(700);
  await manage(s, "income", {
    id,
    source: "Sponsor",
    income_type: "Sponsorship",
    amount: 500,
    status: "received",
    received_on: "2026-09-20",
    category_id: cat,
  });
  q = await summary(s);
  expect(q).toMatchObject({
    received: 500,
    expected: 0,
    restricted: 500,
    allocated: 1200,
    unallocated: 300,
    available: 1500,
  });
  expect(q.categories.find((c: any) => c.id === cat)).toMatchObject({funded:1200,available:1200});
  expect(q.categories.find((c: any) => c.id === otherCategory)).toMatchObject({restricted:0,funded:0,available:0});
  await manage(s, "income", {
    source: "Donation",
    income_type: "Other",
    amount: 50,
    status: "received",
    received_on: "2026-09-20",
  });
  expect((await summary(s)).unallocated).toBe(350);
  await manage(s, "income", {
    id,
    source: "Sponsor",
    income_type: "Sponsorship",
    amount: 500,
    status: "canceled",
    category_id: cat,
  });
  expect((await summary(s)).received).toBe(50);
});
test("category updates, version protection, atomic transfer and amendment audit", async () => {
  const { s, cat } = await season();
  const b = await manage(s, "category", { name: "Travel", allocation: 0 });
  const stale = (await summary(s)).season.version;
  await manage(s, "transfer", { from_id: cat, to_id: b, amount: 200 });
  let q = await summary(s);
  expect(q.categories.find((c: any) => c.id === cat).allocation).toBe(500);
  expect(q.categories.find((c: any) => c.id === b).allocation).toBe(200);
  await as("mentor");
  await expect(
    budget("category", {
      season_id: s,
      version: stale,
      id: cat,
      name: "Stale",
      reason: "x",
    }),
  ).rejects.toThrow(/changed/);
  await expect(
    manage(s, "transfer", { from_id: cat, to_id: b, amount: 501 }),
  ).rejects.toThrow(/exceeds/);
  expect((await summary(s)).allocated).toBe(700);
  await manage(s, "category", {
    id: cat,
    name: "Parts",
    description: "New name",
    display_order: 3,
    active: false,
    allocation: 500,
    forecast: 400,
  });
  await manage(s, "category", {
    id: cat,
    name: "Parts",
    active: true,
    allocation: 500,
    forecast: 400,
  });
  await expect(
    manage(s, "season", {
      name: "Season",
      starting_funds: 2000,
      reserve_target: 300,
      reason: "",
    }),
  ).rejects.toThrow(/Explain/);
  await manage(s, "season", {
    name: "Season",
    starting_funds: 2000,
    reserve_target: 300,
  });
  expect(await summary(s)).toMatchObject({
    starting_funds: 2000,
    unallocated: 1300,
  });
  const c = await context(s);
  expect(
    c.history.filter((h: any) => h.action === "budget_transfer"),
  ).toHaveLength(1);
  expect(
    c.history.find((h: any) => h.action === "budget_transfer").details.before
      .categories,
  ).toHaveLength(2);
});
test("PO current revision moves Requested → Committed → Spent without double count or notification change", async () => {
  const { s, cat } = await season();
  const id = await submitted();
  expect(await summary(s)).toMatchObject({
    requested: 125.5,
    committed: 0,
    spent: 0,
  });
  await expect(
    act("finance", id, "approve", { slot: "finance_approver" }),
  ).rejects.toThrow(/category/);
  await as("finance");
  expect(
    (
      await db.query<any>(
        "select * from public.finance_po_approvals where po_id=$1",
        [id],
      )
    ).rows,
  ).toHaveLength(0);
  await act("po", id, "approve", { slot: "po_approver" });
  await act("finance", id, "approve", {
    slot: "finance_approver",
    category_id: cat,
  });
  expect(await summary(s)).toMatchObject({
    requested: 0,
    committed: 125.5,
    spent: 0,
  });
  await expect(manage(s, "close")).rejects.toThrow(/Resolve/);
  await act("submitter", id, "school_submit", { reference: "School123" });
  expect(await summary(s)).toMatchObject({
    requested: 0,
    committed: 0,
    spent: 125.5,
    available: 874.5,
  });
  await db.exec("reset role");
  const events = (
    await db.query<any>(
      "select event from public.team_notifications where entity_id=$1",
      [id],
    )
  ).rows.map((x) => x.event);
  expect(events).toContain("approval_needed");
  expect(events).toContain("approval_recorded");
  expect(events).toContain("ready_for_school");
  expect(events).toContain("submitted_to_school");
  await manage(s, "close");
  expect((await summary(s)).spent).toBe(125.5);
});
test("revisions, changes requested, draft edits and cancellation release current impact", async () => {
  const { s, cat } = await season();
  const id = await submitted();
  await act("finance", id, "request_changes", {
    slot: "finance_approver",
    reason: "Fix details",
  });
  expect((await summary(s)).requested).toBe(0);
  await act("student", id, "edit", { ...base, amount: 650 });
  await act("student", id, "submit");
  await act("finance", id, "approve", {
    slot: "finance_approver",
    category_id: cat,
  });
  await act("po", id, "approve", { slot: "po_approver" });
  expect(await summary(s)).toMatchObject({ requested: 0, committed: 650 });
  await act("student", id, "cancel", { reason: "No longer needed" });
  expect(await summary(s)).toMatchObject({
    requested: 0,
    committed: 0,
    spent: 0,
  });
});
test("over budget requires reason and mentor override requires category; two people preserved", async () => {
  const { s, cat } = await season();
  await manage(s, "category", { id: cat, name: "Parts", allocation: 10 });
  const id = await submitted();
  await expect(
    act("mentor", id, "approve", {
      slot: "finance_approver",
      override_reason: "Finance lead absent",
    }),
  ).rejects.toThrow(/category/);
  await expect(
    act("mentor", id, "approve", {
      slot: "finance_approver",
      category_id: cat,
      override_reason: "Finance lead absent",
    }),
  ).rejects.toThrow(/Over budget/);
  await act("mentor", id, "approve", {
    slot: "finance_approver",
    category_id: cat,
    override_reason: "Finance lead absent",
    budget_reason: "Required robot repair",
  });
  await expect(
    act("mentor", id, "approve", {
      slot: "po_approver",
      override_reason: "Override",
    }),
  ).rejects.toThrow(/distinct/);
  const h = (await context(s)).history.find(
    (h: any) => h.action === "budget_po_category",
  );
  expect(h.details.after.over_budget).toBe(115.5);
});
test("manual expenses and credits affect net spent only and preserve references", async () => {
  const { s, cat } = await season();
  const e = await manage(s, "expense", {
    category_id: cat,
    amount: 200,
    payee: "Bus",
    occurred_on: "2026-09-20",
  });
  await manage(s, "credit", {
    category_id: cat,
    amount: 40,
    expense_id: e,
    occurred_on: "2026-09-20",
  });
  expect(await summary(s)).toMatchObject({
    spent: 160,
    credits: 40,
    available: 840,
  });
  expect((await summary(s)).categories[0]).toMatchObject({allocation:700,spent:160,available:540});
  await expect(
    manage(s, "expense", {
      category_id: cat,
      amount: -10,
      payee: "Bad",
      occurred_on: "2026-09-20",
    }),
  ).rejects.toThrow();
  await expect(
    manage(s, "credit", {
      category_id: cat,
      amount: 10,
      expense_id: uid(999),
      occurred_on: "2026-09-20",
    }),
  ).rejects.toThrow(/reference/);
});
test("legacy uncategorized POs stay valid; explicit coding binds once, not when season changes", async () => {
  const id = await fullApproved();
  const { s, cat } = await season();
  await as("mentor");
  expect((await context(s)).po_links).toEqual([]);
  await manage(s, "categorize_po", { po_id: id, category_id: cat });
  expect((await summary(s)).committed).toBe(125.5);
  await act("student", id, "cancel", { reason: "Cancel" });
  await manage(s, "close");
  await as("mentor");
  const n = await budget("create_season", { name: "Next" });
  await manage(n, "activate", { confirmed: true });
  const nc = await manage(n, "category", { name: "Parts" });
  await expect(
    manage(n, "categorize_po", { po_id: id, category_id: nc }),
  ).rejects.toThrow(/between seasons/);
});
test("trusted active positions grant budget only; role lead alone, revoked, archived, inactive denied", async () => {
  await as("lead");
  expect((await context()).can_manage).toBe(false);
  await expect(budget("create_season", { name: "No" })).rejects.toThrow(
    /leadership/,
  );
  await as("mentor");
  await db.query("select public.team_manage('assign_position',$1::jsonb)", [
    JSON.stringify({
      user_id: ids.lead,
      position_key: "software_lead",
      reason: "Leadership",
    }),
  ]);
  await as("lead");
  expect((await context()).can_manage).toBe(true);
  expect(
    (
      await db.query<any>(
        "select finance_private.cap('finance_approver') f,finance_private.cap('po_approver') c,finance_private.cap('school_submitter') s,finance_private.admin() a",
      )
    ).rows[0],
  ).toEqual({ f: false, c: false, s: false, a: false });
  await budget("create_season", { name: "Collaborative" });
  await db.exec(
    "reset role;update public.team_positions set active=false where key='software_lead'",
  );
  await as("lead");
  expect((await context()).can_manage).toBe(false);
  await db.exec(
    "reset role;update public.team_positions set active=true where key='software_lead';update public.team_member_positions set revoked_at=now(),revoked_by='" +
      ids.mentor +
      "',revoke_reason='End' where position_key='software_lead'",
  );
  await as("lead");
  expect((await context()).can_manage).toBe(false);
  await as("finance");
  expect((await context()).can_manage).toBe(true);
  await db.exec(
    "reset role;update public.profiles set active=false where id='" +
      ids.finance +
      "'",
  );
  await as("finance");
  expect((await context()).can_manage).toBe(false);
});
test("RLS prevents direct budget reading/writes; private legacy mutation cannot bypass coding", async () => {
  await season();
  await as("student");
  expect((await db.query("select * from public.finance_seasons")).rows).toEqual(
    [],
  );
  await expect(
    db.exec(
      "insert into public.finance_seasons(name,created_by) values('Bad','" +
        ids.student +
        "')",
    ),
  ).rejects.toThrow(/permission/);
  await expect(
    db.query("select finance_private.mutate_v1('create','{}')"),
  ).rejects.toThrow(/permission/);
  await expect(
    db.query("select * from finance_private.history"),
  ).rejects.toThrow(/permission/);
});
test("audit failure rolls all financial changes back", async () => {
  const { s, cat } = await season();
  await db.exec(
    "reset role;create function finance_private.test_fail() returns trigger language plpgsql as $$begin if new.action='budget_transfer' then raise exception 'Audit unavailable';end if;return new;end$$;create trigger budget_test_fail before insert on finance_private.history for each row execute function finance_private.test_fail()",
  );
  await expect(
    manage(s, "transfer", { from_id: cat, amount: 100 }),
  ).rejects.toThrow(/Audit unavailable/);
  expect((await summary(s)).allocated).toBe(700);
});
test("additional classified positions are mentor-only and audited; revoked classification immediately denies", async () => {
  await as("mentor");
  await budget("classify_position", {
    position_key: "custom_lead",
    enabled: true,
    expected_enabled: false,
    reason: "Elected student leadership",
  });
  await db.query("select public.team_manage('assign_position',$1::jsonb)", [
    JSON.stringify({
      user_id: ids.other,
      position_key: "custom_lead",
      reason: "Leadership",
    }),
  ]);
  await as("other");
  expect((await context()).can_manage).toBe(true);
  await expect(
    budget("classify_position", {
      position_key: "lead_coach_1",
      enabled: true,
      reason: "Not allowed",
    }),
  ).rejects.toThrow(/Mentor/);
  await as("mentor");
  await budget("classify_position", {
    position_key: "custom_lead",
    enabled: false,
    expected_enabled: true,
    reason: "End leadership access",
  });
  expect(
    (await context()).history.filter(
      (h: any) => h.action === "budget_classify_position",
    ),
  ).toHaveLength(2);
  await as("other");
  expect((await context()).can_manage).toBe(false);
});
test("approval preview is authoritative and existing coding is not subtracted twice", async () => {
  const { s, cat } = await season();
  const id = await submitted();
  await manage(s, "categorize_po", { po_id: id, category_id: cat });
  await as("finance");
  const preview = async () =>
    (await db.query<any>("select public.finance_budget_approval($1) p", [id]))
      .rows[0].p;
  const c = (await preview()).categories[0];
  expect(c).toMatchObject({
    requested: 125.5,
    available: 574.5,
    projected_available: 574.5,
  });
  await act("finance", id, "approve", {
    slot: "finance_approver",
    category_id: cat,
  });
  await as("mentor");
  const audit = (await context(s)).history.find(
    (h: any) => h.action === "budget_po_category",
  );
  expect(audit.details.after.over_budget).toBe(0);
  await as("student");
  await expect(preview()).rejects.toThrow(/approver/);
});
test("closed season cannot strand draft/changes-requested POs and unchanged approval stays atomic", async () => {
  const { s, cat } = await season();
  const id = await submitted();
  await act("student", id, "edit", base);
  await expect(manage(s, "close")).rejects.toThrow(/unfinished/);
  await act("student", id, "submit");
  await act("finance", id, "request_changes", {
    slot: "finance_approver",
    reason: "Change",
  });
  await expect(manage(s, "close")).rejects.toThrow(/unfinished/);
  await act("student", id, "cancel", { reason: "No longer buying" });
  await manage(s, "close");
  await expect(
    manage(s, "income", {
      source: "No",
      income_type: "Other",
      amount: 10,
      status: "expected",
    }),
  ).rejects.toThrow(/Closed/);
});
test("archived categories reject new coding, cross-season income/reference rejected, invalid money rejected", async () => {
  const { s, cat } = await season();
  await manage(s, "category", {
    id: cat,
    name: "Old parts",
    active: false,
    allocation: 700,
  });
  const id = await submitted();
  await expect(
    act("finance", id, "approve", {
      slot: "finance_approver",
      category_id: cat,
    }),
  ).rejects.toThrow(/category/);
  await as("mentor");
  const other = await budget("create_season", { name: "Other" });
  await expect(
    manage(other, "income", {
      source: "Bad",
      income_type: "Grant",
      category_id: cat,
      status: "expected",
      amount: 10,
    }),
  ).rejects.toThrow(/category/);
  await expect(
    manage(s, "income", {
      source: "Bad",
      income_type: "Grant",
      status: "expected",
      amount: "NaN",
    }),
  ).rejects.toThrow();
  await expect(
    manage(s, "transfer", { from_id: cat, amount: "NaN" }),
  ).rejects.toThrow();
});
test("approval failure rolls notifications and approval rows back before category selection", async () => {
  const { s } = await season();
  const id = await submitted();
  await db.exec("reset role");
  const count = async () =>
    (
      await db.query<any>(
        "select count(*)::int n from public.team_notifications",
      )
    ).rows[0].n;
  const before = await count();
  await expect(
    act("finance", id, "approve", { slot: "finance_approver" }),
  ).rejects.toThrow(/category/);
  await db.exec("reset role");
  expect(await count()).toBe(before);
  expect(
    (
      await db.query<any>(
        "select count(*)::int n from public.finance_po_approvals where po_id=$1",
        [id],
      )
    ).rows[0].n,
  ).toBe(0);
  expect((await summary(s)).requested).toBe(125.5);
});
test("restricted money cannot be moved out through transfers, category rename retains funding", async () => {
  const { s, cat } = await season();
  await manage(s, "income", {
    source: "Restricted grant",
    income_type: "Grant",
    status: "received",
    amount: 500,
    received_on: "2026-09-20",
    category_id: cat,
  });
  await manage(s, "transfer", { from_id: cat, amount: 700 });
  let b = await summary(s);
  expect(b.categories[0]).toMatchObject({
    allocation: 0,
    restricted: 500,
    funded: 500,
  });
  expect(b.unallocated).toBe(1000);
  await expect(
    manage(s, "transfer", { from_id: cat, amount: 1 }),
  ).rejects.toThrow(/exceeds/);
  await expect(
    manage(s, "transfer", { to_id: cat, amount: 1001 }),
  ).rejects.toThrow(/unallocated/);
  await manage(s, "transfer", { to_id: cat, amount: 100 });
  await manage(s, "category", {
    id: cat,
    name: "Robot build",
    allocation: 100,
    display_order: 2,
    forecast: 800,
  });
  b = await summary(s);
  expect(b.categories[0]).toMatchObject({
    name: "Robot build",
    funded: 600,
    forecast: 800,
  });
  expect(b.unallocated).toBe(900);
});
test("school records remain in the original season after activation of the next season", async () => {
  const { s, cat } = await season();
  const id = await submitted();
  await act("finance", id, "approve", {
    slot: "finance_approver",
    category_id: cat,
  });
  await act("po", id, "approve", { slot: "po_approver" });
  await act("submitter", id, "school_submit");
  await manage(s, "close");
  await as("mentor");
  const next = await budget("create_season", {
    name: "Next",
    starting_funds: 874.5,
  });
  await manage(next, "activate", { confirmed: true });
  expect((await summary(next)).spent).toBe(0);
  expect((await summary(s)).spent).toBe(125.5);
  const c = await context(s);
  expect(c.history.some((h: any) => h.action === "school_submit")).toBe(true);
  expect(c.history.some((h: any) => h.action === "approve")).toBe(true);
});
test("Finance Lead keeps budget management while ordinary budget leadership cannot approve", async () => {
  const { s } = await season();
  await as("mentor");
  await expect(
    budget("classify_position", {
      position_key: "finance_lead",
      enabled: false,
      reason: "Remove",
    }),
  ).rejects.toThrow(/required/);
  await db.query("select public.team_manage('assign_position',$1::jsonb)", [
    JSON.stringify({
      user_id: ids.other,
      position_key: "software_lead",
      reason: "Leadership",
    }),
  ]);
  const id = await submitted();
  await expect(
    act("other", id, "approve", { slot: "finance_approver" }),
  ).rejects.toThrow();
  await as("other");
  expect((await context(s)).can_manage).toBe(true);
  expect(
    (
      await db.query(
        "select * from public.finance_purchase_orders where id=$1",
        [id],
      )
    ).rows,
  ).toEqual([]);
  await as("finance");
  const c = await context(s);
  await budget("category", {
    season_id: s,
    version: c.summary.season.version,
    name: "Tools",
    allocation: 20,
    reason: "Annual plan",
  });
  expect(
    (await context(s)).summary.categories.some((c: any) => c.name === "Tools"),
  ).toBe(true);
});
test("legacy Finance administrator does not gain season history through the PO history view", async () => {
  const { s } = await season();
  await as("mentor");
  await call("assignment", {
    user_id: ids.other,
    capability: "finance_admin",
    active: true,
    reason: "Manage PO administration only",
  });
  await as("other");
  expect((await context(s)).can_manage).toBe(false);
  expect(
    (
      await db.query(
        "select * from public.finance_po_history where action like 'budget_%'",
      )
    ).rows,
  ).toEqual([]);
  expect(
    (
      await db.query(
        "select * from public.finance_po_history where action='assignment'",
      )
    ).rows.length,
  ).toBeGreaterThan(0);
});
test("classification edits also reject stale state", async () => {
  await as("mentor");
  await budget("classify_position", {
    position_key: "custom_lead",
    enabled: true,
    expected_enabled: false,
    reason: "New leadership",
  });
  await expect(
    budget("classify_position", {
      position_key: "custom_lead",
      enabled: false,
      expected_enabled: false,
      reason: "Stale removal",
    }),
  ).rejects.toThrow(/changed/);
});

async function workbook(s: string) {
  return (
    await db.query<any>("select public.finance_workbook_context($1::uuid) c", [
      s,
    ])
  ).rows[0].c;
}
test("workbook RPC rechecks mentor, designated leadership, revoked/archived/inactive and student access", async () => {
  const { s } = await season(false);
  for (const who of ["mentor", "admin", "finance"] as const) {
    await as(who);
    expect((await workbook(s)).budget.can_manage).toBe(true);
  }
  for (const who of ["student", "lead", "inactive", "readonly"] as const) {
    await as(who);
    await expect(workbook(s)).rejects.toThrow(/leadership/);
  }
  await as("mentor");
  await db.query("select public.team_manage('assign_position',$1::jsonb)", [
    JSON.stringify({
      user_id: ids.lead,
      position_key: "software_lead",
      reason: "Budget leadership",
    }),
  ]);
  await as("lead");
  expect((await workbook(s)).budget.can_manage).toBe(true);
  expect(
    (
      await db.query<any>(
        "select finance_private.cap('finance_approver') f,finance_private.cap('po_approver') c",
      )
    ).rows[0],
  ).toEqual({ f: false, c: false });
  await db.exec(
    "reset role;update public.team_positions set active=false where key='software_lead'",
  );
  await as("lead");
  await expect(workbook(s)).rejects.toThrow(/leadership/);
  await db.exec(
    "reset role;update public.team_positions set active=true where key='software_lead';update public.team_member_positions set revoked_at=now(),revoked_by='00000000-0000-0000-0000-000000000012',revoke_reason='End' where position_key='software_lead'",
  );
  await as("lead");
  await expect(workbook(s)).rejects.toThrow(/leadership/);
  await db.exec(
    `reset role;update public.profiles set active=false where id='${ids.finance}'`,
  );
  await as("finance");
  await expect(workbook(s)).rejects.toThrow(/leadership/);
  await db.exec("reset role;set role anon");
  await expect(workbook(s)).rejects.toThrow(/permission denied/);
});
test("workbook RPC exports draft/active/closed empty seasons and rejects nonexistent season", async () => {
  const { s } = await season(false);
  for (const status of ["draft", "active", "closed"]) {
    if (status === "active") await manage(s, "activate", { confirmed: true });
    if (status === "closed") await manage(s, "close");
    await as("mentor");
    const x = await workbook(s);
    expect(x.budget.summary.season.status).toBe(status);
    expect(x.purchase_orders).toEqual([]);
    expect(x.budget.income).toEqual([]);
    expect(x.budget.summary).toEqual((await context(s)).summary);
  }
  await expect(workbook(uid(999))).rejects.toThrow(/existing budget season/);
});
test("workbook RPC is a complete read-only snapshot of authoritative totals, current PO revisions and history", async () => {
  const { s, cat } = await season();
  await manage(s, "income", {
    source: "Restricted grant",
    income_type: "Grant",
    amount: 200,
    status: "received",
    received_on: "2026-09-01",
    category_id: cat,
  });
  await manage(s, "income", {
    source: "Expected",
    income_type: "Sponsorship",
    amount: 900,
    status: "expected",
  });
  await manage(s, "income", {
    source: "Canceled",
    income_type: "Other",
    amount: 999,
    status: "canceled",
  });
  await manage(s, "expense", {
    category_id: cat,
    amount: 40,
    payee: "Shop",
    occurred_on: "2026-09-02",
  });
  await manage(s, "credit", {
    category_id: cat,
    amount: 10,
    occurred_on: "2026-09-03",
  });
  const id = await submitted();
  await act("po", id, "approve", { slot: "po_approver" });
  await act("finance", id, "approve", {
    slot: "finance_approver",
    category_id: cat,
  });
  await act("submitter", id, "school_submit", { reference: "School" });
  const requested = await submitted();
  await act("student", requested, "edit", { ...base, amount: 225.5 });
  await act("student", requested, "submit");
  const canceled = await submitted();
  await act("student", canceled, "cancel", { reason: "Not needed" });
  const changed = await submitted();
  await act("po", changed, "request_changes", {
    slot: "po_approver",
    reason: "Please revise",
  });
  await as("mentor");
  const before = await context(s);
  const x = await workbook(s);
  const after = await context(s);
  expect(after).toEqual(before);
  expect(x.budget.summary).toEqual(before.summary);
  expect(x.budget.summary).toMatchObject({
    actual_funding: 1200,
    expected: 900,
    requested: 225.5,
    committed: 0,
    spent: 155.5,
    credits: 10,
    unallocated: 300,
  });
  expect(x.budget.summary.categories[0]).toMatchObject({
    restricted: 200,
    funded: 900,
    spent: 155.5,
    available: 744.5,
  });
  expect(x.purchase_orders).toHaveLength(4);
  expect(x.purchase_orders.find((p: any) => p.id === id)).toMatchObject({
    bucket: "spent",
    requester: "student",
    functional_area: "Fabrication",
    category: "Robot parts",
    purpose: base.purpose,
    school_reference: "School",
  });
  expect(
    x.purchase_orders.find((p: any) => p.id === id).approved_at,
  ).toBeTruthy();
  expect(x.purchase_orders.find((p: any) => p.id === requested)).toMatchObject({
    bucket: "requested",
    revision: 2,
    amount: 225.5,
    approved_at: null,
  });
  for (const pid of [canceled, changed])
    expect(x.purchase_orders.find((p: any) => p.id === pid).bucket).toBe(
      "none",
    );
  expect(
    x.budget.history.some(
      (h: any) => h.po_id === id && h.action === "school_submit",
    ),
  ).toBe(true);
  expect(x.people[ids.mentor]).toBe("mentor");
  // A designated leader receives the same complete season export despite narrower V1 PO visibility.
  await db.query("select public.team_manage('assign_position',$1::jsonb)", [
    JSON.stringify({
      user_id: ids.other,
      position_key: "software_lead",
      reason: "Budget leadership",
    }),
  ]);
  await as("other");
  expect((await workbook(s)).purchase_orders).toEqual(x.purchase_orders);
});
