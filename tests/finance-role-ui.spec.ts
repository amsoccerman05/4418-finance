import { test, expect, type Page } from '@playwright/test';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, extname } from 'node:path';
import { createHash } from 'node:crypto';

const viewer='00000000-0000-0000-0000-000000000001', poid='00000000-0000-0000-0000-000000000101';
const fonts='https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;450;500;550;600;650;700&family=Manrope:wght@400;500;600;650;700;750;800&display=swap';
const walk=(p:string):string[]=>readdirSync(p,{withFileTypes:true}).flatMap(e=>e.isDirectory()?walk(resolve(p,e.name)):[resolve(p,e.name)]);
async function fixture(page:Page, options:{role:string,status?:string,own?:boolean,closed?:boolean,denySave?:boolean,empty?:boolean}){
 expect(process.env.HANDOFF_LIVE).toBeFalsy();
 let role=options.role;
 const calls:any[]=[], unexpected:string[]=[];
 const root=resolve('.playwright-dist'),assets=new Map(walk(root).map(p=>['/'+p.slice(root.length+1),{bytes:readFileSync(p),hash:createHash('sha256').update(readFileSync(p)).digest('hex')}])) ;
 const order:any={id:poid,po_number:42,requester_id:options.own===false?'other':viewer,area_id:'area',vendor:'Fixture supplier',amount:125,purpose:'Fixture parts',status:options.status||'draft',revision:1,version:2,sheet_url:'https://docs.google.com/spreadsheets/d/FixtureOnly/edit',notes:'',needed_by:null,submitted_at:'2026-10-01T12:00:00Z',school_reference:'',school_submitted_by:null,school_submitted_at:null,received_by:null,received_at:null,receipt_note:'',created_at:'2026-10-01T12:00:00Z'};
 const orders=options.empty?[]:[order],approvals:any[]=[],history:any[]=[];
 const user={id:viewer,aud:'authenticated',email:'fixture@example.invalid',app_metadata:{},user_metadata:{},created_at:'2026-01-01T00:00:00Z'};
 await page.addInitScript(user=>localStorage.setItem('4418-finance-auth',JSON.stringify({access_token:'fixture-token',refresh_token:'fixture-refresh',expires_at:4000000000,token_type:'bearer',user})),user);
 await page.routeWebSocket('**/*',socket=>{unexpected.push(socket.url());socket.close();});
 await page.route('**/*',async route=>{
  const request=route.request(),url=new URL(request.url());
  if(url.origin==='http://127.0.0.1:4431'){
   const path=url.pathname==='/'?'/index.html':url.pathname,asset=assets.get(path);
   if(asset && request.method()==='GET'){
    expect(createHash('sha256').update(asset.bytes).digest('hex')).toBe(asset.hash);
    const contentType=({'.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.png':'image/png','.xlsx':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'} as any)[extname(path)];
    await route.fulfill({status:200,contentType,body:asset.bytes});return;
   }
  }
  // Deliberate offline fallback fonts: exact known stylesheet, never an external fetch.
  if(request.url()===fonts){await route.fulfill({contentType:'text/css',body:''});return;}
  if(url.origin==='https://finance-test.supabase.invalid'){
   const path=url.pathname;let body:any;
   if(path==='/auth/v1/user')body=user;
   else if(path==='/rest/v1/rpc/finance_context'){
    const caps=role==='mentor'?['po_approver','finance_approver']:role==='admin_lead'?['school_submitter']:role==='readonly'?['finance_admin','school_submitter']:[];
    body={profile:{id:viewer,display_name:'Synthetic '+role,role,primary_area_id:null},can_create:true,is_admin:role==='readonly',capabilities:caps,areas:[{id:'area',name:'Build',active:true}],people:[{id:viewer,name:'Synthetic '+role}],coach_self_approvals:role==='mentor'&&order.requester_id===viewer&&order.status==='awaiting_approval'?[{po_id:poid,allowed:!approvals.length,reason:'Approve only your Coach step. A different assigned Finance Lead must approve Finance.'}]:[]};
    expect(body.profile.role).toBe(role);
   }
   else if(path==='/rest/v1/rpc/finance_budget_context')body={can_manage:false};
   else if(path==='/rest/v1/rpc/finance_budget_approval')body={required:false};
   else if(path==='/rest/v1/finance_purchase_orders')body=orders;
   else if(path==='/rest/v1/finance_po_approvals')body=approvals;
   else if(path==='/rest/v1/finance_po_history')body=history;
   else if(path==='/rest/v1/finance_po_revisions'||path==='/rest/v1/finance_assignments')body=[];
   else if(path==='/rest/v1/finance_po_actionability')body=options.closed?[{id:poid,season_closed:true}]:[];
   else if(path==='/rest/v1/rpc/finance_mutate'){
    const input=request.postDataJSON();calls.push(input);
    if(options.denySave){role='readonly';await route.fulfill({status:403,json:{code:'42501',message:'This account is read-only'}});return;}
    if(input.action==='create'){expect(role).toBe('student');Object.assign(order,input.p);orders.push(order);}
    else if(input.action==='submit'){expect(role).toBe('student');order.status='awaiting_approval';}
    else if(input.action==='approve'){
     expect(role).toBe('mentor');expect(input.p.slot).toBe('po_approver');expect(input.p.override_reason).toBeFalsy();
     approvals.push({id:'server-approval',po_id:poid,revision:1,slot:'po_approver',action:'approved',actor_id:viewer,acted_at:'2026-10-01T12:00:00Z',explanation:'',override_reason:''});
     history.push({id:1,po_id:poid,revision:1,action:'approve',actor_id:viewer,created_at:'2026-10-01T12:00:00Z',details:{slot:'po_approver',approval_id:'server-approval',approval_authority:'assigned_lead_coach_self'}});
    }else if(input.action==='school_submit'){expect(role).toBe('admin_lead');order.status='submitted_to_school';order.school_submitted_by=viewer;order.school_submitted_at='2026-10-01T12:00:00Z';}
    else if(input.action==='receive'){expect(role).toBe('admin_lead');expect(options.closed).not.toBe(true);order.status='received';order.received_by=viewer;order.received_at='2026-10-01T12:00:00Z';}
    else throw new Error('Unexpected fixture mutation: '+input.action);
    order.version++;body=poid;
   }
   if(body!==undefined){await route.fulfill({json:body});return;}
  }
  unexpected.push(request.method()+' '+request.url());await route.abort('blockedbyclient');
 });
 return {calls,unexpected,order,role:()=>role};
}
async function open(page:Page){await page.goto('/#orders');await page.getByRole('button',{name:/PO 42.*Fixture supplier/}).click();return page.getByRole('dialog').first();}
async function shot(page:Page,name:string,width:number,unexpected:string[]){expect(unexpected).toEqual([]);expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await page.screenshot({path:`test-results/roles-${name}-${width}.png`,fullPage:true});}
for(const width of [390,1440]){
 test(`prospective unassigned Student creates and submits only a request ${width}`,async({page})=>{
  await page.setViewportSize({width,height:900});const f=await fixture(page,{role:'student',empty:true});await page.goto('/#orders');await page.getByRole('button',{name:'New purchase order',exact:true}).click();const d=page.getByRole('dialog');
  await d.getByLabel('Google Sheet URL').fill('https://docs.google.com/spreadsheets/d/FixtureOnly/edit');await d.getByLabel('Vendor', {exact:true}).fill('Fixture supplier');await d.getByLabel('Total amount (USD)', {exact:true}).fill('125');await d.getByLabel('Functional area').selectOption('area');await d.getByLabel('Purpose / short description', {exact:true}).fill('Fixture parts');await d.getByRole('button',{name:'Save draft',exact:true}).click();await d.getByRole('button',{name:'Submit for approval',exact:true}).click();
  await expect(d.getByRole('button',{name:/^Approve|Mark submitted|Mark received/})).toHaveCount(0);expect(f.calls.map(x=>x.action)).toEqual(['create','submit']);expect(f.role()).toBe('student');await shot(page,'student-request',width,f.unexpected);
 });
 test(`Readonly old owner hides all write buttons even with stale privileged facts ${width}`,async({page})=>{
  await page.setViewportSize({width,height:900});const f=await fixture(page,{role:'readonly'});const d=await open(page);await expect(d).toContainText('Read-only access');await expect(d.getByRole('button',{name:/Resume draft|Edit purchase|Submit for approval|Cancel purchase|Approve/})).toHaveCount(0);await expect(d.getByRole('link',{name:'Open Google Sheet ↗'})).toBeVisible();expect(f.calls).toEqual([]);await shot(page,'readonly',width,f.unexpected);
 });
 test(`denied save preserves draft and refreshes Readonly without retry ${width}`,async({page})=>{
  await page.setViewportSize({width,height:900});const f=await fixture(page,{role:'student',denySave:true});const d=await open(page);await d.getByRole('button',{name:'Resume draft',exact:true}).click();await d.getByLabel('Vendor',{exact:true}).fill('Unsaved student work');await d.getByRole('button',{name:'Save draft',exact:true}).click();await expect(d).toContainText('Your account is now read-only');await expect(d.getByLabel('Vendor',{exact:true})).toHaveValue('Unsaved student work');await expect(d.getByRole('button',{name:'Save draft',exact:true})).toBeDisabled();expect(f.calls).toHaveLength(1);await shot(page,'denied-draft',width,f.unexpected);
 });
 test(`Admin Lead submits and receives but closed seasons stay readonly ${width}`,async({page})=>{
  await page.setViewportSize({width,height:900});const f=await fixture(page,{role:'admin_lead',status:'approved',own:false});const d=await open(page);await d.getByRole('button',{name:'Mark submitted to school',exact:true}).click();await d.getByRole('button',{name:'Mark received',exact:true}).click();await expect(d).toContainText('Purchase order complete');expect(f.calls.map(x=>x.action)).toEqual(['school_submit','receive']);await shot(page,'admin-lead-receipt',width,f.unexpected);
 });
 test(`staff assigned Coach own step is approve-only and never offers own Finance ${width}`,async({page})=>{
  await page.setViewportSize({width,height:900});const f=await fixture(page,{role:'mentor',status:'awaiting_approval'});const d=await open(page);await expect(d).toContainText('Review your Coach approval');await expect(d.getByRole('button',{name:'Approve & assign budget',exact:true})).toHaveCount(0);await expect(d.getByRole('button',{name:'Request changes',exact:true})).toHaveCount(0);await d.getByRole('button',{name:'Approve Lead Coach',exact:true}).click();await expect(d).toContainText('Waiting for another approver');await expect(d.getByRole('button',{name:/^Approve|Request changes|Mark submitted/})).toHaveCount(0);expect(f.calls).toHaveLength(1);await shot(page,'own-coach',width,f.unexpected);
 });
 test(`Admin Lead cannot receive a closed-season order ${width}`,async({page})=>{
  await page.setViewportSize({width,height:900});const f=await fixture(page,{role:'admin_lead',status:'submitted_to_school',own:false,closed:true});const d=await open(page);await expect(d).toContainText('closed budget season');await expect(d.getByRole('button',{name:'Mark received',exact:true})).toHaveCount(0);expect(f.calls).toEqual([]);await shot(page,'closed-season',width,f.unexpected);
 });
}
