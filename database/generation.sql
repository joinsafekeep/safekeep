-- Migration: practice_generation
-- Phase 9 of the MVP PRD ("Scam generation"): what the weekly generator needs to know about the library. Selection,
-- the review queue and retirement already exist (practice.sql); this adds the backlog the generator writes toward.
-- Apply after reports.sql.

-- Per category: how many versions are published in each format, and how participants did with that category in the
-- last 90 days. The generator favours categories that are thin in a format, and ones people now spot easily (a low
-- practice-opportunity rate means the scams there have stopped teaching anything).
create function public.library_gaps() returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
 if current_setting('request.jwt.claim.role',true) in ('authenticated','anon') then raise exception 'Not allowed' using errcode='42501'; end if;
 return (with cats as (select distinct category from public.practice_scams where archived_at is null),
  pub as (select s.category, v.format, count(*) n from public.practice_scam_versions v join public.practice_scams s on s.id=v.scam_id where v.status='published' group by 1,2),
  drafts as (select s.category, v.format, count(*) n from public.practice_scam_versions v join public.practice_scams s on s.id=v.scam_id where v.status='draft' and v.rejected_at is null group by 1,2),
  results as (select s.category, count(*) n, count(*) filter (where p.result='engaged') e from public.user_practices p join public.practice_scam_versions v on v.id=p.scam_version_id join public.practice_scams s on s.id=v.scam_id
              where p.delivery_status in ('sent','delivered') and p.result<>'pending' and p.sent_at > now() - interval '90 days' group by 1)
  select jsonb_build_object(
   'categories', coalesce((select jsonb_agg(jsonb_build_object('category',c.category,
     'published',jsonb_build_object('email',coalesce((select n from pub where pub.category=c.category and format='email'),0),'text',coalesce((select n from pub where pub.category=c.category and format='text'),0),'phone',coalesce((select n from pub where pub.category=c.category and format='phone'),0)),
     'waiting_review',coalesce((select sum(n) from drafts where drafts.category=c.category),0),
     'finished_90d',coalesce((select n from results r where r.category=c.category),0),
     'opportunity_rate',(select round(e::numeric/nullif(n,0),2) from results r where r.category=c.category)) order by c.category) from cats c),'[]'),
   'codes', coalesce((select jsonb_agg(stable_code order by stable_code) from public.practice_scams where archived_at is null),'[]'),
   'names', coalesce((select jsonb_agg(name order by name) from public.practice_scams where archived_at is null),'[]')));
end $$;
revoke all on function public.library_gaps() from public, anon, authenticated;
grant execute on function public.library_gaps() to service_role;
