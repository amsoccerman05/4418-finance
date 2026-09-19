-- MANUAL ONLY: after hardened Finance V1 and Team Management positions.
-- No email network calls occur in a PO transaction. No existing rows are backfilled.
begin;
do $$ begin
 perform id,details from finance_private.history limit 1;
 perform position_key from public.team_member_positions limit 1;
end $$;
create schema notifications_private;
revoke all on schema notifications_private from public,anon,authenticated;
create table public.team_notifications (
 id uuid primary key default gen_random_uuid(),
 source text not null default 'finance', source_event_id bigint not null references finance_private.history(id),
 event text not null, recipient_id uuid not null references public.profiles(id),
 entity_type text not null default 'finance_po', entity_id uuid not null references public.finance_purchase_orders(id),
 payload jsonb not null, created_at timestamptz not null default now(), read_at timestamptz,
 channel text not null default 'email' check(channel in ('email','slack','in_app')),
 status text not null default 'pending' check(status in ('pending','sending','sent','failed','skipped','review')),
 attempts integer not null default 0, next_attempt_at timestamptz not null default now(),
 first_attempt_at timestamptz, lease_until timestamptz, lease_token uuid,
 provider_request jsonb, provider_id text, sent_at timestamptz, last_error text,
 constraint team_notifications_sent_timestamp check(status<>'sent' or sent_at is not null),
 unique(source,source_event_id,recipient_id,channel)
);
alter table public.team_notifications enable row level security;
revoke all on public.team_notifications from public,anon,authenticated;
-- Server-only storage, including frozen email address/body. Future in-app access
-- must use a safe projection; never expose delivery internals to browser clients.
create index team_notifications_pending on public.team_notifications(next_attempt_at) where status in ('pending','sending');
create function notifications_private.enqueue(h finance_private.history) returns void
language plpgsql security definer set search_path='' as $$
declare n jsonb:=h.details->'after'; kind text; positions text[]:='{}'; recipients uuid[]:='{}'; r uuid; body jsonb; requester uuid; explicit_count integer;
begin
 if h.po_id is null or n is null then return; end if;
 requester:=(n->>'requester_id')::uuid;
 if h.action='submit' then kind:='approval_needed';positions:=array['lead_coach_1','lead_coach_2','finance_lead'];
 elsif h.action='request_changes' then kind:='changes_requested';recipients:=array[requester];
 elsif h.action='school_submit' then kind:='submitted_to_school';recipients:=array[requester];
 elsif h.action='approve' and n->>'status'='approved' then
  kind:='ready_for_school';
  select coalesce(array_agg(distinct a.user_id),'{}'),count(*) into recipients,explicit_count
  from public.finance_assignments a join public.profiles p on p.id=a.user_id
  where a.capability='school_submitter' and a.active and p.active and p.role::text in ('student','lead','admin','mentor');
  if explicit_count=0 then
   select coalesce(array_agg(id),'{}') into recipients from public.profiles where active and role::text in ('admin','mentor');
   -- Existing Finance authorization allows these roles, but avoid broad blasts.
   if cardinality(recipients)>5 then recipients:='{}';raise warning 'Finance notification requires explicit school submitter assignments';end if;
  end if;
 elsif h.action='approve' and n->>'status'='awaiting_approval' then
  kind:='approval_remaining';
  if h.details->>'slot'='po_approver' then positions:=array['finance_lead'];
  elsif h.details->>'slot'='finance_approver' then positions:=array['lead_coach_1','lead_coach_2'];
  else return;end if;
 else return;end if;
 if cardinality(positions)>0 then
  select coalesce(array_agg(distinct mp.user_id),'{}') into recipients
  from public.team_member_positions mp join public.team_positions pos on pos.key=mp.position_key and pos.active
  join public.profiles p on p.id=mp.user_id and p.active and p.role::text in ('student','lead','admin','mentor')
  where mp.revoked_at is null and mp.position_key=any(positions) and mp.user_id<>requester
  -- A person who already approved cannot fill the other slot.
  and not exists(select 1 from public.finance_po_approvals a where a.po_id=h.po_id and a.revision=h.revision and a.action='approved' and a.actor_id=mp.user_id);
 end if;
 body:=jsonb_build_object('po_number',n->'po_number','vendor',n->>'vendor','amount',n->'amount',
 'revision',h.revision,'purpose',left(n->>'purpose',350),
 'requester',(select display_name from public.profiles where id=requester),
 'area',(select name from public.areas where id=(n->>'area_id')::uuid),
 'actor',(select display_name from public.profiles where id=h.actor_id),
 'explanation',h.details->>'reason','submitted_at',n->>'school_submitted_at','reference',n->>'school_reference');
 foreach r in array recipients loop
  if exists(select 1 from public.profiles where id=r and active and role::text in ('student','lead','admin','mentor')) then
   insert into public.team_notifications(source_event_id,event,recipient_id,entity_id,payload)
   values(h.id,kind,r,h.po_id,body) on conflict do nothing;
  end if;
 end loop;
