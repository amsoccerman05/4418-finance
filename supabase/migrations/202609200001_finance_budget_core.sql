-- MANUAL REVIEW ONLY. Finance V2A; no backfill, no notifications, no production application.
-- Requires Finance V1 + Team Positions + notification coverage v6.
begin;
create table public.finance_seasons(
 id uuid primary key default gen_random_uuid(),name text not null check(length(trim(name)) between 1 and 100),
 starts_on date,ends_on date,starting_funds numeric(14,2) not null default 0 check(starting_funds>=0 and starting_funds<=999999999999.99),reserve_target numeric(14,2) not null default 0 check(reserve_target>=0 and reserve_target<=999999999999.99),
 status text not null default 'draft' check(status in ('draft','active','closed')),version integer not null default 1,
 created_by uuid not null references public.profiles(id),created_at timestamptz not null default now(),updated_at timestamptz not null default now(),check(ends_on>=starts_on)
);
create unique index finance_one_active_season on public.finance_seasons(status) where status='active';
create table public.finance_budget_categories(
 id uuid primary key default gen_random_uuid(),season_id uuid not null references public.finance_seasons(id),name text not null check(length(trim(name)) between 1 and 100),
 description text not null default '' check(length(description)<=2000),display_order integer not null default 0 check(display_order between 0 and 9999),active boolean not null default true,
 allocation numeric(14,2) not null default 0 check(allocation>=0 and allocation<=999999999999.99),forecast numeric(14,2) check(forecast>=0 and forecast<=999999999999.99),unique(season_id,id)
);
create table public.finance_income(
 id uuid primary key default gen_random_uuid(),season_id uuid not null references public.finance_seasons(id),source text not null check(length(trim(source)) between 1 and 150),
 income_type text not null check(length(trim(income_type)) between 1 and 100),amount numeric(14,2) not null check(amount>0 and amount<=999999999999.99),
 status text not null check(status in ('expected','received','canceled')),expected_on date,received_on date,category_id uuid,
 reference text not null default '' check(length(reference)<=200),notes text not null default '' check(length(notes)<=2000),
 created_by uuid not null references public.profiles(id),created_at timestamptz not null default now(),
 foreign key(season_id,category_id) references public.finance_budget_categories(season_id,id),check(status<>'received' or received_on is not null)
);
create table public.finance_po_budget(
 po_id uuid primary key references public.finance_purchase_orders(id),season_id uuid not null references public.finance_seasons(id),category_id uuid,
 foreign key(season_id,category_id) references public.finance_budget_categories(season_id,id)
);
create table public.finance_expenses(
 id uuid primary key default gen_random_uuid(),season_id uuid not null references public.finance_seasons(id),category_id uuid not null,
 kind text not null check(kind in ('expense','credit')),amount numeric(14,2) not null check(amount>0 and amount<=999999999999.99),payee text not null default '' check(length(payee)<=150),occurred_on date not null,
 reference text not null default '' check(length(reference)<=200),reason text not null check(length(trim(reason)) between 1 and 2000),
 po_id uuid references public.finance_purchase_orders(id),expense_id uuid references public.finance_expenses(id),
 created_by uuid not null references public.profiles(id),created_at timestamptz not null default now(),
 foreign key(season_id,category_id) references public.finance_budget_categories(season_id,id),
 check(kind='credit' or (po_id is null and expense_id is null)),check(not(po_id is not null and expense_id is not null))
);
-- Explicit Finance-only classification. Display names/categories never authorize access.
create table finance_private.budget_positions(position_key text primary key references public.team_positions(key));
insert into finance_private.budget_positions select key from public.team_positions where key in
 ('program_manager','product_technical_manager','finance_lead','software_lead','business_lead','cad_lead','fabrication_lead','strategy_lead','power_lead','communications_lead','operations_lead');
