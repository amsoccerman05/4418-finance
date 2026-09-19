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
test.beforeAll(async () => {
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
  await db.exec(readFileSync("tests/fixtures/team_management_positions.sql", "utf8"));
  await db.exec(readFileSync("supabase/migrations/202609120004_finance_notifications.sql", "utf8"));
  await db.exec(readFileSync("supabase/migrations/202609190001_finance_notification_coverage.sql", "utf8"));
  await as("admin");
  for (const [who,position_key] of [["finance","finance_lead"],["po","lead_coach_1"],["coach2","lead_coach_2"]] as const) {
    await db.query("select public.team_manage('assign_position',$1::jsonb)",[JSON.stringify({user_id:ids[who],position_key,reason:"Season assignment"})]);
  }
  await call("assignment", {user_id:ids.submitter,capability:"school_submitter",active:true,reason:"School submission assignment"});

});
test.afterAll(async () => {
  await db.close();
});
async function notices(id:string,event?:string){await db.exec('reset role');return (await db.query<any>('select * from team_notifications where entity_id=$1 and ($2::text is null or event=$2) order by recipient_id',[id,event||null])).rows;}
test('notification submission resolves current positions and excludes requester, vacant and inactive positions',async()=>{
 const id=await submitted();expect((await notices(id,'approval_needed')).map(n=>n.recipient_id).sort()).toEqual([ids.finance,ids.po,ids.coach2].sort());
 await as('admin');const grants=(await db.query<any>("select id,user_id,position_key from team_member_positions where revoked_at is null and position_key in ('lead_coach_1','finance_lead')")).rows;
 for(const g of grants)await db.query("select team_manage('revoke_position',$1::jsonb)",[JSON.stringify({user_id:g.user_id,assignment_id:g.id,reason:'Vacancy test'})]);
 const second=await submitted();expect((await notices(second)).map(n=>n.recipient_id)).toEqual([ids.coach2]);
 await as('admin');for(const g of grants)await db.query("select team_manage('assign_position',$1::jsonb)",[JSON.stringify({user_id:g.user_id,position_key:g.position_key,reason:'Restore test positions'})]);
 await db.exec('reset role');await db.query('update profiles set active=false where id=$1',[ids.po]);
 const third=await submitted();expect((await notices(third)).map(n=>n.recipient_id)).not.toContain(ids.po);
 await db.query('update profiles set active=true where id=$1',[ids.po]);
 await as('finance');const own=await call('create',base);await act('finance',own,'submit');expect((await notices(own)).map(n=>n.recipient_id)).not.toContain(ids.finance);
});
test('notification reminders target only the remaining approval and both approvals target school submitter',async()=>{
 const id=await submitted();await act('coach2',id,'approve',{slot:'po_approver'});expect((await notices(id,'approval_recorded')).map(n=>n.recipient_id)).toEqual([ids.student,ids.finance].sort());
 await act('finance',id,'approve',{slot:'finance_approver'});expect((await notices(id,'ready_for_school')).map(n=>n.recipient_id)).toEqual([ids.student,ids.submitter].sort());
 const second=await submitted();await act('finance',second,'approve',{slot:'finance_approver'});expect((await notices(second,'approval_recorded')).map(n=>n.recipient_id).sort()).toEqual([ids.student,ids.po,ids.coach2].sort());
});
test('change request, resubmission and school submission preserve notification details and revision',async()=>{
 const id=await submitted();await act('coach2',id,'request_changes',{slot:'po_approver',reason:'Please revise <details>'});
 let n=(await notices(id,'changes_requested'))[0];expect(n.recipient_id).toBe(ids.student);expect(n.payload.explanation).toBe('Please revise <details>');expect(n.payload.actor).toBe('coach2');
 await act('student',id,'submit');expect((await notices(id,'approval_needed')).filter(n=>n.payload.revision===2).length).toBe(3);
 await act('coach2',id,'approve',{slot:'po_approver'});await act('finance',id,'approve',{slot:'finance_approver'});await act('submitter',id,'school_submit',{reference:'SCH-42'});
 n=(await notices(id,'submitted_to_school'))[0];expect(n.recipient_id).toBe(ids.student);expect(n.payload.reference).toBe('SCH-42');expect(n.payload.submitted_at).toBeTruthy();
});
test('school fallback uses authorized active mentors/admins only and caps fanout',async()=>{
 await db.exec('reset role');await db.query("update finance_assignments set active=false where capability='school_submitter'");
 const id=await fullApproved();expect((await notices(id,'ready_for_school')).map(n=>n.recipient_id).sort()).toEqual([ids.student,ids.admin,ids.mentor].sort());
 for(let i=201;i<=204;i++)await db.query("insert into profiles(id,display_name,role,active,primary_area_id) values($1,'Fallback test','mentor',true,$2)",[uid(i),area]);
 const excessive=await fullApproved();expect((await notices(excessive,'ready_for_school')).map(n=>n.recipient_id)).toEqual([ids.student]);
 for(let i=201;i<=204;i++)await db.query('delete from profiles where id=$1',[uid(i)]);
 await db.query("update finance_assignments set active=true where capability='school_submitter'");
});
test('browser cannot forge notifications or claim deliveries; trusted replay deduplicates',async()=>{
 const id=await submitted();const n=(await notices(id))[0];
 for(const who of ['student','admin','mentor'] as const){await as(who);await expect(db.exec('select * from team_notifications')).rejects.toThrow(/permission denied/);await expect(db.exec("insert into team_notifications default values")).rejects.toThrow();await expect(db.exec('select team_notification_claim(3)')).rejects.toThrow();await expect(db.query('select team_notification_enqueue_history($1)',[n.source_event_id])).rejects.toThrow();}
 await db.exec('reset role;set role service_role');await db.query('select team_notification_enqueue_history($1)',[n.source_event_id]);expect((await notices(id)).length).toBe(3);
});
test('leases, frozen provider request and retry limits prevent duplicate intentional delivery',async()=>{
 await db.exec("reset role;update team_notifications set status='skipped'");const id=await submitted();
 await db.exec('reset role;set role service_role');const claimed=(await db.query<any>('select * from team_notification_claim(3)')).rows;expect(claimed.length).toBe(3);expect((await db.query('select * from team_notification_claim(3)')).rows.length).toBe(0);
 const n=claimed[0];const original={to:['fixture@example.invalid'],subject:'first'};
 await db.query('select team_notification_prepare($1,$2,$3)',[n.id,n.lease_token,original]);const frozen=(await db.query<any>('select team_notification_prepare($1,$2,$3) body',[n.id,n.lease_token,{subject:'changed'}])).rows[0].body;expect(frozen).toEqual(original);
 await db.query("select team_notification_finish($1,$2,'retry','provider_http_503',null)",[n.id,n.lease_token]);await db.exec('reset role');expect((await row(id)).status).toBe('awaiting_approval');
 await db.exec("reset role;update team_notifications set next_attempt_at=now(),attempts=5 where status='pending';set role service_role");await db.exec('select team_notification_claim(3)');
 await db.exec('reset role');expect((await db.query<any>('select status from team_notifications where id=$1',[n.id])).rows[0].status).toBe('review');
 await db.exec("update team_notifications set lease_until=now()-interval '1 second',first_attempt_at=now()-interval '23 hours 1 minute' where status='sending';set role service_role");expect((await db.query('select * from team_notification_claim(3)')).rows.length).toBe(0);
});
test('inactive recipient is skipped at dispatch without changing the PO',async()=>{
 await db.exec("reset role;update team_notifications set status='skipped'");const id=await submitted();await db.exec('reset role');await db.query('update profiles set active=false where id=$1',[ids.finance]);await db.exec('set role service_role');
 const ns=(await db.query<any>('select * from team_notification_claim(3)')).rows;expect(ns.map(n=>n.recipient_id)).not.toContain(ids.finance);await db.exec('reset role');await db.query('update profiles set active=true where id=$1',[ids.finance]);expect((await row(id)).status).toBe('awaiting_approval');
});

