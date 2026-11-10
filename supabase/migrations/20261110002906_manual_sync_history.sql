-- Manual runs only. No foreign keys to live products/rivals: evidence survives removal.
create table ml.ml_sync_runs (
  id uuid primary key default gen_random_uuid(),
  request_key uuid not null unique,
  scope_key text not null,
  action text not null check(action in ('all','own','catalog','rivals','tracked','product')),
  origin text not null,
  target_id text,
  requested_by uuid not null,
  requested_by_label text not null,
  status text not null default 'queued' check(status in ('queued','running','completed','partial','failed','warnings')),
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,
  updated_at timestamptz not null default now(),
  updated_count integer not null default 0,
  failed_count integer not null default 0,
  skipped_count integer not null default 0,
  warning_count integer not null default 0,
  total_count integer not null default 0,
  completed_count integer not null default 0
);
create unique index ml_sync_active_scope on ml.ml_sync_runs(scope_key) where status in ('queued','running');
create index ml_sync_runs_order on ml.ml_sync_runs(created_at desc,id desc);
create index ml_sync_runs_filter on ml.ml_sync_runs(action,status,created_at desc,id desc);
create table ml.ml_sync_tasks (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references ml.ml_sync_runs(id),
  stage text not null check(stage in ('own','catalog','rivals','tracked')),
  stage_order integer not null,
  task_key text not null,
  kind text not null check(kind in ('discover','batch')),
  payload jsonb not null default '[]',
  status text not null default 'queued' check(status in ('queued','running','done')),
  attempts integer not null default 0,
  lease_token uuid,
  lease_until timestamptz,
  created_at timestamptz not null default now(),
  unique(run_id,stage,task_key)
);
create index ml_sync_tasks_pending on ml.ml_sync_tasks(run_id,stage_order,status);
create table ml.ml_sync_results (
  id bigint generated always as identity primary key,
  run_id uuid not null references ml.ml_sync_runs(id),
  task_id uuid not null references ml.ml_sync_tasks(id),
  stage text not null,
  entity_id text not null,
  identity jsonb not null default '{}',
  outcome text not null check(outcome in ('updated','failed','skipped','warning')),
  category text,
  message text not null,
  operation text,
  resource text,
  http_status integer,
  attempts integer not null default 1,
  recorded_at timestamptz not null default now(),
  unique(run_id,stage,entity_id)
);
create index ml_sync_results_page on ml.ml_sync_results(run_id,outcome,id);
create index ml_sync_results_stage on ml.ml_sync_results(run_id,stage,id);
alter table ml.ml_sync_runs enable row level security;
alter table ml.ml_sync_tasks enable row level security;
alter table ml.ml_sync_results enable row level security;
revoke all on ml.ml_sync_runs, ml.ml_sync_tasks, ml.ml_sync_results from public,anon,authenticated;
grant all on ml.ml_sync_runs, ml.ml_sync_tasks, ml.ml_sync_results to service_role;
grant usage,select on sequence ml.ml_sync_results_id_seq to service_role;

create function ml.refresh_manual_sync(p_run uuid) returns void language plpgsql set search_path='' as $$
declare u integer; f integer; s integer; w integer; pending boolean; total integer;
begin
  -- Every task completion and recovery serializes on its run before finalizing.
  perform 1 from ml.ml_sync_runs where id=p_run for update;
  select count(*) filter(where outcome='updated'), count(*) filter(where outcome='failed'),
    count(*) filter(where outcome='skipped'),count(*) filter(where outcome='warning')
    into u,f,s,w from ml.ml_sync_results where run_id=p_run;
  select exists(select 1 from ml.ml_sync_tasks where run_id=p_run and status<>'done') into pending;
  select coalesce(sum(jsonb_array_length(payload)),0)::integer into total
    from ml.ml_sync_tasks where run_id=p_run and kind='batch';
  update ml.ml_sync_runs set updated_count=u,failed_count=f,skipped_count=s,warning_count=w,
    completed_count=u+f+s+w,total_count=greatest(total,u+f+s+w),updated_at=now(),
    status=case when pending then 'running' when f>0 and u+w=0 then 'failed'
      when f>0 then 'partial' when w>0 then 'warnings' else 'completed' end,
    finished_at=case when pending then null else now() end where id=p_run;
end $$;

