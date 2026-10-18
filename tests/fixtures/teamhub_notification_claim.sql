-- Exact shared claim replacement from amsoccerman05/4418-team-hub at
-- 6f8b7b92eb847a6e840efa2285fba0bb14db1437, 202609120006_team_communications.sql.
create or replace function public.team_notification_claim(batch_size integer default 3) returns setof public.team_notifications
language plpgsql security definer set search_path='' as $$
begin
 -- Never retry an uncertain send outside Resend's 24-hour idempotency window.
 update public.team_notifications set status='review',last_error='Retry window or attempt limit reached',lease_token=null,lease_until=null
 where channel='email' and status in ('pending','sending') and (lease_until is null or lease_until<now())
 and (attempts>=5 or first_attempt_at<now()-interval '23 hours');
 update public.team_notifications n set status='skipped',last_error='Recipient no longer active',lease_token=null,lease_until=null
 where n.channel='email' and n.status in ('pending','sending') and (n.lease_until is null or n.lease_until<now())
 and not exists(select 1 from public.profiles p where p.id=n.recipient_id and p.active and (p.role::text in ('student','lead','admin','mentor') or (n.source='hub' and p.role::text='readonly')));
 return query with candidates as (
 select id from public.team_notifications where channel='email' and
 ((status='pending' and next_attempt_at<=now()) or (status='sending' and lease_until<now()))
 order by created_at,id for update skip locked limit greatest(1,least(coalesce(batch_size,3),3))
 ) update public.team_notifications n set status='sending',attempts=attempts+1,
 first_attempt_at=coalesce(first_attempt_at,now()),lease_until=now()+interval '3 minutes',lease_token=gen_random_uuid()
 from candidates c where n.id=c.id returning n.*;
end $$;
