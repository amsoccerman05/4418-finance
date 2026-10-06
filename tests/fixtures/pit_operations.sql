-- Run manually in the EXISTING Inventory Supabase project. Does not change Inventory objects.
begin;
-- Fail before creating anything if the shared profile contract differs.
do $$ begin
 if not exists(select 1 from information_schema.columns where table_schema='public' and table_name='profiles' and column_name='active') then
 raise exception 'Existing public.profiles(id, display_name, role, active) required. Review the Inventory profile schema first.'; end if;
 perform id,display_name,role,active from public.profiles limit 1;
end $$;
create schema pit_private;
revoke all on schema pit_private from public;
grant usage on schema pit_private to authenticated;
create function pit_private.current_role() returns text language sql stable security definer set search_path='' as $$
 select role::text from public.profiles where id=(select auth.uid()) and active
$$;
create function pit_private.require_role(allowed text[]) returns void language plpgsql security definer set search_path='' as $$
begin if not coalesce(pit_private.current_role()=any(allowed),false) then raise exception 'Insufficient Pit Operations permissions' using errcode='42501'; end if; end $$;
create table public.pit_events(
 id uuid primary key default gen_random_uuid(), name text not null check(length(trim(name)) between 1 and 150),location text not null default '',
 start_date date not null,end_date date not null check(end_date>=start_date),status text not null default 'upcoming' check(status in('upcoming','active','completed')),
 notes text not null default '',created_by uuid references public.profiles(id),created_at timestamptz not null default now(),updated_at timestamptz not null default now()
);
create unique index pit_one_active_event on public.pit_events(status) where status='active';
create table public.pit_batteries(
 id uuid primary key default gen_random_uuid(),battery_number text not null unique check(battery_number ~ '^B[0-9]{2,4}$'),label text not null default '',
 status text not null default 'TESTING' check(status in('READY','ON ROBOT','COOLING','CHARGING','TESTING','FLAGGED','RETIRED')),
 notes text not null default '',active boolean not null default true,created_at timestamptz not null default now(),updated_at timestamptz not null default now()
);
create unique index pit_one_robot_battery on public.pit_batteries(status) where status='ON ROBOT';
create table public.pit_issues(
 id uuid primary key default gen_random_uuid(),issue_number bigint generated always as identity unique,
 event_id uuid not null references public.pit_events(id),title text not null check(length(trim(title)) between 1 and 150),
 subsystem text not null check(subsystem in('Drivetrain','Intake','Shooter','Climber','Electrical','Software','Controls','Structure','Pneumatics','Other')),
 severity text not null check(severity in('LOW','MEDIUM','HIGH','ROBOT DOWN')),
 status text not null default 'OPEN' check(status in('OPEN','DIAGNOSING','REPAIRING','TESTING','RESOLVED','DEFERRED')),
 description text not null check(length(trim(description)) between 1 and 10000),reported_by uuid not null references public.profiles(id),assigned_to uuid references public.profiles(id),
 discovered_match text not null default '',root_cause text not null default '',repair_notes text not null default '',resolution_notes text not null default '',
 resolved_by uuid references public.profiles(id),resolved_at timestamptz,battery_id uuid references public.pit_batteries(id),
 created_at timestamptz not null default now(),updated_at timestamptz not null default now()
);
create table public.pit_issue_events(
 id uuid primary key default gen_random_uuid(),issue_id uuid not null references public.pit_issues(id),performed_by uuid not null references public.profiles(id),
 changes jsonb not null,created_at timestamptz not null default now()
);
create table public.pit_battery_events(
 id uuid primary key default gen_random_uuid(),battery_id uuid not null references public.pit_batteries(id),event_id uuid references public.pit_events(id),
 event_type text not null check(event_type in('created','status_changed','measurement','issue_linked','metadata_updated')),
 from_status text,to_status text,voltage numeric check(voltage>=0 and voltage<=20),voltage_kind text check(voltage_kind in('pre-match','post-match')),
 match_number text not null default '',issue_id uuid references public.pit_issues(id),notes text not null default '',performed_by uuid not null references public.profiles(id),created_at timestamptz not null default now(),
 check((voltage is null and voltage_kind is null) or (voltage is not null and voltage_kind is not null))
);
create index pit_issues_event_status on public.pit_issues(event_id,status);
create index pit_issues_battery on public.pit_issues(battery_id);
create index pit_issue_history on public.pit_issue_events(issue_id,created_at desc);
create index pit_battery_history on public.pit_battery_events(battery_id,created_at desc);
create index pit_battery_event_context on public.pit_battery_events(event_id,created_at desc);
-- Clients have read-only table privileges. All writes use role-checked transactional RPCs below.
-- This prevents direct writes, fabricated history/actors, and student metadata edits.
do $$ declare t text; begin
 foreach t in array array['pit_events','pit_issues','pit_batteries','pit_issue_events','pit_battery_events'] loop
 execute format('alter table public.%I enable row level security',t);
 execute format('revoke all on public.%I from anon, authenticated',t);
 execute format('grant select on public.%I to authenticated',t);
 execute format('create policy pit_member_read on public.%I for select to authenticated using ((select pit_private.current_role()) in (''readonly'',''student'',''lead'',''admin'',''mentor''))',t);
 end loop;
