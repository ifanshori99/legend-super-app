#!/bin/sh
# First-boot database role provisioning (legend-zoqc). Run on the VM, as the
# operator who owns the private env files, after a migration and before the
# application services start. Safe to run again: it re-keys and re-verifies.
#
#   provision-roles.sh --env-file /absolute/path/compose.env [--dry-run | --audit | --migrator]
#
# --dry-run validates the env files only. --audit changes nothing: it checks
# that the restricted logins exist, keep their limits and match the env files
# (deploy.sh runs it after every migration). --migrator runs ONCE, before the
# first migration (legend-jtnd): it creates the dedicated migration login
# named in MIGRATION_DATABASE_URL (legend_migrator_<16 hex>: BYPASSRLS,
# CREATEROLE, not superuser, owner of the database). It connects as the
# bootstrap superuser (POSTGRES_USER and POSTGRES_PASSWORD in compose.env),
# which reaches the job through its environment only and never belongs in a
# service env file. Provisioning (no flag) first runs the pre-deploy check
# (legend-jtnd, legend-k1np) and stops before migrating when it fails.
#
# The optional MAINTENANCE_DATABASE_URL (worker.env only, legend-usyi) is the
# audit retention login: legend_maint_<16 hex>, member of legend_maintenance
# only. It is validated and provisioned when present; the cloud worker refuses
# to start in production without it.
#
# The optional PAYOUT_GRANTOR_DATABASE_URL (api.env only, legend-911) is the
# payout step grant login: legend_grant_<16 hex>, member of
# legend_payout_grantor only. It is validated and provisioned when present.
# Without it the API still starts, but every payout money step (correction,
# overpaid, return, proof closure, posting source) answers 503
# PAYOUT_STEP_GRANT_UNAVAILABLE: set it before payouts are used.
#
# The restricted URLs are read from the same api.env and worker.env the
# services use, so the database always matches them. They travel to the job
# through this process's environment, never on a command line, and are never
# printed. The migration credentials stay in migrator.env only; this script
# refuses to run if an application env file carries them.
set -eu
usage() { echo "Usage: $0 --env-file /absolute/path/to/compose.env [--dry-run | --audit | --migrator]" >&2; exit 2; }
[ "${1:-}" = --env-file ] || usage
[ "$#" -ge 2 ] || usage
env_file=$2
shift 2
case "$env_file" in /*) ;; *) usage ;; esac
[ -f "$env_file" ] || { echo "Environment file not found" >&2; exit 1; }
case "${1:-}" in --dry-run) mode=dry-run; shift ;; --audit) mode=audit; shift ;; --migrator) mode=migrator; shift ;; '') mode=provision ;; *) usage ;; esac
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
# Lines inside a quoted value that spans lines (double quotes, with \
# escapes, or single quotes) are value text, not keys. This is a first,
# line-based screen; the Compose check below sees what Compose really reads.
ascii_keys() {
  line=$(LC_ALL=C awk '
    q == "d" { v = $0; gsub(/\\./, "", v); if (v ~ /"/) q = ""; next }
    q == "s" { if ($0 ~ /\047/) q = ""; next }
    { k = $0; sub(/[#=:].*/, "", k); gsub(/[\t\r -~]/, "", k); if (k != "") { print NR; exit } }
    /^[^#=:]*[=:]/ {
      v = $0; sub(/^[^=:]*[=:][ \t]*/, "", v)
      if (v ~ /^"/) { v = substr(v, 2); gsub(/\\./, "", v); if (v !~ /"/) q = "d" }
      else if (v ~ /^\047/) { if (substr(v, 2) !~ /\047/) q = "s" }
    }' "$1")
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
for key in DATABASE_URL APP_DATABASE_URL WORKER_DATABASE_URL MAINTENANCE_DATABASE_URL PAYOUT_GRANTOR_DATABASE_URL; do
  defines "$web_env" "$key" && fail "web.env must not contain $key."
done
defines "$api_env" MAINTENANCE_DATABASE_URL && fail "api.env must not contain MAINTENANCE_DATABASE_URL."
defines "$worker_env" PAYOUT_GRANTOR_DATABASE_URL && fail "worker.env must not contain PAYOUT_GRANTOR_DATABASE_URL."

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
maintenance_url=$(value_of "$worker_env" MAINTENANCE_DATABASE_URL)
if [ -z "$maintenance_url" ] && defines "$worker_env" MAINTENANCE_DATABASE_URL; then
  fail "MAINTENANCE_DATABASE_URL in worker.env is empty; set the maintenance login or remove the line."
