#!/usr/bin/env bash
# Targeted server-side rollout. Run from the reviewed bundle, never from a client.
set -Eeuo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVICE_UUID="${COOLIFY_SUPABASE_SERVICE_UUID:-bbbxl4gqwtuiu30nj1khefau}"
VOLUME_ROOT="${COOLIFY_SUPABASE_VOLUME_ROOT:-/data/coolify/services/${SERVICE_UUID}/volumes}"
DB_CONTAINER="supabase-db-${SERVICE_UUID}"
FUNCTIONS_CONTAINER="supabase-edge-functions-${SERVICE_UUID}"
MIGRATION_NAME="20261105165701_restore_competitor_sync_schedule.sql"
MIGRATION_VERSION="${MIGRATION_NAME%%_*}"
MIGRATION_FILE="$ROOT_DIR/supabase/migrations/$MIGRATION_NAME"
FUNCTION_SOURCE="$ROOT_DIR/supabase/functions/ml-sync-competitor"
FUNCTION_TARGET="$VOLUME_ROOT/functions/ml-sync-competitor"

psql() {
  # Only streamed migrations need stdin. Forwarding it for -c queries can
  # consume the remaining commands of a pasted heredoc installer.
  local stdin_flags=(-i)
  local argument
  for argument in "$@"; do
    case "$argument" in -c|-Atc|--command) stdin_flags=();; esac
  done
  sudo -n docker exec "${stdin_flags[@]}" "$DB_CONTAINER" psql -X -v ON_ERROR_STOP=1 -U postgres -d postgres "$@"
}
fail() { printf '%s\n' "$*" >&2; exit 1; }

[[ "${1:-}" == "--check" || "${1:-}" == "--apply" ]] || fail "Uso: bash scripts/deploy-competitor-sync.sh --check|--apply"
[[ -f "$MIGRATION_FILE" && -f "$FUNCTION_SOURCE/index.ts" && -f "$FUNCTION_SOURCE/handler.ts" ]] || fail "Paquete incompleto"
[[ "$(sudo -n docker inspect --format '{{.State.Running}}' "$FUNCTIONS_CONTAINER")" == true ]] || fail "El runtime no está activo"
sudo -n test -d "$FUNCTION_TARGET" || fail "No existe el directorio esperado de la función; comprobar VOLUME_ROOT"
runtime_url="$(sudo -n docker exec "$FUNCTIONS_CONTAINER" printenv SUPABASE_URL)"
expected_url="${runtime_url%/}/functions/v1/ml-sync-competitor"
vault_url="$(psql -Atc "select coalesce(
  (select decrypted_secret from vault.decrypted_secrets where name='sync_ml_competitor_url'),
  (select regexp_replace(decrypted_secret,'/sync-ml-to-web$','/ml-sync-competitor')
   from vault.decrypted_secrets where name='sync_ml_to_web_url'));")"
[[ "$vault_url" == "$expected_url" ]] || fail "La URL de Vault no coincide con el runtime autoalojado; no se modificó nada"

# Compare high-entropy credentials on the server without printing or passing
# their raw values as process arguments. MD5 here is equality checking only.
vault_fingerprint="$(psql -Atc "select md5(coalesce(
  (select decrypted_secret from vault.decrypted_secrets where name='sync_ml_competitor_apikey'),
  (select decrypted_secret from vault.decrypted_secrets where name='sync_ml_to_web_apikey')));")"
runtime_fingerprints="$(sudo -n docker exec "$FUNCTIONS_CONTAINER" sh -c '
  for name in SUPABASE_SERVICE_ROLE_KEY SYNC_OWN_SECRET ML_SYNC_TRIGGER_SECRET SUPABASE_SECRET_KEY; do
    value="$(printenv "$name" || true)"
    if [ -n "$value" ]; then printf "%s" "$value" | md5sum | cut -d " " -f1; fi
  done')"
[[ -n "$vault_fingerprint" ]] || fail "Falta la credencial de Vault"
matched=false
while IFS= read -r fingerprint; do
  if [[ "$fingerprint" == "$vault_fingerprint" ]]; then matched=true; fi
