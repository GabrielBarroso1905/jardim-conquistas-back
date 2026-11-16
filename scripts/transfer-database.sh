#!/usr/bin/env bash
# Copia schema + dados de DATABASE_URL para DATABASE_URL_NEW (pg_dump / pg_restore).
# Uso: ./scripts/transfer-database.sh [--dry-run]

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DRY_RUN=false

for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=true ;;
    -h | --help)
      echo "Uso: $0 [--dry-run]"
      exit 0
      ;;
    *)
      echo "Argumento desconhecido: $arg" >&2
      exit 1
      ;;
  esac
done

prepend_postgres_bin_path() {
  if command -v pg_dump >/dev/null 2>&1; then
    return 0
  fi
  local candidates=(
    "/c/Program Files/PostgreSQL/18/bin"
    "/c/Program Files/PostgreSQL/17/bin"
    "/c/Program Files/PostgreSQL/16/bin"
    "/c/Program Files/PostgreSQL/15/bin"
    "/usr/bin"
  )
  for dir in "${candidates[@]}"; do
    if [[ -x "${dir}/pg_dump" || -x "${dir}/pg_dump.exe" ]]; then
      PATH="${dir}:${PATH}"
      export PATH
      return 0
    fi
  done
}

require_cmd() {
  prepend_postgres_bin_path
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "ERROR: '$1' não encontrado no PATH (instale PostgreSQL client tools)." >&2
    exit 1
  fi
}

load_dotenv() {
  local env_file="$ROOT/.env"
  if [[ ! -f "$env_file" ]]; then
    echo "ERROR: $env_file não existe." >&2
    exit 1
  fi
  set -a
  # shellcheck disable=SC1090
  source "$env_file"
  set +a
}

