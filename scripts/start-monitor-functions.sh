#!/usr/bin/env bash
set -Eeuo pipefail
LOCAL_DIR="${MONITOR_LOCAL_DIR:-/tmp/eurotech-monitor-local}"
if docker ps --format '{{.Names}}' | rg '^supabase[-_]' | rg -v 'eurotech-monitor-improvements' >/dev/null; then
  echo "Hay otro Supabase activo; detenerlo antes de iniciar las funciones del Monitor." >&2
  exit 1
fi
if [[ ! -f "$LOCAL_DIR/supabase/config.toml" ]] || ! rg -q '^project_id = "eurotech-monitor-improvements"$' "$LOCAL_DIR/supabase/config.toml"; then
  echo "Primero iniciar la instancia aislada con scripts/start-monitor-local.sh." >&2
  exit 1
fi
[[ "$(docker inspect --format '{{.State.Running}}' supabase_db_eurotech-monitor-improvements)" == true ]]
umask 077
cat > "$LOCAL_DIR/edge-live.env" <<'ENV'
ML_API_BASE_URL=https://api.mercadolibre.com
MONITOR_FX_URL=https://open.er-api.com/v6/latest/USD
ENV
printf '%s\n' real-live > "$LOCAL_DIR/data-mode"
# Supabase injects credentials for this local project. No production credentials
# or OAuth client secrets are passed to the runtime.
# The CLI can recreate the container during hot reload. Reapply the local
# resource ceiling to each new runtime ID, without starting another stack.
supabase functions serve --workdir "$LOCAL_DIR" --env-file "$LOCAL_DIR/edge-live.env" &
serve_pid=$!
cleanup() {
  trap - EXIT INT TERM
  kill "$serve_pid" 2>/dev/null || true
  wait "$serve_pid" 2>/dev/null || true
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
runtime_id=''
while kill -0 "$serve_pid" 2>/dev/null; do
  current_id="$(docker inspect --format '{{if .State.Running}}{{.Id}}{{end}}' supabase_edge_runtime_eurotech-monitor-improvements 2>/dev/null || true)"
  if [[ -n "$current_id" && "$current_id" != "$runtime_id" ]]; then
    docker update --memory 768m --memory-swap 1g --cpus 1 "$current_id" >/dev/null
    runtime_id="$current_id"
  fi
  sleep 2
done
wait "$serve_pid"
