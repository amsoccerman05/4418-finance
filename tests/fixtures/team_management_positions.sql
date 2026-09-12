-- MANUAL REVIEW ONLY. Apply after Inventory, Attendance and hardened Finance V1.
-- Existing users, areas, attendance snapshots and Finance revisions are preserved.
begin;
do $$ begin
 perform id,display_name,role,active,primary_area_id,updated_at from public.profiles limit 1;
 perform id,name,slug,active from public.areas limit 1;
 perform student_id,member_status,team_area from public.team_attendance_members limit 1;
 perform id from finance_private.history limit 1;
end $$;
create schema team_private;
revoke all on schema team_private from public;
grant usage on schema team_private to authenticated;
create function team_private.admin() returns boolean language sql stable security definer set search_path='' as $$
 select exists(select 1 from public.profiles where id=auth.uid() and active and role::text in ('admin','mentor'))
$$;
create table public.team_positions(
 key text primary key check(key ~ '^[a-z][a-z0-9_]{1,63}$'), name text not null check(length(trim(name)) between 1 and 100), active boolean not null default true
);
insert into public.team_positions(key,name) values ('lead_coach_1','Lead Coach 1'),('lead_coach_2','Lead Coach 2'),('finance_lead','Finance Lead');
create table public.team_member_positions(
 id uuid primary key default gen_random_uuid(),user_id uuid not null references public.profiles(id),position_key text not null references public.team_positions(key),
 assigned_by uuid not null references public.profiles(id),assigned_at timestamptz not null default now(),assignment_reason text not null check(length(trim(assignment_reason)) between 1 and 2000),
 revoked_by uuid references public.profiles(id),revoked_at timestamptz,revoke_reason text,
 check((revoked_at is null and revoked_by is null and revoke_reason is null) or (revoked_at is not null and revoked_by is not null and length(trim(revoke_reason)) between 1 and 2000))
);
create unique index team_one_active_position on public.team_member_positions(user_id,position_key) where revoked_at is null;
create table team_private.management_history(
 id bigint generated always as identity primary key,user_id uuid references public.profiles(id),action text not null,
 actor_id uuid not null references public.profiles(id),created_at timestamptz not null default now(),reason text not null,before_data jsonb,after_data jsonb
);
alter table team_private.management_history enable row level security;
revoke all on team_private.management_history from public,anon,authenticated;
do $$ declare t text; begin
 foreach t in array array['team_positions','team_member_positions'] loop
 execute format('alter table public.%I enable row level security',t);
 execute format('revoke all on public.%I from public,anon,authenticated',t);
 execute format('grant select on public.%I to authenticated',t);
 end loop;
end $$;
create policy team_position_read on public.team_positions for select to authenticated using(exists(select 1 from public.profiles where id=auth.uid() and active));
create policy team_member_position_read on public.team_member_positions for select to authenticated using(team_private.admin() or (user_id=auth.uid() and exists(select 1 from public.profiles where id=auth.uid() and active)));
-- Current-caller helpers only: callers cannot spoof a user or inspect another student's positions.
create function public.team_my_positions() returns text[] language sql stable security definer set search_path='' as $$
 select coalesce(array_agg(mp.position_key order by mp.position_key),'{}') from public.team_member_positions mp
 join public.team_positions pos on pos.key=mp.position_key and pos.active
 join public.profiles pr on pr.id=mp.user_id and pr.active and pr.role::text in ('student','lead','mentor','admin')
 where mp.user_id=auth.uid() and mp.revoked_at is null
$$;
create function public.team_has_any_position(keys text[]) returns boolean language sql stable security definer set search_path='' as $$
 select coalesce(public.team_my_positions() && keys,false)
$$;
create function public.team_has_position(key text) returns boolean language sql stable security definer set search_path='' as $$
 select public.team_has_any_position(array[key])