fi
[ -z "$maintenance_url" ] || { [ "$maintenance_url" != "$app_url" ] && [ "$maintenance_url" != "$worker_url" ]; } ||
  fail "the maintenance login must differ from the application and queue logins."
grantor_url=$(value_of "$api_env" PAYOUT_GRANTOR_DATABASE_URL)
if [ -z "$grantor_url" ] && defines "$api_env" PAYOUT_GRANTOR_DATABASE_URL; then
  fail "PAYOUT_GRANTOR_DATABASE_URL in api.env is empty; set the payout grantor login or remove the line."
fi
[ -z "$grantor_url" ] || { [ "$grantor_url" != "$app_url" ] && [ "$grantor_url" != "$worker_url" ] && [ "$grantor_url" != "$maintenance_url" ]; } ||
  fail "the payout grantor login must differ from the application, queue and maintenance logins."

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
if [ -n "$maintenance_url" ]; then
  maintenance_endpoint=$(endpoint_of "$maintenance_url" 'legend_maint_[a-f0-9]{16}' '[a-f0-9]{48}' 0)
  [ -n "$maintenance_endpoint" ] ||
    fail "MAINTENANCE_DATABASE_URL must look like postgresql://legend_maint_<16 hex>:<48 hex>@host:port/database, with nothing after the database name."
  [ "$maintenance_endpoint" = "$app_endpoint" ] ||
    fail "MAINTENANCE_DATABASE_URL must name the same host, port and database as APP_DATABASE_URL."
fi
if [ -n "$grantor_url" ]; then
  grantor_endpoint=$(endpoint_of "$grantor_url" 'legend_grant_[a-f0-9]{16}' '[a-f0-9]{48}' 0)
  [ -n "$grantor_endpoint" ] ||
    fail "PAYOUT_GRANTOR_DATABASE_URL must look like postgresql://legend_grant_<16 hex>:<48 hex>@host:port/database, with nothing after the database name."
  [ "$grantor_endpoint" = "$app_endpoint" ] ||
    fail "PAYOUT_GRANTOR_DATABASE_URL must name the same host, port and database as APP_DATABASE_URL."
fi
migration_url=$(value_of "$migrator_env" MIGRATION_DATABASE_URL)
if [ -n "$migration_url" ]; then
  [ "$(endpoint_of "$migration_url" '[^:@/]+' '[^@/]*' 1)" = "$app_endpoint" ] ||
    fail "the restricted URLs must name the same host, port and database as MIGRATION_DATABASE_URL in migrator.env."
else
  defines "$migrator_env" MIGRATION_DATABASE_URL_FILE ||
    fail "migrator.env must set MIGRATION_DATABASE_URL (or MIGRATION_DATABASE_URL_FILE)."
fi

