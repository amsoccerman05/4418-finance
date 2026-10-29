-- Exact helper/constraint excerpts from Hub canonical core; not a deployment migration.
alter table public.profiles drop constraint profiles_role_check;
alter table public.profiles add constraint profiles_role_check check(role in ('readonly','student','lead','admin_lead','admin','mentor'));
CREATE OR REPLACE FUNCTION public.team_my_positions()
 RETURNS text[]
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
 select coalesce(array_agg(mp.position_key order by mp.position_key),'{}') from public.team_member_positions mp
 join public.team_positions pos on pos.key=mp.position_key and pos.active
 join public.profiles pr on pr.id=mp.user_id and pr.active and pr.role::text in ('student','lead','admin_lead','mentor','admin')
 where mp.user_id=auth.uid() and mp.revoked_at is null
$function$;