alter table finance_private.budget_positions enable row level security;
revoke all on finance_private.budget_positions from public,anon,authenticated;
create function finance_private.can_manage_budget() returns boolean language sql stable security definer set search_path='' as $$
 select coalesce(finance_private.role() in ('mentor','admin') or (finance_private.role() in ('student','lead') and exists(
 select 1 from public.team_member_positions m join public.team_positions p on p.key=m.position_key and p.active
 join finance_private.budget_positions b on b.position_key=p.key where m.user_id=auth.uid() and m.revoked_at is null)),false)
$$;
alter table finance_private.history add column season_id uuid references public.finance_seasons(id),add column category_id uuid references public.finance_budget_categories(id);
-- Preserve the existing PO history shape and filtering. Season-only budget history
-- is available exclusively through the budget-authorized context, not finance_admin.
create or replace view public.finance_po_history with (security_barrier=true) as
 select id,po_id,revision,action,actor_id,created_at,
 case when finance_private.admin() or finance_private.role()='lead' or finance_private.cap('finance_approver') or finance_private.cap('po_approver') or finance_private.cap('school_submitter')
 then details else finance_private.student_history_payload(details) end as details
 from finance_private.history where finance_private.visible(po_id) or (po_id is null and finance_private.admin() and left(action,7)<>'budget_');
create index finance_budget_history on finance_private.history(season_id,id);
create index finance_budget_po_season on public.finance_po_budget(season_id);
create function finance_private.budget_audit(s uuid,c uuid,pid uuid,act text,why text,before_value jsonb,after_value jsonb) returns void
language sql security definer set search_path='' as $$
 insert into finance_private.history(season_id,category_id,po_id,revision,action,actor_id,details)
 values(s,c,pid,(select revision from public.finance_purchase_orders where id=pid),'budget_'||act,auth.uid(),jsonb_build_object('reason',why,'before',before_value,'after',after_value))
$$;
do $$ declare t text;begin
 foreach t in array array['finance_seasons','finance_budget_categories','finance_income','finance_po_budget','finance_expenses'] loop
 execute format('alter table public.%I enable row level security',t);
 execute format('revoke all on public.%I from public,anon,authenticated',t);
 execute format('grant select on public.%I to authenticated',t);
 execute format('create policy budget_read on public.%I for select to authenticated using(finance_private.can_manage_budget())',t);
 end loop;
end $$;
-- A single authoritative current-state source, private to reporting helpers.
create view finance_private.po_impacts as
 select p.id po_id,b.season_id,b.category_id,p.amount,p.area_id,p.revision,p.status,
 case when p.status='awaiting_approval' then 'requested'
 when p.status='approved' and finance_private.revision_approved(p.id,p.revision) then 'committed'
 when p.status='submitted_to_school' and finance_private.revision_approved(p.id,p.revision) then 'spent' else 'none' end bucket
 from public.finance_purchase_orders p join public.finance_po_budget b on b.po_id=p.id;