end $$;
create function notifications_private.on_finance_history() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 perform notifications_private.enqueue(new);return new;
end $$;
create trigger finance_notification_outbox after insert on finance_private.history
 for each row execute function notifications_private.on_finance_history();
-- Explicit server-only repair/backfill for a reviewed history event, idempotent.
create function public.team_notification_enqueue_history(history_id bigint) returns void
language plpgsql security definer set search_path='' as $$
declare h finance_private.history;
begin select * into h from finance_private.history where id=history_id;
 if not found then raise exception 'History event not found';end if;
 perform notifications_private.enqueue(h);
end $$;
create function public.team_notification_claim(batch_size integer default 3) returns setof public.team_notifications
language plpgsql security definer set search_path='' as $$
begin
 -- Never retry an uncertain send outside Resend's 24-hour idempotency window.
 update public.team_notifications set status='review',last_error='Retry window or attempt limit reached',lease_token=null,lease_until=null
 where status in ('pending','sending') and (lease_until is null or lease_until<now())
 and (attempts>=5 or first_attempt_at<now()-interval '23 hours');
 update public.team_notifications n set status='skipped',last_error='Recipient no longer active',lease_token=null,lease_until=null
 where n.status in ('pending','sending') and (n.lease_until is null or n.lease_until<now())
 and not exists(select 1 from public.profiles p where p.id=n.recipient_id and p.active and p.role::text in ('student','lead','admin','mentor'));
 return query with candidates as (
 select id from public.team_notifications where
 ((status='pending' and next_attempt_at<=now()) or (status='sending' and lease_until<now()))
 order by created_at,id for update skip locked limit greatest(1,least(coalesce(batch_size,3),3))
 ) update public.team_notifications n set status='sending',attempts=attempts+1,
 first_attempt_at=coalesce(first_attempt_at,now()),lease_until=now()+interval '3 minutes',lease_token=gen_random_uuid()
 from candidates c where n.id=c.id returning n.*;
end $$;
create function public.team_notification_prepare(notification_id uuid,token uuid,request_body jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare result jsonb;
begin
 update public.team_notifications set provider_request=coalesce(provider_request,request_body)
 where id=notification_id and lease_token=token and status='sending' and lease_until>now()
 returning provider_request into result;
 if not found then raise exception 'Delivery lease expired';end if;return result;
end $$;
create function public.team_notification_finish(notification_id uuid,token uuid,outcome text,error_code text default null,provider_message_id text default null) returns void
language plpgsql security definer set search_path='' as $$
begin
 if outcome not in ('sent','retry','failed','skipped') then raise exception 'Invalid delivery outcome';end if;
 update public.team_notifications set status=case when outcome='retry' then case when attempts>=5 then 'review' else 'pending' end else outcome end,
 next_attempt_at=now()+make_interval(mins=>5*power(2,least(attempts,5)-1)::integer),
 last_error=left(error_code,200),provider_id=coalesce(provider_message_id,provider_id),
 sent_at=case when outcome='sent' then now() else sent_at end,lease_token=null,lease_until=null
 where id=notification_id and lease_token=token and status='sending';
end $$;
revoke all on all functions in schema notifications_private from public,anon,authenticated;
revoke all on function public.team_notification_enqueue_history(bigint),public.team_notification_claim(integer),public.team_notification_prepare(uuid,uuid,jsonb),public.team_notification_finish(uuid,uuid,text,text,text) from public,anon,authenticated;
grant execute on function public.team_notification_enqueue_history(bigint),public.team_notification_claim(integer),public.team_notification_prepare(uuid,uuid,jsonb),public.team_notification_finish(uuid,uuid,text,text,text) to service_role;
commit;
