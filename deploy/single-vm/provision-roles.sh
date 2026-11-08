#!/bin/sh
# First-boot database role provisioning (legend-zoqc). Run on the VM, as the
# operator who owns the private env files, after a migration and before the
# application services start. Safe to run again: it re-keys and re-verifies.
#
#   provision-roles.sh --env-file /absolute/path/compose.env [--dry-run]
#
# The restricted URLs are read from the same api.env and worker.env the
# services use, so the database always matches them. They travel to the job
# through this process's environment, never on a command line, and are never
# printed. The migration credentials stay in migrator.env only; this script
# refuses to run if an application env file carries them.
set -eu
usage() { echo "Usage: $0 --env-file /absolute/path/to/compose.env [--dry-run]" >&2; exit 2; }
[ "${1:-}" = --env-file ] || usage
[ "$#" -ge 2 ] || usage
env_file=$2
shift 2
case "$env_file" in /*) ;; *) usage ;; esac
[ -f "$env_file" ] || { echo "Environment file not found" >&2; exit 1; }
case "${1:-}" in --dry-run) dry_run=1; shift ;; '') dry_run=0 ;; *) usage ;; esac
[ "$#" -eq 0 ] || usage
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
compose() { docker compose --env-file "$env_file" -f "$script_dir/compose.yaml" "$@"; }
fail() { echo "Role provisioning refused: $*" >&2; exit 1; }

# Last KEY=value (or KEY: value) in an env file, with optional `export `,
# spaces around the separator and matching quotes removed: the forms Compose's
# env_file parser accepts, last one winning. Empty when the key is absent.
# Anything stranger fails closed later (values must match exactly).
value_of() {
  sed -n "s/^[[:space:]]*\(export[[:space:]][[:space:]]*\)\{0,1\}$2[[:space:]]*[=:][[:space:]]*//p" "$1" |
    tail -n 1 | sed -e 's/[[:space:]]*$//' -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'\$/\1/"
}
# A bare KEY line also counts: Compose then copies the value from its shell.
defines() { grep -Eq "^[[:space:]]*(export[[:space:]]+)?$2[[:space:]]*([=:]|\$)" "$1"; }
service_file() {
  path=$(value_of "$env_file" "$1")
  case "$path" in /*) ;; *) fail "$1 in the compose env file must be an absolute path." ;; esac
  [ -r "$path" ] || fail "the file named by $1 is not readable."
  printf '%s\n' "$path"
}

api_env=$(service_file API_ENV_FILE)
web_env=$(service_file WEB_ENV_FILE)
worker_env=$(service_file WORKER_ENV_FILE)
for file in "$api_env" "$web_env" "$worker_env"; do
  defines "$file" MIGRATION_DATABASE_URL &&
    fail "an application env file ($(basename "$file")) contains MIGRATION_DATABASE_URL; keep it in migrator.env only."
done
for key in DATABASE_URL APP_DATABASE_URL WORKER_DATABASE_URL; do
  defines "$web_env" "$key" && fail "web.env must not contain $key."
done

app_url=$(value_of "$api_env" APP_DATABASE_URL)
[ -n "$app_url" ] || fail "api.env must set APP_DATABASE_URL to the restricted application login."
worker_app_url=$(value_of "$worker_env" APP_DATABASE_URL)
[ -n "$worker_app_url" ] || worker_app_url=$(value_of "$worker_env" DATABASE_URL)
[ "$worker_app_url" = "$app_url" ] ||
  fail "worker.env must use the same restricted application login as api.env."
for file in "$api_env" "$worker_env"; do
  if defines "$file" DATABASE_URL; then
    [ "$(value_of "$file" DATABASE_URL)" = "$app_url" ] ||
      fail "DATABASE_URL in $(basename "$file") must equal APP_DATABASE_URL."
  fi
done
defines "$api_env" WORKER_DATABASE_URL && fail "api.env must not contain WORKER_DATABASE_URL."
worker_url=$(value_of "$worker_env" WORKER_DATABASE_URL)
[ -n "$worker_url" ] || fail "worker.env must set WORKER_DATABASE_URL to the queue login."
[ "$worker_url" != "$app_url" ] || fail "the queue and application logins must differ."

# Validate without printing resolved secrets.
compose config --quiet
if [ "$dry_run" -eq 1 ]; then
  echo 'Validated env files; would start database, run migrations, then provision restricted roles.'
  exit 0
fi
APP_DATABASE_URL=$app_url
WORKER_DATABASE_URL=$worker_url
export APP_DATABASE_URL WORKER_DATABASE_URL
compose up -d --wait postgres
compose --profile migration run --rm migrate
compose --profile provisioning run --rm provision-roles
