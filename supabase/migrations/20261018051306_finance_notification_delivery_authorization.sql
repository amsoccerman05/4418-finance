-- MANUAL ONLY: deploy this migration before the updated notification worker.
-- Additive: do not replace Team Hub's shared claim/prepare/finish functions.
begin;

create function public.finance_notification_delivery_allowed(notification_id uuid, token uuid)
returns boolean
language plpgsql stable security definer set search_path = '' as $$
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
   and active and role::text in ('student','lead','mentor','admin');
 if not found then return false; end if;

 select coalesce(array_agg(mp.position_key), '{}') into positions
 from public.team_member_positions mp
 join public.team_positions p on p.key = mp.position_key and p.active
 where mp.user_id = recipient.id and mp.revoked_at is null;
 select exists(select 1 from public.finance_assignments a
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
      or (recipient.role::text = 'lead' and po.area_id = recipient.primary_area_id)))), false) then
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
       and not exists(select 1 from public.finance_assignments a
         join public.profiles p on p.id = a.user_id and p.active
           and p.role::text in ('student','lead','mentor','admin')
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
end $$;

revoke all on function public.finance_notification_delivery_allowed(uuid,uuid)
 from public,anon,authenticated;
grant execute on function public.finance_notification_delivery_allowed(uuid,uuid) to service_role;

commit;
