-- Additive coordinated role batch. Requires Hub 20261028160322_student_admin_lead_roles.sql.
-- No data/backfill/assignment conversion or table/policy grants. Existing ACLs preserved.
begin;
do $$ begin
 if not exists(select 1 from pg_constraint where conrelid='public.profiles'::regclass and conname='profiles_role_check' and pg_get_constraintdef(oid) like '%admin_lead%') or (select md5(prosrc) from pg_proc where oid='public.team_my_positions()'::regprocedure) is distinct from '3a7116cddaf8fadd8ab9cb4447420392' then raise exception 'Apply the reviewed shared Admin Lead core before Finance';end if;
 if (select md5(prosrc) from pg_proc where oid='finance_private.cap(text)'::regprocedure) is distinct from '1f72da21f658f3ba83df5618daf9f979' then raise exception 'Unreviewed source drift: finance_private.cap(text)';end if;
 if (select md5(prosrc) from pg_proc where oid='finance_private.creator()'::regprocedure) is distinct from '58bee31ea3d061528d35eac4090e3b1a' then raise exception 'Unreviewed source drift: finance_private.creator()';end if;
 if (select md5(prosrc) from pg_proc where oid='finance_private.visible(uuid)'::regprocedure) is distinct from '2e3b77ce38c9bfcba3eb0596ec99df6a' then raise exception 'Unreviewed source drift: finance_private.visible(uuid)';end if;
 if (select md5(prosrc) from pg_proc where oid='finance_private.can_manage_budget()'::regprocedure) is distinct from 'e432fc68643876118558022660df7002' then raise exception 'Unreviewed source drift: finance_private.can_manage_budget()';end if;
 if (select md5(prosrc) from pg_proc where oid='public.finance_repair_context(uuid)'::regprocedure) is distinct from '0667aa536d9c4268c09b504a3f4ebcb1' then raise exception 'Unreviewed source drift: public.finance_repair_context(uuid)';end if;
 if (select md5(prosrc) from pg_proc where oid='public.finance_repair_po_candidate(uuid,uuid)'::regprocedure) is distinct from 'dc21e59ef52bd0c866119ee02ccf606c' then raise exception 'Unreviewed source drift: public.finance_repair_po_candidate(uuid,uuid)';end if;
 if (select md5(prosrc) from pg_proc where oid='public.finance_attach_repair_po(uuid,uuid,timestamp with time zone,text)'::regprocedure) is distinct from 'd0e609af4f24baa07826b2472ab0cfd8' then raise exception 'Unreviewed source drift: public.finance_attach_repair_po(uuid,uuid,timestamp with time zone,text)';end if;
 if (select md5(prosrc) from pg_proc where oid='public.finance_mutate(text,jsonb)'::regprocedure) is distinct from '5061061e4478f3ce4aa8616884aca5c5' then raise exception 'Unreviewed source drift: public.finance_mutate(text,jsonb)';end if;
 if (select md5(prosrc) from pg_proc where oid='public.finance_budget_context(uuid)'::regprocedure) is distinct from 'a507b2a1aae29e9accb1d228ec57bb83' then raise exception 'Unreviewed source drift: public.finance_budget_context(uuid)';end if;
 if (select md5(prosrc) from pg_proc where oid='public.finance_workbook_context(uuid)'::regprocedure) is distinct from '955fadbce9b5bc572228fa0d9fb272bb' then raise exception 'Unreviewed source drift: public.finance_workbook_context(uuid)';end if;
 if (select md5(prosrc) from pg_proc where oid='notifications_private.enqueue(finance_private.history)'::regprocedure) is distinct from 'da82f784759a997735ecad55794595ab' then raise exception 'Unreviewed source drift: notifications_private.enqueue(finance_private.history)';end if;
 if (select md5(prosrc) from pg_proc where oid='public.finance_notification_delivery_allowed(uuid,uuid)'::regprocedure) is distinct from '226dc0af86f3aa370b52b5270d8ee832' then raise exception 'Unreviewed source drift: public.finance_notification_delivery_allowed(uuid,uuid)';end if;
 if (select md5(prosrc) from pg_proc where oid='public.finance_budget_manage(text,jsonb)'::regprocedure) is distinct from '2d2fe4455981ed42fa8a58ba2adc92ff' then raise exception 'Unreviewed source drift: public.finance_budget_manage(text,jsonb)';end if;
 if (select md5(prosrc) from pg_proc where oid='public.finance_context()'::regprocedure) is distinct from '247d34c84d1fbad9843d6d3e4b1c5084' then raise exception 'Unreviewed source drift: public.finance_context()';end if;
 if (select md5(prosrc) from pg_proc where oid='finance_private.mutate_v1(text,jsonb)'::regprocedure) is distinct from '07967004825370950711b5ec4360649f' then raise exception 'Unreviewed source drift: finance_private.mutate_v1(text,jsonb)';end if;
 if (select md5(prosrc) from pg_proc where oid='finance_private.revision_approved(uuid,integer)'::regprocedure) is distinct from 'a3ac6fa2ba8f2b573067d032119818f0' then raise exception 'Unreviewed source drift: finance_private.revision_approved(uuid,integer)';end if;
