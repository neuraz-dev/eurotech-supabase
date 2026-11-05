#!/usr/bin/env bash
# Read-only diagnostics. Never print cron commands, credentials or token rows.
set -Eeuo pipefail
SERVICE_UUID="${COOLIFY_SUPABASE_SERVICE_UUID:-bbbxl4gqwtuiu30nj1khefau}"
sudo -n docker exec -i "supabase-db-${SERVICE_UUID}" \
  psql -X -v ON_ERROR_STOP=1 -U postgres -d postgres <<'SQL'
select jobid, jobname, schedule, active from cron.job
where jobname like '%competitor%' or jobname like 'ml-sync%';
select jobid, status, start_time, end_time from cron.job_run_details
where command ilike '%competitor%' order by start_time desc limit 10;
select now(), count(*) as rivals, max(synced_at) as last_data_update
from ml.ml_competitor_items;
select name, case when name like '%url' then decrypted_secret
  else '[configured]' end as configuration
from vault.decrypted_secrets where name in (
  'sync_ml_to_web_url', 'sync_ml_to_web_apikey', 'supabase_service_key',
  'sync_ml_competitor_url', 'sync_ml_competitor_apikey'
);
select id, status_code, timed_out, created,
  content::jsonb->>'success' as success,
  content::jsonb->>'items_updated' as updated,
  content::jsonb->>'items_failed' as failed,
  content::jsonb->>'alert_errors' as alert_errors
from net._http_response where content like '%"items_processed"%'
  and content like '%"items_updated"%'
order by created desc limit 5;
SQL
sudo -n docker exec "supabase-edge-functions-${SERVICE_UUID}" sh -c '
  printf "SUPABASE_URL="; printenv SUPABASE_URL
  for name in SUPABASE_SERVICE_ROLE_KEY SYNC_OWN_SECRET ML_SYNC_TRIGGER_SECRET SUPABASE_SECRET_KEY; do
    if printenv "$name" >/dev/null; then echo "$name=configured"; fi
  done'
