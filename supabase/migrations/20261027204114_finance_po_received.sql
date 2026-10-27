-- REVIEW / MANUAL ONLY. Record receipt after school submission; no data backfill.
-- Requires Finance V2C and the installed Team Positions workflow.
-- Keep existing approvals, permissions, notifications and financial totals unchanged.
begin;

-- Fail closed rather than overwrite any deployed budget/export customizations.
-- The delegated PO workflow itself is retained verbatim below.
do $$ begin
  if (select md5(prosrc) from pg_proc where oid='public.finance_budget_manage(text,jsonb)'::regprocedure) is distinct from '2a752184d11024879eb3433f8b726a12' then
    raise exception 'Installed public.finance_budget_manage differs from reviewed source; compare before applying receipt migration';
  end if;
  if (select md5(prosrc) from pg_proc where oid='public.finance_workbook_context(uuid)'::regprocedure) is distinct from '5f9b0e79a823ab84d05e86628361eb5c' then
    raise exception 'Installed public.finance_workbook_context differs from reviewed source; compare before applying receipt migration';
  end if;
end $$;

alter table public.finance_purchase_orders
  drop constraint finance_purchase_orders_status_check,
  add constraint finance_purchase_orders_status_check check(status in
    ('draft','awaiting_approval','changes_requested','approved','submitted_to_school','received','cancelled')),
  add column received_by uuid references public.profiles(id),
  add column received_at timestamptz,
  add column receipt_note text not null default '' check(length(receipt_note)<=2000),
  add constraint finance_po_receipt_facts check(
    (status='received' and received_by is not null and received_at is not null)
    or (status<>'received' and received_by is null and received_at is null and receipt_note='')
  );

-- Preserve the exact installed approval + budget implementation, including its
-- audit/outbox hooks. Only the public entrypoint can call this private delegate.
alter function public.finance_mutate(text,jsonb) set schema finance_private;
alter function finance_private.finance_mutate(text,jsonb) rename to mutate_before_received;
revoke all on function finance_private.mutate_before_received(text,jsonb) from public,anon,authenticated;

create function public.finance_mutate(action text,p jsonb) returns uuid
language plpgsql security definer set search_path='' as $$
declare
  po public.finance_purchase_orders;
  previous jsonb;
  pid uuid;
  sid uuid;
  note text:=trim(coalesce(p->>'note',''));
begin
  -- Same lock order as the installed budget workflow and season close.
  perform pg_advisory_xact_lock(4418,20);
  if action in ('create','assignment') then
    return finance_private.mutate_before_received(action,p);
  end if;
  pid:=(p->>'id')::uuid;
  if not finance_private.visible(pid) then
    raise exception 'Purchase order unavailable' using errcode='42501';
  end if;
  select * into po from public.finance_purchase_orders where id=pid for update;
  -- Recheck account/visibility after the lock wait, before accepting any receipt.
  if finance_private.role() is null or not finance_private.visible(pid) then
    raise exception 'Purchase order unavailable' using errcode='42501';
  end if;
  if po.version is distinct from (p->>'version')::integer then
    raise exception 'This PO changed. Refresh before acting.';
  end if;
  if po.status='received' then raise exception 'This PO is locked';end if;
  if action is distinct from 'receive' then
    return finance_private.mutate_before_received(action,p);
  end if;
  -- Exactly the current school-submission authority: finance_admin alone is not enough.
  if not (finance_private.cap('school_submitter') or finance_private.role() in ('admin','mentor')) then
    raise exception 'School submission capability required to record receipt' using errcode='42501';
  end if;
  if po.status<>'submitted_to_school' or po.school_submitted_at is null
    or po.school_submitted_by is null or not finance_private.revision_approved(pid,po.revision) then
    raise exception 'Only a submitted-to-school PO with both current-revision approvals can be received';
  end if;
  if length(note)>2000 then raise exception 'Receipt note must be at most 2000 characters';end if;
  select season_id into sid from public.finance_po_budget where po_id=pid;
  if exists(select 1 from public.finance_seasons where id=sid and status='closed') then
    raise exception 'Closed season PO cannot be changed';
  end if;
  previous:=to_jsonb(po);
  update public.finance_purchase_orders
    set status='received',received_by=auth.uid(),received_at=clock_timestamp(),receipt_note=note,
      version=version+1,updated_at=clock_timestamp()
    where id=pid returning * into po;
  insert into finance_private.history(po_id,revision,action,actor_id,details)
    values(pid,po.revision,'receive',auth.uid(),jsonb_build_object('reason',note,'before',previous,'after',to_jsonb(po)));
  -- The existing history trigger deliberately ignores unknown notification kinds:
  -- receipt is audited in-app and does not send a new email or duplicate submission.
  if sid is not null then
    update public.finance_seasons set version=version+1,updated_at=clock_timestamp() where id=sid;
  end if;
  return pid;