end $$;

create function finance_private.coach_self_approval_context(pid uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare po public.finance_purchase_orders; f public.finance_po_approvals; paired uuid;
begin
 if auth.uid() is null or not coalesce(finance_private.role() in ('mentor','admin')
   and public.team_has_any_position(array['lead_coach_1','lead_coach_2']),false) then
  return jsonb_build_object('eligible',false,'allowed',false,'reason','');
 end if;
 select * into po from public.finance_purchase_orders where id=pid and requester_id=auth.uid();
 if not found or not finance_private.visible(pid) then
  return jsonb_build_object('eligible',false,'allowed',false,'reason','');
 end if;
 if po.status<>'awaiting_approval' or exists(select 1 from public.finance_po_approvals a
   where a.po_id=pid and a.revision=po.revision and (a.action='changes_requested' or a.slot='po_approver' or a.actor_id=auth.uid())) then
  return jsonb_build_object('eligible',true,'allowed',false,'reason','A different Finance Lead must approve the Finance step.');
 end if;
 select * into f from public.finance_po_approvals where po_id=pid and revision=po.revision
   and slot='finance_approver' and action='approved';
 if found then
  if f.actor_id=auth.uid() or not (
    exists(select 1 from finance_private.history h where h.po_id=pid and h.revision=po.revision and h.action='approve'
      and h.actor_id=f.actor_id and h.details->>'slot'=f.slot and h.details->>'approval_id'=f.id::text
      and h.details->>'approval_authority'='assigned_finance_lead')
    or (f.override_reason='' and not exists(select 1 from finance_private.history h
      where h.po_id=pid and h.revision=po.revision and h.details->>'approval_id'=f.id::text)
      and exists(select 1 from public.profiles pr join public.team_member_positions mp on mp.user_id=pr.id
        join public.team_positions pos on pos.key=mp.position_key and pos.active
        where pr.id=f.actor_id and pr.active and pr.role::text in ('student','lead','admin_lead','mentor','admin')
        and mp.revoked_at is null and mp.position_key='finance_lead'))
  ) then
   return jsonb_build_object('eligible',true,'allowed',false,'reason',
    'This revision has an earlier Finance override or unverified Finance assignment. Edit and resubmit before using your own Coach approval; a different assigned Finance Lead must approve the new revision.');
  end if;
  paired:=f.id;
 end if;
 return jsonb_build_object('eligible',true,'allowed',true,'reason','Approve only your Coach step. A different assigned Finance Lead must approve Finance.','paired_finance_approval_id',paired);
end $$;
revoke all on function finance_private.coach_self_approval_context(uuid) from public,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION finance_private.cap(c text)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
 select case c when 'finance_approver' then public.team_has_position('finance_lead')
 when 'po_approver' then public.team_has_any_position(array['lead_coach_1','lead_coach_2'])
 when 'school_submitter' then coalesce(finance_private.role()='admin_lead' or (finance_private.role() in ('student','lead','admin_lead','admin','mentor') and exists(select 1 from public.finance_assignments where user_id=auth.uid() and capability=c and active)),false)
 else coalesce(finance_private.role() in ('student','lead','admin_lead','admin','mentor'),false) and exists(select 1 from public.finance_assignments where user_id=auth.uid() and capability=c and active) end
$function$
;

CREATE OR REPLACE FUNCTION finance_private.creator()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select coalesce(
    finance_private.admin()
    or finance_private.role() in ('lead', 'admin_lead', 'student'),
    false
  )
$function$
;

CREATE OR REPLACE FUNCTION finance_private.visible(pid uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
 select finance_private.role() is not null and exists(select 1 from public.finance_purchase_orders p where p.id=pid and
 (p.requester_id=auth.uid() or finance_private.admin() or (p.status<>'draft' and
 (finance_private.cap('finance_approver') or finance_private.cap('po_approver') or finance_private.cap('school_submitter') or
 (finance_private.role() in ('lead','admin_lead') and p.area_id=(select primary_area_id from public.profiles where id=auth.uid()))))))
$function$
;

CREATE OR REPLACE FUNCTION finance_private.can_manage_budget()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
 select coalesce(finance_private.role() in ('mentor','admin') or (finance_private.role() in ('student','lead','admin_lead') and exists(
 select 1 from public.team_member_positions m join public.team_positions p on p.key=m.position_key and p.active
 join finance_private.budget_positions b on b.position_key=p.key where m.user_id=auth.uid() and m.revoked_at is null)),false)
$function$
;

CREATE OR REPLACE FUNCTION public.finance_repair_context(p_issue_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  issue_stamp timestamptz;
  pit_role text := pit_private.current_role();
begin
  if not coalesce(pit_role = any(array['readonly','student','lead','admin_lead','mentor','admin']), false) then
    raise exception 'Repair purchasing details unavailable' using errcode = '42501';
  end if;
  select i.updated_at into issue_stamp from public.pit_issues i where i.id = p_issue_id;
  if not found then
    raise exception 'Repair purchasing details unavailable' using errcode = '42501';
  end if;
  return jsonb_build_object(
    'issue_id', p_issue_id,
    'issue_updated_at', issue_stamp,
    'can_attach', pit_role = any(array['lead','admin_lead','mentor','admin']),
    'links', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'po_id', po.id, 'po_number', po.po_number, 'status', po.status,
        'requester_name', coalesce(nullif(trim(pr.display_name), ''), 'Team member'),
        'linked_at', l.linked_at
      ) order by l.linked_at, po.id), '[]'::jsonb)
      from finance_private.repair_po_links l
      join public.finance_purchase_orders po on po.id = l.po_id
      join public.profiles pr on pr.id = po.requester_id
      where l.issue_id = p_issue_id and finance_private.visible(po.id)
    )
  );
