-- Any active student profile may request a purchase, even before an attendance
-- registration record exists. Registration does not confer approval authority.
-- Keep the existing private helper, execution grants, ownership checks, RLS,
-- two-person approval workflow, and school-submission permissions unchanged.
begin;

create or replace function finance_private.creator()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    finance_private.admin()
    or finance_private.role() in ('lead', 'student'),
    false
  )
$$;

commit;