test('notification channels allow future channels while Finance enqueues email only',async()=>{
 const id=await submitted();const ns=await notices(id);expect(ns.length).toBeGreaterThan(0);expect(ns.every(n=>n.channel==='email')).toBe(true);
 for(const channel of ['slack','in_app','email']){
  await db.query('update team_notifications set channel=$1 where id=$2',[channel,ns[0].id]);
  expect((await notices(id)).find(n=>n.id===ns[0].id).channel).toBe(channel);
 }
 await expect(db.query("update team_notifications set channel='sms' where id=$1",[ns[0].id])).rejects.toThrow(/check constraint/);
});
test('sent notifications require a timestamp and successful delivery sets it',async()=>{
 await db.exec("reset role;update team_notifications set status='skipped'");const id=await submitted();const n=(await notices(id))[0];
 expect(n.sent_at).toBeNull();
 await expect(db.query("update team_notifications set status='sent' where id=$1",[n.id])).rejects.toThrow(/team_notifications_sent_timestamp/);
 await db.exec('set role service_role');const claimed=(await db.query<any>('select * from team_notification_claim(3)')).rows;const delivery=claimed.find(x=>x.id===n.id);expect(delivery).toBeTruthy();
 await db.query("select team_notification_finish($1,$2,'sent',null,'test-provider-id')",[n.id,delivery.lease_token]);
 const sent=(await notices(id)).find(x=>x.id===n.id);expect(sent.status).toBe('sent');expect(sent.sent_at).not.toBeNull();
 await expect(db.query('update team_notifications set sent_at=null where id=$1',[n.id])).rejects.toThrow(/team_notifications_sent_timestamp/);
});

test('cancellation informs involved approvers once, excludes actor and ignores draft edits',async()=>{
 const draft=await create();expect(await notices(draft)).toHaveLength(0);await act('student',draft,'edit',base);expect(await notices(draft)).toHaveLength(0);await act('student',draft,'cancel',{reason:'Not needed'});expect(await notices(draft)).toHaveLength(0);
 const id=await submitted();await act('finance',id,'approve',{slot:'finance_approver'});await act('student',id,'cancel',{reason:'Different parts selected'});
 const ns=await notices(id,'cancelled');expect(ns.map(n=>n.recipient_id).sort()).toEqual([ids.finance,ids.po,ids.coach2].sort());expect(ns.every(n=>n.payload.explanation==='Different parts selected')).toBe(true);expect(new Set(ns.map(n=>n.recipient_id)).size).toBe(ns.length);
});
test('final approval combines approval and ready-for-school in one event per recipient',async()=>{
 const id=await fullApproved(),ns=await notices(id,'ready_for_school');expect(ns.map(n=>n.recipient_id).sort()).toEqual([ids.student,ids.submitter].sort());expect(ns.every(n=>n.payload.slot==='po_approver')).toBe(true);
 await act('submitter',id,'school_submit',{reference:'School receipt'});expect((await notices(id,'submitted_to_school')).map(n=>n.recipient_id).sort()).toEqual([ids.student,ids.finance,ids.po].sort());
});