end $$;
create function public.pit_report_issue(p jsonb) returns uuid language plpgsql security definer set search_path='' as $$
declare v_id uuid; v_event uuid:=(p->>'event_id')::uuid; v_battery uuid:=nullif(p->>'battery_id','')::uuid;
begin
 perform pit_private.require_role(array['student','lead','admin','mentor']);
 perform 1 from public.pit_events where id=v_event and status='active' for share;
 if not found then raise exception 'Select the active event before reporting an issue'; end if;
 if v_battery is not null and not exists(select 1 from public.pit_batteries where id=v_battery and active) then raise exception 'Battery is unavailable'; end if;
 insert into public.pit_issues(event_id,title,subsystem,severity,description,reported_by,discovered_match,battery_id)
 values(v_event,left(trim(p->>'description'),100),p->>'subsystem',p->>'severity',trim(p->>'description'),auth.uid(),coalesce(p->>'discovered_match',''),v_battery) returning id into v_id;
 insert into public.pit_issue_events(issue_id,performed_by,changes) values(v_id,auth.uid(),jsonb_build_object('status',jsonb_build_object('from',null,'to','OPEN')));
 if v_battery is not null then insert into public.pit_battery_events(battery_id,event_id,event_type,issue_id,performed_by) values(v_battery,v_event,'issue_linked',v_id,auth.uid()); end if;
 return v_id;
end $$;
create function public.pit_update_issue(p jsonb) returns void language plpgsql security definer set search_path='' as $$
declare old_row public.pit_issues; new_row public.pit_issues; changes jsonb:='{}'; k text;
begin
 perform pit_private.require_role(array['lead','admin','mentor']);
 select * into old_row from public.pit_issues where id=(p->>'id')::uuid for update;
 if not found then raise exception 'Issue not found'; end if;
 if old_row.updated_at is distinct from (p->>'expected_updated_at')::timestamptz then raise exception 'This issue changed on another device. Close and reopen it before saving.'; end if;
 if nullif(p->>'assigned_to','') is not null and not exists(select 1 from public.profiles where id=(p->>'assigned_to')::uuid and active) then raise exception 'Assignee must be an active team member'; end if;
 update public.pit_issues set title=coalesce(p->>'title',title),severity=coalesce(p->>'severity',severity),status=coalesce(p->>'status',status),
 assigned_to=case when p?'assigned_to' then nullif(p->>'assigned_to','')::uuid else assigned_to end,
 battery_id=case when p?'battery_id' then nullif(p->>'battery_id','')::uuid else battery_id end,
 root_cause=coalesce(p->>'root_cause',root_cause),repair_notes=coalesce(p->>'repair_notes',repair_notes),resolution_notes=coalesce(p->>'resolution_notes',resolution_notes),
 resolved_at=case when coalesce(p->>'status',status)='RESOLVED' then coalesce(resolved_at,clock_timestamp()) else null end,
 resolved_by=case when coalesce(p->>'status',status)='RESOLVED' then coalesce(resolved_by,auth.uid()) else null end,updated_at=clock_timestamp()
 where id=old_row.id returning * into new_row;
 foreach k in array array['title','severity','status','assigned_to','battery_id','root_cause','repair_notes','resolution_notes'] loop
 if (to_jsonb(old_row)->k) is distinct from (to_jsonb(new_row)->k) then changes:=changes||jsonb_build_object(k,jsonb_build_object('from',to_jsonb(old_row)->k,'to',to_jsonb(new_row)->k)); end if;
 end loop;
 if changes<>'{}' then insert into public.pit_issue_events(issue_id,performed_by,changes) values(old_row.id,auth.uid(),changes); end if;
 if new_row.battery_id is not null and new_row.battery_id is distinct from old_row.battery_id then
 insert into public.pit_battery_events(battery_id,event_id,event_type,issue_id,performed_by) values(new_row.battery_id,new_row.event_id,'issue_linked',new_row.id,auth.uid()); end if;
