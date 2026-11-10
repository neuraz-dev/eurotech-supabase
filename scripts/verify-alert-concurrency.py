#!/usr/bin/env python3
"""Concurrent CAS check in a disposable schema inside the same local Postgres."""
from concurrent.futures import ThreadPoolExecutor
import json
import subprocess
import uuid

container = 'supabase_db_eurotech-monitor-improvements'
schema = 'monitor_event_check_' + uuid.uuid4().hex[:12]

def sql(text):
    result = subprocess.run(
        ['docker', 'exec', '-i', container, 'psql', '-X', '-q', '-A', '-t',
         '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1'],
        input=text, text=True, capture_output=True, check=True,
    )
    return result.stdout.strip()

ddl = subprocess.check_output(
    ['docker', 'exec', container, 'pg_dump', '-U', 'postgres', '-d', 'postgres',
     '--schema-only', '--schema=ml', '--no-owner', '--no-privileges'], text=True,
)
ddl = ddl.replace('SCHEMA ml', 'SCHEMA ' + schema).replace('ml.', schema + '.')
created = False
try:
    seed = """
    insert into ml.ml_products(id,sku,title,status,price,currency_id) values('CAS-OWN','cas','Test','active',100,'UYU');
    insert into ml.ml_competitor_items(id,our_sku,status,price,currency_id,observation)
      values('CAS-RIVAL','cas','active',90,'UYU','{"amount":90,"currency":"UYU","observedAt":"2020-01-01T00:00:00Z"}');
    insert into ml.ml_competitor_links(competitor_item_id,scope,our_product_id,equivalence) values('CAS-RIVAL','publication','CAS-OWN','accepted');
    insert into ml.ml_price_alert_rules(id,name,rule_type) values('00000000-0000-0000-0000-000000000099','Test','competitor_cheaper');
    """.replace('ml.', schema + '.')
    sql('BEGIN;\n' + ddl + '\n' + seed + '\nCOMMIT;')
    created = True
    event = json.dumps({
        'rule_id': '00000000-0000-0000-0000-000000000099', 'our_sku': 'cas',
        'our_product_id': 'CAS-OWN', 'our_price': 100, 'competitor_price_before': 90,
        'competitor_price_after': 80, 'diff_pct': 20, 'fired_at': '2026-01-01T00:00:00Z',
        'event_snapshot': {'version': 2, 'relativePct': -20, 'rows': [], 'own': {'id': 'CAS-OWN'}, 'rival': {'id': 'CAS-RIVAL'}},
        'matched_rules': [],
    })
    update = json.dumps({'price': 80, 'status': 'active', 'availability': 'available',
                         'observation': {'amount': 80, 'currency': 'UYU', 'observedAt': '2026-01-01T00:00:00Z'}})
    query = f"select {schema}.record_monitor_observation('CAS-RIVAL',0,'{update}'::jsonb,'[{event}]'::jsonb);"
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(lambda _: json.loads(sql(query)), range(2)))
    assert sum(result.get('alerts', 0) for result in results) == 1, results
    assert sum(bool(result.get('conflict')) for result in results) == 1, results
    assert sql(f'select count(*) from {schema}.ml_price_alerts;') == '1'
    assert sql(f'select observation_revision from {schema}.ml_competitor_items;') == '1'
    print('Concurrencia real aprobada: un evento persistido, un conflicto recuperable y una revisión.')
    # Different logical destinations can observe the same physical offer at once.
    sql(f"""
      insert into {schema}.ml_competitor_items(id,target_kind,status,price,currency_id,observation)
      values ('MLU900301','catalog','active',90,'UYU','{{"amount":90,"currency":"UYU"}}'),
             ('MLU900302','item','active',90,'UYU','{{"amount":90,"currency":"UYU"}}');
      insert into {schema}.ml_competitor_links(competitor_item_id,scope,our_product_id,equivalence)
      values ('MLU900301','publication','CAS-OWN','accepted'),('MLU900302','publication','CAS-OWN','accepted');
    """)
    physical_update = json.loads(update)
    physical_update['observation']['itemId'] = 'MLU900302'
    physical_update = json.dumps(physical_update)
    queries = [f"select {schema}.record_monitor_observation('{rival}',0,'{physical_update}'::jsonb,'[{event}]'::jsonb);"
               for rival in ('MLU900301', 'MLU900302')]
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(lambda query: json.loads(sql(query)), queries))
    assert sum(result.get('alerts', 0) for result in results) == 1, results
    assert not any(result.get('conflict') for result in results), results
    assert sql(f"select count(*) from {schema}.ml_price_event_origins where rival_id in ('MLU900301','MLU900302');") == '2'
    assert sql(f"select count(*) from {schema}.ml_price_event_claims where item_id='MLU900302';") == '1'
    print('Dos destinos concurrentes: un cambio físico, un evento y ambas procedencias conservadas.')
finally:
    if created:
        sql('DROP SCHEMA ' + schema + ' CASCADE;')
