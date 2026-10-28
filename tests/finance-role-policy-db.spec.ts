import { test, expect } from '@playwright/test';
import { installedDatabase, ids, area, otherArea, base, read, uid, issue } from './fixtures/finance-role-db.mjs';

const migration = 'supabase/migrations/20261028160500_finance_student_roles_readonly_privacy.sql';
let db: any;
let beforeCatalog: any, beforeData: any;
async function catalog() {
 await owner(); return {
  functions: (await db.query(`select n.nspname,p.proname,p.prosrc,p.proacl,p.prosecdef,p.proconfig from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in ('public','finance_private','notifications_private','team_private','pit_private') order by 1,2`)).rows,
  policies: (await db.query('select * from pg_policies order by schemaname,tablename,policyname')).rows,
  relations: (await db.query("select n.nspname,c.relname,c.relrowsecurity,c.relacl,c.reloptions from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname in ('public','finance_private','notifications_private') and c.relkind in ('r','v') order by 1,2")).rows,
 };
}
async function owner() { await db.exec('reset role'); }
async function as(person: string) { await db.exec(`reset role;select set_config('test.uid','${ids[person]}',false);set role authenticated`); }
async function rpc(name: string, args: any[] = []) { const marks=args.map((_,i)=>`$${i+1}`).join(',');return (await db.query(`select public.${name}(${marks}) value`,args)).rows[0].value; }
async function act(person: string,id: string, action: string,p: any={}) { await owner();const po=(await db.query('select * from public.finance_purchase_orders where id=$1',[id])).rows[0];await as(person);return rpc('finance_mutate',[action,{id,version:po.version,...p}]); }
async function create(person='student',p: any={}) { await as(person);return rpc('finance_mutate',['create',{...base,...p}]); }
async function pending(person='student') { const id=await create(person);await act(person,id,'submit');return id; }
async function row(id: string) { await owner();return (await db.query('select * from public.finance_purchase_orders where id=$1',[id])).rows[0]; }
async function context(person: string) { await as(person);return rpc('finance_context'); }
async function snapshot() { await owner();const out:any={};for(const t of ['public.finance_purchase_orders','public.finance_po_approvals','public.finance_po_revisions','finance_private.history','public.team_notifications','public.finance_assignments','finance_private.repair_po_links'])out[t]=(await db.query(`select to_jsonb(x) row from ${t} x order by to_jsonb(x)::text`)).rows;return out; }
async function deny(person: string,id: string,action: string,p: any={}) {const before=await snapshot();await expect(act(person,id,action,p)).rejects.toMatchObject({code:'42501'});expect(await snapshot()).toEqual(before);}
async function approve(id:string, person='finance',slot='finance_approver',p:any={}) {return act(person,id,'approve',{slot,...p});}
async function goodPair(id:string) {await approve(id);await approve(id,'coach','po_approver');}
async function marked(id:string) {await owner();return (await db.query(`select h.* from finance_private.history h where po_id=$1 and details->>'approval_authority'='assigned_lead_coach_self'`,[id])).rows;}
async function renameRole(person:string,role:string) {await owner();await db.query('update public.profiles set role=$1 where id=$2',[role,ids[person]]);}
test.beforeEach(async()=>{
 db=await installedDatabase();
 // Finance's fixture mirrors the exact shared core helper; the Hub suite applies
 // the entire canonical core + Finance migration for combined-schema coverage.
 await db.exec(read('tests/fixtures/student-role-position-eligibility.sql'));
 await renameRole('adminLead','admin_lead');
 beforeCatalog=await catalog();beforeData=await snapshot();
 await db.exec(read(migration));
});
test.afterEach(async()=>{await db?.close();});

