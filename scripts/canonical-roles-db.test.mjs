import test from 'node:test';
import assert from 'node:assert/strict';
import { installedDatabase, ids, area, base, read, uid } from '../tests/fixtures/finance-role-db.mjs';

const prior='supabase/migrations/20261028160500_finance_student_roles_readonly_privacy.sql';
const migration='supabase/migrations/20261029190421_finance_canonical_roles.sql';
const expected=['finance_private.role','finance_private.admin','finance_private.cap','finance_private.can_manage_budget','finance_private.coach_self_approval_context','finance_private.mutate_v1','public.finance_budget_approval','public.finance_budget_context','public.finance_budget_manage','public.finance_mutate','public.finance_notification_delivery_allowed','public.finance_repair_context','public.finance_repair_po_candidate','public.finance_attach_repair_po','notifications_private.enqueue'];
async function fixture(t,{apply=true}={}) {
 const db=await installedDatabase();t.after(()=>db.close());
 const owner=()=>db.exec('reset role');
 const as=async(person)=>db.exec(`reset role;select set_config('test.uid','${ids[person]}',false);set role authenticated`);
 const rpc=async(name,args=[])=> (await db.query(`select public.${name}(${args.map((_,i)=>`$${i+1}`).join(',')}) value`,args)).rows[0].value;
 const row=async(id)=>{await owner();return (await db.query('select * from public.finance_purchase_orders where id=$1',[id])).rows[0];};
 const act=async(person,id,action,p={})=>{const po=await row(id);await as(person);return rpc('finance_mutate',[action,{id,version:po.version,...p}]);};
 const create=async(person='student')=>{await as(person);return rpc('finance_mutate',['create',base]);};
 const pending=async(person='student')=>{const id=await create(person);await act(person,id,'submit');return id;};
 const approve=(person,id,slot,p={})=>act(person,id,'approve',{slot,...p});
 const pair=async(id)=>{await approve('finance',id,'finance_approver');await approve('coach',id,'po_approver');};
 const context=async(person)=>{await as(person);return rpc('finance_context');};
 const snapshot=async()=>{await owner();const out={};for(const table of ['public.profiles','public.team_member_positions','public.finance_assignments','public.finance_purchase_orders','public.finance_po_approvals','public.finance_po_revisions','finance_private.history','public.team_notifications'])out[table]=(await db.query(`select to_jsonb(x) row from ${table} x order by to_jsonb(x)::text`)).rows;return out;};
 const deny=async(person,id,action,p={})=>{const before=await snapshot();await assert.rejects(act(person,id,action,p),{code:'42501'});assert.deepEqual(await snapshot(),before);};
 const canonicalCore=async()=>{await owner();await db.exec(`update public.profiles set role='admin_lead' where role='admin';alter table public.profiles drop constraint profiles_role_check;alter table public.profiles add constraint profiles_role_check check(role in ('readonly','student','lead','admin_lead','mentor'));`);};
 await db.exec(read('tests/fixtures/student-role-position-eligibility.sql'));
 await db.query('update public.profiles set role=$1 where id=$2',['admin_lead',ids.adminLead]);
 await db.exec(read(prior));
 if(apply){await canonicalCore();await db.exec(read(migration));}
 return {db,owner,as,rpc,row,act,create,pending,approve,pair,context,snapshot,deny,canonicalCore};
}

test('canonical Finance migration changes exactly 15 bodies, no ACL/policy/business data; requires completed core transition',async t=>{
 const f=await fixture(t,{apply:false});await assert.rejects(f.db.exec(read(migration)),/canonical five-role account transition/);await f.db.exec('rollback');await f.canonicalCore();
 const catalog=async()=>{await f.owner();return{functions:(await f.db.query(`select n.nspname||'.'||p.proname name,pg_get_function_identity_arguments(p.oid) args,p.prosrc,p.proacl,p.proowner,p.prosecdef,p.proconfig,p.provolatile from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in ('public','finance_private','notifications_private') order by 1,2`)).rows,policies:(await f.db.query('select * from pg_policies order by schemaname,tablename,policyname')).rows};};
 const before=await catalog(),data=await f.snapshot();await f.db.exec(read(migration));const after=await catalog();assert.deepEqual(await f.snapshot(),data);assert.deepEqual(after.policies,before.policies);assert.equal(after.functions.length,before.functions.length);
 const changed=[];for(let i=0;i<before.functions.length;i++){const a=before.functions[i],b=after.functions[i];assert.deepEqual({...b,prosrc:a.prosrc},a);if(a.prosrc!==b.prosrc)changed.push(a.name);}assert.deepEqual(changed.sort(),expected.sort());
 await assert.rejects(f.db.query('update public.profiles set role=$1 where id=$2',['admin',ids.admin]),{code:'23514'});
});

test('converted Admin Lead has own request tools, not private drafts or suite Finance administration',async t=>{
 const f=await fixture(t);const own=await f.create('admin'),hidden=await f.create('other'),visible=await f.pending('other');const c=await f.context('admin');assert.equal(c.profile.role,'admin_lead');assert.equal(c.can_create,true);assert.equal(c.is_admin,false);assert.deepEqual(c.capabilities,['school_submitter']);
 const rows=(await f.db.query('select id from public.finance_purchase_orders')).rows.map(x=>x.id);assert.ok(rows.includes(own)&&rows.includes(visible));assert.ok(!rows.includes(hidden));assert.deepEqual(await f.rpc('finance_budget_context',[null]),{can_manage:false});
 for(const action of ['edit','cancel'])await f.deny('admin',visible,action,{...base,reason:'Synthetic denied action'});
 await f.deny('admin',visible,'assignment',{user_id:ids.other,capability:'finance_admin',active:true,reason:'Not suite administration'});
 await f.deny('admin',visible,'approve',{slot:'finance_approver',override_reason:'No automatic staff override'});
 await f.act('admin',own,'edit',{...base,vendor:'Updated own supplier'});await f.act('admin',own,'submit');assert.equal((await f.row(own)).status,'awaiting_approval');
});