$$;
create function public.team_management_context() returns jsonb language plpgsql security definer set search_path='' as $$
begin
 if not team_private.admin() then raise exception 'Active mentor or admin required' using errcode='42501'; end if;
 return jsonb_build_object(
 'members',(select coalesce(jsonb_agg(jsonb_build_object('id',p.id,'display_name',p.display_name,'role',p.role,'active',p.active,'primary_area_id',p.primary_area_id,'updated_at',p.updated_at,'member_status',m.member_status,'team_area',m.team_area) order by p.display_name),'[]') from public.profiles p left join public.team_attendance_members m on m.student_id=p.id),
 'areas',(select coalesce(jsonb_agg(jsonb_build_object('id',id,'name',name,'active',active) order by name),'[]') from public.areas),
 'positions',(select coalesce(jsonb_agg(to_jsonb(p) order by p.name),'[]') from public.team_positions p),
 'assignments',(select coalesce(jsonb_agg(to_jsonb(p) order by p.assigned_at desc),'[]') from public.team_member_positions p),
 'history',(select coalesce(jsonb_agg(to_jsonb(h) order by h.id desc),'[]') from (select * from team_private.management_history order by id desc limit 100) h));
end $$;
create function public.team_manage(action text,p jsonb) returns void language plpgsql security definer set search_path='' as $$
declare pr public.profiles; old_member public.team_attendance_members; assignment public.team_member_positions;
 reason text:=trim(coalesce(p->>'reason','')); target uuid:=(p->>'user_id')::uuid; next_area uuid:=nullif(p->>'primary_area_id','')::uuid; before_json jsonb;
begin
 -- Share Inventory's profile guard lock, preventing concurrent last-admin removal.
 perform pg_advisory_xact_lock(4418);
 if not team_private.admin() then raise exception 'Active mentor or admin required' using errcode='42501'; end if;
 if length(reason) not between 1 and 2000 then raise exception 'Explain the change (up to 2000 characters)'; end if;
 if action='create_area' then
 if length(trim(coalesce(p->>'name',''))) not between 1 and 100 or coalesce(p->>'slug','') !~ '^[a-z0-9]+(-[a-z0-9]+)*$' then raise exception 'Area name and lowercase hyphenated key required'; end if;
 if length(p->>'slug')>100 then raise exception 'Area key is too long'; end if;
 insert into public.areas(name,slug) values(trim(p->>'name'),p->>'slug') returning id into next_area;
 insert into team_private.management_history(action,actor_id,reason,after_data) select action,auth.uid(),reason,jsonb_build_object('area_id',id,'name',name,'slug',slug) from public.areas where id=next_area;
 return;
 end if;
 select * into pr from public.profiles where id=target for update;
 if not found then raise exception 'Team member not found'; end if;
 if action='member' then
 if pr.updated_at is distinct from (p->>'expected_updated_at')::timestamptz then raise exception 'Member changed. Reload before saving.'; end if;
 if length(trim(coalesce(p->>'display_name',''))) not between 1 and 150 or coalesce(p->>'role','') not in ('student','lead','admin','mentor','readonly') or p->>'active' is null then raise exception 'Valid name, role and active status required'; end if;
 if next_area is not null and not exists(select 1 from public.areas where id=next_area and active) then raise exception 'Choose an active area'; end if;
 if pr.active and pr.role::text in ('admin','mentor') and (not (p->>'active')::boolean or p->>'role' not in ('admin','mentor')) and not exists(select 1 from public.profiles where id<>target and active and role::text in ('admin','mentor')) then raise exception 'Keep at least one active admin or mentor'; end if;
 select * into old_member from public.team_attendance_members where student_id=target for update;
 if old_member.member_status is distinct from p->>'expected_member_status' or old_member.team_area is distinct from p->>'expected_team_area' then raise exception 'Registration changed. Reload before saving.'; end if;
 if p->>'member_status' is not null and p->>'member_status' not in ('prospective','registered','inactive') then raise exception 'Invalid member status'; end if;
 before_json:=jsonb_build_object('profile',to_jsonb(pr),'membership',to_jsonb(old_member));
 update public.profiles set display_name=trim(p->>'display_name'),role=p->>'role',active=(p->>'active')::boolean,primary_area_id=next_area,updated_at=clock_timestamp() where id=target;
 -- Keep the existing Attendance roster's area label compatible. Past snapshots are untouched.
 if p->>'member_status' is not null or old_member.student_id is not null then
 insert into public.team_attendance_members(student_id,member_status,team_area) values(target,coalesce(p->>'member_status',old_member.member_status),coalesce((select name from public.areas where id=next_area),''))
 on conflict(student_id) do update set member_status=excluded.member_status,team_area=excluded.team_area;
 end if;
 insert into team_private.management_history(user_id,action,actor_id,reason,before_data,after_data)
 select target,action,auth.uid(),reason,before_json,jsonb_build_object('profile',to_jsonb(n),'membership',(select to_jsonb(m) from public.team_attendance_members m where student_id=target)) from public.profiles n where id=target;
 elsif action='assign_position' then
 if not pr.active or pr.role::text not in ('student','lead','admin','mentor') then raise exception 'Choose an active student or leadership account'; end if;
 if not exists(select 1 from public.team_positions where key=p->>'position_key' and active) then raise exception 'Choose an active position'; end if;
 insert into public.team_member_positions(user_id,position_key,assigned_by,assignment_reason) values(target,p->>'position_key',auth.uid(),reason) returning * into assignment;
 insert into team_private.management_history(user_id,action,actor_id,reason,after_data) values(target,action,auth.uid(),reason,to_jsonb(assignment));
 elsif action='revoke_position' then
 select * into assignment from public.team_member_positions where id=(p->>'assignment_id')::uuid and user_id=target and revoked_at is null for update;
 if not found then raise exception 'Active assignment not found. Reload.'; end if;
 update public.team_member_positions set revoked_by=auth.uid(),revoked_at=clock_timestamp(),revoke_reason=reason where id=assignment.id;
 insert into team_private.management_history(user_id,action,actor_id,reason,before_data,after_data) select target,action,auth.uid(),reason,to_jsonb(assignment),to_jsonb(n) from public.team_member_positions n where id=assignment.id;
 else raise exception 'Unknown team management action'; end if;