test('only reviewed functions change; table privileges/policies/business rows remain unchanged; private helper cannot be called directly',async()=>{
 expect(await snapshot()).toEqual(beforeData);
 const after=await catalog();expect(after.policies).toEqual(beforeCatalog.policies);expect(after.relations).toEqual(beforeCatalog.relations);
 const expected=['finance_private.cap','finance_private.creator','finance_private.visible','finance_private.can_manage_budget','finance_private.mutate_v1','finance_private.revision_approved','public.finance_context','public.finance_mutate','public.finance_budget_context','public.finance_budget_manage','public.finance_workbook_context','public.finance_repair_context','public.finance_repair_po_candidate','public.finance_attach_repair_po','public.finance_notification_delivery_allowed','notifications_private.enqueue'];
 const changed:string[]=[];
 for(const old of beforeCatalog.functions){const next=after.functions.find((x:any)=>x.nspname===old.nspname&&x.proname===old.proname);expect(next).toBeTruthy();expect({...next,prosrc:old.prosrc}).toEqual(old);if(next.prosrc!==old.prosrc)changed.push(old.nspname+'.'+old.proname);}
 expect(changed.sort()).toEqual(expected.sort());expect(after.functions.length-beforeCatalog.functions.length).toBe(1);
 const signatures=['finance_private.coach_self_approval_context(uuid)'];
 await owner();for(const role of ['anon','authenticated','service_role'])for(const signature of signatures)expect((await db.query('select has_function_privilege($1,$2,\'execute\') ok',[role,signature])).rows[0].ok).toBe(false);
 const helper=(await db.query(`select prosecdef,proconfig from pg_proc where oid='finance_private.coach_self_approval_context(uuid)'::regprocedure`)).rows[0];expect(helper.prosecdef).toBe(true);expect(helper.proconfig).toContain('search_path=""');
 for(const table of ['finance_purchase_orders','finance_po_approvals','finance_po_revisions','finance_assignments'])expect((await db.query(`select has_table_privilege('authenticated','public.${table}','insert,update,delete') ok`)).rows[0].ok).toBe(false);
});
test('prospective Student with no attendance, primary area or positions can create and request-submit, never approve or school-submit',async()=>{
 const c=await context('student');expect(c.profile.role).toBe('student');expect(c.can_create).toBe(true);expect(c.capabilities).toEqual([]);
 const id=await pending();expect((await row(id)).status).toBe('awaiting_approval');await deny('student',id,'approve',{slot:'finance_approver'});await deny('student',id,'school_submit');
});
test('Readonly old owner retains authorized views/history but every request mutation is denied without writes',async()=>{
 const id=await pending();await renameRole('student','readonly');const c=await context('student');expect(c.can_create).toBe(false);expect(c.is_admin).toBe(false);expect(c.capabilities).toEqual([]);
 for(const action of ['edit','submit','cancel','approve','request_changes','school_submit','receive'])await deny('student',id,action,{...base,slot:'po_approver',reason:'Fixture'});
 await as('student');expect((await db.query('select * from public.finance_purchase_orders where id=$1',[id])).rows).toHaveLength(1);expect((await db.query('select * from public.finance_po_history where po_id=$1',[id])).rows.length).toBeGreaterThan(0);
 await expect(rpc('finance_mutate',['create',base])).rejects.toMatchObject({code:'42501'});
});
test('Readonly overrides retained Finance admin/submitter/Coach/Finance positions',async()=>{
 const id=await pending('financeAdmin');await owner();await db.exec(`insert into public.team_member_positions(user_id,position_key,assigned_by,assignment_reason) values('${ids.financeAdmin}','finance_lead','${ids.admin}','Fixture'),('${ids.financeAdmin}','lead_coach_1','${ids.admin}','Fixture')`);await renameRole('financeAdmin','readonly');expect((await context('financeAdmin')).capabilities).toEqual([]);await deny('financeAdmin',id,'assignment',{user_id:ids.other,capability:'school_submitter',active:true,reason:'Fixture'});
});
test('Admin Lead baseline is own requests plus all nondrafts, not hidden drafts, approvals, budgets or unrestricted admin',async()=>{
 const own=await create('adminLead'),hidden=await create('other'),visible=await pending('other');const c=await context('adminLead');expect(c).toMatchObject({can_create:true,is_admin:false,capabilities:['school_submitter']});
 await as('adminLead');const rows=(await db.query('select id from public.finance_purchase_orders')).rows.map((x:any)=>x.id);expect(rows).toContain(own);expect(rows).toContain(visible);expect(rows).not.toContain(hidden);expect(await rpc('finance_budget_context',[null])).toEqual({can_manage:false});await deny('adminLead',visible,'edit',base);await deny('adminLead',visible,'approve',{slot:'finance_approver',override_reason:'Cannot override'});await deny('adminLead',visible,'assignment',{user_id:ids.other,capability:'finance_admin',active:true,reason:'Cannot assign'});
});
test('Admin Lead can school-submit and receive only approved/submitted POs under unchanged closed-season rules',async()=>{
 const id=await pending();await expect(act('adminLead',id,'school_submit')).rejects.toThrow(/approvals/);await goodPair(id);await act('adminLead',id,'school_submit');await act('adminLead',id,'receive',{note:'Synthetic delivery'});expect((await row(id)).status).toBe('received');
 const locked=await pending();await goodPair(locked);await act('adminLead',locked,'school_submit');await owner();await db.exec(`insert into public.finance_seasons(id,name,status,created_by) values('${uid(500)}','Closed fixture','closed','${ids.admin}');insert into public.finance_po_budget(po_id,season_id) values('${locked}','${uid(500)}');`);await expect(act('adminLead',locked,'receive')).rejects.toThrow(/Closed season/);
});
test('Admin Lead legitimate explicit Finance position/admin overlays remain, but no staff override is inherited',async()=>{
 await owner();await db.exec(`insert into public.team_member_positions(user_id,position_key,assigned_by,assignment_reason) values('${ids.adminLead}','finance_lead','${ids.admin}','Fixture');`);const c=await context('adminLead');expect(c.capabilities).toContain('finance_approver');expect((await rpc('finance_budget_context',[null])).can_manage).toBe(true);const id=await pending();await approve(id,'adminLead');await deny('adminLead',id,'approve',{slot:'po_approver',override_reason:'No staff role'});
});
test('budget row/workbook/history projection hides private draft detail, preserves stored audit and whole-season totals',async()=>{
 await as('mentor');const season=await rpc('finance_budget_manage',['create_season',{name:'Privacy fixture',starting_funds:1000}]);
 const hidden=await create('student'),visible=await pending('other');await owner();await db.exec(`insert into public.finance_po_budget(po_id,season_id) values('${hidden}','${season}'),('${visible}','${season}');`);
 await owner();await db.query('update public.profiles set primary_area_id=$1 where id=$2',[otherArea,ids.budgetLead]);const before=await snapshot();await as('budgetLead');const b=await rpc('finance_budget_context',[season]);expect(b.po_links).toEqual([]);expect(JSON.stringify(b.history)).not.toContain('Private fixture supplier');expect(b.summary.requested).toBe(125.5);const workbook=await rpc('finance_workbook_context',[season]);expect(workbook.purchase_orders).toEqual([]);expect(await snapshot()).toEqual(before);
 // Lead area visibility is legitimate; use another area to hide non-owned rows.
 await owner();await db.query('update public.profiles set primary_area_id=$1 where id=$2',[otherArea,ids.budgetLead]);
 await as('finance');const full=await rpc('finance_budget_context',[season]);expect(full.po_links.map((p:any)=>p.po_id)).toEqual([visible]);expect(JSON.stringify(full.history)).not.toContain(hidden);expect(full.summary.requested).toBe(125.5);
});

