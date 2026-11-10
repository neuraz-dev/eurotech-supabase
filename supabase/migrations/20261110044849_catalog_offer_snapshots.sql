-- Catalog snapshots are server-only, shared by all own publications in a catalog.
create table ml.ml_catalog_snapshots (
  catalog_product_id text primary key check(catalog_product_id ~ '^ML[AU][0-9]+$'),
  snapshot jsonb,
  observed_at timestamptz,
  last_attempt_at timestamptz not null default now(),
  last_error text,
  check(snapshot is null or jsonb_typeof(snapshot) = 'object')
);
alter table ml.ml_catalog_snapshots enable row level security;
revoke all on ml.ml_catalog_snapshots from public, anon, authenticated;
grant all on ml.ml_catalog_snapshots to service_role;

-- A failed attempt must never delete or renew the last successful observation.
create function ml.record_catalog_snapshot(p_catalog text, p_snapshot jsonb, p_error text)
returns void language sql set search_path='' as $$
  insert into ml.ml_catalog_snapshots(catalog_product_id,snapshot,observed_at,last_attempt_at,last_error)
  values(p_catalog,p_snapshot,(p_snapshot->>'observedAt')::timestamptz,now(),p_error)
  on conflict(catalog_product_id) do update set
    snapshot=case when excluded.snapshot is not null and (ml.ml_catalog_snapshots.observed_at is null or excluded.observed_at >= ml.ml_catalog_snapshots.observed_at)
      then excluded.snapshot else ml.ml_catalog_snapshots.snapshot end,
    observed_at=greatest(ml.ml_catalog_snapshots.observed_at,excluded.observed_at),
    last_attempt_at=excluded.last_attempt_at,
    last_error=excluded.last_error;
$$;
revoke all on function ml.record_catalog_snapshot(text,jsonb,text) from public,anon,authenticated;
grant execute on function ml.record_catalog_snapshot(text,jsonb,text) to service_role;

create or replace function ml.start_manual_sync(p_action text,p_target text,p_origin text,p_user uuid,p_label text,p_request uuid)
returns ml.ml_sync_runs language plpgsql set search_path='' as $$
declare r ml.ml_sync_runs; scope text; stages text[]; stage text; n integer:=0;
begin
  if p_action not in ('all','own','catalog','rivals','tracked','product') or (p_action='product' and nullif(p_target,'') is null)
    or (p_action not in ('product','catalog') and p_target is not null)
    or (p_target is not null and p_target !~ '^ML[AU][0-9]+$') or p_user is null then raise exception 'Alcance inválido'; end if;
  if p_action='catalog' and p_target is not null then
    if not exists(select 1 from ml.ml_products where id=p_target and catalog_listing is true and catalog_product_id is not null) then
      raise exception 'La publicación no tiene catálogo asociado';
    end if;
    select 'catalog:'||catalog_product_id into scope from ml.ml_products where id=p_target;
  else
    scope:=p_action||':'||coalesce(p_target,'');
  end if;
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

