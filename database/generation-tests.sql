-- Tests for database/generation.sql. Run in a transaction against a database with all migrations applied.
begin;
insert into public.practice_scams(id,stable_code,name,category) values('d1111111-1111-4111-8111-111111111111','test-gap','Gap test','gaptest');
insert into public.practice_scam_versions(scam_id,version_number,format,difficulty,content,learning_objective,debrief,status) values
('d1111111-1111-4111-8111-111111111111',1,'email',1,'c','x','y','published'),('d1111111-1111-4111-8111-111111111111',2,'text',1,'c','x','y','draft');
do $$ declare g jsonb := (select c from jsonb_array_elements(public.library_gaps()->'categories') c where c->>'category'='gaptest'); begin
 if (g->'published'->>'email')::int<>1 or (g->'published'->>'phone')::int<>0 or (g->>'waiting_review')::int<>1 then raise exception 'Gaps wrong: %', g; end if;
 if not (public.library_gaps()->'codes') ? 'test-gap' then raise exception 'Codes missing'; end if;
end $$;
set local role authenticated;
do $$ begin begin perform public.library_gaps(); raise exception 'Signed-in user read gaps'; exception when insufficient_privilege then null; end; end $$;
rollback;
select 'Generation tests passed; fixtures rolled back' as result;