for(const person of ['staffCoach','adminCoach'])for(const first of ['finance','coach'])test(`${person}: normal own Coach approval with ${first} first requires a different Finance Lead`,async()=>{
 const id=await pending(person);expect((await context(person)).coach_self_approvals).toEqual([expect.objectContaining({po_id:id,allowed:true})]);
 if(first==='finance')await approve(id);await approve(id,person,'po_approver');
 if(first==='coach'){expect((await row(id)).status).toBe('awaiting_approval');await expect(act('adminLead',id,'school_submit')).rejects.toThrow(/approvals/);await deny('mentor',id,'approve',{slot:'finance_approver',override_reason:'Cannot replace Finance Lead'});await approve(id);}
 expect((await row(id)).status).toBe('approved');const h=(await marked(id))[0];expect(h.details.self_approval_override).toBe(false);expect(h.details.approval_id).toBeTruthy();await act('adminLead',id,'school_submit');await act('adminLead',id,'receive');expect((await row(id)).status).toBe('received');
});
test('own normal exception is approve-only; Student, Lead, Admin Lead, Readonly and unassigned staff cannot use it',async()=>{
 const id=await pending('staffCoach');await deny('staffCoach',id,'request_changes',{slot:'po_approver',reason:'Own changes'});await deny('staffCoach',id,'approve',{slot:'finance_approver'});
 for(const role of ['student','lead','admin_lead','readonly']){await renameRole('staffCoach',role);expect((await context('staffCoach')).coach_self_approvals).toEqual([]);await deny('staffCoach',id,'approve',{slot:'po_approver'});}
 await renameRole('staffCoach','mentor');await owner();await db.exec(`update public.team_member_positions set revoked_at=now(),revoked_by='${ids.admin}',revoke_reason='Fixture revoke' where user_id='${ids.staffCoach}'`);expect((await context('staffCoach')).coach_self_approvals).toEqual([]);await deny('staffCoach',id,'approve',{slot:'po_approver'});
});
test('dual Finance+Coach holder cannot normal-approve own Finance or fill both slots; one Coach vote is never enough',async()=>{
 await owner();await db.exec(`insert into public.team_member_positions(user_id,position_key,assigned_by,assignment_reason) values('${ids.staffCoach}','finance_lead','${ids.admin}','Fixture')`);const id=await pending('staffCoach');await deny('staffCoach',id,'approve',{slot:'finance_approver'});await approve(id,'staffCoach','po_approver');await deny('staffCoach',id,'approve',{slot:'finance_approver',override_reason:'Cannot bypass own flow'});expect((await row(id)).status).toBe('awaiting_approval');
});
test('legacy ordinary Finance vote may pair only with live different assigned Finance Lead; ambiguous override explains resubmission without rewriting history',async()=>{
 const id=await pending('staffCoach');await owner();await db.exec(`insert into public.finance_po_approvals(po_id,revision,slot,action,actor_id) values('${id}',1,'finance_approver','approved','${ids.finance}')`);await approve(id,'staffCoach','po_approver');expect((await row(id)).status).toBe('approved');
 const blocked=await pending('adminCoach');await approve(blocked,'mentor','finance_approver',{override_reason:'Existing emergency'});const before=await snapshot();const c=await context('adminCoach');expect(c.coach_self_approvals.find((f:any)=>f.po_id===blocked)).toMatchObject({allowed:false,reason:expect.stringMatching(/resubmit/)});await deny('adminCoach',blocked,'approve',{slot:'po_approver'});expect(await snapshot()).toEqual(before);
});
test('client marker spoofing is ignored and server proofs survive legitimate later assignment revocation',async()=>{
 const id=await pending('staffCoach');await approve(id,'staffCoach','po_approver',{approval_id:uid(999),approval_authority:'assigned_finance_lead',paired_finance_approval_id:uid(998)});const h=(await marked(id))[0];expect(h.details.approval_id).not.toBe(uid(999));expect(h.details.paired_finance_approval_id).toBeNull();await approve(id);await owner();await db.exec(`update public.team_member_positions set revoked_at=now(),revoked_by='${ids.admin}',revoke_reason='Later fixture change' where user_id in ('${ids.staffCoach}','${ids.finance}')`);await act('adminLead',id,'school_submit');
});
test('unmarked historical emergency approvals retain quorum and remain unchanged',async()=>{
 const id=await pending('mentor');await approve(id,'mentor','po_approver',{override_reason:'Existing emergency own approval'});await approve(id,'admin','finance_approver',{override_reason:'Existing emergency other approval'});expect((await row(id)).status).toBe('approved');expect(await marked(id)).toEqual([]);await act('adminLead',id,'school_submit');
});

