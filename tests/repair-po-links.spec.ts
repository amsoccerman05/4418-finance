import { test, expect } from '@playwright/test';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';

const migration = 'supabase/migrations/20261005235435_finance_repair_po_links.sql';
const uid = (n: number) => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
const ids = { student: uid(1), other: uid(2), lead: uid(3), otherLead: uid(4), finance: uid(5), coach: uid(6), admin: uid(7), mentor: uid(8), readonly: uid(9), inactive: uid(10), financeAdmin: uid(11), financeAdminLead: uid(12), prospective: uid(13) };
type Person = keyof typeof ids;
const area = uid(100), otherArea = uid(101), event = uid(200), issue = uid(300), otherIssue = uid(301);
let db: PGlite;
const sql = (path: string) => readFileSync(path, 'utf8');
async function as(person: Person) {
  await db.exec(`reset role; select set_config('test.uid','${ids[person]}',false); set role authenticated;`);
}
async function owner() { await db.exec('reset role'); }
async function finance(action: string, p: Record<string, unknown>) {
  return (await db.query<{ id: string }>('select public.finance_mutate($1,$2::jsonb) id', [action, JSON.stringify(p)])).rows[0].id;
}
async function create(person: Person = 'lead', patch: Record<string, unknown> = {}) {
  await as(person);
  return finance('create', { area_id: person === 'otherLead' ? otherArea : area, sheet_url: 'https://docs.google.com/spreadsheets/d/LocalFixture/edit', vendor: 'Fixture supplier', amount: 125.50, purpose: 'Repair motor', notes: 'Private PO note', ...patch });
}
async function act(person: Person, poId: string, action: string, patch: Record<string, unknown> = {}) {
  await as(person);
  const po = (await db.query<any>('select * from public.finance_purchase_orders where id=$1', [poId])).rows[0];
  return finance(action, { id: poId, version: po.version, ...patch });
}
async function stamp(issueId = issue) {
  return (await db.query<{ stamp: string }>('select updated_at::text stamp from public.pit_issues where id=$1', [issueId])).rows[0].stamp;
}
async function context(issueId: string | null = issue) {
  return (await db.query<any>('select public.finance_repair_context($1::uuid) value', [issueId])).rows[0].value;
}
async function candidate(poId: string | null, issueId: string | null = issue) {
  return (await db.query<any>('select public.finance_repair_po_candidate($1::uuid,$2::uuid) value', [issueId, poId])).rows[0].value;
}
async function attach(poId: string | null, options: { issueId?: string; expected?: string | null; reason?: string | null } = {}) {
  const issueId = options.issueId || issue;
  const expected = 'expected' in options ? options.expected : await stamp(issueId);
  return (await db.query<any>('select public.finance_attach_repair_po($1::uuid,$2::uuid,$3::timestamptz,$4::text) value', [issueId, poId, expected, options.reason === undefined ? 'Parts for this repair' : options.reason])).rows[0].value;
}
async function auditRows() { await owner(); return (await db.query<any>('select * from finance_private.repair_po_links order by issue_id,po_id')).rows; }
async function denied(work: Promise<unknown>) { await expect(work).rejects.toMatchObject({ code: '42501', message: 'Repair purchasing details unavailable' }); }
async function setup(withBridge = true, withPit = true) {
  db = new PGlite();
  await db.exec(`create role anon;create role authenticated;create role service_role;
    create schema auth;create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('test.uid',true),'')::uuid$$;
    grant usage on schema auth to authenticated;grant execute on function auth.uid() to authenticated;
    create table public.areas(id uuid primary key,name text,active boolean,slug text unique default gen_random_uuid()::text);
    insert into public.areas(id,name,active) values('${area}','Build',true),('${otherArea}','Electrical',true);
    create table public.profiles(id uuid primary key,display_name text,role text,active boolean,primary_area_id uuid,updated_at timestamptz default now());
    create table public.team_attendance_members(student_id uuid primary key,member_status text,team_area text default '');
    ${Object.entries(ids).map(([name,id]) => `insert into public.profiles values('${id}','${name}','${name === 'admin' ? 'admin' : name === 'mentor' ? 'mentor' : ['lead','otherLead','financeAdminLead'].includes(name) ? 'lead' : name === 'readonly' ? 'readonly' : 'student'}',${name !== 'inactive'},'${name === 'otherLead' ? otherArea : area}',now());insert into public.team_attendance_members values('${id}','${name === 'prospective' ? 'prospective' : 'registered'}','');`).join('\n')}
  `);
  for (const path of ['supabase/migrations/202609120002_finance_v1.sql', 'tests/fixtures/team_management_positions.sql', 'supabase/migrations/202609120004_finance_notifications.sql', 'supabase/migrations/202609190001_finance_notification_coverage.sql', 'supabase/migrations/202609200001_finance_budget_core.sql']) await db.exec(sql(path));
  await db.exec('grant select on public.profiles to authenticated');
  await as('admin');
  for (const [person, position] of [['finance','finance_lead'], ['coach','lead_coach_1']] as const) await db.query("select public.team_manage('assign_position',$1::jsonb)", [JSON.stringify({ user_id: ids[person], position_key: position, reason: 'Local fixture assignment' })]);
  for (const person of ['financeAdmin', 'financeAdminLead'] as const) await finance('assignment', { user_id: ids[person], capability: 'finance_admin', active: true, reason: 'Local fixture assignment' });
  await owner();
  if (withPit) {
    await db.exec(sql('tests/fixtures/pit_operations.sql'));
    await db.exec(`insert into public.pit_events(id,name,start_date,end_date,status) values('${event}','Fixture regional','2026-10-01','2026-10-03','completed');
      insert into public.pit_issues(id,event_id,title,subsystem,severity,status,description,reported_by,assigned_to) values
      ('${issue}','${event}','Motor repair','Drivetrain','ROBOT DOWN','REPAIRING','Replace damaged motor','${ids.student}','${ids.student}'),
      ('${otherIssue}','${event}','Electrical repair','Electrical','HIGH','DEFERRED','Inspect wiring','${ids.student}',null);`);
  }
  if (withBridge) await db.exec(sql(migration));
}
test.beforeEach(async () => { await setup(); });
test.afterEach(async () => { await db.close(); });