mask_url() {
  local url="$1"
  if [[ "$url" =~ ^postgresql://([^:]+):[^@]+@(.+)$ ]]; then
    echo "postgresql://${BASH_REMATCH[1]}:***@${BASH_REMATCH[2]}"
  else
    echo "(url inválida ou não-postgresql)"
  fi
}

row_counts_per_table() {
  local url="$1"
  local tables
  tables="$(psql "$url" -v ON_ERROR_STOP=1 -At -c "
    SELECT quote_ident(table_name)
    FROM information_schema.tables
    WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
    ORDER BY table_name;
  ")"
  while IFS= read -r tbl; do
    [[ -z "$tbl" ]] && continue
    local cnt
    cnt="$(psql "$url" -v ON_ERROR_STOP=1 -At -c "SELECT COUNT(*) FROM public.${tbl};")"
    echo "${tbl}|${cnt}"
  done <<<"$tables"
}

test_connection() {
  local url="$1"
  psql "$url" -v ON_ERROR_STOP=1 -c 'SELECT 1' >/dev/null 2>&1
}

try_connection_with_ssl_modes() {
  local base="$1"
  local label="$2"
  local url=""

  if test_connection "$base"; then
    url="$base"
  elif [[ "$base" != *"?"* ]]; then
    for mode in require prefer disable; do
      local try="${base}?sslmode=${mode}"
      if test_connection "$try"; then
        url="$try"
        echo "OK: conexão $label (sslmode=${mode})" >&2
        printf '%s' "$url"
        return 0
      fi
    done
  fi

  if [[ -n "$url" ]]; then
    echo "OK: conexão $label" >&2
    printf '%s' "$url"
    return 0
  fi

  echo "ERROR: não foi possível conectar em $label ($(mask_url "$base"))." >&2
  exit 1
}

dest_has_user_data() {
  local url="$1"
  local tables
  tables="$(psql "$url" -v ON_ERROR_STOP=1 -At -c "
    SELECT quote_ident(table_name)
    FROM information_schema.tables
    WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
      AND table_name <> '_prisma_migrations';
  ")"
  local total=0
  while IFS= read -r tbl; do
    [[ -z "$tbl" ]] && continue
    local cnt
    cnt="$(psql "$url" -v ON_ERROR_STOP=1 -At -c "SELECT COUNT(*) FROM public.${tbl};")"
    total=$((total + cnt))
  done <<<"$tables"

  if [[ "$total" -gt 0 ]]; then
    echo "WARN: destino já tem $total linhas (exc. _prisma_migrations)." >&2
    if [[ -t 0 ]]; then
      read -r -p "Continuar mesmo assim? [y/N] " ans
      [[ "${ans,,}" == "y" ]] || exit 1
    else
      echo "ERROR: destino não está vazio. Esvazie o banco ou use ambiente interativo." >&2
      exit 1
    fi
  fi
}

compare_counts() {
  local src_url="$1"
  local dst_url="$2"
  local fail=0

  echo ""
  echo "=== Contagens por tabela (origem | destino) ==="
  printf "%-40s %10s %10s\n" "tabela" "origem" "destino"

  local src_file dst_file
  src_file="$(mktemp)"
  dst_file="$(mktemp)"
  row_counts_per_table "$src_url" >"$src_file"
  row_counts_per_table "$dst_url" >"$dst_file"

  while IFS='|' read -r tbl src_cnt; do
    local dst_cnt
    dst_cnt="$(grep -F "${tbl}|" "$dst_file" | cut -d'|' -f2- | head -n1 || true)"
    if [[ -z "$dst_cnt" ]]; then
      dst_cnt="-"
      fail=1
    elif [[ "$src_cnt" -gt 0 && "$dst_cnt" == "0" ]]; then
      fail=1
    elif [[ "$src_cnt" != "$dst_cnt" ]]; then
      fail=1
    fi
    printf "%-40s %10s %10s\n" "$tbl" "$src_cnt" "$dst_cnt"
  done <"$src_file"

  rm -f "$src_file" "$dst_file"

  if [[ "$fail" -ne 0 ]]; then
    echo ""
    echo "ERROR: contagens não batem entre origem e destino." >&2
    return 1
  fi
  echo ""
  echo "Contagens conferem."
  return 0
}

main() {
  require_cmd pg_dump
  require_cmd pg_restore
  require_cmd psql

  load_dotenv

  if [[ -z "${DATABASE_URL:-}" ]]; then
    echo "ERROR: DATABASE_URL não definido no .env" >&2
    exit 1
  fi
  if [[ -z "${DATABASE_URL_NEW:-}" ]]; then
    echo "ERROR: DATABASE_URL_NEW não definido no .env" >&2
    exit 1
  fi
  if [[ "$DATABASE_URL" == "$DATABASE_URL_NEW" ]]; then
    echo "ERROR: DATABASE_URL e DATABASE_URL_NEW são iguais." >&2
    exit 1
  fi

  echo "Origem:  $(mask_url "$DATABASE_URL")"
  echo "Destino: $(mask_url "$DATABASE_URL_NEW")"

  SRC_URL="$(try_connection_with_ssl_modes "$DATABASE_URL" "origem")"
  DST_URL="$(try_connection_with_ssl_modes "$DATABASE_URL_NEW" "destino")"

  mkdir -p "$ROOT/backups"
  STAMP="$(date +%Y%m%d-%H%M%S)"
  DUMP_FILE="$ROOT/backups/jardim-${STAMP}.dump"

  if $DRY_RUN; then
    echo "[dry-run] pg_dump -> $DUMP_FILE"
    echo "[dry-run] pg_restore --dbname=<destino> $DUMP_FILE"
    exit 0
  fi

  dest_has_user_data "$DST_URL"

  echo ""
  echo "=== pg_dump (origem) ==="
  pg_dump "$SRC_URL" --format=custom --no-owner --no-acl --verbose -f "$DUMP_FILE"
  echo "Backup: $DUMP_FILE"

  echo ""
  echo "=== pg_restore (destino) ==="
  set +e
  pg_restore --dbname="$DST_URL" --no-owner --no-acl --verbose "$DUMP_FILE"
  restore_rc=$?
  set -e
  if [[ "$restore_rc" -ne 0 ]]; then
    echo "WARN: pg_restore exit=$restore_rc (comum com objetos já existentes); validando dados..."
  fi

  compare_counts "$SRC_URL" "$DST_URL"

  echo ""
  echo "Transferência concluída. Próximo passo: trocar DATABASE_URL pelo valor de DATABASE_URL_NEW no .env e no Coolify."
}

main "$@"