revoke all on finance_private.po_impacts from public,anon,authenticated;
create function finance_private.budget_summary(s uuid) returns jsonb language sql stable security definer set search_path='' as $$
 with income as (select coalesce(sum(amount) filter(where status='received'),0) received,coalesce(sum(amount) filter(where status='expected'),0) expected,
 coalesce(sum(amount) filter(where status='received' and category_id is not null),0) restricted from public.finance_income where season_id=s),
 po as (select coalesce(sum(amount) filter(where bucket='requested'),0) requested,coalesce(sum(amount) filter(where bucket='committed'),0) committed,
 coalesce(sum(amount) filter(where bucket='spent'),0) spent from finance_private.po_impacts where season_id=s),
 expense as (select coalesce(sum(amount) filter(where kind='expense'),0) spent,coalesce(sum(amount) filter(where kind='credit'),0) credits from public.finance_expenses where season_id=s),
 alloc as (select coalesce(sum(allocation),0) allocation from public.finance_budget_categories where season_id=s),
 cats as (select c.*,coalesce((select sum(i.amount) from public.finance_income i where i.category_id=c.id and i.status='received'),0) restricted,
 coalesce((select sum(i.amount) from public.finance_income i where i.category_id=c.id and i.status='expected'),0) expected,
 coalesce((select sum(p.amount) from finance_private.po_impacts p where p.category_id=c.id and p.bucket='requested'),0) requested,
 coalesce((select sum(p.amount) from finance_private.po_impacts p where p.category_id=c.id and p.bucket='committed'),0) committed,
 coalesce((select sum(p.amount) from finance_private.po_impacts p where p.category_id=c.id and p.bucket='spent'),0)+coalesce((select sum(e.amount) from public.finance_expenses e where e.category_id=c.id and e.kind='expense'),0)-coalesce((select sum(e.amount) from public.finance_expenses e where e.category_id=c.id and e.kind='credit'),0) spent
 from public.finance_budget_categories c where c.season_id=s)
 select jsonb_build_object('season',to_jsonb(b),'starting_funds',b.starting_funds,'received',i.received,'expected',i.expected,'restricted',i.restricted,
 'actual_funding',b.starting_funds+i.received,'allocated',a.allocation+i.restricted,'unallocated',b.starting_funds+i.received-i.restricted-a.allocation,
 'requested',p.requested,'committed',p.committed,'spent',p.spent+e.spent-e.credits,'credits',e.credits,
 'available',b.starting_funds+i.received-p.requested-p.committed-p.spent-e.spent+e.credits,
 'categories',(select coalesce(jsonb_agg(to_jsonb(c)||jsonb_build_object('funded',c.allocation+c.restricted,'available',c.allocation+c.restricted-c.requested-c.committed-c.spent) order by display_order,name),'[]') from cats c))
 from public.finance_seasons b cross join income i cross join po p cross join expense e cross join alloc a where b.id=s
$$;
create function public.finance_budget_context(season uuid default null) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare s uuid:=season;
begin
 if not finance_private.can_manage_budget() then return jsonb_build_object('can_manage',false);end if;
 if s is null then select id into s from public.finance_seasons order by (status='active') desc,created_at desc limit 1;end if;
 return jsonb_build_object('can_manage',true,'can_classify',finance_private.role() in ('mentor','admin'),
 'seasons',(select coalesce(jsonb_agg(to_jsonb(b) order by created_at desc),'[]') from public.finance_seasons b),
 'summary',finance_private.budget_summary(s),
 'income',(select coalesce(jsonb_agg(to_jsonb(i) order by created_at desc),'[]') from public.finance_income i where season_id=s),
 'expenses',(select coalesce(jsonb_agg(to_jsonb(e) order by occurred_on desc),'[]') from public.finance_expenses e where season_id=s),
 'history',(select coalesce(jsonb_agg(to_jsonb(h) order by id desc),'[]') from (select h.*,p.display_name actor_name from finance_private.history h join public.profiles p on p.id=h.actor_id where h.season_id=s or h.po_id in (select po_id from public.finance_po_budget where season_id=s) or (h.season_id is null and h.action='budget_classify_position' and finance_private.role() in ('mentor','admin')) order by id desc) h),
 'po_links',(select coalesce(jsonb_agg(to_jsonb(b)||jsonb_build_object('po_number',p.po_number,'vendor',p.vendor,'amount',p.amount,'status',p.status,'revision',p.revision,'area_id',p.area_id,'bucket',i.bucket)),'[]') from public.finance_po_budget b join public.finance_purchase_orders p on p.id=b.po_id join finance_private.po_impacts i on i.po_id=p.id where b.season_id=s),
 'uncategorized',(select coalesce(jsonb_agg(jsonb_build_object('po_id',p.id,'po_number',p.po_number,'vendor',p.vendor,'amount',p.amount,'status',p.status)),'[]') from public.finance_purchase_orders p where p.status not in ('draft','cancelled') and not exists(select 1 from public.finance_po_budget b where b.po_id=p.id)),
 'positions',case when finance_private.role() in ('mentor','admin') then (select coalesce(jsonb_agg(jsonb_build_object('key',p.key,'name',p.name,'enabled',b.position_key is not null)),'[]') from public.team_positions p left join finance_private.budget_positions b on b.position_key=p.key) else '[]'::jsonb end);
