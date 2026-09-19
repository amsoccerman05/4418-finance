-- Prospective only. Existing authoritative history/queue/approval rules remain intact.
begin;
CREATE OR REPLACE FUNCTION notifications_private.enqueue(h finance_private.history)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare n jsonb:=h.details->'after'; kind text; positions text[]:='{}'; recipients uuid[]:='{}'; approvers uuid[]:='{}'; r uuid; body jsonb; requester uuid; explicit_count integer;
begin
 if h.po_id is null or n is null then return; end if;
 requester:=(n->>'requester_id')::uuid;
 if h.action='submit' then kind:='approval_needed';positions:=array['lead_coach_1','lead_coach_2','finance_lead'];
 elsif h.action='request_changes' then kind:='changes_requested';recipients:=array[requester];
 elsif h.action='school_submit' then
  kind:='submitted_to_school';
  select array[requester]||coalesce(array_agg(distinct a.actor_id),'{}') into recipients from public.finance_po_approvals a where a.po_id=h.po_id and a.revision=h.revision and a.action='approved';
 elsif h.action='cancel' then
  kind:='cancelled';recipients:=array[requester];
  if h.revision>0 then
   positions:=array['lead_coach_1','lead_coach_2','finance_lead'];
   select recipients||coalesce(array_agg(distinct a.actor_id),'{}') into recipients from public.finance_po_approvals a where a.po_id=h.po_id and a.revision=h.revision;
  end if;
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
  kind:='approval_recorded';recipients:=array[requester];
  if h.details->>'slot'='po_approver' then positions:=array['finance_lead'];
  elsif h.details->>'slot'='finance_approver' then positions:=array['lead_coach_1','lead_coach_2'];
  else return;end if;
 else return;end if;
 if h.action='approve' and n->>'status'='approved' then recipients:=recipients||array[requester];end if;
 if cardinality(positions)>0 then
  select coalesce(array_agg(distinct mp.user_id),'{}') into approvers
  from public.team_member_positions mp join public.team_positions pos on pos.key=mp.position_key and pos.active
  join public.profiles p on p.id=mp.user_id and p.active and p.role::text in ('student','lead','admin','mentor')
  where mp.revoked_at is null and mp.position_key=any(positions) and mp.user_id<>requester
  -- A person who already approved cannot fill the other slot.
  and (h.action='cancel' or not exists(select 1 from public.finance_po_approvals a where a.po_id=h.po_id and a.revision=h.revision and a.action='approved' and a.actor_id=mp.user_id));
  recipients:=recipients||approvers;
 end if;
 body:=jsonb_build_object('po_number',n->'po_number','vendor',n->>'vendor','amount',n->'amount',
 'revision',h.revision,'action',h.action,'slot',h.details->>'slot','resubmitted',h.action='submit' and h.revision>1,'purpose',left(n->>'purpose',350),
 'requester',(select display_name from public.profiles where id=requester),
 'area',(select name from public.areas where id=(n->>'area_id')::uuid),
 'actor',(select display_name from public.profiles where id=h.actor_id),
 'explanation',h.details->>'reason','submitted_at',n->>'school_submitted_at','reference',n->>'school_reference');
 for r in select distinct unnest(recipients) loop
  if r<>h.actor_id and exists(select 1 from public.profiles where id=r and active and role::text in ('student','lead','admin','mentor')) then
   insert into public.team_notifications(source_event_id,event,recipient_id,entity_id,payload)
   values(h.id,kind,r,h.po_id,body) on conflict do nothing;
  end if;
 end loop;
end $function$
;
commit;
