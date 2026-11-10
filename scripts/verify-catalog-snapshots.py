#!/usr/bin/env python3
"""Verify catalog persistence, permissions and scoped queueing in a rollback-only local transaction."""
from pathlib import Path
import subprocess

root = Path(__file__).resolve().parent.parent
migration = next((root / 'supabase/migrations').glob('*_catalog_offer_snapshots.sql')).read_text()
checks = r'''
select ml.record_catalog_snapshot('MLU991001', '{"observedAt":"2026-11-09T12:00:00Z","offers":[]}', null);
select ml.record_catalog_snapshot('MLU991001', null, 'Consulta HTTP 403');
do $$ begin
  if not exists(select 1 from ml.ml_catalog_snapshots where catalog_product_id='MLU991001'
    and observed_at='2026-11-09T12:00:00Z' and snapshot->'offers'='[]'::jsonb and last_error='Consulta HTTP 403') then
    raise exception 'A failed attempt deleted or renewed the last successful snapshot';
  end if;
end $$;
select ml.record_catalog_snapshot('MLU991001', '{"observedAt":"2026-11-08T12:00:00Z","offers":[1]}', null);
do $$ begin
  if not exists(select 1 from ml.ml_catalog_snapshots where catalog_product_id='MLU991001' and snapshot->'offers'='[]'::jsonb) then
    raise exception 'An older completion overwrote the newest snapshot';
  end if;
  if has_table_privilege('anon','ml.ml_catalog_snapshots','SELECT') or has_table_privilege('authenticated','ml.ml_catalog_snapshots','SELECT') then
    raise exception 'Snapshots must be accessible only through authenticated server routes';
  end if;
  if has_function_privilege('authenticated','ml.record_catalog_snapshot(text,jsonb,text)','EXECUTE') then
    raise exception 'Snapshot writes must remain server-only';
  end if;
  if not (select relrowsecurity from pg_class where oid='ml.ml_catalog_snapshots'::regclass) then
    raise exception 'RLS must be enabled';
  end if;
end $$;
-- Do not dispatch any network requests while testing queue semantics.
create or replace function ml.dispatch_manual_sync() returns bigint language sql security definer set search_path='' as $$ select 0::bigint $$;
insert into ml.ml_products(id,title,catalog_listing,catalog_product_id) values
 ('MLU991011','Prueba A',true,'MLU991001'),('MLU991012','Prueba B',true,'MLU991001');
do $$ declare a ml.ml_sync_runs; b ml.ml_sync_runs; invalid boolean := false; begin
 a := ml.start_manual_sync('catalog','MLU991011','verification','11111111-1111-1111-1111-111111111111','local',gen_random_uuid());
 b := ml.start_manual_sync('catalog','MLU991012','verification','11111111-1111-1111-1111-111111111111','local',gen_random_uuid());
 if a.id<>b.id or a.scope_key<>'catalog:MLU991001' then raise exception 'Related publications must deduplicate the same catalog run'; end if;
 if exists(select 1 from ml.ml_sync_tasks where run_id=a.id and stage<>'catalog') then raise exception 'Scoped catalog sync queued unrelated stages'; end if;
 begin
   perform ml.start_manual_sync('catalog','MLU991099','verification','11111111-1111-1111-1111-111111111111','local',gen_random_uuid());
 exception when others then invalid := true; end;
 if not invalid then raise exception 'A missing catalog target was accepted'; end if;
end $$;
'''
subprocess.run(['docker', 'exec', '-i', 'supabase_db_eurotech-monitor-improvements',
    'psql', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1'],
    input='begin;\ndrop function if exists ml.record_catalog_snapshot(text,jsonb,text);\ndrop table if exists ml.ml_catalog_snapshots;\n' + migration + checks + '\nrollback;\n', text=True, check=True)
print('Catalog persistence, RLS and scoped queue checks passed (rolled back).')
