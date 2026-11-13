#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVICE_UUID="${COOLIFY_SUPABASE_SERVICE_UUID:-bbbxl4gqwtuiu30nj1khefau}"
VOLUME_ROOT="${COOLIFY_SUPABASE_VOLUME_ROOT:-/data/coolify/services/${SERVICE_UUID}/volumes}"
DB_CONTAINER="${COOLIFY_SUPABASE_DB_CONTAINER:-supabase-db-${SERVICE_UUID}}"
FUNCTIONS_CONTAINER="${COOLIFY_SUPABASE_FUNCTIONS_CONTAINER:-supabase-edge-functions-${SERVICE_UUID}}"
RUN_LOCAL="${COOLIFY_RUN_LOCAL:-0}"

if [[ "$RUN_LOCAL" != "1" ]]; then
  echo "Este script debe ejecutarse en el runner de Oracle con COOLIFY_RUN_LOCAL=1." >&2
  exit 1
fi

run_docker() {
  sudo -n docker "$@"
}

psql() {
  run_docker exec -i "$DB_CONTAINER" psql -X -v ON_ERROR_STOP=1 -U postgres -d postgres "$@"
}

ensure_runtime() {
  if [[ "$(run_docker inspect --format '{{.State.Running}}' "$FUNCTIONS_CONTAINER")" != "true" ]]; then
    echo "El runtime de Edge Functions no está ejecutándose: $FUNCTIONS_CONTAINER" >&2
    exit 1
  fi
}

verify_legacy_ml_baseline() {
  # El dump inicial ya contiene el esquema ML. Antes de registrar las migraciones
  # históricas comprobamos los objetos que representan sus cambios acumulados.
  psql -At <<'SQL' | grep -qx 'baseline-ok'
WITH expected_tables(table_name) AS (
  VALUES
    ('ml_categories'),
    ('ml_competitor_items'),
    ('ml_price_alert_rules'),
    ('ml_price_alerts'),
    ('ml_products'),
    ('ml_tracked_items'),
    ('ml_tracked_snapshots')
), expected_columns(table_name, column_name) AS (
  VALUES
    ('ml_categories', 'full_path'),
    ('ml_competitor_items', 'our_product_id'),
    ('ml_competitor_items', 'usd_price'),
    ('ml_products', 'catalog_price'),
    ('ml_products', 'sale_price')
), missing AS (
  SELECT table_name || '.' || column_name AS name
  FROM expected_columns
  EXCEPT
  SELECT table_name || '.' || column_name
  FROM information_schema.columns
  WHERE table_schema = 'ml'
  UNION ALL
  SELECT table_name
  FROM expected_tables
  EXCEPT
  SELECT table_name
  FROM information_schema.tables
  WHERE table_schema = 'ml'
)
SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM missing) THEN 'baseline-ok' END;
SQL
}

init_migration_tracking() {
  psql <<'SQL'
CREATE SCHEMA IF NOT EXISTS deployment;
CREATE TABLE IF NOT EXISTS deployment.monitor_migrations (
  version text PRIMARY KEY,
  filename text NOT NULL,
  checksum text NOT NULL,
  deployed_at timestamptz NOT NULL DEFAULT now()
);
SQL
}

legacy_migrations=(
  20260324000000_create_ml_products.sql
  20260324000001_add_ml_products_columns.sql
  20260325000000_create_ml_extra_tables.sql
  20260331000000_add_sku_and_competitor_items.sql
  20260403000000_add_price_alerts.sql
  20260408000000_add_catalog_price_and_categories.sql
  20260408000001_add_category_full_path.sql
  20260409000000_add_user_product_id.sql
  20260409000001_add_competitor_status.sql
  20260409000002_add_buybox_price.sql
  20260409000003_add_seller_name.sql
  20260410000000_add_read_at_to_price_alerts.sql
  20260413000000_add_fk_price_alerts_competitor_items.sql
  20260413000001_add_usd_price_to_competitor_items.sql
  20260413000002_add_sale_price_to_snapshots.sql
  20260421000000_add_sale_price_to_ml_products.sql
  20260505000000_move_ml_tables_to_ml_schema.sql
  20260518000000_add_our_product_id_to_competitor_items.sql
  20260714000000_fix_sku_conflict_review_source_fk.sql
)

bootstrap_legacy_migrations() {
  local tracked
  tracked="$(psql -Atc 'SELECT count(*) FROM deployment.monitor_migrations')"
  if [[ "$tracked" != "0" ]]; then
    return
  fi

  verify_legacy_ml_baseline

  for filename in "${legacy_migrations[@]}"; do
    local file="$ROOT_DIR/supabase/migrations/$filename"
    local version="${filename%%_*}"
    local checksum
    checksum="$(shasum -a 256 "$file" | awk '{print $1}')"
    psql -v version="$version" -v filename="$filename" -v checksum="$checksum" <<'SQL'
INSERT INTO deployment.monitor_migrations (version, filename, checksum)
VALUES (:'version', :'filename', :'checksum');
SQL
  done

  echo "Historial ML existente registrado sin reejecutar migraciones históricas."
}

apply_pending_migrations() {
  local file filename version checksum recorded
  while IFS= read -r file; do
    filename="$(basename "$file")"
    version="${filename%%_*}"
    if [[ ! "$version" =~ ^[0-9]{14}$ ]]; then
      echo "Nombre de migración inválido: $filename" >&2
      exit 1
    fi
    checksum="$(shasum -a 256 "$file" | awk '{print $1}')"
    recorded="$(psql -Atc "SELECT checksum FROM deployment.monitor_migrations WHERE version = '$version'")"

    if [[ -n "$recorded" ]]; then
      if [[ "$recorded" != "$checksum" ]]; then
        echo "La migración registrada $filename cambió después de aplicarse." >&2
        exit 1
      fi
      continue
    fi

    echo "Aplicando migración $filename"
    {
      printf 'BEGIN;\n'
      cat "$file"
      printf "\nINSERT INTO deployment.monitor_migrations (version, filename, checksum) VALUES ('%s', '%s', '%s');\n" "$version" "$filename" "$checksum"
      printf 'COMMIT;\n'
    } | psql
  done < <(find "$ROOT_DIR/supabase/migrations" -maxdepth 1 -type f -name '*.sql' -print | sort)
}

sync_functions() {
  local function_dir function_name
  local sync_options
  for function_dir in "$ROOT_DIR"/supabase/functions/*; do
    [[ -d "$function_dir" ]] || continue
    function_name="$(basename "$function_dir")"
    echo "Sincronizando Edge Function $function_name"
    sudo -n mkdir -p "$VOLUME_ROOT/functions/$function_name"
    sync_options=(-az --checksum --exclude='.DS_Store' --exclude='._*')
    # Gestor also owns files in _shared (including self-hosted-auth.ts).
    # Delete obsolete files only inside Monitor's own function directories.
    if [[ "$function_name" != "_shared" ]]; then
      sync_options+=(--delete)
    fi
    sudo -n rsync "${sync_options[@]}" \
      "$function_dir/" "$VOLUME_ROOT/functions/$function_name/"
  done

  run_docker restart "$FUNCTIONS_CONTAINER" >/dev/null
  ensure_runtime
}

ensure_runtime
init_migration_tracking
bootstrap_legacy_migrations
apply_pending_migrations
sync_functions

echo "Migraciones y Edge Functions de Monitor desplegadas en el Supabase autoalojado."