end $function$
;

CREATE OR REPLACE FUNCTION public.finance_repair_po_candidate(p_issue_id uuid, p_po_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  issue_stamp timestamptz;
  po public.finance_purchase_orders;
  requester_name text;
  pit_role text := pit_private.current_role();
begin
  if not coalesce(pit_role = any(array['readonly','student','lead','admin_lead','mentor','admin']), false) then
    raise exception 'Repair purchasing details unavailable' using errcode = '42501';
  end if;
  select i.updated_at into issue_stamp from public.pit_issues i where i.id = p_issue_id;
  if not found or not coalesce(finance_private.visible(p_po_id), false) then
    raise exception 'Repair purchasing details unavailable' using errcode = '42501';
  end if;
  select * into po from public.finance_purchase_orders where id = p_po_id;
  if not found then
    raise exception 'Repair purchasing details unavailable' using errcode = '42501';
  end if;
  select coalesce(nullif(trim(pr.display_name), ''), 'Team member') into requester_name
    from public.profiles pr where pr.id = po.requester_id;
  return jsonb_build_object(
    'issue_id', p_issue_id, 'issue_updated_at', issue_stamp,
    'po_id', po.id, 'po_number', po.po_number, 'status', po.status,
    'requester_name', requester_name,
    'can_attach', pit_role = any(array['lead','admin_lead','mentor','admin'])
      and (po.requester_id = auth.uid() or finance_private.admin())
  );
end $function$
;

CREATE OR REPLACE FUNCTION public.finance_attach_repair_po(p_issue_id uuid, p_po_id uuid, p_expected_issue_updated_at timestamp with time zone, p_reason text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  issue_stamp timestamptz;
  po public.finance_purchase_orders;
  why text := trim(coalesce(p_reason, ''));
begin
  if not coalesce(pit_private.current_role() = any(array['lead','admin_lead','mentor','admin']), false) then
    raise exception 'Repair purchasing details unavailable' using errcode = '42501';
  end if;
  -- Consistent lock order: repair first, then PO. The existing repair update RPC
  -- takes this same repair row lock, so a stale attachment cannot race its save.
  select i.updated_at into issue_stamp from public.pit_issues i where i.id = p_issue_id for update;
  if not found or not coalesce(finance_private.visible(p_po_id), false) then
    raise exception 'Repair purchasing details unavailable' using errcode = '42501';
  end if;
  select * into po from public.finance_purchase_orders where id = p_po_id for share;
  -- Either row lock can wait while another transaction revokes this caller's
  -- authority. Recheck every permission after both locks have been acquired;
  -- ownership alone must not let a newly downgraded repair reader attach.
  if not found
     or not coalesce(pit_private.current_role() = any(array['lead','admin_lead','mentor','admin']), false)
     or not coalesce(finance_private.visible(p_po_id), false)
     or not coalesce(po.requester_id = auth.uid() or finance_private.admin(), false) then
    raise exception 'Repair purchasing details unavailable' using errcode = '42501';
  end if;
  if length(why) not between 1 and 2000 or why !~ '[^[:space:]]' then
    raise exception 'An attachment reason of 1 to 2000 characters is required' using errcode = '22023';
  end if;
  if issue_stamp is distinct from p_expected_issue_updated_at then
    raise exception 'This repair changed. Refresh before attaching a purchase order.' using errcode = '40001';
  end if;
  insert into finance_private.repair_po_links(issue_id, po_id, linked_by, issue_updated_at, reason)
  values (p_issue_id, p_po_id, auth.uid(), issue_stamp, why)
  on conflict (issue_id, po_id) do nothing;
  -- A replay is a no-op: retain the original actor, reason and timestamp.
  -- No PO/approval/budget/repair/history/outbox records are written here.
  return public.finance_repair_context(p_issue_id);
end $function$
;

CREATE OR REPLACE FUNCTION public.finance_mutate(action text, p jsonb)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  po public.finance_purchase_orders;
  previous jsonb;
  pid uuid;
  sid uuid;
  note text:=trim(coalesce(p->>'note',''));
begin
  -- Same lock order as the installed budget workflow and season close.
  perform pg_advisory_xact_lock(4418,20);
  if finance_private.role() is null or finance_private.role()='readonly' then
    raise exception 'This account is read-only' using errcode='42501';
  end if;
  if action in ('create','assignment') then
    return finance_private.mutate_before_received(action,p);
  end if;
  pid:=(p->>'id')::uuid;
  if not finance_private.visible(pid) then
    raise exception 'Purchase order unavailable' using errcode='42501';
  end if;
  select * into po from public.finance_purchase_orders where id=pid for update;
  -- Recheck account/visibility after the lock wait, before accepting any receipt.
  if finance_private.role() is null or finance_private.role()='readonly' or not finance_private.visible(pid) then
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
end $function$
;

CREATE OR REPLACE FUNCTION public.finance_budget_context(season uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare s uuid:=season;
begin
 if not finance_private.can_manage_budget() then return jsonb_build_object('can_manage',false);end if;
 if s is null then select id into s from public.finance_seasons order by (status='active') desc,created_at desc limit 1;end if;
 return jsonb_build_object('can_manage',true,'can_classify',finance_private.role() in ('mentor','admin'),
 'seasons',(select coalesce(jsonb_agg(to_jsonb(b) order by created_at desc),'[]') from public.finance_seasons b),
 'summary',finance_private.budget_summary(s),
 'income',(select coalesce(jsonb_agg(to_jsonb(i) order by created_at desc),'[]') from public.finance_income i where season_id=s),
 'expenses',(select coalesce(jsonb_agg(to_jsonb(e) order by occurred_on desc),'[]') from public.finance_expenses e where season_id=s),
 'history',(select coalesce(jsonb_agg(to_jsonb(h) order by id desc),'[]') from (select h.*,p.display_name actor_name from finance_private.history h join public.profiles p on p.id=h.actor_id where (h.season_id=s or h.po_id in (select po_id from public.finance_po_budget where season_id=s) or (h.season_id is null and h.action='budget_classify_position' and finance_private.role() in ('mentor','admin'))) and (h.po_id is null or finance_private.visible(h.po_id)) order by id desc) h),
 'po_links',(select coalesce(jsonb_agg(to_jsonb(b)||jsonb_build_object('po_number',p.po_number,'vendor',p.vendor,'amount',p.amount,'status',p.status,'revision',p.revision,'area_id',p.area_id,'bucket',i.bucket)),'[]') from public.finance_po_budget b join public.finance_purchase_orders p on p.id=b.po_id join finance_private.po_impacts i on i.po_id=p.id where b.season_id=s and finance_private.visible(p.id)),
 'uncategorized',(select coalesce(jsonb_agg(jsonb_build_object('po_id',p.id,'po_number',p.po_number,'vendor',p.vendor,'amount',p.amount,'status',p.status)),'[]') from public.finance_purchase_orders p where finance_private.visible(p.id) and p.status not in ('draft','cancelled') and not exists(select 1 from public.finance_po_budget b where b.po_id=p.id)),
 'positions',case when finance_private.role() in ('mentor','admin') then (select coalesce(jsonb_agg(jsonb_build_object('key',p.key,'name',p.name,'enabled',b.position_key is not null)),'[]') from public.team_positions p left join finance_private.budget_positions b on b.position_key=p.key) else '[]'::jsonb end);
end $function$
;

CREATE OR REPLACE FUNCTION public.finance_workbook_context(season uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
  left join public.finance_budget_categories bc on bc.id=pb.category_id where pb.season_id=season and finance_private.visible(p.id)
 ) x),
 'people',(select coalesce(jsonb_object_agg(p.id,p.display_name),'{}') from public.profiles p where p.id in (
  select created_by from public.finance_income where season_id=season union select created_by from public.finance_expenses where season_id=season)));
end $function$
;

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
  select coalesce(array_agg(distinct p.id),'{}'),count(*) into recipients,explicit_count
  from public.profiles p left join public.finance_assignments a on p.id=a.user_id and a.capability='school_submitter' and a.active
  where p.active and p.role::text in ('student','lead','admin_lead','admin','mentor') and (p.role::text='admin_lead' or a.id is not null);
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
  join public.profiles p on p.id=mp.user_id and p.active and p.role::text in ('student','lead','admin_lead','admin','mentor')
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
  if r<>h.actor_id and exists(select 1 from public.profiles where id=r and active and role::text in ('student','lead','admin_lead','admin','mentor')) then
   insert into public.team_notifications(source_event_id,event,recipient_id,entity_id,payload)
   values(h.id,kind,r,h.po_id,body) on conflict do nothing;
  end if;
 end loop;
end $function$
;

CREATE OR REPLACE FUNCTION public.finance_notification_delivery_allowed(notification_id uuid, token uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
 n public.team_notifications;
 h finance_private.history;
 po public.finance_purchase_orders;
 recipient public.profiles;
 positions text[];
 is_school_submitter boolean;
 is_finance_admin boolean;
 is_requester boolean;
 has_approved boolean;
 allowed boolean := false;
begin
 -- Bind the decision to the server-owned row and the current delivery lease.
 -- Neither an actor ID nor notification payload is an authorization input.
 select * into n from public.team_notifications
 where id = notification_id and source = 'finance' and entity_type = 'finance_po'
   and channel = 'email' and status = 'sending' and lease_token = token;
 if not found then return false; end if;
 -- A slow check must not permanently skip an otherwise eligible recipient.
 -- The worker records RPC errors as retry; a superseded token cannot finish.
 if n.lease_until is null or n.lease_until <= clock_timestamp() then
  raise exception 'Delivery lease expired';
 end if;
 select * into h from finance_private.history
 where id = n.source_event_id and po_id = n.entity_id;
 if not found then return false; end if;
 select * into po from public.finance_purchase_orders where id = n.entity_id;
 if not found then return false; end if;
 select * into recipient from public.profiles where id = n.recipient_id
   and active and role::text in ('student','lead','admin_lead','mentor','admin');
 if not found then return false; end if;

 select coalesce(array_agg(mp.position_key), '{}') into positions
 from public.team_member_positions mp
 join public.team_positions p on p.key = mp.position_key and p.active
 where mp.user_id = recipient.id and mp.revoked_at is null;
 select recipient.role::text='admin_lead' or exists(select 1 from public.finance_assignments a
   where a.user_id = recipient.id and a.capability = 'school_submitter' and a.active),
   exists(select 1 from public.finance_assignments a
   where a.user_id = recipient.id and a.capability = 'finance_admin' and a.active)
 into is_school_submitter, is_finance_admin;

 -- Match finance_private.visible for this explicit recipient, without changing
 -- auth.uid()/JWT state in a service-role request. Approver capabilities come
 -- from live Team Hub positions, never the legacy Finance assignment slots.
 if not coalesce((po.requester_id = recipient.id or recipient.role::text in ('mentor','admin')
   or is_finance_admin or (po.status <> 'draft' and
     (positions && array['finance_lead','lead_coach_1','lead_coach_2']
      or is_school_submitter
      or (recipient.role::text in ('lead','admin_lead') and po.area_id = recipient.primary_area_id)))), false) then
  return false;
 end if;

 is_requester := recipient.id = po.requester_id
   and h.details->'after'->>'requester_id' = recipient.id::text;
 select exists(select 1 from public.finance_po_approvals a
   where a.po_id = po.id and a.revision = h.revision and a.action = 'approved'
     and a.actor_id = recipient.id) into has_approved;

 -- Re-evaluate the queued event's audience against current authority. The
 -- historical event, not the frozen display payload, identifies that audience.
 case n.event
 when 'approval_needed' then
  allowed := h.action = 'submit' and not is_requester and not has_approved
    and positions && array['finance_lead','lead_coach_1','lead_coach_2'];
 when 'approval_remaining', 'approval_recorded' then
  allowed := h.action = 'approve' and h.details->'after'->>'status' = 'awaiting_approval'
    and ((n.event = 'approval_recorded' and is_requester)
      or (not is_requester and not has_approved and
        case h.details->>'slot'
        when 'po_approver' then positions && array['finance_lead']
        when 'finance_approver' then positions && array['lead_coach_1','lead_coach_2']
        else false end));
 when 'changes_requested' then
  allowed := h.action = 'request_changes' and is_requester;
 when 'ready_for_school' then
  allowed := h.action = 'approve' and h.details->'after'->>'status' = 'approved'
    and (is_requester or is_school_submitter or
      (recipient.role::text in ('mentor','admin')
       and not exists(select 1 from public.profiles p where p.active and p.role::text='admin_lead')
       and not exists(select 1 from public.finance_assignments a
         join public.profiles p on p.id = a.user_id and p.active
           and p.role::text in ('student','lead','admin_lead','mentor','admin')
         where a.capability = 'school_submitter' and a.active)
       and (select count(*) from public.profiles p
         where p.active and p.role::text in ('mentor','admin')) <= 5));
 when 'submitted_to_school' then
  allowed := h.action = 'school_submit' and (is_requester or has_approved);
 when 'cancelled' then
  allowed := h.action = 'cancel' and (is_requester or (h.revision > 0 and
    (positions && array['finance_lead','lead_coach_1','lead_coach_2']
     or exists(select 1 from public.finance_po_approvals a
       where a.po_id = po.id and a.revision = h.revision and a.actor_id = recipient.id))));
 else
  return false;
 end case;
 return coalesce(allowed, false);
end $function$
;

CREATE OR REPLACE FUNCTION public.finance_budget_manage(action text, p jsonb)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
 if not finance_private.can_manage_budget() then raise exception 'Budget leadership required' using errcode='42501';end if;
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
 if not finance_private.can_manage_budget() then raise exception 'Budget leadership required' using errcode='42501';end if;
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
end $function$
;

CREATE OR REPLACE FUNCTION public.finance_context()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
 if finance_private.role() is null then raise exception 'Active team account required' using errcode='42501'; end if;
 return jsonb_build_object('profile',(select jsonb_build_object('id',id,'display_name',display_name,'role',role) from public.profiles where id=auth.uid()),
 'can_create',finance_private.creator(),'is_admin',finance_private.admin(),
 'coach_self_approvals',(select coalesce(jsonb_agg(jsonb_build_object('po_id',p.id,'allowed',f->'allowed','reason',f->>'reason')),'[]') from public.finance_purchase_orders p cross join lateral finance_private.coach_self_approval_context(p.id) f where p.requester_id=auth.uid() and p.status='awaiting_approval' and (f->>'eligible')::boolean),
 'capabilities',(select coalesce(jsonb_agg(c),'[]') from unnest(array['finance_approver','po_approver','school_submitter','finance_admin']) c where finance_private.cap(c)),
 'areas',(select coalesce(jsonb_agg(jsonb_build_object('id',id,'name',name,'active',active) order by name),'[]') from public.areas),
 'people',(select coalesce(jsonb_agg(jsonb_build_object('id',pr.id,'name',pr.display_name) order by pr.display_name),'[]') from public.profiles pr
 where (finance_private.admin() and pr.active) or pr.id=auth.uid() or exists(select 1 from public.finance_purchase_orders p where finance_private.visible(p.id) and p.requester_id=pr.id)
 or exists(select 1 from finance_private.history h where h.actor_id=pr.id and finance_private.visible(h.po_id))));
end $function$
;

CREATE OR REPLACE FUNCTION finance_private.mutate_v1(action text, p jsonb)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare po public.finance_purchase_orders; previous jsonb; pid uuid; slot text:=p->>'slot'; reason text:=trim(coalesce(p->>'reason','')); override_note text:=trim(coalesce(p->>'override_reason','')); caps boolean; coach_self boolean:=false; self_context jsonb; marked_self boolean:=false; approval_id uuid; authority text; paired uuid;
begin
 if finance_private.role() is null then raise exception 'Active team account required' using errcode='42501'; end if;
 if length(reason)>2000 or length(override_note)>2000 then raise exception 'Explanations must be at most 2000 characters'; end if;
 if action='assignment' then
 if p->>'capability' is null or p->>'capability' not in ('school_submitter','finance_admin') then raise exception 'Manage Lead Coach and Finance Lead positions in Team Hub'; end if;
 if not finance_private.admin() then raise exception 'Finance administration required' using errcode='42501'; end if;
 if not exists(select 1 from public.profiles where id=(p->>'user_id')::uuid and active and role::text in ('student','lead','admin_lead','admin','mentor')) then raise exception 'Choose an active student or leadership account'; end if;
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
 coach_self:=action='approve' and slot='po_approver' and po.requester_id=auth.uid()
   and finance_private.role() in ('mentor','admin') and caps;
 marked_self:=exists(select 1 from public.finance_po_approvals c join finance_private.history h
 on h.po_id=c.po_id and h.revision=c.revision and h.actor_id=c.actor_id and h.action='approve'
 and h.details->>'approval_id'=c.id::text and h.details->>'slot'=c.slot
 and h.details->>'approval_authority'='assigned_lead_coach_self'
 where c.po_id=pid and c.revision=po.revision and c.slot='po_approver' and c.action='approved' and c.actor_id=po.requester_id);
 if coach_self then
  self_context:=finance_private.coach_self_approval_context(pid);
  if not coalesce((self_context->>'allowed')::boolean,false) then
   raise exception '%',self_context->>'reason' using errcode='42501';
  end if;
  paired:=nullif(self_context->>'paired_finance_approval_id','')::uuid;
 end if;
 if action='approve' and slot='finance_approver' and marked_self and
   (not caps or po.requester_id=auth.uid()) then
  raise exception 'A different assigned Finance Lead must approve the Finance step' using errcode='42501';
 end if;
 if not coach_self and (not caps or po.requester_id=auth.uid()) and not (finance_private.role() in ('admin','mentor') and override_note<>'') then raise exception 'Configured approver required; administrators must give an explicit override reason' using errcode='42501'; end if;
 if override_note<>'' and finance_private.role() not in ('admin','mentor') then raise exception 'Only mentors and admins can override' using errcode='42501'; end if;
 if action='request_changes' and reason='' then raise exception 'Explain the requested changes'; end if;
 if action='approve' and exists(select 1 from public.finance_po_approvals a where a.po_id=pid and a.revision=po.revision and a.action='approved' and a.actor_id=auth.uid()) then raise exception 'Two distinct people must approve each revision'; end if;
 insert into public.finance_po_approvals(po_id,revision,slot,action,actor_id,explanation,override_reason)
 values(pid,po.revision,slot,case when action='approve' then 'approved' else 'changes_requested' end,auth.uid(),reason,override_note) returning id into approval_id;
 authority:=case when coach_self then 'assigned_lead_coach_self' when slot='finance_approver' and caps and po.requester_id<>auth.uid() then 'assigned_finance_lead' when slot='po_approver' and caps and po.requester_id<>auth.uid() then 'assigned_lead_coach' else 'mentor_admin_override' end;
 update public.finance_purchase_orders set status=case when action='request_changes' then 'changes_requested'
 when finance_private.revision_approved(pid,po.revision)
 -- The new record-bound authority history is inserted below in the SAME transaction.
 -- Only the already-validated normal self-Coach pair / different Finance vote may
 -- bridge that insertion order; a failed history insert rolls back the approval.
 or (action='approve' and ((coach_self and paired is not null) or (marked_self and slot='finance_approver' and authority='assigned_finance_lead'))
   and not exists(select 1 from public.finance_po_approvals qa where qa.po_id=pid and qa.revision=po.revision and qa.action='changes_requested')
   and (select count(distinct qa.slot)=2 and count(distinct qa.actor_id)=2 from public.finance_po_approvals qa where qa.po_id=pid and qa.revision=po.revision and qa.action='approved')) then 'approved'  else 'awaiting_approval' end where id=pid;
 elsif action='school_submit' then
 if not (finance_private.cap('school_submitter') or finance_private.role() in ('admin','mentor')) then raise exception 'School submission capability required' using errcode='42501'; end if;
 if po.status<>'approved' or not finance_private.revision_approved(pid,po.revision) then raise exception 'Both current-revision approvals are required'; end if;
 update public.finance_purchase_orders set status='submitted_to_school',school_submitted_by=auth.uid(),school_submitted_at=clock_timestamp(),school_reference=trim(coalesce(p->>'reference','')),school_note=trim(coalesce(p->>'note','')) where id=pid;
 else raise exception 'Unknown Finance action'; end if;
 update public.finance_purchase_orders set version=version+1,updated_at=clock_timestamp() where id=pid;
 insert into finance_private.history(po_id,revision,action,actor_id,details)
 select pid,revision,action,auth.uid(),jsonb_build_object('reason',reason,'slot',slot,'override_reason',override_note,'self_approval_override',action='approve' and po.requester_id=auth.uid() and not coach_self,
 'approval_id',approval_id,'approval_authority',authority,'paired_finance_approval_id',paired,'before',previous,'after',to_jsonb(n)) from public.finance_purchase_orders n where id=pid;
 return pid;
end $function$
;

CREATE OR REPLACE FUNCTION finance_private.revision_approved(pid uuid, rev integer)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
 select not exists(select 1 from public.finance_po_approvals where po_id=pid and revision=rev and action='changes_requested')
 and (select count(distinct slot)=2 and count(distinct actor_id)=2 from public.finance_po_approvals
 where po_id=pid and revision=rev and action='approved')

 and not exists(
  select 1 from public.finance_po_approvals c
  join public.finance_purchase_orders po on po.id=c.po_id and po.requester_id=c.actor_id
  join finance_private.history h on h.po_id=c.po_id and h.revision=c.revision and h.actor_id=c.actor_id and h.action='approve'
    and h.details->>'approval_id'=c.id::text and h.details->>'slot'=c.slot
    and h.details->>'approval_authority'='assigned_lead_coach_self'
  where c.po_id=pid and c.revision=rev and c.slot='po_approver' and c.action='approved'
  and not exists(select 1 from public.finance_po_approvals f where f.po_id=pid and f.revision=rev
    and f.slot='finance_approver' and f.action='approved' and f.actor_id<>c.actor_id
    and (h.details->>'paired_finance_approval_id'=f.id::text or exists(select 1 from finance_private.history fh
      where fh.po_id=f.po_id and fh.revision=f.revision and fh.actor_id=f.actor_id and fh.action='approve'
      and fh.details->>'slot'=f.slot and fh.details->>'approval_id'=f.id::text
      and fh.details->>'approval_authority'='assigned_finance_lead')))
 )
$function$
;
commit;