test('bridge has private RLS storage, narrow exact RPC signatures, and no anonymous execute', async () => {
  await owner();
  const row = (await db.query<any>(`select relrowsecurity from pg_class where oid='finance_private.repair_po_links'::regclass`)).rows[0];
  expect(row.relrowsecurity).toBe(true);
  for (const role of ['anon','authenticated','service_role']) expect((await db.query<any>(`select has_table_privilege($1,'finance_private.repair_po_links','select,insert,update,delete') allowed`, [role])).rows[0].allowed).toBe(false);
  const signatures = ['public.finance_repair_context(uuid)', 'public.finance_repair_po_candidate(uuid,uuid)', 'public.finance_attach_repair_po(uuid,uuid,timestamptz,text)'];
  for (const signature of signatures) {
    expect((await db.query<any>('select has_function_privilege($1,$2,\'execute\') allowed', ['anon', signature])).rows[0].allowed).toBe(false);
    expect((await db.query<any>('select has_function_privilege($1,$2,\'execute\') allowed', ['authenticated', signature])).rows[0].allowed).toBe(true);
  }
  const functions = (await db.query<any>(`select proname,proargnames,prosecdef,proconfig from pg_proc where proname in ('finance_repair_context','finance_repair_po_candidate','finance_attach_repair_po') order by proname`)).rows;
  expect(functions.every(f => f.prosecdef && f.proconfig.includes('search_path=""'))).toBe(true);
  expect(functions.find(f => f.proname === 'finance_attach_repair_po').proargnames).toEqual(['p_issue_id','p_po_id','p_expected_issue_updated_at','p_reason']);
});

test('lead can preview and attach their PO; context returns only minimal live fields', async () => {
  const po = await create();
  const preview = await candidate(po);
  expect(Object.keys(preview).sort()).toEqual(['issue_id','issue_updated_at','po_id','po_number','status','requester_name','can_attach'].sort());
  expect(preview).toMatchObject({ issue_id: issue, po_id: po, status: 'draft', requester_name: 'lead', can_attach: true });
  const c = await attach(po, { reason: '  Replacement motor  ' });
  expect(Object.keys(c).sort()).toEqual(['issue_id','issue_updated_at','can_attach','links'].sort());
  expect(c.links).toHaveLength(1);
  expect(Object.keys(c.links[0]).sort()).toEqual(['po_id','po_number','status','requester_name','linked_at'].sort());
  expect(c.links[0]).toMatchObject({ po_id: po, status: 'draft', requester_name: 'lead' });
  const records = await auditRows();
  expect(records[0]).toMatchObject({ issue_id: issue, po_id: po, linked_by: ids.lead, reason: 'Replacement motor' });
  expect(new Date(records[0].issue_updated_at).toISOString()).toBe(new Date(c.issue_updated_at).toISOString());
});

