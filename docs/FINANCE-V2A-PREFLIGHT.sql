-- READ ONLY. Run on production before reviewing/applying the corrective additive migration.
-- Compare with docs/FINANCE-V2A.md. Stop on drift; do not overwrite deployed workflow logic.
select p.oid::regprocedure,pg_get_functiondef(p.oid)
from pg_proc p join pg_namespace n on n.oid=p.pronamespace
where (n.nspname='public' and p.proname in ('finance_mutate','finance_context'))
 or (n.nspname='finance_private' and p.proname in ('cap','admin','revision_approved'));
select table_schema,table_name,column_name,data_type from information_schema.columns
where (table_schema='public' and table_name in ('finance_purchase_orders','finance_po_revisions','finance_po_approvals','finance_assignments','team_positions','team_member_positions'))
 or (table_schema='finance_private' and table_name='history') order by table_schema,table_name,ordinal_position;
select pg_get_triggerdef(oid) from pg_trigger where not tgisinternal and tgrelid='finance_private.history'::regclass;
select key,name,active,category from public.team_positions order by key;
select to_regprocedure('finance_private.mutate_v1(text,jsonb)') as must_be_null_before_first_install;
select pg_get_viewdef('public.finance_po_history'::regclass,true);