end $$;
create function public.finance_budget_manage(action text,p jsonb) returns uuid language plpgsql security definer set search_path='' as $$
declare s public.finance_seasons;c public.finance_budget_categories;i public.finance_income;e public.finance_expenses;
 sid uuid:=nullif(p->>'season_id','')::uuid;cid uuid:=nullif(p->>'category_id','')::uuid;rid uuid:=nullif(p->>'id','')::uuid;
 why text:=trim(coalesce(p->>'reason',''));prev jsonb;after_value jsonb;amount numeric;from_id uuid:=nullif(p->>'from_id','')::uuid;to_id uuid:=nullif(p->>'to_id','')::uuid;po public.finance_purchase_orders;
begin
 perform pg_advisory_xact_lock(4418,20);
 if not finance_private.can_manage_budget() then raise exception 'Budget leadership required' using errcode='42501';end if;
 if length(why)>2000 then raise exception 'Reason must be at most 2000 characters';end if;
 if action='classify_position' then
 if finance_private.role() not in ('mentor','admin') or why='' then raise exception 'Mentor/admin and reason required';end if;
 if p->>'position_key'='finance_lead' and not coalesce((p->>'enabled')::boolean,false) then raise exception 'Finance Lead budget authority is required';end if;
 if p->>'enabled' is null or (exists(select 1 from finance_private.budget_positions where position_key=p->>'position_key')) is distinct from (p->>'expected_enabled')::boolean then raise exception 'Budget access changed. Refresh before saving.';end if;
 prev:=jsonb_build_object('position_key',p->>'position_key','enabled',exists(select 1 from finance_private.budget_positions where position_key=p->>'position_key'));
 if (p->>'enabled')::boolean then insert into finance_private.budget_positions values(p->>'position_key') on conflict do nothing;
 else delete from finance_private.budget_positions where position_key=p->>'position_key';end if;
 perform finance_private.budget_audit(null,null,null,action,why,prev,p);return null;
 elsif action='create_season' then
 insert into public.finance_seasons(name,starts_on,ends_on,starting_funds,reserve_target,created_by)
 values(trim(p->>'name'),nullif(p->>'starts_on','')::date,nullif(p->>'ends_on','')::date,coalesce((p->>'starting_funds')::numeric,0),coalesce((p->>'reserve_target')::numeric,0),auth.uid()) returning * into s;
 if nullif(p->>'copy_season','') is not null then
 if not exists(select 1 from public.finance_seasons where id=(p->>'copy_season')::uuid) then raise exception 'Source season unavailable';end if;
 insert into public.finance_budget_categories(season_id,name,description,display_order,active,allocation,forecast)
 select s.id,name,description,display_order,active,case when coalesce((p->>'copy_allocations')::boolean,false) then allocation else 0 end,forecast from public.finance_budget_categories where season_id=(p->>'copy_season')::uuid;
 end if;
 perform finance_private.budget_audit(s.id,null,null,action,why,null,jsonb_build_object('season',to_jsonb(s),'copy_season',p->>'copy_season','copy_allocations',p->'copy_allocations','categories',(select jsonb_agg(to_jsonb(b)) from public.finance_budget_categories b where season_id=s.id)));return s.id;
 end if;
 select * into s from public.finance_seasons where id=sid for update;
 if not found or s.version is distinct from (p->>'version')::integer then raise exception 'Budget changed. Refresh before saving.';end if;
 if s.status='closed' then raise exception 'Closed seasons cannot be changed';end if;
 if (action in ('transfer','expense','credit','categorize_po','close') or s.status='active') and why='' then raise exception 'Explain this financial change';end if;
 if action in ('season','activate','close') then
 prev:=to_jsonb(s);
 if action='activate' then
 if s.status<>'draft' or exists(select 1 from public.finance_seasons where status='active') then raise exception 'Close the active season before activating a draft';end if;
 if not coalesce((p->>'confirmed')::boolean,false) then raise exception 'Review and confirm activation';end if;
 update public.finance_seasons set status='active' where id=sid;
 elsif action='close' then
 if exists(select 1 from public.finance_po_budget b join public.finance_purchase_orders p on p.id=b.po_id where b.season_id=sid and p.status not in ('submitted_to_school','cancelled')) then raise exception 'Resolve unfinished POs before closing';end if;
 update public.finance_seasons set status='closed' where id=sid;
 else update public.finance_seasons set name=trim(p->>'name'),starts_on=nullif(p->>'starts_on','')::date,ends_on=nullif(p->>'ends_on','')::date,starting_funds=(p->>'starting_funds')::numeric,reserve_target=(p->>'reserve_target')::numeric where id=sid;end if;
 select to_jsonb(b) into after_value from public.finance_seasons b where id=sid;rid:=sid;
 elsif action='category' then
 if rid is not null then select * into c from public.finance_budget_categories where id=rid and season_id=sid for update;if not found then raise exception 'Category unavailable';end if;prev:=to_jsonb(c);end if;
 insert into public.finance_budget_categories(id,season_id,name,description,display_order,active,allocation,forecast)
 values(coalesce(rid,gen_random_uuid()),sid,trim(p->>'name'),coalesce(p->>'description',''),coalesce((p->>'display_order')::integer,0),coalesce((p->>'active')::boolean,true),coalesce((p->>'allocation')::numeric,0),nullif(p->>'forecast','')::numeric)
 on conflict(id) do update set name=excluded.name,description=excluded.description,display_order=excluded.display_order,active=excluded.active,allocation=excluded.allocation,forecast=excluded.forecast returning * into c;
 rid:=c.id;cid:=c.id;after_value:=to_jsonb(c);
 elsif action='transfer' then
 amount:=(p->>'amount')::numeric;
 if amount is null or amount<=0 or amount>999999999999.99 or amount<>round(amount,2) or from_id is not distinct from to_id then raise exception 'Choose different funds and a positive cents amount';end if;
 if exists(select 1 from unnest(array[from_id,to_id]) x where x is not null and not exists(select 1 from public.finance_budget_categories where id=x and season_id=sid and active)) then raise exception 'Choose active categories in this season';end if;
 if from_id is null then
 if amount>(finance_private.budget_summary(sid)->>'unallocated')::numeric then raise exception 'Not enough unrestricted unallocated funds';end if;
 elsif amount>(select allocation from public.finance_budget_categories where id=from_id) then raise exception 'Transfer exceeds unrestricted allocation';end if;
 prev:=jsonb_build_object('from_id',from_id,'to_id',to_id,'amount',amount,'categories',(select jsonb_agg(to_jsonb(b)) from public.finance_budget_categories b where id in (from_id,to_id)));
 update public.finance_budget_categories set allocation=allocation+case when id=to_id then amount else -amount end where id in (from_id,to_id);
 after_value:=jsonb_build_object('from_id',from_id,'to_id',to_id,'amount',amount,'categories',(select jsonb_agg(to_jsonb(b)) from public.finance_budget_categories b where id in (from_id,to_id)));rid:=sid;
 elsif action='income' then
 if cid is not null and not exists(select 1 from public.finance_budget_categories where id=cid and season_id=sid and active) then raise exception 'Choose an active category';end if;
 if rid is not null then select * into i from public.finance_income where id=rid and season_id=sid for update;if not found then raise exception 'Income unavailable';end if;prev:=to_jsonb(i);end if;
 insert into public.finance_income(id,season_id,source,income_type,amount,status,expected_on,received_on,category_id,reference,notes,created_by)
 values(coalesce(rid,gen_random_uuid()),sid,trim(p->>'source'),trim(p->>'income_type'),(p->>'amount')::numeric,p->>'status',nullif(p->>'expected_on','')::date,nullif(p->>'received_on','')::date,cid,coalesce(p->>'reference',''),coalesce(p->>'notes',''),auth.uid())
 on conflict(id) do update set source=excluded.source,income_type=excluded.income_type,amount=excluded.amount,status=excluded.status,expected_on=excluded.expected_on,received_on=excluded.received_on,category_id=excluded.category_id,reference=excluded.reference,notes=excluded.notes returning * into i;
 rid:=i.id;after_value:=to_jsonb(i);
 elsif action in ('expense','credit') then
 if s.status<>'active' then raise exception 'Activate the season before recording spending';end if;
 if not exists(select 1 from public.finance_budget_categories where id=cid and season_id=sid and active) then raise exception 'Choose an active category';end if;
 if nullif(p->>'po_id','') is not null and not exists(select 1 from public.finance_po_budget where po_id=(p->>'po_id')::uuid and season_id=sid and category_id=cid) then raise exception 'Credit reference must belong to this season and category';end if;
 if nullif(p->>'expense_id','') is not null and not exists(select 1 from public.finance_expenses where id=(p->>'expense_id')::uuid and season_id=sid and category_id=cid and kind='expense') then raise exception 'Expense reference must belong to this season and category';end if;
 if action='expense' and length(trim(coalesce(p->>'payee','')))=0 then raise exception 'Vendor/payee required';end if;
 insert into public.finance_expenses(season_id,category_id,kind,amount,payee,occurred_on,reference,reason,po_id,expense_id,created_by)
 values(sid,cid,action,(p->>'amount')::numeric,trim(coalesce(p->>'payee','')),(p->>'occurred_on')::date,coalesce(p->>'reference',''),why,nullif(p->>'po_id','')::uuid,nullif(p->>'expense_id','')::uuid,auth.uid()) returning * into e;
 rid:=e.id;after_value:=to_jsonb(e);
 elsif action='categorize_po' then
 select * into po from public.finance_purchase_orders where id=(p->>'po_id')::uuid for update;
 if not found or (po.status='draft' and not finance_private.visible(po.id)) then raise exception 'PO unavailable';end if;
 if s.status<>'active' then raise exception 'Use an active season for PO coding';end if;
 if not exists(select 1 from public.finance_budget_categories where id=cid and season_id=sid and active) then raise exception 'Choose an active category';end if;
 if exists(select 1 from public.finance_po_budget where po_id=po.id and season_id<>sid) then raise exception 'A PO cannot move between seasons';end if;
 select to_jsonb(b) into prev from public.finance_po_budget b where po_id=po.id;
 insert into public.finance_po_budget values(po.id,sid,cid) on conflict(po_id) do update set category_id=excluded.category_id;
 after_value:=jsonb_build_object('po_id',po.id,'season_id',sid,'category_id',cid);rid:=po.id;
 else raise exception 'Unknown budget action';end if;
 update public.finance_seasons set version=version+1,updated_at=clock_timestamp() where id=sid;
 if action in ('season','activate','close') then select to_jsonb(b) into after_value from public.finance_seasons b where id=sid;end if;
 perform finance_private.budget_audit(sid,cid,case when action='categorize_po' then po.id else null end,action,why,prev,after_value);return rid;