test('unique repair/PO pairs allow multiple POs and repairs; replay preserves original audit', async () => {
  const first = await create(), second = await create();
  await attach(first);
  const before = await auditRows();
  await as('lead');
  await Promise.all([attach(first, { reason: 'Different replay reason' }), attach(first)]);
  expect(await auditRows()).toEqual(before);
  await as('lead');
  expect((await attach(second)).links).toHaveLength(2);
  expect((await attach(first, { issueId: otherIssue })).links).toHaveLength(1);
  expect(await auditRows()).toHaveLength(3);
});

test('visible non-owned PO can be previewed but not attached by a lead', async () => {
  const po = await create('student'); await act('student', po, 'submit');
  await as('lead');
  expect((await candidate(po)).can_attach).toBe(false);
  await denied(attach(po));
  expect(await auditRows()).toEqual([]);
});

for (const person of ['admin','mentor','financeAdminLead'] as const) test(`${person} may attach under existing Finance admin plus repair-edit authority`, async () => {
  const po = await create('student');
  await as(person);
  expect((await candidate(po)).can_attach).toBe(true);
  expect((await attach(po)).links[0].po_id).toBe(po);
});

for (const person of ['student','financeAdmin','readonly','inactive','prospective'] as const) test(`${person} gains no repair-edit permission from ownership, assignment or Finance capability`, async () => {
  const po = await create('student');
  await as(person);
  await denied(attach(po, { expected: '2026-01-01T00:00:00Z' }));
  expect(await auditRows()).toEqual([]);
});

test('hidden and missing PO/repair requests have identical unavailable errors', async () => {
  const hidden = await create('student');
  await as('lead');
  for (const po of [hidden, uid(999), null]) {
    await denied(candidate(po));
    await denied(attach(po));
  }
  const own = await create();
  await denied(candidate(own, uid(999)));
  await denied(context(uid(999)));
  await denied(context(null));
  await denied(attach(own, { issueId: uid(999), expected: null }));
});

test('linked drafts and submitted POs retain all existing Finance read boundaries', async () => {
  const studentDraft = await create('student'), otherDraft = await create('other'), areaSubmitted = await create('other'), otherAreaSubmitted = await create('otherLead');
  await act('other', areaSubmitted, 'submit'); await act('otherLead', otherAreaSubmitted, 'submit');
  await as('admin');
  for (const po of [studentDraft, otherDraft, areaSubmitted, otherAreaSubmitted]) await attach(po);
  await as('student'); expect((await context()).links.map((p: any) => p.po_id)).toEqual([studentDraft]);
  await as('lead'); expect((await context()).links.map((p: any) => p.po_id)).toEqual([areaSubmitted]);
  await as('finance'); expect((await context()).links.map((p: any) => p.po_id).sort()).toEqual([areaSubmitted, otherAreaSubmitted].sort());
  await as('readonly'); expect((await context()).links).toEqual([]);
  expect(Object.keys(await context()).sort()).toEqual(['issue_id','issue_updated_at','can_attach','links'].sort());
  await as('inactive'); await denied(context());
});

test('all active Pit readers receive context but only existing repair editors receive can_attach', async () => {
  for (const person of ['student','lead','otherLead','finance','coach','admin','mentor','readonly','financeAdmin','financeAdminLead','prospective'] as const) {
    await as(person);
    expect((await context()).can_attach).toBe(['lead','otherLead','admin','mentor','financeAdminLead'].includes(person));
  }
  await owner(); await db.exec("select set_config('test.uid','',false);set role authenticated;"); await denied(context());
  await owner(); await db.exec('set role anon;');
  await expect(context()).rejects.toMatchObject({ code: '42501' });
});

test('current permission changes are rechecked after preview', async () => {
  const po = await create(); expect((await candidate(po)).can_attach).toBe(true);
  const expected = await stamp();
  await owner(); await db.query('update public.profiles set role=\'student\' where id=$1', [ids.lead]);
  await as('lead'); await denied(attach(po, { expected }));
  await owner(); await db.query('update public.profiles set role=\'lead\',active=false where id=$1', [ids.lead]);
  await as('lead'); await denied(candidate(po)); await denied(attach(po, { expected }));
  expect(await auditRows()).toEqual([]);
});

