-- Finance V2C: read-only, selected-season export. No financial records or rules change.
begin;
create function public.finance_workbook_context(season uuid) returns jsonb
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
  select p.id,p.po_number,p.vendor,p.purpose,p.amount,p.revision,p.status,p.submitted_at,p.school_submitted_at,p.school_reference,p.updated_at,
   pr.display_name requester,ar.name functional_area,bc.name category,i.bucket,
   case when p.status in ('approved','submitted_to_school') and finance_private.revision_approved(p.id,p.revision)
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
revoke all on function public.finance_workbook_context(uuid) from public,anon,authenticated;
grant execute on function public.finance_workbook_context(uuid) to authenticated;
commit;
