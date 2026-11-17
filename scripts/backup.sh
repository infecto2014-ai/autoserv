#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

project_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$project_dir"

if (( $# > 1 )); then
  printf 'Использование: %s [backups/имя.dump]\n' "$0" >&2
  exit 2
fi

command -v docker >/dev/null || { printf 'Не найден Docker.\n' >&2; exit 1; }
output_file="${1:-backups/sto-crm-$(date -u +%Y%m%dT%H%M%SZ).dump}"
if [[ -e "$output_file" || -L "$output_file" ]]; then
  printf 'Файл уже существует: %s\n' "$output_file" >&2
  exit 1
fi
mkdir -p -- "$(dirname -- "$output_file")"
temporary_file="$(mktemp "$(dirname -- "$output_file")/.sto-backup.XXXXXX")"
trap 'rm -f -- "$temporary_file"' EXIT

docker compose exec -T db sh -c \
  'exec pg_dump --username="$POSTGRES_USER" --dbname="$POSTGRES_DB" --format=custom --no-owner --no-acl' \
  > "$temporary_file"

if [[ ! -s "$temporary_file" ]]; then
  printf 'pg_dump создал пустой файл.\n' >&2
  exit 1
fi
docker compose exec -T db pg_restore --list < "$temporary_file" > /dev/null

# Hard link создаётся атомарно и откажет, если файл появился во время pg_dump.
ln -- "$temporary_file" "$output_file"
printf 'Резервная копия создана: %s\n' "$output_file"
