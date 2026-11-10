#!/usr/bin/env bash
set -Eeuo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOCAL_DIR="${MONITOR_LOCAL_DIR:-/tmp/eurotech-monitor-local}"
# This workstation runs ONE Supabase stack at a time. Never stop another project.
if docker ps --format '{{.Names}}' | rg '^supabase[-_]' | rg -v 'eurotech-monitor-improvements' >/dev/null; then
  echo "Ya hay otra instancia de Supabase activa. Detenela antes de iniciar las pruebas de Monitor." >&2
  exit 1
fi
python3 - <<'PY'
import socket
with socket.socket() as sock:
    sock.settimeout(1)
    if sock.connect_ex(('127.0.0.1', 54321)) == 0:
        raise SystemExit('El puerto de otro Supabase local (54321) está ocupado; no se inicia otro stack.')
PY
mkdir -p "$LOCAL_DIR/supabase/migrations"
cat > "$LOCAL_DIR/supabase/config.toml" <<'TOML'
project_id = "eurotech-monitor-improvements"
[api]
enabled = true
port = 55421
schemas = ["public", "graphql_public", "ml"]
max_rows = 1000
[db]
port = 55422
shadow_port = 55420
major_version = 17
[studio]
enabled = false
[analytics]
enabled = false
[storage]
enabled = false
[realtime]
enabled = false
[inbucket]
enabled = false
[auth]
enabled = true
site_url = "http://localhost:3000"
additional_redirect_urls = ["http://127.0.0.1:3000"]
[functions.ml-sync-competitor]
verify_jwt = false
[functions.ml-sync]
verify_jwt = false
[functions.ml-scrape-tracked]
verify_jwt = false
TOML
if [[ "$(supabase --version)" == 3.* ]]; then
  sed -i 's/^\[inbucket\]/[local_smtp]/' "$LOCAL_DIR/supabase/config.toml"
fi
if rg -q 'cron\.(schedule|unschedule)|net\.http_post|https://' "$ROOT_DIR/supabase/local/baseline.sql"; then
  echo "Baseline local insegura; se cancela el arranque." >&2
  exit 1
fi
# Intentionally never copy historical cron or migrations referencing other projects.
cp "$ROOT_DIR/supabase/local/baseline.sql" "$LOCAL_DIR/supabase/migrations/20261108000000_local_baseline.sql"
cp "$ROOT_DIR"/supabase/migrations/*_monitor_prioritary_improvements.sql "$LOCAL_DIR/supabase/migrations/"
cp "$ROOT_DIR"/supabase/migrations/*_accept_legacy_manual_equivalence.sql "$LOCAL_DIR/supabase/migrations/"
cp "$ROOT_DIR"/supabase/migrations/*_alert_events_and_history.sql "$LOCAL_DIR/supabase/migrations/"
cp "$ROOT_DIR"/supabase/migrations/*_monitor_source_resolution.sql "$LOCAL_DIR/supabase/migrations/"
cp "$ROOT_DIR"/supabase/migrations/*_monitor_7270_dynamic_catalog.sql "$LOCAL_DIR/supabase/migrations/"
cp "$ROOT_DIR"/supabase/migrations/*_manual_sync_history.sql "$LOCAL_DIR/supabase/migrations/"
cp "$ROOT_DIR"/supabase/migrations/*_catalog_offer_snapshots.sql "$LOCAL_DIR/supabase/migrations/"
cp "$ROOT_DIR/supabase/local/fixture-guard.sql" "$LOCAL_DIR/supabase/migrations/20261109012208_local_fixture_guard.sql"
if [[ ! -e "$LOCAL_DIR/supabase/functions" ]]; then ln -s "$ROOT_DIR/supabase/functions" "$LOCAL_DIR/supabase/functions"; fi
# The CLI treats an existing stopped database as an already-started stack.
# Resume the minimal services directly, preserving containers and volumes.
SERVICES=(db auth rest kong)
EXISTING=0
for service in "${SERVICES[@]}"; do
  if docker container inspect "supabase_${service}_eurotech-monitor-improvements" >/dev/null 2>&1; then
    EXISTING=$((EXISTING + 1))
  fi
done
if (( EXISTING == 4 )); then
  docker start supabase_db_eurotech-monitor-improvements >/dev/null
  READY=false
  for attempt in {1..60}; do
    if docker exec supabase_db_eurotech-monitor-improvements pg_isready -U postgres >/dev/null 2>&1; then
      READY=true
      break
    fi
    sleep 1
  done
  if [[ "$READY" != true ]]; then
    echo "PostgreSQL no está listo. Revisar docker logs supabase_db_eurotech-monitor-improvements." >&2
    exit 1
  fi
  docker start supabase_auth_eurotech-monitor-improvements supabase_rest_eurotech-monitor-improvements supabase_kong_eurotech-monitor-improvements >/dev/null
elif (( EXISTING > 0 )); then
  echo "La instancia existente está incompleta; se conservan sus datos. Revisar los contenedores antes de continuar." >&2
  exit 1
else
  supabase start --workdir "$LOCAL_DIR" --exclude logflare,studio,storage-api,imgproxy,realtime,vector,postgres-meta,mailpit,edge-runtime,supavisor
fi
python3 - <<'PY'
import time
import urllib.request
for attempt in range(60):
    try:
        with urllib.request.urlopen('http://127.0.0.1:55421/auth/v1/health', timeout=2) as response:
            if response.status == 200:
                break
    except (OSError, urllib.error.URLError):
        pass
    time.sleep(1)
else:
    raise SystemExit('La API de autenticación no está lista; revisar los logs de auth y kong.')
PY
echo "Monitor local: $LOCAL_DIR (sin tareas programadas)."
echo "Consultar credenciales locales con: supabase status --workdir $LOCAL_DIR"