end $$;
-- Preserve the exact installed V1 workflow, security checks, history and notification hooks.
alter function public.finance_mutate(text,jsonb) set schema finance_private;
alter function finance_private.finance_mutate(text,jsonb) rename to mutate_v1;
revoke all on function finance_private.mutate_v1(text,jsonb) from public,anon,authenticated;
create function public.finance_mutate(action text,p jsonb) returns uuid language plpgsql security definer set search_path='' as $$
declare pid uuid;sid uuid;cid uuid;before_link jsonb;po public.finance_purchase_orders;cat jsonb;available numeric;over_amount numeric;why text:=trim(coalesce(p->>'budget_reason',''));
begin
 perform pg_advisory_xact_lock(4418,20);
 -- V1 executes first inside this transaction; any budget failure rolls it and its outbox back.
 pid:=finance_private.mutate_v1(action,p);
 if action in ('create','assignment') then return pid;end if;
 select * into po from public.finance_purchase_orders where id=pid;
 select b.season_id,to_jsonb(b) into sid,before_link from public.finance_po_budget b where po_id=pid;
 if sid is null and action in ('submit','approve','school_submit') then select id into sid from public.finance_seasons where status='active';end if;
 if sid is null then return pid;end if;
 if exists(select 1 from public.finance_seasons where id=sid and status='closed') then raise exception 'Closed season PO cannot be changed';end if;
 insert into public.finance_po_budget(po_id,season_id) values(pid,sid) on conflict do nothing;
 if action='approve' and p->>'slot'='finance_approver' then
 cid:=nullif(p->>'category_id','')::uuid;
 if cid is null or not exists(select 1 from public.finance_budget_categories where id=cid and season_id=sid and active) then raise exception 'Choose a budget category for Finance approval';end if;
 select value into cat from jsonb_array_elements(finance_private.budget_summary(sid)->'categories') where value->>'id'=cid::text;
 available:=(cat->>'available')::numeric;
 -- Remove this PO's existing impact before projecting its single new impact.
 if exists(select 1 from public.finance_po_budget where po_id=pid and category_id=cid) then available:=available+po.amount;end if;
 over_amount:=greatest(0,po.amount-available);
 if over_amount>0 and (length(why) not between 1 and 2000) then raise exception 'Over budget by %. Explain the override.',over_amount;end if;
 update public.finance_po_budget set category_id=cid where po_id=pid;
 perform finance_private.budget_audit(sid,cid,pid,'po_category',why,before_link,jsonb_build_object('po_id',pid,'category_id',cid,'amount',po.amount,'over_budget',over_amount,'revision',po.revision));
 elsif before_link is null then perform finance_private.budget_audit(sid,null,pid,'po_season','Current active season',null,jsonb_build_object('po_id',pid,'season_id',sid));end if;
 update public.finance_seasons set version=version+1,updated_at=clock_timestamp() where id=sid;
 return pid;