end $$;
revoke all on function public.finance_mutate(text,jsonb) from public,anon,authenticated;
grant execute on function public.finance_mutate(text,jsonb) to authenticated;

-- Receipt is fulfillment, not another expense. Keep the single existing spent impact.
create or replace view finance_private.po_impacts as
 select p.id po_id,b.season_id,b.category_id,p.amount,p.area_id,p.revision,p.status,
 case when p.status='awaiting_approval' then 'requested'
 when p.status='approved' and finance_private.revision_approved(p.id,p.revision) then 'committed'
 when p.status in ('submitted_to_school','received') and finance_private.revision_approved(p.id,p.revision) then 'spent' else 'none' end bucket
 from public.finance_purchase_orders p join public.finance_po_budget b on b.po_id=p.id;
revoke all on finance_private.po_impacts from public,anon,authenticated;

-- Existing budget management, with only Received added to the terminal states
-- accepted by season close. All financial mutations and permissions are unchanged.
create or replace function public.finance_budget_manage(action text,p jsonb) returns uuid language plpgsql security definer set search_path='' as $$
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
 if exists(select 1 from public.finance_po_budget b join public.finance_purchase_orders p on p.id=b.po_id where b.season_id=sid and p.status not in ('submitted_to_school','received','cancelled')) then raise exception 'Resolve unfinished POs before closing';end if;
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

-- Keep approval dates and receipt facts in the selected-season workbook projection.
create or replace function public.finance_workbook_context(season uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare b jsonb;
begin
 if not finance_private.can_manage_budget() then
  raise exception 'Budget leadership access required' using errcode='42501';
 end if;
 if season is null or not exists(select 1 from public.finance_seasons s where s.id=season) then
  raise exception 'Select an existing budget season' using errcode='22023';
 end if;
 -- One statement snapshot; reuse the deployed financial summary without new totals.
 b:=public.finance_budget_context(season)-'seasons'-'uncategorized'-'positions'-'can_classify';
 b:=jsonb_set(b,'{history}',coalesce((select jsonb_agg(h order by (h->>'id')::bigint)
  from jsonb_array_elements(b->'history') h where h->>'season_id'=season::text or
  exists(select 1 from public.finance_po_budget p where p.season_id=season and p.po_id::text=h->>'po_id')),'[]'::jsonb));
 return jsonb_build_object('generated_at',statement_timestamp(),'budget',b,
 'purchase_orders',(select coalesce(jsonb_agg(to_jsonb(x) order by x.po_number),'[]') from (
  select p.id,p.po_number,p.vendor,p.purpose,p.amount,p.revision,p.status,p.submitted_at,p.school_submitted_at,p.school_reference,p.updated_at,p.received_at,p.received_by,p.receipt_note,
   pr.display_name requester,ar.name functional_area,bc.name category,i.bucket,
   case when p.status in ('approved','submitted_to_school','received') and finance_private.revision_approved(p.id,p.revision)
    then (select max(a.acted_at) from public.finance_po_approvals a where a.po_id=p.id and a.revision=p.revision and a.action='approved') end approved_at,
   (select coalesce(jsonb_agg(jsonb_build_object('slot',a.slot,'action',a.action,'actor',actor.display_name,'acted_at',a.acted_at) order by a.acted_at,a.id),'[]')
    from public.finance_po_approvals a left join public.profiles actor on actor.id=a.actor_id where a.po_id=p.id and a.revision=p.revision) approvals
  from public.finance_po_budget pb join public.finance_purchase_orders p on p.id=pb.po_id
  join finance_private.po_impacts i on i.po_id=p.id
  left join public.profiles pr on pr.id=p.requester_id left join public.areas ar on ar.id=p.area_id
  left join public.finance_budget_categories bc on bc.id=pb.category_id where pb.season_id=season
 ) x),
 'people',(select coalesce(jsonb_object_agg(p.id,p.display_name),'{}') from public.profiles p where p.id in (
  select created_by from public.finance_income where season_id=season union select created_by from public.finance_expenses where season_id=season)));
end $$;
revoke all on function public.finance_budget_manage(text,jsonb),public.finance_workbook_context(uuid) from public,anon,authenticated;
grant execute on function public.finance_budget_manage(text,jsonb),public.finance_workbook_context(uuid) to authenticated;
commit;