test('explicit bounded reason and matching repair timestamp are required with no partial rows', async () => {
  const po = await create();
  for (const reason of ['', '   ', '\n\t', '\r\n \t', null, 'x'.repeat(2001)]) await expect(attach(po, { reason })).rejects.toMatchObject({ code: '22023' });
  for (const expected of [null, '2000-01-01T00:00:00Z']) await expect(attach(po, { expected })).rejects.toMatchObject({ code: '40001' });
  const oldStamp = await stamp();
  await owner();
  await expect(db.query('insert into finance_private.repair_po_links(issue_id,po_id,linked_by,issue_updated_at,reason) values($1,$2,$3,$4,$5)', [issue,po,ids.lead,oldStamp,'\n\t'])).rejects.toMatchObject({ code: '23514' });
  await as('lead');
  await db.query('select public.pit_update_issue($1::jsonb)', [JSON.stringify({ id: issue, expected_updated_at: oldStamp, repair_notes: 'A newer repair update' })]);
  await expect(attach(po, { expected: oldStamp })).rejects.toMatchObject({ code: '40001' });
  expect(await auditRows()).toEqual([]);
  await as('lead'); expect((await attach(po)).links).toHaveLength(1);
});

test('client cannot read audit reasons or directly insert, update or delete relationship rows', async () => {
  const po = await create(); await attach(po);
  for (const query of ['select * from finance_private.repair_po_links', 'delete from finance_private.repair_po_links', "update finance_private.repair_po_links set reason='forged'", `insert into finance_private.repair_po_links(issue_id,po_id,linked_by,issue_updated_at,reason) values('${otherIssue}','${po}','${ids.admin}',now(),'forged')`]) await expect(db.exec(query)).rejects.toMatchObject({ code: '42501' });
  expect(await auditRows()).toHaveLength(1);
});

test('attachment changes no Finance, approval, budget, repair, history or notification rows', async () => {
  const po = await create('student'); await act('student', po, 'submit');
  await act('finance', po, 'approve', { slot: 'finance_approver' });
  await act('coach', po, 'approve', { slot: 'po_approver' });
  await owner();
  await db.exec(`insert into public.finance_seasons(id,name,status,starting_funds,reserve_target,created_by) values('${uid(500)}','Fixture budget','active',1000,100,'${ids.admin}');
    insert into public.finance_budget_categories(id,season_id,name,allocation) values('${uid(501)}','${uid(500)}','Parts',500);
    insert into public.finance_po_budget(po_id,season_id,category_id) values('${po}','${uid(500)}','${uid(501)}');`);
  const tables = ['public.finance_purchase_orders','public.finance_po_approvals','public.finance_po_revisions','finance_private.history','public.finance_seasons','public.finance_budget_categories','public.finance_po_budget','public.finance_income','public.finance_expenses','public.team_notifications','public.pit_issues','public.pit_issue_events','public.pit_battery_events'];
  const snapshot = async () => { await owner(); const data: Record<string, unknown> = {}; for (const table of tables) data[table] = (await db.query<any>(`select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text),'[]') rows from ${table} t`)).rows[0].rows; return data; };
  const before = await snapshot();
  await as('admin'); await attach(po);
  expect(await snapshot()).toEqual(before);
  expect((before['public.team_notifications'] as any[]).length).toBeGreaterThan(0);
});

test('context uses live PO state, not a snapshot, and safely falls back for a blank requester name', async () => {
  const po = await create(); await attach(po);
  await act('lead', po, 'submit');
  await owner(); await db.query("update public.profiles set display_name=' ' where id=$1", [ids.lead]);
  await as('lead');
  expect((await context()).links[0]).toMatchObject({ status: 'awaiting_approval', requester_name: 'Team member' });
  expect((await candidate(po)).requester_name).toBe('Team member');
});

test('migration fails atomically when Pit is not installed', async () => {
  await db.close(); await setup(false, false);
  await expect(db.exec(sql(migration))).rejects.toThrow('Existing Pit Operations and Finance permission contracts are required');
  await db.exec('rollback');
  expect((await db.query<any>("select to_regclass('finance_private.repair_po_links') name")).rows[0].name).toBeNull();
});

test('missing staged bridge fails explicitly without changing existing Pit or Finance availability', async () => {
  await db.close(); await setup(false, true);
  await as('lead');
  await expect(context()).rejects.toMatchObject({ code: '42883' });
  expect((await db.query<any>('select id from public.pit_issues where id=$1', [issue])).rows).toHaveLength(1);
  expect((await db.query<any>('select public.finance_context() value')).rows[0].value.can_create).toBe(true);
});