test('new self-Coach quorum rejects mismatched/stale proof and generic override votes at school-submit and receipt',async()=>{
 const id=await pending('staffCoach');await approve(id,'staffCoach','po_approver');await owner();
 await db.exec(`insert into public.finance_po_approvals(id,po_id,revision,slot,action,actor_id,override_reason) values('${uid(900)}','${id}',1,'finance_approver','approved','${ids.mentor}','Fixture emergency');
 insert into finance_private.history(po_id,revision,action,actor_id,details) values('${id}',0,'approve','${ids.mentor}',jsonb_build_object('slot','finance_approver','approval_id','${uid(900)}','approval_authority','assigned_finance_lead'));
 update public.finance_purchase_orders set status='approved' where id='${id}';`);
 expect((await db.query('select finance_private.revision_approved($1,1) ok',[id])).rows[0].ok).toBe(false);
 await expect(act('adminLead',id,'school_submit')).rejects.toThrow(/approvals/);
 await owner();await db.exec(`update public.finance_purchase_orders set status='submitted_to_school',school_submitted_at=now(),school_submitted_by='${ids.adminLead}' where id='${id}'`);
 await expect(act('adminLead',id,'receive')).rejects.toThrow(/approvals/);
 for(const patch of ["revision=1,actor_id='"+ids.other+"'", "actor_id='"+ids.mentor+"',details=jsonb_set(details,'{slot}','\"po_approver\"')", "details=jsonb_set(details,'{approval_id}','\""+uid(901)+"\"')"]){await owner();await db.exec(`update finance_private.history set ${patch} where po_id='${id}' and actor_id<>'${ids.staffCoach}' and details->>'approval_authority'='assigned_finance_lead'`);expect((await db.query('select finance_private.revision_approved($1,1) ok',[id])).rows[0].ok).toBe(false);}
});
test('a legacy Finance vote loses admission to NEW self-Coach flow when its actor is inactive or no longer assigned',async()=>{
 const id=await pending('staffCoach');await owner();await db.exec(`insert into public.finance_po_approvals(po_id,revision,slot,action,actor_id) values('${id}',1,'finance_approver','approved','${ids.finance}');update public.profiles set active=false where id='${ids.finance}'`);expect((await context('staffCoach')).coach_self_approvals[0].allowed).toBe(false);await deny('staffCoach',id,'approve',{slot:'po_approver'});
});
test('Admin Lead school notification audience is current-role checked; downgrade loses delivery',async()=>{
 const id=await pending();await goodPair(id);await owner();const n=(await db.query(`select id from public.team_notifications where entity_id=$1 and recipient_id=$2 and event='ready_for_school'`,[id,ids.adminLead])).rows[0];expect(n).toBeTruthy();const token=uid(999);await db.exec(`update public.team_notifications set status='sending',lease_token='${token}',lease_until=now()+interval '5 minutes' where id='${n.id}';set role service_role`);expect(await rpc('finance_notification_delivery_allowed',[n.id,token])).toBe(true);await renameRole('adminLead','lead');await db.exec('set role service_role');expect(await rpc('finance_notification_delivery_allowed',[n.id,token])).toBe(false);await renameRole('adminLead','readonly');await db.exec('set role service_role');expect(await rpc('finance_notification_delivery_allowed',[n.id,token])).toBe(false);
});
test('Admin Lead repair attachment remains own-PO scoped and Readonly cannot attach',async()=>{
 const own=await create('adminLead'),other=await pending('other');await as('adminLead');expect(await rpc('finance_repair_po_candidate',[issue,own])).toMatchObject({can_attach:true});expect(await rpc('finance_repair_po_candidate',[issue,other])).toMatchObject({can_attach:false});await owner();const stamp=(await db.query('select updated_at::text value from public.pit_issues where id=$1',[issue])).rows[0].value;await as('adminLead');await rpc('finance_attach_repair_po',[issue,own,stamp,'Fixture attachment']);await expect(rpc('finance_attach_repair_po',[issue,other,stamp,'Not mine'])).rejects.toMatchObject({code:'42501'});await renameRole('adminLead','readonly');await as('adminLead');await expect(rpc('finance_attach_repair_po',[issue,own,stamp,'Read only'])).rejects.toMatchObject({code:'42501'});
});
test('visible approved and submitted reporting retains facts and totals while a private draft stays excluded',async()=>{
 const hidden=await create(),approved=await pending('other'),submitted=await pending('other');await goodPair(approved);await goodPair(submitted);await act('submitter',submitted,'school_submit');await as('mentor');const season=await rpc('finance_budget_manage',['create_season',{name:'Historical fixture',starting_funds:1000}]);await owner();for(const id of [hidden,approved,submitted])await db.query('insert into public.finance_po_budget(po_id,season_id) values($1,$2)',[id,season]);const before=await snapshot();await as('finance');const b=await rpc('finance_budget_context',[season]),w=await rpc('finance_workbook_context',[season]);expect(b.summary.committed).toBe(125.5);expect(b.summary.spent).toBe(125.5);expect(w.purchase_orders.map((p:any)=>p.id).sort()).toEqual([approved,submitted].sort());expect(w.purchase_orders.every((p:any)=>p.approved_at&&p.approvals.length===2)).toBe(true);expect(JSON.stringify(w.budget.history)).not.toContain(hidden);expect(await snapshot()).toEqual(before);
});
test('anonymous/inactive callers and direct helper access fail closed; source drift aborts the migration',async()=>{
 await db.exec("reset role;select set_config('test.uid','',false);set role anon");await expect(rpc('finance_context')).rejects.toMatchObject({code:'42501'});await as('inactive');await expect(rpc('finance_context')).rejects.toMatchObject({code:'42501'});await expect(rpc('finance_mutate',['create',base])).rejects.toMatchObject({code:'42501'});await as('student');await expect(db.query('select finance_private.coach_self_approval_context($1)',[uid(444)])).rejects.toMatchObject({code:'42501'});const before=await snapshot();await owner();await expect(db.exec(read(migration))).rejects.toThrow(/source drift/);await db.exec('rollback');expect(await snapshot()).toEqual(before);
});

