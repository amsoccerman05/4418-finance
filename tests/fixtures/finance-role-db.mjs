import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';

export const uid = n => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
export const ids = { student: uid(1), other: uid(2), finance: uid(3), coach: uid(4), submitter: uid(5), admin: uid(6), mentor: uid(7), financeAdmin: uid(8), lead: uid(9), readonly: uid(10), inactive: uid(11), adminLead: uid(12), staffCoach: uid(13), adminCoach: uid(14), budgetLead: uid(15) };
export const area = uid(100), otherArea = uid(101), issue = uid(300);
export const base = { area_id: area, sheet_url: 'https://docs.google.com/spreadsheets/d/FixtureOnly/edit', vendor: 'Private fixture supplier', amount: 125.5, purpose: 'Synthetic replacement part', notes: '', needed_by: '' };
export const read = p => readFileSync(p, 'utf8');
export async function installedDatabase() {
  const db = new PGlite();
  await db.exec(`create role anon;create role authenticated;create role service_role;create schema auth;
    create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('test.uid',true),'')::uuid$$;
    grant usage on schema auth to authenticated;grant execute on function auth.uid() to authenticated;
    create table public.areas(id uuid primary key,name text,active boolean,slug text unique default gen_random_uuid()::text);
    insert into public.areas(id,name,active) values('${area}','Build',true),('${otherArea}','Electrical',true);
    create table public.profiles(id uuid primary key,display_name text,role text constraint profiles_role_check check(role in ('readonly','student','lead','mentor','admin')),active boolean,primary_area_id uuid,updated_at timestamptz default now());
    create table public.team_attendance_members(student_id uuid primary key,member_status text,team_area text default '');
    ${Object.entries(ids).map(([name,id]) => `insert into public.profiles values('${id}','${name}','${({admin:'admin',mentor:'mentor',lead:'lead',readonly:'readonly',staffCoach:'mentor',adminCoach:'admin',budgetLead:'lead'})[name] || 'student'}',${name !== 'inactive'},${name==='student' ? 'null' : `'${area}'`},now());`).join('\n')}
  `);
  for (const path of [
    'supabase/migrations/202609120002_finance_v1.sql','tests/fixtures/team_management_positions.sql',
    'supabase/migrations/202609120004_finance_notifications.sql','supabase/migrations/202609190001_finance_notification_coverage.sql',
    'supabase/migrations/202609200001_finance_budget_core.sql','supabase/migrations/202609200002_finance_workbook.sql',
    'tests/fixtures/pit_operations.sql','supabase/migrations/20261005235435_finance_repair_po_links.sql',
    'supabase/migrations/20261007011342_allow_all_active_student_purchase_requests.sql',
    'supabase/migrations/20261018051306_finance_notification_delivery_authorization.sql',
    'supabase/migrations/20261027204114_finance_po_received.sql','supabase/migrations/20261028033326_finance_po_actionability.sql',
  ]) await db.exec(read(path));
  await db.exec(`grant select on public.profiles to authenticated;
    insert into public.team_member_positions(user_id,position_key,assigned_by,assignment_reason) values
      ('${ids.finance}','finance_lead','${ids.admin}','Fixture'),('${ids.coach}','lead_coach_1','${ids.admin}','Fixture'),
      ('${ids.staffCoach}','lead_coach_1','${ids.admin}','Fixture'),('${ids.adminCoach}','lead_coach_2','${ids.admin}','Fixture');
    insert into public.team_positions(key,name) values('software_lead','Software Lead') on conflict do nothing;
    insert into finance_private.budget_positions values('software_lead') on conflict do nothing;
    insert into public.team_member_positions(user_id,position_key,assigned_by,assignment_reason) values('${ids.budgetLead}','software_lead','${ids.admin}','Fixture');
    insert into public.finance_assignments(user_id,capability,active,assigned_by) values('${ids.submitter}','school_submitter',true,'${ids.admin}'),('${ids.financeAdmin}','finance_admin',true,'${ids.admin}');
    insert into public.pit_events(id,name,start_date,end_date,status) values('${uid(200)}','Fixture event','2026-10-01','2026-10-03','completed');
    insert into public.pit_issues(id,event_id,title,subsystem,severity,status,description,reported_by) values('${issue}','${uid(200)}','Fixture repair','Drivetrain','HIGH','REPAIRING','Synthetic only','${ids.student}');
  `);
  return db;
}
