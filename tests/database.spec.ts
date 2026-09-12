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
test.beforeAll(async () => {
  db = new PGlite();
  await db.exec(`create role anon;create role authenticated;create schema auth;create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('test.uid',true),'')::uuid$$;grant usage on schema auth to authenticated;grant execute on function auth.uid() to authenticated;
create table public.areas(id uuid primary key,name text,active boolean);insert into public.areas values('${area}','Fabrication',true),('${otherArea}','Power',true);
create table public.profiles(id uuid primary key,display_name text,role text,active boolean,primary_area_id uuid);
create table public.team_attendance_members(student_id uuid primary key,member_status text);
${Object.entries(ids)
  .map(
    ([name, id]) =>
      `insert into public.profiles values('${id}','${name}','${name === "admin" ? "admin" : name === "lead" ? "lead" : name === "readonly" ? "readonly" : "student"}',${name !== "inactive"},'${area}');insert into public.team_attendance_members values('${id}','${name === "prospective" ? "prospective" : "registered"}');`,
  )
  .join("\n")}`);
  await db.exec(
    readFileSync("supabase/migrations/202609120002_finance_v1.sql", "utf8"),
  );
  await as("admin");
  for (const [who, capability] of [
    ["finance", "finance_approver"],
    ["po", "po_approver"],
    ["submitter", "school_submitter"],
  ] as const)
    await call("assignment", {
      user_id: ids[who],
      capability,
      active: true,
      reason: "Season assignment",
    });
});
test.afterAll(async () => {
  await db.close();
});
test("registered student draft/submission uses trusted actor and immutable revision", async () => {
  const id = await create();
  let p = await row(id);
  expect(p.status).toBe("draft");
  expect(p.requester_id).toBe(ids.student);
  await act("student", id, "submit", { requester_id: ids.admin });
  p = await row(id);
  expect(p.status).toBe("awaiting_approval");
  expect(p.revision).toBe(1);
  const revisions = (
    await db.query<any>(
      "select * from public.finance_po_revisions where po_id=$1",
      [id],
    )
  ).rows;
  expect(revisions[0].submitted_by).toBe(ids.student);
  expect(revisions[0].metadata.amount).toBe(125.5);
});
for (const first of ["finance", "po"] as const)
  test(`both independent approvals, ${first} first`, async () => {
    const id = await submitted(),
      second = first === "finance" ? "po" : "finance";
    await act(first, id, "approve", {
      slot: first === "finance" ? "finance_approver" : "po_approver",
    });
    expect((await row(id)).status).toBe("awaiting_approval");
    await act(second, id, "approve", {
      slot: second === "finance" ? "finance_approver" : "po_approver",
    });
    expect((await row(id)).status).toBe("approved");
    expect(
      (
        await db.query(
          "select * from public.finance_po_approvals where po_id=$1",
          [id],
        )
      ).rows,
    ).toHaveLength(2);
  });