end $$;
-- Narrow approval preview for existing approvers/mentor overrides, without granting budget management.
create function public.finance_budget_approval(po_id uuid) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare sid uuid;po public.finance_purchase_orders;b public.finance_po_budget;
begin
 if not finance_private.visible(po_id) or not(finance_private.cap('finance_approver') or finance_private.role() in ('mentor','admin')) then raise exception 'Finance approver required' using errcode='42501';end if;
 select * into po from public.finance_purchase_orders where id=po_id;
 select * into b from public.finance_po_budget x where x.po_id=po.id;sid:=b.season_id;
 if sid is null then select id into sid from public.finance_seasons where status='active';end if;
 if sid is null then return jsonb_build_object('required',false);end if;
 return jsonb_build_object('required',true,'category_id',b.category_id,'season_id',sid,'categories',
 (select coalesce(jsonb_agg(c||jsonb_build_object('projected_available',(c->>'available')::numeric-po.amount+case when c->>'id'=b.category_id::text and po.status='awaiting_approval' then po.amount else 0 end)),'[]') from jsonb_array_elements(finance_private.budget_summary(sid)->'categories') c where (c->>'active')::boolean));
end $$;
revoke all on function finance_private.can_manage_budget(),finance_private.budget_audit(uuid,uuid,uuid,text,text,jsonb,jsonb),finance_private.budget_summary(uuid) from public,anon,authenticated;
grant execute on function finance_private.can_manage_budget() to authenticated;
revoke all on function public.finance_budget_context(uuid),public.finance_budget_manage(text,jsonb),public.finance_budget_approval(uuid),public.finance_mutate(text,jsonb) from public,anon,authenticated;
grant execute on function public.finance_budget_context(uuid),public.finance_budget_manage(text,jsonb),public.finance_budget_approval(uuid),public.finance_mutate(text,jsonb) to authenticated;
commit;