end $$;
create function public.pit_transition_battery(p jsonb) returns void language plpgsql security definer set search_path='' as $$
declare b public.pit_batteries; target text:=p->>'status'; v_event uuid:=nullif(p->>'event_id','')::uuid; v_voltage numeric:=nullif(p->>'voltage','')::numeric;
begin
 perform pit_private.require_role(array['student','lead','admin','mentor']);
 -- Serialize installs so another device cannot silently replace the current battery.
 perform pg_advisory_xact_lock(4418,1);
 select * into b from public.pit_batteries where id=(p->>'id')::uuid for update;
 if not found then raise exception 'Battery not found'; end if;
 if b.status is distinct from p->>'expected_status' then raise exception 'Battery status changed. Refresh and try again.'; end if;
 if not b.active then raise exception 'Reactivate this battery before changing its status'; end if;
 if b.status='RETIRED' or target='RETIRED' then perform pit_private.require_role(array['admin','mentor']); end if;
 if b.status='FLAGGED' and target<>'FLAGGED' then perform pit_private.require_role(array['lead','admin','mentor']); end if;
 if target='ON ROBOT' and exists(select 1 from public.pit_batteries where status='ON ROBOT' and id<>b.id) then raise exception 'Remove the current battery before installing another.'; end if;
 if v_event is not null then
 perform 1 from public.pit_events where id=v_event and status='active' for share;
 if not found then raise exception 'Event changed. Refresh and try again.'; end if; end if;
 update public.pit_batteries set status=target,updated_at=clock_timestamp() where id=b.id;
 insert into public.pit_battery_events(battery_id,event_id,event_type,from_status,to_status,voltage,voltage_kind,match_number,notes,performed_by)
 values(b.id,v_event,case when target=b.status then 'measurement' else 'status_changed' end,b.status,target,v_voltage,case when v_voltage is null then null else p->>'voltage_kind' end,coalesce(p->>'match_number',''),coalesce(p->>'notes',''),auth.uid());
end $$;
create function public.pit_save_battery(p jsonb) returns uuid language plpgsql security definer set search_path='' as $$
declare v_id uuid:=nullif(p->>'id','')::uuid; b public.pit_batteries;
begin
 perform pit_private.require_role(array['admin','mentor']);
 if v_id is null then
 insert into public.pit_batteries(battery_number,label,notes) values(upper(trim(p->>'battery_number')),coalesce(p->>'label',''),coalesce(p->>'notes','')) returning id into v_id;
 insert into public.pit_battery_events(battery_id,event_type,to_status,performed_by) values(v_id,'created','TESTING',auth.uid());
 else
 select * into b from public.pit_batteries where id=v_id for update;
 if not found then raise exception 'Battery not found'; end if;
 if p->>'active'='false' and b.status<>'RETIRED' then raise exception 'Retire the battery before archiving it'; end if;
 update public.pit_batteries set battery_number=upper(trim(p->>'battery_number')),label=coalesce(p->>'label',''),notes=coalesce(p->>'notes',''),active=coalesce((p->>'active')::boolean,active),updated_at=clock_timestamp() where id=v_id;
 insert into public.pit_battery_events(battery_id,event_type,notes,performed_by) values(v_id,'metadata_updated','Battery details updated',auth.uid());
 end if;return v_id;
end $$;
create function public.pit_save_event(p jsonb) returns uuid language plpgsql security definer set search_path='' as $$
declare v_id uuid:=nullif(p->>'id','')::uuid;
begin
 perform pit_private.require_role(array['admin','mentor']);
 if v_id is null then
 insert into public.pit_events(name,location,start_date,end_date,notes,created_by) values(trim(p->>'name'),coalesce(p->>'location',''),(p->>'start_date')::date,(p->>'end_date')::date,coalesce(p->>'notes',''),auth.uid()) returning id into v_id;
 else
 if p?'status' and p->>'status'<>'completed' then raise exception 'Use Activate event to change the active event'; end if;
 update public.pit_events set name=trim(p->>'name'),location=coalesce(p->>'location',''),start_date=(p->>'start_date')::date,end_date=(p->>'end_date')::date,notes=coalesce(p->>'notes',''),status=coalesce(p->>'status',status),updated_at=clock_timestamp() where id=v_id;
 if not found then raise exception 'Event not found'; end if;
 end if; return v_id;
end $$;
create function public.pit_activate_event(p jsonb) returns void language plpgsql security definer set search_path='' as $$
begin
 perform pit_private.require_role(array['admin','mentor']);
 perform pg_advisory_xact_lock(4418,2);
 if not exists(select 1 from public.pit_events where id=(p->>'id')::uuid) then raise exception 'Event not found'; end if;
 update public.pit_events set status='completed',updated_at=clock_timestamp() where status='active' and id<>(p->>'id')::uuid;
 update public.pit_events set status='active',updated_at=clock_timestamp() where id=(p->>'id')::uuid;
end $$;
-- Functions default to PUBLIC execute in PostgreSQL: explicitly close that access.
revoke all on all functions in schema pit_private from public,anon,authenticated;
grant execute on function pit_private.current_role() to authenticated;
do $$ declare f text; t text; begin
 foreach f in array array['pit_report_issue','pit_update_issue','pit_transition_battery','pit_save_battery','pit_save_event','pit_activate_event'] loop
 execute format('revoke all on function public.%I(jsonb) from public, anon, authenticated',f);
 execute format('grant execute on function public.%I(jsonb) to authenticated',f);
 end loop;
 if exists(select 1 from pg_publication where pubname='supabase_realtime') then
 foreach t in array array['pit_events','pit_issues','pit_batteries','pit_battery_events','pit_issue_events'] loop
 if not exists(select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename=t) then execute format('alter publication supabase_realtime add table public.%I',t); end if;
 end loop;end if;
end $$;
commit;