# --migrator needs the bootstrap superuser from compose.env and a migration
# URL naming the generated migrator login, checked here so a typo fails before
# docker runs. The URL must be written out in migrator.env (not _FILE): the
# format cannot be checked in a file this script does not read.
if [ "$mode" = migrator ]; then
  bootstrap_user=$(value_of "$env_file" POSTGRES_USER)
  bootstrap_password=$(value_of "$env_file" POSTGRES_PASSWORD)
  [ -n "$bootstrap_user" ] && [ -n "$bootstrap_password" ] ||
    fail "compose.env must set POSTGRES_USER and POSTGRES_PASSWORD (the bootstrap superuser) for --migrator."
  # Compose resolves $, backslash and quotes in an env file value its own
  # way, so the value it hands the job could differ from value_of's. Refuse
  # them; the message names the key only.
  for key in POSTGRES_USER POSTGRES_PASSWORD; do
    case $(value_of "$env_file" "$key") in
      *[\$\\\"\']*) fail "$key in compose.env must not contain \$, a backslash or a quote character for --migrator." ;;
    esac
  done
  [ -n "$migration_url" ] ||
    fail "--migrator needs MIGRATION_DATABASE_URL written out in migrator.env (not MIGRATION_DATABASE_URL_FILE)."
  [ -n "$(endpoint_of "$migration_url" 'legend_migrator_[a-f0-9]{16}' '[a-f0-9]{48}' 1)" ] ||
    fail "MIGRATION_DATABASE_URL must look like postgresql://legend_migrator_<16 hex>:<48 hex>@host:port/database for --migrator."
fi

# Compose prints the offending line, secrets included, when an env file does
# not parse, so its output is discarded and only a fixed message is shown.
compose config --quiet >/dev/null 2>&1 ||
  fail "docker compose could not read the configuration (output hidden because it can contain secrets). Check compose.env and the env files for unbalanced quotes or invalid lines."
if [ "$mode" = dry-run ]; then
  echo 'Validated env files; would start database, run migrations, then provision restricted roles. (The check of the configuration Compose really applies needs the migrator image and runs with --audit and when provisioning.)'
  exit 0
fi
# Compose reads more than the line starts checked above (text after a closing
# quote is a new KEY=value, for one), so compare what it will really hand each
# service with the checked URLs. The JSON holds secrets: it goes straight into
# check-compose-env.mjs, run with node from the migrator image in a container
# with no network and no env file, which prints only fixed messages naming
# services and keys. Compose fills ${VAR} in env files from this shell, so it
# runs here with the environment deploy.sh uses to start the services (which
# never exports the URLs); the two checked URLs are exported to the checker's
# side of the pipe only. Keep this before the export below. The image
# is resolved as Compose does: an exported MIGRATOR_IMAGE wins over compose.env.
migrator_image=${MIGRATOR_IMAGE:-$(value_of "$env_file" MIGRATOR_IMAGE)}
[ -n "$migrator_image" ] || fail "compose.env must set MIGRATOR_IMAGE."
printf '%s\n' "$migrator_image" | grep -Eqx '[A-Za-z0-9][A-Za-z0-9._/:@-]*' ||
  fail "MIGRATOR_IMAGE must be a plain image reference (letters, digits and . _ / : @ -)."
set +e
compose config --format json 2>/dev/null | (
  APP_DATABASE_URL=$app_url
  WORKER_DATABASE_URL=$worker_url
  export APP_DATABASE_URL WORKER_DATABASE_URL
  set -- -e APP_DATABASE_URL -e WORKER_DATABASE_URL
  if [ -n "$maintenance_url" ]; then
    MAINTENANCE_DATABASE_URL=$maintenance_url
    export MAINTENANCE_DATABASE_URL
    set -- "$@" -e MAINTENANCE_DATABASE_URL
  fi
  if [ -n "$grantor_url" ]; then
    PAYOUT_GRANTOR_DATABASE_URL=$grantor_url
    export PAYOUT_GRANTOR_DATABASE_URL
    set -- "$@" -e PAYOUT_GRANTOR_DATABASE_URL
  fi
  docker run --rm -i --network none "$@" \
    -v "$script_dir/check-compose-env.mjs:/tmp/check-compose-env.mjs:ro" \
    --entrypoint node "$migrator_image" /tmp/check-compose-env.mjs
)
check_status=$?
set -e
case "$check_status" in
  0) ;;
  1) fail "the configuration docker compose would apply does not match the checked env files (reason above)." ;;
  *) fail "could not run the configuration check (docker exit $check_status). Is MIGRATOR_IMAGE pulled, and does it contain node?" ;;
esac
if [ "$mode" = migrator ]; then
  compose up -d --wait postgres
  # The bootstrap credentials reach the job through its environment only.
  (
    BOOTSTRAP_DATABASE_USER=$bootstrap_user
    BOOTSTRAP_DATABASE_PASSWORD=$bootstrap_password
    APP_DATABASE_URL=$app_url
    WORKER_DATABASE_URL=$worker_url
    export BOOTSTRAP_DATABASE_USER BOOTSTRAP_DATABASE_PASSWORD APP_DATABASE_URL WORKER_DATABASE_URL
    compose --profile provisioning run --rm -e BOOTSTRAP_DATABASE_USER -e BOOTSTRAP_DATABASE_PASSWORD provision-roles node dist/provision-roles.js --migrator
  )
  exit 0
fi
APP_DATABASE_URL=$app_url
WORKER_DATABASE_URL=$worker_url
export APP_DATABASE_URL WORKER_DATABASE_URL
if [ -n "$maintenance_url" ]; then
  MAINTENANCE_DATABASE_URL=$maintenance_url
  export MAINTENANCE_DATABASE_URL
fi
if [ -n "$grantor_url" ]; then
  PAYOUT_GRANTOR_DATABASE_URL=$grantor_url
  export PAYOUT_GRANTOR_DATABASE_URL
fi
if [ "$mode" = audit ]; then
  compose --profile provisioning run --rm provision-roles node dist/provision-roles.js --audit
  exit 0
fi
compose up -d --wait postgres
compose --profile migration run --rm migrate node dist/predeploy-check.js
compose --profile migration run --rm migrate
compose --profile provisioning run --rm provision-roles
