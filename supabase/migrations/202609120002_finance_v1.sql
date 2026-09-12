-- REVIEW / MANUAL ONLY. Reads shared identity, areas and registration; changes no existing table.
begin;
do $$ begin
 perform id,display_name,role,active,primary_area_id from public.profiles limit 1;
 perform id,name,active from public.areas limit 1;
 perform student_id,member_status from public.team_attendance_members limit 1;
end $$;
create schema finance_private;
revoke all on schema finance_private from public;
grant usage on schema finance_private to authenticated;
create table public.finance_assignments(
 id uuid primary key default gen_random_uuid(), user_id uuid not null references public.profiles(id),
 capability text not null check(capability in ('finance_approver','po_approver','school_submitter','finance_admin')),
 active boolean not null default true, assigned_by uuid not null references public.profiles(id),assigned_at timestamptz not null default now(),
 unique(user_id,capability)
);
create table public.finance_purchase_orders(
 id uuid primary key default gen_random_uuid(), po_number bigint generated always as identity unique,
 requester_id uuid not null references public.profiles(id),area_id uuid not null references public.areas(id),
 sheet_url text not null check(length(sheet_url)<=2000) check(sheet_url ~ '^https://docs\.google\.com/(spreadsheets|document)/d/[A-Za-z0-9_-]+([/?#][^[:space:]]*)?$'),
 vendor text not null check(length(trim(vendor)) between 1 and 150),amount numeric(14,2) not null check(amount>0 and amount<=999999999999.99),
 purpose text not null check(length(trim(purpose)) between 1 and 2000),notes text not null default '' check(length(notes)<=4000),needed_by date,
 status text not null default 'draft' check(status in ('draft','awaiting_approval','changes_requested','approved','submitted_to_school','cancelled')),
 revision integer not null default 0 check(revision>=0),version integer not null default 1 check(version>0),
 created_at timestamptz not null default now(),updated_at timestamptz not null default now(),submitted_at timestamptz,
 school_submitted_by uuid references public.profiles(id),school_submitted_at timestamptz,
 school_reference text not null default '' check(length(school_reference)<=150),school_note text not null default '' check(length(school_note)<=2000)
);
create table public.finance_po_revisions(
 po_id uuid not null references public.finance_purchase_orders(id),revision integer not null,
 metadata jsonb not null,submitted_by uuid not null references public.profiles(id),submitted_at timestamptz not null default now(),primary key(po_id,revision)
);
create table public.finance_po_approvals(
 id uuid primary key default gen_random_uuid(),po_id uuid not null,revision integer not null,
 slot text not null check(slot in ('finance_approver','po_approver')),
 action text not null check(action in ('approved','changes_requested')),
 actor_id uuid not null references public.profiles(id),acted_at timestamptz not null default now(),
 explanation text not null default '' check(length(explanation)<=2000),override_reason text not null default '' check(length(override_reason)<=2000),
 foreign key(po_id,revision) references public.finance_po_revisions(po_id,revision)
);
create unique index finance_one_slot_approval on public.finance_po_approvals(po_id,revision,slot) where action='approved';
create table finance_private.history(
 id bigint generated always as identity primary key,po_id uuid references public.finance_purchase_orders(id),revision integer,
 action text not null,actor_id uuid not null references public.profiles(id),created_at timestamptz not null default now(),details jsonb not null default '{}'
);
create index finance_po_requester on public.finance_purchase_orders(requester_id);
create index finance_po_area_status on public.finance_purchase_orders(area_id,status);
create index finance_history_po on finance_private.history(po_id,id);
create index finance_approval_po on public.finance_po_approvals(po_id,revision);
create function finance_private.role() returns text language sql stable security definer set search_path='' as $$
 select role::text from public.profiles where id=auth.uid() and active
$$;
create function finance_private.cap(c text) returns boolean language sql stable security definer set search_path='' as $$
 select coalesce(finance_private.role() in ('student','lead','admin','mentor'),false) and exists(select 1 from public.finance_assignments where user_id=auth.uid() and capability=c and active)