end $$;
-- Suite profile edits now use the audited RPC, preserving existing SELECT policies/guards.
revoke update on public.profiles from public,anon,authenticated;
revoke all on all functions in schema team_private from public,anon,authenticated;
grant execute on function team_private.admin() to authenticated;
revoke all on function public.team_my_positions(),public.team_has_any_position(text[]),public.team_has_position(text),public.team_management_context(),public.team_manage(text,jsonb) from public,anon,authenticated;
grant execute on function public.team_my_positions(),public.team_has_any_position(text[]),public.team_has_position(text),public.team_management_context(),public.team_manage(text,jsonb) to authenticated;
-- Retain the persisted slot keys and all prior decisions; change only FUTURE authorization.
-- Legacy finance_approver/po_approver assignments are not guessed into team positions.
create or replace function finance_private.cap(c text) returns boolean language sql stable security definer set search_path='' as $$
 select case c when 'finance_approver' then public.team_has_position('finance_lead')
 when 'po_approver' then public.team_has_any_position(array['lead_coach_1','lead_coach_2'])
 else coalesce(finance_private.role() in ('student','lead','admin','mentor'),false) and exists(select 1 from public.finance_assignments where user_id=auth.uid() and capability=c and active) end
$$;
create or replace function public.finance_context() returns jsonb language plpgsql security definer set search_path='' as $$
begin
 if finance_private.role() is null then raise exception 'Active team account required' using errcode='42501'; end if;
 return jsonb_build_object('profile',(select jsonb_build_object('id',id,'display_name',display_name,'role',role) from public.profiles where id=auth.uid()),
 'can_create',finance_private.creator(),'is_admin',finance_private.admin(),
 'capabilities',(select coalesce(jsonb_agg(c),'[]') from unnest(array['finance_approver','po_approver','school_submitter','finance_admin']) c where finance_private.cap(c)),
 'areas',(select coalesce(jsonb_agg(jsonb_build_object('id',id,'name',name,'active',active) order by name),'[]') from public.areas),
 'people',(select coalesce(jsonb_agg(jsonb_build_object('id',pr.id,'name',pr.display_name) order by pr.display_name),'[]') from public.profiles pr
 where (finance_private.admin() and pr.active) or pr.id=auth.uid() or exists(select 1 from public.finance_purchase_orders p where finance_private.visible(p.id) and p.requester_id=pr.id)
 or exists(select 1 from finance_private.history h where h.actor_id=pr.id and finance_private.visible(h.po_id))));
