-- STAGED / MANUAL REVIEW ONLY. Apply only after Pit Operations and Finance exist.
-- Existing-PO attachment only: no PO creation, purchasing, readiness changes or notifications.
begin;

do $$ begin
  if to_regclass('public.pit_issues') is null
     or to_regprocedure('pit_private.current_role()') is null
     or to_regprocedure('finance_private.visible(uuid)') is null
     or to_regprocedure('finance_private.admin()') is null then
    raise exception 'Existing Pit Operations and Finance permission contracts are required';
  end if;
  perform id, updated_at from public.pit_issues limit 0;
  perform id, po_number, status, requester_id from public.finance_purchase_orders limit 0;
end $$;

-- Immutable relationship/audit rows. Neither the table nor its reasons/actors are
-- exposed through a broad Pit history feed or direct client table access.
create table finance_private.repair_po_links (
  id uuid primary key default gen_random_uuid(),
  issue_id uuid not null references public.pit_issues(id),
  po_id uuid not null references public.finance_purchase_orders(id),
  linked_by uuid not null references public.profiles(id),
  linked_at timestamptz not null default clock_timestamp(),
  issue_updated_at timestamptz not null,
  reason text not null check (length(trim(reason)) between 1 and 2000 and reason ~ '[^[:space:]]'),
  unique (issue_id, po_id)
);
create index finance_repair_links_po on finance_private.repair_po_links(po_id);
alter table finance_private.repair_po_links enable row level security;
revoke all on finance_private.repair_po_links from public, anon, authenticated, service_role;

create function public.finance_repair_context(p_issue_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  issue_stamp timestamptz;
  pit_role text := pit_private.current_role();
begin
  if not coalesce(pit_role = any(array['readonly','student','lead','mentor','admin']), false) then
    raise exception 'Repair purchasing details unavailable' using errcode = '42501';
  end if;
  select i.updated_at into issue_stamp from public.pit_issues i where i.id = p_issue_id;
  if not found then
    raise exception 'Repair purchasing details unavailable' using errcode = '42501';
  end if;
  return jsonb_build_object(
    'issue_id', p_issue_id,
    'issue_updated_at', issue_stamp,
    'can_attach', pit_role = any(array['lead','mentor','admin']),
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
end $$;

-- One explicitly supplied PO only; no broad directory or hidden-link count.
create function public.finance_repair_po_candidate(p_issue_id uuid, p_po_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  issue_stamp timestamptz;
  po public.finance_purchase_orders;
  requester_name text;
  pit_role text := pit_private.current_role();
begin
  if not coalesce(pit_role = any(array['readonly','student','lead','mentor','admin']), false) then
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
    'can_attach', pit_role = any(array['lead','mentor','admin'])
      and (po.requester_id = auth.uid() or finance_private.admin())
  );
end $$;

create function public.finance_attach_repair_po(
  p_issue_id uuid,
  p_po_id uuid,
  p_expected_issue_updated_at timestamptz,
  p_reason text
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  issue_stamp timestamptz;
  po public.finance_purchase_orders;
  why text := trim(coalesce(p_reason, ''));
begin
  if not coalesce(pit_private.current_role() = any(array['lead','mentor','admin']), false) then
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
     or not coalesce(pit_private.current_role() = any(array['lead','mentor','admin']), false)
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
end $$;

revoke all on function public.finance_repair_context(uuid),
  public.finance_repair_po_candidate(uuid,uuid),
  public.finance_attach_repair_po(uuid,uuid,timestamptz,text)
  from public, anon, authenticated;
grant execute on function public.finance_repair_context(uuid),
  public.finance_repair_po_candidate(uuid,uuid),
  public.finance_attach_repair_po(uuid,uuid,timestamptz,text)
  to authenticated;
commit;