create function ml.finish_manual_sync_task(p_task uuid,p_lease uuid,p_results jsonb default '[]',p_children jsonb default '[]')
returns boolean language plpgsql set search_path='' as $$
declare t ml.ml_sync_tasks; result jsonb; child jsonb;
begin
  select * into t from ml.ml_sync_tasks where id=p_task;
  if not found then return false; end if;
  perform 1 from ml.ml_sync_runs where id=t.run_id for update;
  select * into t from ml.ml_sync_tasks where id=p_task for update;
  if t.status<>'running' or t.lease_token is distinct from p_lease or t.lease_until<now() then return false; end if;
  for result in select * from jsonb_array_elements(p_results) loop
    insert into ml.ml_sync_results(run_id,task_id,stage,entity_id,identity,outcome,category,message,operation,resource,http_status,attempts)
    values(t.run_id,t.id,t.stage,result->>'entity_id',coalesce(result->'identity','{}'),result->>'outcome',
      result->>'category',result->>'message',result->>'operation',result->>'resource',
      (result->>'http_status')::integer,greatest(t.attempts,coalesce((result->>'attempts')::integer,1)))
    on conflict(run_id,stage,entity_id) do nothing;
  end loop;
  for child in select * from jsonb_array_elements(p_children) loop
    insert into ml.ml_sync_tasks(run_id,stage,stage_order,task_key,kind,payload)
      values(t.run_id,t.stage,t.stage_order,child->>'key','batch',child->'payload')
      on conflict(run_id,stage,task_key) do nothing;
  end loop;
  update ml.ml_sync_tasks set status='done',lease_until=null where id=t.id;
  perform ml.refresh_manual_sync(t.run_id);
  return true;
end $$;

create function ml.claim_manual_sync_task() returns setof ml.ml_sync_tasks language plpgsql set search_path='' as $$
declare r record; t ml.ml_sync_tasks; failures jsonb;
begin
  -- SKIP LOCKED allows multiple workers without overlapping tasks within a run.
  for r in select id from ml.ml_sync_runs where status in ('queued','running') order by created_at,id for update skip locked loop
    -- Crashed workers get three leased attempts; every exhausted target gets evidence.
    for t in select * from ml.ml_sync_tasks where run_id=r.id and status='running' and lease_until<now() and attempts>=3 loop
      select coalesce(jsonb_agg(jsonb_build_object('entity_id',v->>'id','identity',v,'outcome','failed',
        'category','interrupted','message','La tarea se interrumpió después de tres intentos. No se confirmó su resultado.','operation','worker')), '[]')
        into failures from jsonb_array_elements(case when t.kind='discover' then jsonb_build_array(jsonb_build_object('id','$stage')) else t.payload end) v;
      update ml.ml_sync_tasks set lease_until=now()+interval '1 minute' where id=t.id;
      perform ml.finish_manual_sync_task(t.id,t.lease_token,failures);
    end loop;
    if exists(select 1 from ml.ml_sync_tasks where run_id=r.id and status='running' and lease_until>=now()) then continue; end if;
    select * into t from ml.ml_sync_tasks where run_id=r.id and status<>'done'
      order by stage_order,case kind when 'discover' then 0 else 1 end,created_at,id limit 1 for update;
    if not found then continue; end if;
    update ml.ml_sync_runs set status='running',started_at=coalesce(started_at,now()) where id=r.id;
    return query update ml.ml_sync_tasks set status='running',attempts=attempts+1,
      lease_token=gen_random_uuid(),lease_until=now()+interval '150 seconds' where id=t.id returning *;
    return;
  end loop;
end $$;