end $$;
create or replace function public.finance_mutate(action text,p jsonb) returns uuid language plpgsql security definer set search_path='' as $$
declare po public.finance_purchase_orders; previous jsonb; pid uuid; slot text:=p->>'slot'; reason text:=trim(coalesce(p->>'reason','')); override_note text:=trim(coalesce(p->>'override_reason','')); caps boolean;
begin
 if finance_private.role() is null then raise exception 'Active team account required' using errcode='42501'; end if;
 if length(reason)>2000 or length(override_note)>2000 then raise exception 'Explanations must be at most 2000 characters'; end if;
 if action='assignment' then
 if p->>'capability' is null or p->>'capability' not in ('school_submitter','finance_admin') then raise exception 'Manage Lead Coach and Finance Lead positions in Team Hub'; end if;
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
 -- Emergency exception: an active mentor/admin may replace ONE position-based
 -- approver (including on their own PO) only with an explicit override reason.
 -- The same actor can NEVER approve both slots, including through overrides.
 caps:=finance_private.cap(slot);
 if (not caps or po.requester_id=auth.uid()) and not (finance_private.role() in ('admin','mentor') and override_note<>'') then raise exception 'Configured approver required; administrators must give an explicit override reason' using errcode='42501'; end if;
 if override_note<>'' and finance_private.role() not in ('admin','mentor') then raise exception 'Only mentors and admins can override' using errcode='42501'; end if;
 if action='request_changes' and reason='' then raise exception 'Explain the requested changes'; end if;
 if action='approve' and exists(select 1 from public.finance_po_approvals a where a.po_id=pid and a.revision=po.revision and a.action='approved' and a.actor_id=auth.uid()) then raise exception 'Two distinct people must approve each revision'; end if;
 insert into public.finance_po_approvals(po_id,revision,slot,action,actor_id,explanation,override_reason)
 values(pid,po.revision,slot,case when action='approve' then 'approved' else 'changes_requested' end,auth.uid(),reason,override_note);
 update public.finance_purchase_orders set status=case when action='request_changes' then 'changes_requested'
 when finance_private.revision_approved(pid,po.revision) then 'approved' else 'awaiting_approval' end where id=pid;
 elsif action='school_submit' then
 if not (finance_private.cap('school_submitter') or finance_private.role() in ('admin','mentor')) then raise exception 'School submission capability required' using errcode='42501'; end if;
 if po.status<>'approved' or not finance_private.revision_approved(pid,po.revision) then raise exception 'Both current-revision approvals are required'; end if;
 update public.finance_purchase_orders set status='submitted_to_school',school_submitted_by=auth.uid(),school_submitted_at=clock_timestamp(),school_reference=trim(coalesce(p->>'reference','')),school_note=trim(coalesce(p->>'note','')) where id=pid;
 else raise exception 'Unknown Finance action'; end if;
 update public.finance_purchase_orders set version=version+1,updated_at=clock_timestamp() where id=pid;
 insert into finance_private.history(po_id,revision,action,actor_id,details)
 select pid,revision,action,auth.uid(),jsonb_build_object('reason',reason,'slot',slot,'override_reason',override_note,'self_approval_override',action='approve' and po.requester_id=auth.uid(),'before',previous,'after',to_jsonb(n)) from public.finance_purchase_orders n where id=pid;
 return pid;
end $$;

commit;