test("changes requested require explanation, revision/resubmission preserves prior approvals", async () => {
  const id = await submitted();
  await act("finance", id, "approve", { slot: "finance_approver" });
  await expect(
    act("po", id, "request_changes", { slot: "po_approver" }),
  ).rejects.toThrow(/Explain/);
  await act("po", id, "request_changes", {
    slot: "po_approver",
    reason: "Include shipping",
  });
  expect((await row(id)).status).toBe("changes_requested");
  await act("student", id, "edit", { ...base, amount: 140 });
  await act("student", id, "submit");
  expect((await row(id)).revision).toBe(2);
  await expect(act("submitter", id, "school_submit")).rejects.toThrow(
    /Both current/,
  );
  await act("po", id, "approve", { slot: "po_approver" });
  expect((await row(id)).status).toBe("awaiting_approval");
  await act("finance", id, "approve", { slot: "finance_approver" });
  expect((await row(id)).status).toBe("approved");
  const a = (
    await db.query<any>(
      "select * from public.finance_po_approvals where po_id=$1",
      [id],
    )
  ).rows;
  expect(a.filter((x) => x.revision === 1)).toHaveLength(2);
  expect(a.filter((x) => x.revision === 2)).toHaveLength(2);
});
test("each material metadata edit invalidates approved state", async () => {
  for (const change of [
    { vendor: "Updated supplier" },
    { amount: 200 },
    { area_id: otherArea },
    { purpose: "Updated purpose" },
    { sheet_url: "https://docs.google.com/spreadsheets/d/Updated_123/edit" },
  ]) {
    const id = await fullApproved();
    await act("student", id, "edit", { ...base, ...change });
    expect((await row(id)).status).toBe("draft");
    await expect(act("submitter", id, "school_submit")).rejects.toThrow();
    await act("student", id, "submit");
    expect((await row(id)).revision).toBe(2);
    expect((await row(id)).status).toBe("awaiting_approval");
  }
});
test("school submission is capability gated, timestamped and locked afterward", async () => {
  const id = await submitted();
  await expect(act("submitter", id, "school_submit")).rejects.toThrow(
    /Both current/,
  );
  await act("finance", id, "approve", { slot: "finance_approver" });
  await expect(act("submitter", id, "school_submit")).rejects.toThrow(
    /Both current/,
  );
  await act("po", id, "approve", { slot: "po_approver" });
  await expect(act("student", id, "school_submit")).rejects.toThrow(
    /capability/,
  );
  await act("submitter", id, "school_submit", {
    reference: "SCHOOL-42",
    note: "Sent by email",
    submitted_by: ids.admin,
  });
  const p = await row(id);
  expect(p.status).toBe("submitted_to_school");
  expect(p.school_submitted_by).toBe(ids.submitter);
  expect(p.school_reference).toBe("SCHOOL-42");
  expect(p.school_submitted_at).toBeTruthy();
  await expect(act("student", id, "edit", base)).rejects.toThrow(/locked/);
});
test("students see only own requests; leads see submitted POs only for their area", async () => {
  const draft = await create(),
    id = await submitted();
  await as("other");
  expect(await row(id)).toBeUndefined();
  expect(
    (
      await db.query("select * from public.finance_po_history where po_id=$1", [
        id,
      ])
    ).rows,
  ).toHaveLength(0);
  expect(
    (
      await db.query(
        "select * from public.finance_po_approvals where po_id=$1",
        [id],
      )
    ).rows,
  ).toHaveLength(0);
  await expect(call("edit", { ...base, id, version: 2 })).rejects.toThrow(
    /unavailable/,
  );
  await as("lead");
  expect(await row(id)).toBeTruthy();
  expect(await row(draft)).toBeUndefined();
  await expect(
    call("approve", { id, version: 2, slot: "finance_approver" }),
  ).rejects.toThrow(/Configured/);
  await act("student", id, "edit", { ...base, area_id: otherArea });
  await act("student", id, "submit");
  await as("lead");
  expect(await row(id)).toBeUndefined();
});
test("unassigned admins need explicit override; one person cannot fill both slots; no normal self approval", async () => {
  const id = await submitted();
  await expect(
    act("admin", id, "approve", { slot: "finance_approver" }),
  ).rejects.toThrow(/override/);
  await act("admin", id, "approve", {
    slot: "finance_approver",
    override_reason: "Finance approver unavailable, mentor review",
  });
  await expect(
    act("admin", id, "approve", {
      slot: "po_approver",
      override_reason: "Second override",
    }),
  ).rejects.toThrow(/distinct/);
  await act("po", id, "approve", { slot: "po_approver" });
  await as("admin");
  await call("assignment", {
    user_id: ids.student,
    capability: "finance_approver",
    active: true,
    reason: "Test eligibility",
  });
  const own = await submitted();
  await expect(
    act("student", own, "approve", { slot: "finance_approver" }),
  ).rejects.toThrow(/override/);
  await as("admin");
  await call("assignment", {
    user_id: ids.student,
    capability: "finance_approver",
    active: false,
    reason: "End test assignment",
  });
  const history = (
    await db.query<any>(
      "select * from public.finance_po_history where po_id=$1",
      [id],
    )
  ).rows;
  expect(
    history.some((h) => h.details.override_reason?.includes("unavailable")),
  ).toBe(true);
});
test("stale approvals and unauthorized RPC/direct audit mutations fail", async () => {
  const id = await submitted();
  await act("finance", id, "approve", { slot: "finance_approver" });
  await as("po");
  await expect(
    call("approve", { id, version: 2, slot: "po_approver" }),
  ).rejects.toThrow(/changed/);
  for (const table of [
    "finance_purchase_orders",
    "finance_po_revisions",
    "finance_po_approvals",
    "finance_po_history",
    "finance_assignments",
  ]) {
    await expect(db.exec(`delete from public.${table}`)).rejects.toThrow(
      /permission denied/,
    );
  }
  await as("student");
  await expect(
    call("assignment", {
      user_id: ids.student,
      capability: "finance_admin",
      active: true,
      reason: "Spoof",
    }),
  ).rejects.toThrow(/administration/);
  for (const who of ["readonly", "inactive", "prospective"] as const) {
    await as(who);
    await expect(call("create", base)).rejects.toThrow();
  }
  await db.exec("reset role;set role anon");
  await expect(call("create", base)).rejects.toThrow(/permission denied/);
});
test("bad links and values rejected; cancellation audited", async () => {
  await as("student");
  for (const sheet_url of [
    "javascript:alert(1)",
    "https://docs.google.com.evil.invalid/spreadsheets/d/x",
    "http://docs.google.com/spreadsheets/d/x",
    "https://evil.invalid",
  ])
    await expect(call("create", { ...base, sheet_url })).rejects.toThrow();
  await expect(call("create", { ...base, amount: 0 })).rejects.toThrow();
  await expect(call("create", { ...base, amount: "NaN" })).rejects.toThrow();
  const id = await create();
  await expect(act("student", id, "cancel")).rejects.toThrow(/explanation/);
  await act("student", id, "cancel", { reason: "No longer needed" });
  expect((await row(id)).status).toBe("cancelled");
  await expect(act("student", id, "submit")).rejects.toThrow(/locked/);
});