-- Only this narrowly scoped dispatcher needs Vault privileges. It accepts no URL
-- or credentials from callers and can dispatch only the configured manual worker.
create function ml.dispatch_manual_sync() returns bigint language plpgsql security definer set search_path='' as $$
declare worker_url text; worker_key text; headers jsonb; request_id bigint; r record;
begin
  -- A broken gateway/runtime must eventually yield an inspectable terminal run.
  for r in select id from ml.ml_sync_runs where status in ('queued','running') and updated_at<now()-interval '20 minutes' for update loop
    insert into ml.ml_sync_results(run_id,task_id,stage,entity_id,identity,outcome,category,message,operation,attempts)
    select t.run_id,t.id,t.stage,v->>'id',v,'failed','interrupted',
      'Sin progreso durante 20 minutos. La actualización no pudo completarse.','worker',greatest(1,t.attempts)
    from ml.ml_sync_tasks t cross join lateral jsonb_array_elements(
      case when t.kind='discover' then jsonb_build_array(jsonb_build_object('id','$stage')) else t.payload end) v
    where t.run_id=r.id and t.status<>'done' on conflict(run_id,stage,entity_id) do nothing;
    update ml.ml_sync_tasks set status='done',lease_until=null where run_id=r.id and status<>'done';
    perform ml.refresh_manual_sync(r.id);
  end loop;
  if not exists(select 1 from ml.ml_sync_runs where status in ('queued','running')) then return null; end if;
  select decrypted_secret into worker_url from vault.decrypted_secrets where name='monitor_manual_worker_url' limit 1;
  select decrypted_secret into worker_key from vault.decrypted_secrets where name='monitor_manual_worker_key' limit 1;
  if worker_url is null or worker_url !~ '/functions/v1/ml-manual-sync$' or nullif(worker_key,'') is null then
    raise exception 'Configure monitor_manual_worker_url y monitor_manual_worker_key en Vault';
  end if;
  headers:=jsonb_build_object('Content-Type','application/json','apikey',worker_key,'x-sync-secret',worker_key);
  if worker_key ~ '^eyJ[^.]+\.[^.]+\.[^.]+$' then headers:=headers||jsonb_build_object('Authorization','Bearer '||worker_key); end if;
  select net.http_post(url:=worker_url,headers:=headers,body:='{}',timeout_milliseconds:=120000) into request_id;
  return request_id;
end $$;

create function ml.start_manual_sync(p_action text,p_target text,p_origin text,p_user uuid,p_label text,p_request uuid)
returns ml.ml_sync_runs language plpgsql set search_path='' as $$
declare r ml.ml_sync_runs; scope text; stages text[]; stage text; n integer:=0;
begin
  if p_action not in ('all','own','catalog','rivals','tracked','product') or (p_action='product' and nullif(p_target,'') is null)
    or (p_action<>'product' and p_target is not null) or p_user is null then raise exception 'Alcance inválido'; end if;
  scope:=p_action||':'||coalesce(p_target,'');
  perform pg_advisory_xact_lock(hashtextextended('manual-sync:'||scope,0));
  select * into r from ml.ml_sync_runs where request_key=p_request;
  if found then return r; end if;
  select * into r from ml.ml_sync_runs where scope_key=scope and status in ('queued','running');
  if found then return r; end if;
  insert into ml.ml_sync_runs(request_key,scope_key,action,origin,target_id,requested_by,requested_by_label)
    values(p_request,scope,p_action,left(p_origin,100),p_target,p_user,left(p_label,200)) returning * into r;
  stages:=case p_action when 'all' then array['own','catalog','rivals'] when 'product' then array['own'] else array[p_action] end;
  foreach stage in array stages loop
    n:=n+1;
    insert into ml.ml_sync_tasks(run_id,stage,stage_order,task_key,kind) values(r.id,stage,n,'discover','discover');
  end loop;
  perform ml.dispatch_manual_sync();
  return r;
end $$;

revoke all on function ml.refresh_manual_sync(uuid),ml.finish_manual_sync_task(uuid,uuid,jsonb,jsonb),
  ml.claim_manual_sync_task(),ml.dispatch_manual_sync(),ml.start_manual_sync(text,text,text,uuid,text,uuid) from public,anon,authenticated;
grant execute on function ml.refresh_manual_sync(uuid),ml.finish_manual_sync_task(uuid,uuid,jsonb,jsonb),
  ml.claim_manual_sync_task(),ml.dispatch_manual_sync(),ml.start_manual_sync(text,text,text,uuid,text,uuid) to service_role;
select cron.schedule('monitor-manual-sync-worker','* * * * *','select ml.dispatch_manual_sync();');

create function ml.manual_sync_stage_summary(p_run uuid)
returns table(stage text,pending bigint,updated bigint,failed bigint,skipped bigint,warning bigint)
language sql stable set search_path='' as $$
  select t.stage,count(*) filter(where t.status<>'done'),
    coalesce(max(r.updated),0),coalesce(max(r.failed),0),coalesce(max(r.skipped),0),coalesce(max(r.warning),0)
  from ml.ml_sync_tasks t left join (
    select stage,count(*) filter(where outcome='updated') updated,count(*) filter(where outcome='failed') failed,
      count(*) filter(where outcome='skipped') skipped,count(*) filter(where outcome='warning') warning
    from ml.ml_sync_results where run_id=p_run group by stage
  ) r on r.stage=t.stage where t.run_id=p_run group by t.stage,t.stage_order order by t.stage_order;
$$;
revoke all on function ml.manual_sync_stage_summary(uuid) from public,anon,authenticated;
grant execute on function ml.manual_sync_stage_summary(uuid) to service_role;
