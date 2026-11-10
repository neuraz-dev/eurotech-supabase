#!/usr/bin/env python3
"""Verify the complete migration in a rollback-only schema in the SAME local DB."""
from pathlib import Path
import subprocess

root = Path(__file__).resolve().parent.parent
baseline = (root / 'supabase/local/baseline.sql').read_text()
start = baseline.index('-- Move MercadoLibre objects out of public')
end = baseline.index('alter table ml.ml_competitor_items', start)
baseline = baseline[:start] + baseline[end:]
baseline = '\n'.join(line for line in baseline.splitlines() if not line.startswith('create extension'))
migration = next((root / 'supabase/migrations').glob('*_monitor_prioritary_improvements.sql')).read_text()
checks = (root / 'supabase/local/verify.sql').read_text().replace('\\set ON_ERROR_STOP on', '').replace('begin;', '', 1)
checks = checks.rsplit('rollback;', 1)[0]
schema = 'monitor_migration_verify'
legacy_tables = migration[migration.index('create table if not exists ml.ml_tracked_items'):migration.index('alter table ml.ml_tracked_items')]
legacy_tables += "\ninsert into ml.ml_tracked_items(ml_item_id,url,title) values('MLU901','https://www.mercadolibre.com.uy/p/MLU901','Legado ambiguo');\n"
sql = baseline + '\n' + legacy_tables + '\n' + migration + '\n' + checks
legacy_acceptance = next((root / 'supabase/migrations').glob('*_accept_legacy_manual_equivalence.sql')).read_text()
sql += "\nupdate ml.ml_competitor_links set equivalence='rejected' where our_product_id='MLU102';\n"
sql += legacy_acceptance
sql += """
DO $$ BEGIN
IF NOT EXISTS (SELECT 1 FROM ml.ml_competitor_links WHERE competitor_item_id='MLU200'
  AND scope='sku' AND equivalence='accepted' AND review_source='legacy_manual_assignment'
  AND reviewed_at IS NOT NULL AND reviewed_by IS NULL)
THEN RAISE EXCEPTION 'Existing manual assignment was not recognized'; END IF;
IF NOT EXISTS (SELECT 1 FROM ml.ml_competitor_links WHERE our_product_id='MLU100' AND equivalence='pending')
THEN RAISE EXCEPTION 'New association was accepted implicitly'; END IF;
IF NOT EXISTS (SELECT 1 FROM ml.ml_competitor_links WHERE our_product_id='MLU102' AND equivalence='rejected')
THEN RAISE EXCEPTION 'Explicit rejection was overwritten'; END IF;
END $$;
"""
event_migration = next((root / 'supabase/migrations').glob('*_alert_events_and_history.sql')).read_text()
event_checks = (root / 'supabase/local/verify-alert-events.sql').read_text().replace('\\set ON_ERROR_STOP on', '').replace('begin;', '', 1).rsplit('rollback;', 1)[0]
sql += '\n' + event_migration + '\n' + event_checks
source_migration=next((root / 'supabase/migrations').glob('*_monitor_source_resolution.sql')).read_text()
sql+='\n'+source_migration
source_checks=(root/'supabase/local/verify-source-resolution.sql').read_text().replace('\\set ON_ERROR_STOP on','').replace('begin;','',1).rsplit('rollback;',1)[0]
sql+='\n'+source_checks
sql+="\ninsert into ml.ml_monitor_repairs(key,kind,sku) values('legacy-fixed:7270:255754420','recover_fixed','7270');\n"
sql+='\n'+next((root/'supabase/migrations').glob('*_monitor_7270_dynamic_catalog.sql')).read_text()
sql+="\nDO $$ BEGIN IF NOT EXISTS(select 1 from ml.ml_monitor_repairs where key='legacy-fixed:7270:255754420' and status='resolved' and evidence->>'resolutionStrategy'='dynamic_catalog_only' and evidence->>'fixedItemCreated'='false') THEN RAISE EXCEPTION '7270 catalog decision not preserved'; END IF; END $$;\n"
sql = sql.replace('public.', f'{schema}.').replace('ml.', f'{schema}.')
sql = 'BEGIN;\nCREATE SCHEMA ' + schema + ';\nSET LOCAL search_path TO '+schema+',public;\n' + sql
sql += "\nDO $$ BEGIN IF NOT EXISTS(select 1 from "+schema+".ml_tracked_items where target_id='MLU901' and target_review_required) THEN RAISE EXCEPTION 'Ambiguous legacy target not flagged'; END IF; END $$;\n"
sql += "\nDO $$ BEGIN IF " + schema + ".normalize_monitor_sku(E' \\tSKU-v\\n ') <> 'sku-v' THEN RAISE EXCEPTION 'SKU whitespace mismatch'; END IF; END $$;\nROLLBACK;\n"
subprocess.run(
    ['docker', 'exec', '-i', 'supabase_db_eurotech-monitor-improvements', 'psql', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1'],
    input=sql, text=True, check=True,
)
