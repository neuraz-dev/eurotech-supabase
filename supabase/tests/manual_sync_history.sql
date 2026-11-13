-- Fixtures only in the new queue tables, all rolled back. No live data written.
begin;
select set_config('statement_timeout','60000',true);
-- Do not allow a concurrent real run to be claimed by fixture assertions.
lock table ml.ml_sync_runs in exclusive mode;
do $$ begin
  assert not exists(select 1 from ml.ml_sync_runs where status in ('queued','running')), 'Hay una sincronización real activa; no ejecutar fixtures';
end $$;
do $$
declare r ml.ml_sync_runs; duplicate ml.ml_sync_runs; t ml.ml_sync_tasks; next_task ml.ml_sync_tasks; done boolean;
begin
  select * into r from ml.start_manual_sync('all',null,'sql-test','00000000-0000-4000-8000-000000000001','fixture',gen_random_uuid());
  select * into duplicate from ml.start_manual_sync('all',null,'sql-test','00000000-0000-4000-8000-000000000001','fixture',gen_random_uuid());
  assert r.id=duplicate.id,'active scope deduplication';
  select * into t from ml.claim_manual_sync_task();
  assert t.stage='own' and t.kind='discover','own discovery first';
  assert not ml.finish_manual_sync_task(t.id,gen_random_uuid()),'wrong lease cannot commit';
  assert not exists(select 1 from ml.claim_manual_sync_task()),'second worker cannot overlap';
  assert ml.finish_manual_sync_task(t.id,t.lease_token,'[]','[{"key":"batch:0","payload":[{"id":"fixture-own"}]}]'),'valid completion';
  select * into t from ml.claim_manual_sync_task();
  assert t.stage='own' and t.kind='batch','catalog waits for all own pages';
  assert ml.finish_manual_sync_task(t.id,t.lease_token,'[{"entity_id":"fixture-own","identity":{"id":"fixture-own","title":"Guardado"},"outcome":"updated","message":"Confirmado"}]'),'confirmed result';
  assert not ml.finish_manual_sync_task(t.id,t.lease_token),'completion retry idempotence';
  assert (select status='running' and finished_at is null from ml.ml_sync_runs where id=r.id),'first page is not final';
  select * into t from ml.claim_manual_sync_task();
  assert t.stage='catalog','catalog follows own';
  perform ml.finish_manual_sync_task(t.id,t.lease_token,'[{"entity_id":"fixture-catalog","identity":{"id":"fixture-catalog"},"outcome":"failed","message":"HTTP 404","http_status":404}]');
  select * into t from ml.claim_manual_sync_task();
  assert t.stage='rivals','partial catalog still runs rivals';
  perform ml.finish_manual_sync_task(t.id,t.lease_token);
  assert (select status='partial' and updated_count=1 and failed_count=1 and completed_count=2 and finished_at is not null from ml.ml_sync_runs where id=r.id),'exact terminal counts';
  assert (select count(*)=3 from ml.manual_sync_stage_summary(r.id)),'stage summary';
  select * into duplicate from ml.start_manual_sync('all',null,'sql-test','00000000-0000-4000-8000-000000000001','fixture',r.request_key);
  assert r.id=duplicate.id,'same request after completion returns original run';
  select * into r from ml.start_manual_sync('tracked',null,'sql-test','00000000-0000-4000-8000-000000000001','fixture',gen_random_uuid());
  select * into t from ml.claim_manual_sync_task();
  update ml.ml_sync_tasks set lease_until=now()-interval '1 second' where id=t.id;
  select * into next_task from ml.claim_manual_sync_task();
  assert t.id=next_task.id and next_task.lease_token<>t.lease_token and next_task.attempts=2,'new lease for interrupted task';
  assert not ml.finish_manual_sync_task(t.id,t.lease_token),'expired writer fenced';
  update ml.ml_sync_tasks set attempts=3,lease_until=now()-interval '1 second' where id=t.id;
  perform ml.claim_manual_sync_task();
  assert (select status='failed' and failed_count=1 from ml.ml_sync_runs where id=r.id),'exhausted task finalizes';
  select * into r from ml.start_manual_sync('catalog',null,'sql-test','00000000-0000-4000-8000-000000000001','fixture',gen_random_uuid());
  select * into t from ml.claim_manual_sync_task();
  perform ml.finish_manual_sync_task(t.id,t.lease_token,'[]',jsonb_build_array(jsonb_build_object('key','large','payload',(select jsonb_agg(jsonb_build_object('id','fixture-'||g)) from generate_series(1,20050) g))));
  select * into t from ml.claim_manual_sync_task();
  perform ml.finish_manual_sync_task(t.id,t.lease_token,(select jsonb_agg(jsonb_build_object('entity_id','fixture-'||g,'identity',jsonb_build_object('id','fixture-'||g),'outcome',case when g<=49 then 'failed' else 'updated' end,'message','Fixture')) from generate_series(1,20050) g));
  assert (select count(*)=20050 from ml.ml_sync_results where run_id=r.id),'no truncation beyond 20000';
  assert (select failed_count=49 and updated_count=20001 and total_count=20050 from ml.ml_sync_runs where id=r.id),'counts across pages';
  assert not has_table_privilege('authenticated','ml.ml_sync_results','select'),'direct access denied';
  assert not has_function_privilege('anon','ml.dispatch_manual_sync()','execute'),'anonymous dispatch denied';
end $$;
rollback;
