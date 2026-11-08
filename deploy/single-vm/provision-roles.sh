#!/bin/sh
# First-boot database role provisioning (legend-zoqc). Run on the VM, as the
# operator who owns the private env files, after a migration and before the
# application services start. Safe to run again: it re-keys and re-verifies.
#
#   provision-roles.sh --env-file /absolute/path/compose.env [--dry-run | --audit]
#
# --dry-run validates the env files only. --audit changes nothing: it checks
# that the restricted logins exist, keep their limits and match the env files
# (deploy.sh runs it after every migration).
#
# The restricted URLs are read from the same api.env and worker.env the
# services use, so the database always matches them. They travel to the job
# through this process's environment, never on a command line, and are never
# printed. The migration credentials stay in migrator.env only; this script
# refuses to run if an application env file carries them.
set -eu
usage() { echo "Usage: $0 --env-file /absolute/path/to/compose.env [--dry-run | --audit]" >&2; exit 2; }
[ "${1:-}" = --env-file ] || usage
[ "$#" -ge 2 ] || usage
env_file=$2
shift 2
case "$env_file" in /*) ;; *) usage ;; esac
[ -f "$env_file" ] || { echo "Environment file not found" >&2; exit 1; }
case "${1:-}" in --dry-run) mode=dry-run; shift ;; --audit) mode=audit; shift ;; '') mode=provision ;; *) usage ;; esac
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
# Compose's env parser skips a byte-order mark or a no-break space in front
# of a key; the checks below would not, so a hidden MIGRATION_DATABASE_URL
# could slip past them. Refuse any byte outside printable ASCII (tab and CR
# aside) before the first =, : or # of a line. Only the line number is shown.
# (awk, not grep: BSD grep skips a leading byte-order mark.)
ascii_keys() {
  line=$(LC_ALL=C awk '{ k = $0; sub(/[#=:].*/, "", k); gsub(/[\t\r -~]/, "", k); if (k != "") { print NR; exit } }' "$1")
  [ -z "$line" ] ||
    fail "$(basename "$1") has a non-ASCII character (byte-order mark, no-break space, ...) before a key on line $line; save it as plain text without them."
}
service_file() {
  path=$(value_of "$env_file" "$1")
  case "$path" in /*) ;; *) fail "$1 in the compose env file must be an absolute path." ;; esac
  [ -r "$path" ] || fail "the file named by $1 is not readable."
  printf '%s\n' "$path"
}
# Prints host[:port]/database when $1 is postgresql://USER:PASSWORD@host/db
# with USER matching $2 and PASSWORD matching $3 (extended regexes), followed
# by a query string only when $4 is 1. Prints nothing otherwise. The value is
# only piped to sed, never shown.
endpoint_of() {
  query=''
  [ "$4" -eq 1 ] && query='([?].*)?'
  printf '%s\n' "$1" |
    sed -nE "s|^postgres(ql)?://$2:$3@([^/?#@]+)/([^/?#]+)$query\$|\\2/\\3|p" | head -n 1
}

# Compose lets the shell override compose.env, so an exported API_ENV_FILE
# (or the others) would swap in a file this script never checked. Refuse a
# conflicting export, then pin the checked paths for every Compose call.
ascii_keys "$env_file"
for key in MIGRATOR_ENV_FILE API_ENV_FILE WEB_ENV_FILE WORKER_ENV_FILE; do
  if shell_value=$(printenv "$key"); then
    [ "$shell_value" = "$(value_of "$env_file" "$key")" ] ||
      fail "the shell exports $key with a different value than the compose env file; unset it and re-run."
  fi
done
migrator_env=$(service_file MIGRATOR_ENV_FILE)
api_env=$(service_file API_ENV_FILE)
web_env=$(service_file WEB_ENV_FILE)
worker_env=$(service_file WORKER_ENV_FILE)
MIGRATOR_ENV_FILE=$migrator_env
API_ENV_FILE=$api_env
WEB_ENV_FILE=$web_env
WORKER_ENV_FILE=$worker_env
export MIGRATOR_ENV_FILE API_ENV_FILE WEB_ENV_FILE WORKER_ENV_FILE
for file in "$migrator_env" "$api_env" "$web_env" "$worker_env"; do
  ascii_keys "$file"
done
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

# The same format the job enforces, so a typo fails here and not after the
# migration ran: generated login names, 48-hex passwords, no query string.
app_endpoint=$(endpoint_of "$app_url" 'legend_runtime_[a-f0-9]{16}' '[a-f0-9]{48}' 0)
[ -n "$app_endpoint" ] ||
  fail "APP_DATABASE_URL must look like postgresql://legend_runtime_<16 hex>:<48 hex>@host:port/database, with nothing after the database name."
worker_endpoint=$(endpoint_of "$worker_url" 'legend_worker_[a-f0-9]{16}' '[a-f0-9]{48}' 0)
[ -n "$worker_endpoint" ] ||
  fail "WORKER_DATABASE_URL must look like postgresql://legend_worker_<16 hex>:<48 hex>@host:port/database, with nothing after the database name."
[ "$worker_endpoint" = "$app_endpoint" ] ||
  fail "APP_DATABASE_URL and WORKER_DATABASE_URL must name the same host, port and database."
migration_url=$(value_of "$migrator_env" MIGRATION_DATABASE_URL)
if [ -n "$migration_url" ]; then
  [ "$(endpoint_of "$migration_url" '[^:@/]+' '[^@/]*' 1)" = "$app_endpoint" ] ||
    fail "the restricted URLs must name the same host, port and database as MIGRATION_DATABASE_URL in migrator.env."
else
  defines "$migrator_env" MIGRATION_DATABASE_URL_FILE ||
    fail "migrator.env must set MIGRATION_DATABASE_URL (or MIGRATION_DATABASE_URL_FILE)."
fi

# Compose prints the offending line, secrets included, when an env file does
# not parse, so its output is discarded and only a fixed message is shown.
compose config --quiet >/dev/null 2>&1 ||
  fail "docker compose could not read the configuration (output hidden because it can contain secrets). Check compose.env and the env files for unbalanced quotes or invalid lines."
if [ "$mode" = dry-run ]; then
  echo 'Validated env files; would start database, run migrations, then provision restricted roles.'
  exit 0
fi
APP_DATABASE_URL=$app_url
WORKER_DATABASE_URL=$worker_url
export APP_DATABASE_URL WORKER_DATABASE_URL
if [ "$mode" = audit ]; then
  compose --profile provisioning run --rm provision-roles node dist/provision-roles.js --audit
  exit 0
fi
compose up -d --wait postgres
compose --profile migration run --rm migrate
compose --profile provisioning run --rm provision-roles