for(const first of ['finance','coach'])test(`reason text never selects an emergency bypass of assigned own-Coach flow: ${first} first`,async()=>{
 // Preserve the existing staff-only override-reason input rule; this actor is
 // genuinely assigned Finance Lead AND staff, so a note cannot erase that proof.
 await renameRole('finance','mentor');
 const id=await pending('staffCoach');
 if(first==='finance')await approve(id,'finance','finance_approver',{override_reason:'An explanatory note from a genuinely assigned Finance Lead'});
 await approve(id,'staffCoach','po_approver',{override_reason:'A note must not opt out of the independent Finance requirement'});
 expect((await marked(id))).toHaveLength(1);
 if(first==='coach'){await deny('mentor',id,'approve',{slot:'finance_approver',override_reason:'Not an assigned Finance Lead'});await approve(id,'finance','finance_approver',{override_reason:'Still assigned Finance Lead'});}
 expect((await row(id)).status).toBe('approved');await act('adminLead',id,'school_submit');
});
test('missing shared core is rejected atomically before any Finance definition or data changes',async()=>{
 await db.close();db=await installedDatabase();const before=await catalog(),facts=await snapshot();await expect(db.exec(read(migration))).rejects.toThrow(/shared Admin Lead core/);await db.exec('rollback');expect(await catalog()).toEqual(before);expect(await snapshot()).toEqual(facts);
});