$$;
create function finance_private.admin() returns boolean language sql stable security definer set search_path='' as $$
 select coalesce(finance_private.role() in ('admin','mentor') or finance_private.cap('finance_admin'),false)
$$;
create function finance_private.creator() returns boolean language sql stable security definer set search_path='' as $$
 select coalesce(finance_private.admin() or finance_private.role()='lead' or (finance_private.role()='student' and exists(select 1 from public.team_attendance_members where student_id=auth.uid() and member_status='registered')),false)
$$;
create function finance_private.visible(pid uuid) returns boolean language sql stable security definer set search_path='' as $$
 select finance_private.role() is not null and exists(select 1 from public.finance_purchase_orders p where p.id=pid and
 (p.requester_id=auth.uid() or finance_private.admin() or (p.status<>'draft' and
 (finance_private.cap('finance_approver') or finance_private.cap('po_approver') or finance_private.cap('school_submitter') or
 (finance_private.role()='lead' and p.area_id=(select primary_area_id from public.profiles where id=auth.uid()))))))
$$;
do $$ declare t text; begin
 foreach t in array array['finance_purchase_orders','finance_po_revisions','finance_po_approvals','finance_assignments'] loop
 execute format('alter table public.%I enable row level security',t);
 execute format('revoke all on public.%I from public,anon,authenticated',t);
 execute format('grant select on public.%I to authenticated',t);
 end loop;
end $$;
create policy finance_po_read on public.finance_purchase_orders for select to authenticated using(finance_private.visible(id));
create policy finance_revision_read on public.finance_po_revisions for select to authenticated using(finance_private.visible(po_id));
create policy finance_approval_read on public.finance_po_approvals for select to authenticated using(finance_private.visible(po_id));
-- Raw audit storage is never directly exposed to clients. Keep the public API shape.
alter table finance_private.history enable row level security;
revoke all on finance_private.history from public,anon,authenticated;
create function finance_private.student_history_payload(payload jsonb) returns jsonb
language sql immutable set search_path='' as $$
 select coalesce((select jsonb_object_agg(key,value) from jsonb_each(payload)
 where key in ('reason','slot','override_reason','self_approval_override')), '{}'::jsonb)
$$;
create view public.finance_po_history with (security_barrier=true) as
 select id,po_id,revision,action,actor_id,created_at,
 case when finance_private.admin() or finance_private.role()='lead' or
 finance_private.cap('finance_approver') or finance_private.cap('po_approver') or finance_private.cap('school_submitter')
 then details else finance_private.student_history_payload(details) end as details
 from finance_private.history
 where finance_private.visible(po_id) or (po_id is null and finance_private.admin());
revoke all on public.finance_po_history from public,anon,authenticated;
grant select on public.finance_po_history to authenticated;
-- A change request permanently invalidates this revision, regardless of later status.
-- Only resubmission creates a new eligible revision; historical actions remain intact.
create function finance_private.revision_approved(pid uuid, rev integer) returns boolean
language sql stable security definer set search_path='' as $$
 select not exists(select 1 from public.finance_po_approvals where po_id=pid and revision=rev and action='changes_requested')
 and (select count(distinct slot)=2 and count(distinct actor_id)=2 from public.finance_po_approvals
 where po_id=pid and revision=rev and action='approved')
$$;
create policy finance_assignment_read on public.finance_assignments for select to authenticated using(finance_private.admin() or (user_id=auth.uid() and finance_private.role() is not null));
-- Minimal directory: approver/requester names only for visible records; full assignment picker for admins.
create function public.finance_context() returns jsonb language plpgsql security definer set search_path='' as $$
begin
 if finance_private.role() is null then raise exception 'Active team account required' using errcode='42501'; end if;
 return jsonb_build_object('profile',(select jsonb_build_object('id',id,'display_name',display_name,'role',role) from public.profiles where id=auth.uid()),
 'can_create',finance_private.creator(),'is_admin',finance_private.admin(),
 'capabilities',(select coalesce(jsonb_agg(capability),'[]') from public.finance_assignments where user_id=auth.uid() and active),
 'areas',(select coalesce(jsonb_agg(jsonb_build_object('id',id,'name',name,'active',active) order by name),'[]') from public.areas),
 'people',(select coalesce(jsonb_agg(jsonb_build_object('id',pr.id,'name',pr.display_name) order by pr.display_name),'[]') from public.profiles pr
 where (finance_private.admin() and pr.active) or pr.id=auth.uid() or exists(select 1 from public.finance_purchase_orders p where finance_private.visible(p.id) and p.requester_id=pr.id)
 or exists(select 1 from finance_private.history h where h.actor_id=pr.id and finance_private.visible(h.po_id))));