done <<< "$runtime_fingerprints"
[[ "$matched" == true ]] || fail "La credencial de Vault no coincide con las aceptadas por el runtime; no se modificó nada"
unset vault_fingerprint runtime_fingerprints fingerprint

[[ "$(psql -Atc "select to_regclass('deployment.monitor_migrations') is not null;")" == t ]] || fail "Falta el registro deployment.monitor_migrations; revisar el despliegue existente antes de continuar"
migration_checksum="$(sha256sum "$MIGRATION_FILE" | cut -d ' ' -f1)"
recorded_checksum="$(psql -Atc "select checksum from deployment.monitor_migrations where version='$MIGRATION_VERSION';")"
[[ -z "$recorded_checksum" || "$recorded_checksum" == "$migration_checksum" ]] || fail "La migración registrada tiene otro checksum; no se modificó nada"
printf 'Preflight correcto: URL interna, credencial y registro de migraciones verificados.\n'
[[ "$1" == --apply ]] || exit 0

# Back up the existing function and replace only this function's source files.
backup_dir="$(sudo -n mktemp -d /tmp/ml-sync-competitor-backup.XXXXXXXX)"
sudo -n cp -a "$FUNCTION_TARGET/." "$backup_dir/"
printf 'Respaldo de la función: %s\n' "$backup_dir"
sudo -n install -m 0644 "$FUNCTION_SOURCE/handler.ts" "$FUNCTION_TARGET/handler.ts"
sudo -n install -m 0644 "$FUNCTION_SOURCE/index.ts" "$FUNCTION_TARGET/index.ts"
sudo -n docker restart "$FUNCTIONS_CONTAINER" >/dev/null
sleep 2
[[ "$(sudo -n docker inspect --format '{{.State.Running}}' "$FUNCTIONS_CONTAINER")" == true ]] || fail "El runtime no inició; restaurar la función desde $backup_dir"

if [[ -z "$recorded_checksum" ]]; then
  {
    printf 'BEGIN;\n'
    cat "$MIGRATION_FILE"
    printf "\nINSERT INTO deployment.monitor_migrations(version,filename,checksum) VALUES ('%s','%s','%s');\nCOMMIT;\n" \
      "$MIGRATION_VERSION" "$MIGRATION_NAME" "$migration_checksum"
  } | psql
fi

[[ "$(psql -Atc "select count(*) from cron.job where jobname='ml-sync-competitor-2h' and schedule='5 */2 * * *' and active;")" == 1 ]] || fail "La tarea de dos horas no está activa; revisar cron.job"
request_id="$(psql -Atc 'select ml.invoke_competitor_sync();')"
[[ "$request_id" =~ ^[0-9]+$ ]] || fail "La invocación no devolvió un ID válido"
printf 'Solicitud de verificación: %s. Esperando respuesta HTTP...\n' "$request_id"
for ((attempt=0; attempt<65; attempt++)); do
  response_count="$(psql -Atc "select count(*) from net._http_response where id=$request_id;")"
  if [[ "$response_count" == 1 ]]; then break; fi
  sleep 2
done
[[ "$response_count" == 1 ]] || fail "Sin respuesta HTTP todavía. Revisar la solicitud $request_id y los registros del runtime"
psql -c "select id,status_code,timed_out,
  case when content like '%\"items_processed\"%' then content::jsonb->>'success' end as success,
  case when content like '%\"items_processed\"%' then content::jsonb->>'items_updated' end as updated,
  case when content like '%\"items_processed\"%' then content::jsonb->>'items_failed' end as failed,
  case when content like '%\"items_processed\"%' then content::jsonb->>'alert_errors' end as alert_errors
  from net._http_response where id=$request_id;"
updated="$(psql -Atc "select case when content like '%\"items_processed\"%'
  then coalesce(content::jsonb->>'items_updated','0')::integer else 0 end
  from net._http_response where id=$request_id;")"
[[ "$updated" =~ ^[0-9]+$ && "$updated" -gt 0 ]] || fail "La función no actualizó rivales. La tarea está instalada; revisar autenticación, token ML y registros antes de dar el despliegue por validado"
printf 'Cron restaurado y actualización controlada comprobada. Revisar los fallos parciales y la próxima ejecución programada.\n'
