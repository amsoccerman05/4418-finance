-- Read-only actionability for POs already visible to the caller. Do not expose
-- season IDs, names, budgets or classifications, and do not change any mutation
-- rule or underlying table grants/RLS. In particular, closed seasons stay locked.
begin;

-- Budget tables are deliberately not readable by every PO viewer. This private
-- lookup reveals only the lock flag, after independently checking the caller
-- and existing PO visibility. A nonexistent or invisible PO returns no fact.
create function finance_private.po_season_closed(pid uuid) returns boolean
language plpgsql stable security definer set search_path='' as $$
begin
  if auth.uid() is null or not coalesce(finance_private.visible(pid),false) then
    return null;
  end if;
  return exists (
    select 1 from public.finance_po_budget b
    join public.finance_seasons s on s.id=b.season_id
    where b.po_id=pid and s.status='closed'
  );
end;
$$;
revoke all on function finance_private.po_season_closed(uuid) from public,anon,authenticated;
grant execute on function finance_private.po_season_closed(uuid) to authenticated;

-- Invoker security retains the purchase-order table's RLS. The barrier keeps
-- caller-supplied filters outside the view's visibility boundary.
create view public.finance_po_actionability with (security_invoker=true,security_barrier=true) as
select p.id, finance_private.po_season_closed(p.id) as season_closed
from public.finance_purchase_orders p;

revoke all on public.finance_po_actionability from public,anon,authenticated;
grant select on public.finance_po_actionability to authenticated;

commit;