end $$;
create function public.finance_mutate(action text,p jsonb) returns uuid language plpgsql security definer set search_path='' as $$
declare po public.finance_purchase_orders; previous jsonb; pid uuid; slot text:=p->>'slot'; reason text:=trim(coalesce(p->>'reason','')); override_note text:=trim(coalesce(p->>'override_reason','')); caps boolean;
begin
 if finance_private.role() is null then raise exception 'Active team account required' using errcode='42501'; end if;
 if length(reason)>2000 or length(override_note)>2000 then raise exception 'Explanations must be at most 2000 characters'; end if;
 if action='assignment' then
 if not finance_private.admin() then raise exception 'Finance administration required' using errcode='42501'; end if;
 if not exists(select 1 from public.profiles where id=(p->>'user_id')::uuid and active and role::text in ('student','lead','admin','mentor')) then raise exception 'Choose an active student or leadership account'; end if;
 if reason='' then raise exception 'Assignment explanation required'; end if;
 insert into public.finance_assignments(user_id,capability,active,assigned_by) values((p->>'user_id')::uuid,p->>'capability',(p->>'active')::boolean,auth.uid())
 on conflict(user_id,capability) do update set active=excluded.active,assigned_by=auth.uid(),assigned_at=clock_timestamp() returning id into pid;
 insert into finance_private.history(action,actor_id,details) values('assignment',auth.uid(),jsonb_build_object('assignment_id',pid,'user_id',p->>'user_id','capability',p->>'capability','active',p->'active','reason',reason));return pid;
 end if;
 if action='create' then
 if not finance_private.creator() then raise exception 'Registered student or leadership access required' using errcode='42501'; end if;
 if not exists(select 1 from public.areas where id=(p->>'area_id')::uuid and active) then raise exception 'Choose an active team area'; end if;
 insert into public.finance_purchase_orders(requester_id,area_id,sheet_url,vendor,amount,purpose,notes,needed_by)
 values(auth.uid(),(p->>'area_id')::uuid,trim(p->>'sheet_url'),trim(p->>'vendor'),(p->>'amount')::numeric,trim(p->>'purpose'),coalesce(p->>'notes',''),nullif(p->>'needed_by','')::date) returning * into po;
 insert into finance_private.history(po_id,revision,action,actor_id,details) values(po.id,0,'created',auth.uid(),to_jsonb(po)); return po.id;
 end if;
 pid:=(p->>'id')::uuid;
 if not finance_private.visible(pid) then raise exception 'Purchase order unavailable' using errcode='42501'; end if;
 select * into po from public.finance_purchase_orders where id=pid for update;
 previous:=to_jsonb(po);
 if po.version is distinct from (p->>'version')::integer then raise exception 'This PO changed. Refresh before acting.'; end if;
 if action in ('edit','submit','cancel') then
 if po.requester_id<>auth.uid() and not finance_private.admin() then raise exception 'Requester or Finance administrator required' using errcode='42501'; end if;
 if po.status in ('submitted_to_school','cancelled') then raise exception 'This PO is locked'; end if;
 if action='edit' then
 if not exists(select 1 from public.areas where id=(p->>'area_id')::uuid and active) then raise exception 'Choose an active team area'; end if;
 update public.finance_purchase_orders set area_id=(p->>'area_id')::uuid,sheet_url=trim(p->>'sheet_url'),vendor=trim(p->>'vendor'),amount=(p->>'amount')::numeric,
 purpose=trim(p->>'purpose'),notes=coalesce(p->>'notes',''),needed_by=nullif(p->>'needed_by','')::date,status='draft' where id=pid;
 elsif action='submit' then
 if po.status not in ('draft','changes_requested') then raise exception 'Only drafts or requested changes can be submitted'; end if;
 update public.finance_purchase_orders set revision=revision+1,status='awaiting_approval',submitted_at=clock_timestamp() where id=pid returning * into po;
 insert into public.finance_po_revisions(po_id,revision,metadata,submitted_by) values(pid,po.revision,to_jsonb(po),auth.uid());
 else
 if reason='' then raise exception 'Cancellation explanation required'; end if;
 update public.finance_purchase_orders set status='cancelled' where id=pid;
 end if;
 elsif action in ('approve','request_changes') then
 if po.status<>'awaiting_approval' then raise exception 'PO is not awaiting approval'; end if;
 if exists(select 1 from public.finance_po_approvals a where a.po_id=pid and a.revision=po.revision and a.action='changes_requested') then raise exception 'This revision requires resubmission'; end if;
 if slot is null or slot not in ('finance_approver','po_approver') then raise exception 'Choose an approval slot'; end if;
 -- Emergency exception: an active Finance administrator may replace ONE configured
 -- approver (including on their own PO) only with an explicit override reason.
 -- The same actor can NEVER approve both slots, including through overrides.
 caps:=finance_private.cap(slot);
 if (not caps or po.requester_id=auth.uid()) and not (finance_private.admin() and override_note<>'') then raise exception 'Configured approver required; administrators must give an explicit override reason' using errcode='42501'; end if;
 if override_note<>'' and not finance_private.admin() then raise exception 'Only Finance administrators can override' using errcode='42501'; end if;
 if action='request_changes' and reason='' then raise exception 'Explain the requested changes'; end if;
 if action='approve' and exists(select 1 from public.finance_po_approvals a where a.po_id=pid and a.revision=po.revision and a.action='approved' and a.actor_id=auth.uid()) then raise exception 'Two distinct people must approve each revision'; end if;
 insert into public.finance_po_approvals(po_id,revision,slot,action,actor_id,explanation,override_reason)
 values(pid,po.revision,slot,case when action='approve' then 'approved' else 'changes_requested' end,auth.uid(),reason,override_note);
 update public.finance_purchase_orders set status=case when action='request_changes' then 'changes_requested'
 when finance_private.revision_approved(pid,po.revision) then 'approved' else 'awaiting_approval' end where id=pid;
 elsif action='school_submit' then
 if not (finance_private.cap('school_submitter') or finance_private.admin()) then raise exception 'School submission capability required' using errcode='42501'; end if;
 if po.status<>'approved' or not finance_private.revision_approved(pid,po.revision) then raise exception 'Both current-revision approvals are required'; end if;
 update public.finance_purchase_orders set status='submitted_to_school',school_submitted_by=auth.uid(),school_submitted_at=clock_timestamp(),school_reference=trim(coalesce(p->>'reference','')),school_note=trim(coalesce(p->>'note','')) where id=pid;
 else raise exception 'Unknown Finance action'; end if;
 update public.finance_purchase_orders set version=version+1,updated_at=clock_timestamp() where id=pid;
 insert into finance_private.history(po_id,revision,action,actor_id,details)
 select pid,revision,action,auth.uid(),jsonb_build_object('reason',reason,'slot',slot,'override_reason',override_note,'self_approval_override',action='approve' and po.requester_id=auth.uid(),'before',previous,'after',to_jsonb(n)) from public.finance_purchase_orders n where id=pid;
 return pid;
end $$;
revoke all on all functions in schema finance_private from public,anon,authenticated;
grant execute on function finance_private.role(),finance_private.cap(text),finance_private.admin(),finance_private.creator(),finance_private.visible(uuid),finance_private.student_history_payload(jsonb) to authenticated;
revoke all on function public.finance_context(),public.finance_mutate(text,jsonb) from public,anon,authenticated;
grant execute on function public.finance_context(),public.finance_mutate(text,jsonb) to authenticated;
commit;
