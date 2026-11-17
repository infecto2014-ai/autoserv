#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

project_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$project_dir"

if (( $# != 2 )) || [[ "$1" != '--replace' ]]; then
  printf 'Использование: %s --replace backups/имя.dump\n' "$0" >&2
  printf 'Флаг --replace явно разрешает замену данных в POSTGRES_DB из compose.yaml.\n' >&2
  exit 2
fi

input_file="$2"
if [[ ! -f "$input_file" || ! -r "$input_file" || ! -s "$input_file" ]]; then
  printf 'Нет доступного непустого файла: %s\n' "$input_file" >&2
  exit 1
fi
command -v docker >/dev/null || { printf 'Не найден Docker.\n' >&2; exit 1; }

# Проверяем формат архива до любых изменений базы.
docker compose exec -T db pg_restore --list < "$input_file" > /dev/null
docker compose exec -T db sh -c '
  case "${POSTGRES_DB:-}" in
    ""|postgres|template0|template1)
      printf "Отказ: системную базу восстанавливать этим скриптом нельзя.\n" >&2
      exit 1
      ;;
  esac
  exec pg_restore --username="$POSTGRES_USER" --dbname="$POSTGRES_DB" \
    --clean --if-exists --single-transaction --exit-on-error --no-owner --no-acl
' < "$input_file"
printf 'Архив восстановлен в настроенную POSTGRES_DB.\n'