test("change requests permanently invalidate a revision even if its status is stale", async () => {
  const id = await submitted();
  await act("finance", id, "approve", { slot: "finance_approver" });
  await act("po", id, "request_changes", { slot: "po_approver", reason: "Include shipping" });
  await expect(act("po", id, "approve", { slot: "po_approver" })).rejects.toThrow(/not awaiting/);
  // Simulate stale/corrected status using the database owner, never a client bypass.
  await db.exec("reset role");
  await db.query("update finance_purchase_orders set status='awaiting_approval' where id=$1", [id]);
  await expect(act("po", id, "approve", { slot: "po_approver" })).rejects.toThrow(/resubmission/);
  await db.exec("reset role");
  await db.query("insert into finance_po_approvals(po_id,revision,slot,action,actor_id) values($1,1,'po_approver','approved',$2)", [id, ids.po]);
  await db.query("update finance_purchase_orders set status='approved' where id=$1", [id]);
  expect((await db.query<any>("select finance_private.revision_approved($1,1) valid", [id])).rows[0].valid).toBe(false);
  await expect(act("submitter", id, "school_submit")).rejects.toThrow(/Both current/);
  await act("student", id, "edit", base);
  await act("student", id, "submit");
  await act("finance", id, "approve", { slot: "finance_approver" });
  expect((await row(id)).status).toBe("awaiting_approval");
  await expect(act("submitter", id, "school_submit")).rejects.toThrow(/Both current/);
  await act("po", id, "approve", { slot: "po_approver" });
  expect((await row(id)).status).toBe("approved");
});

test("admin requester requires an explicit audited exception and a distinct second approver", async () => {
  await as("admin");
  const id = await call("create", base);
  await act("admin", id, "submit");
  await expect(act("admin", id, "approve", { slot: "finance_approver" })).rejects.toThrow(/override/);
  await act("admin", id, "approve", { slot: "finance_approver", override_reason: "Emergency requester exception reviewed" });
  await expect(act("admin", id, "approve", { slot: "po_approver", override_reason: "Emergency" })).rejects.toThrow(/distinct/);
  await act("po", id, "approve", { slot: "po_approver" });
  expect((await row(id)).status).toBe("approved");
  await as("admin");
  const h = (await db.query<any>("select * from public.finance_po_history where po_id=$1 and action='approve' and actor_id=$2", [id, ids.admin])).rows[0];
  expect(h.details.self_approval_override).toBe(true);
  expect(h.details.override_reason).toBe("Emergency requester exception reviewed");
  expect(h.details.before).toBeTruthy();
});

test("student history allowlists activity fields and keeps raw audit inaccessible", async () => {
  const id = await submitted();
  await db.exec("reset role");
  await db.query("update finance_private.history set details=details || $2::jsonb where po_id=$1", [id, JSON.stringify({ internal_future_field: "private", before: { internal: "private" }, after: { internal: "private" }, reason: "Review requested" })]);
  await as("student");
  const history = (await db.query<any>("select * from public.finance_po_history where po_id=$1", [id])).rows;
  expect(history.length).toBeGreaterThan(0);
  for (const h of history) {
    expect(h.actor_id).toBeTruthy();
    expect(h.details.reason).toBe("Review requested");
    expect(h.details.before).toBeUndefined();
    expect(h.details.after).toBeUndefined();
    expect(h.details.internal_future_field).toBeUndefined();
  }
  await expect(db.exec("select * from finance_private.history")).rejects.toThrow(/permission denied/);
  for (const who of ["admin", "lead", "finance"] as const) {
    await as(who);
    const full = (await db.query<any>("select * from public.finance_po_history where po_id=$1", [id])).rows;
    expect(full[0].details.internal_future_field).toBe("private");
  }
  await as("other");
  expect((await db.query("select * from public.finance_po_history where po_id=$1", [id])).rows).toHaveLength(0);
});