test('Admin Lead submission and receipt require existing two approvals, correct state and open season',async t=>{
 const f=await fixture(t);const id=await f.pending();await assert.rejects(f.act('admin',id,'school_submit'),/approvals/);await f.pair(id);await f.act('admin',id,'school_submit');await f.act('admin',id,'receive',{note:'Synthetic only'});assert.equal((await f.row(id)).status,'received');
 const locked=await f.pending();await f.pair(locked);await f.act('adminLead',locked,'school_submit');await f.owner();await f.db.exec(`insert into public.finance_seasons(id,name,status,created_by) values('${uid(500)}','Closed fixture','closed','${ids.mentor}');insert into public.finance_po_budget(po_id,season_id) values('${locked}','${uid(500)}');`);await assert.rejects(f.act('admin',locked,'receive'),/Closed season/);
});

test('Mentor still administers Finance while assigned Finance administration and budget leadership remain distinct overlays',async t=>{
 const f=await fixture(t);assert.equal((await f.context('mentor')).is_admin,true);assert.equal((await f.rpc('finance_budget_context',[null])).can_manage,true);
 const id=await f.pending();await f.act('mentor',id,'assignment',{user_id:ids.admin,capability:'finance_admin',active:true,reason:'Synthetic explicit overlay'});assert.equal((await f.context('admin')).is_admin,true);await f.act('admin',id,'edit',base);
 const pending=await f.pending('other');await f.deny('admin',pending,'approve',{slot:'finance_approver',override_reason:'Explicit finance_admin is not staff override'});
 await f.context('budgetLead');assert.equal((await f.rpc('finance_budget_context',[null])).can_manage,true);await assert.rejects(f.rpc('finance_budget_manage',['classify_position',{position_key:'software_lead',enabled:false,expected_enabled:true,reason:'Cannot classify'}]),/Mentor and reason/);
});

for(const first of ['finance','coach'])test(`Mentor assigned Coach own step, ${first} first, requires different assigned Finance Lead`,async t=>{
 const f=await fixture(t);const id=await f.pending('staffCoach');if(first==='finance')await f.approve('finance',id,'finance_approver');await f.approve('staffCoach',id,'po_approver');if(first==='coach'){await f.deny('mentor',id,'approve',{slot:'finance_approver',override_reason:'Cannot replace required Finance Lead'});await f.approve('finance',id,'finance_approver');}assert.equal((await f.row(id)).status,'approved');await f.act('adminLead',id,'school_submit');
});

test('converted Admin Lead Coach cannot newly self-approve; old authorized Admin Coach vote remains valid',async t=>{
 const f=await fixture(t,{apply:false});const old=await f.pending('adminCoach');await f.approve('adminCoach',old,'po_approver');const before=await f.snapshot();await f.canonicalCore();await f.db.exec(read(migration));await f.approve('finance',old,'finance_approver');assert.equal((await f.row(old)).status,'approved');await f.act('adminLead',old,'school_submit');
 const now=await f.pending('adminCoach');assert.deepEqual((await f.context('adminCoach')).coach_self_approvals,[]);await f.deny('adminCoach',now,'approve',{slot:'po_approver'});await f.deny('adminCoach',now,'approve',{slot:'po_approver',override_reason:'Cannot use prior staff role'});
 await f.owner();const priorApproval=before['public.finance_po_approvals'][0].row;assert.deepEqual((await f.db.query('select to_jsonb(a) row from public.finance_po_approvals a where id=$1',[priorApproval.id])).rows[0].row,priorApproval);
});

test('literal Readonly and unknown legacy role fail closed despite retained Finance capabilities and positions',async t=>{
 const f=await fixture(t);const id=await f.pending('adminCoach');await f.owner();await f.db.query('update public.profiles set role=$1 where id=$2',['readonly',ids.adminCoach]);const c=await f.context('adminCoach');assert.equal(c.can_create,false);assert.equal(c.is_admin,false);assert.deepEqual(c.capabilities,[]);for(const action of ['edit','submit','cancel','approve','request_changes','school_submit','receive'])await f.deny('adminCoach',id,action,{...base,slot:'po_approver',reason:'Synthetic'});
 // Deliberately corrupt only this disposable fixture to prove a stale unknown role is not an alias.
 await f.owner();await f.db.exec('alter table public.profiles drop constraint profiles_role_check');await f.db.query('update public.profiles set role=$1 where id=$2',['admin',ids.adminCoach]);await assert.rejects(f.context('adminCoach'),{code:'42501'});await f.deny('adminCoach',id,'approve',{slot:'po_approver',override_reason:'No legacy alias'});
});

test('Admin Lead school notifications remain authorized; no base-role other-draft access after conversion',async t=>{
 const f=await fixture(t);const id=await f.pending();await f.pair(id);await f.owner();const notices=(await f.db.query("select recipient_id from public.team_notifications where entity_id=$1 and event='ready_for_school'",[id])).rows;assert.ok(notices.some(x=>x.recipient_id===ids.admin));assert.ok(notices.some(x=>x.recipient_id===ids.adminLead));
 const hidden=await f.create('other');await f.as('admin');for(const table of ['finance_po_history','finance_po_revisions','finance_po_approvals'])assert.equal((await f.db.query(`select * from public.${table} where po_id=$1`,[hidden])).rows.length,0);
});
