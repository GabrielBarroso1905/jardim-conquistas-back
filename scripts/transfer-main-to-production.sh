#!/usr/bin/env bash
# Sincroniza dados da main (.env_main) → production (.env): PostgreSQL + Supabase Storage.
#
# Uso:
#   npm run sync:main-to-prod:dry-run
#   npm run sync:main-to-prod -- --yes
#   npm run sync:main-to-prod -- --storage-only --prefix assets/
#   npm run sync:main-to-prod -- --db-only --yes

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DRY_RUN=false
YES=false
STORAGE_ONLY=false
DB_ONLY=false
STORAGE_ARGS=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN=true ;;
    --yes) YES=true ;;
    --storage-only) STORAGE_ONLY=true ;;
    --db-only) DB_ONLY=true ;;
    --prefix)
      shift
      STORAGE_ARGS+=(--prefix "${1:-}")
      ;;
    --skip-existing) STORAGE_ARGS+=(--skip-existing) ;;
    -h | --help)
      echo "Uso: $0 [--dry-run] [--yes] [--storage-only] [--db-only] [--prefix assets/] [--skip-existing]"
      exit 0
      ;;
    *)
      echo "Argumento desconhecido: $1" >&2
      exit 1
      ;;
  esac
  shift
done

parse_env_val() {
  local file="$1"
  local key="$2"
  grep -E "^${key}=" "$file" | tail -n 1 | cut -d= -f2- | sed 's/^"//;s/"$//'
}

MAIN_ENV="$ROOT/.env_main"
PROD_ENV="$ROOT/.env"

if [[ ! -f "$MAIN_ENV" ]]; then
  echo "ERROR: $MAIN_ENV não encontrado" >&2
  exit 1
fi
if [[ ! -f "$PROD_ENV" ]]; then
  echo "ERROR: $PROD_ENV não encontrado" >&2
  exit 1
fi

MAIN_DB="$(parse_env_val "$MAIN_ENV" DATABASE_URL)"
PROD_DB="$(parse_env_val "$PROD_ENV" DATABASE_URL)"

if [[ -z "$MAIN_DB" || -z "$PROD_DB" ]]; then
  echo "ERROR: DATABASE_URL ausente em .env_main ou .env" >&2
  exit 1
fi

run_storage() {
  echo "=== Storage (Supabase): main → production ==="
  if $DRY_RUN; then
    npm run storage:transfer:supabase:dry-run -- "${STORAGE_ARGS[@]:+${STORAGE_ARGS[@]}}"
  else
    npm run storage:transfer:supabase -- "${STORAGE_ARGS[@]:+${STORAGE_ARGS[@]}}"
  fi
}

run_db() {
  echo "=== PostgreSQL: main → production ==="
  export DATABASE_URL="$MAIN_DB"
  export DATABASE_URL_NEW="$PROD_DB"
  local db_args=()
  $DRY_RUN && db_args+=(--dry-run)
  $YES && db_args+=(--yes)
  bash "$ROOT/scripts/transfer-database.sh" "${db_args[@]}"
}

if $STORAGE_ONLY; then
  run_storage
  exit 0
fi
if $DB_ONLY; then
  run_db
  exit 0
fi

run_storage
echo ""
run_db