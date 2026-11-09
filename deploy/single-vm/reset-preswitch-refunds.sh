#!/bin/sh
# One-off pre-switch DOIT refund reset (legend-d21p, legend-8cf3). Run on the
# VM, as the operator who owns the private env files. See docs/deployment.md.
#
#   reset-preswitch-refunds.sh --env-file /absolute/path/compose.env
#     [--dry-run | --apply] [--touched-before <ISO>] [--ids /absolute/path]
#
# The job runs in the migrator image, whose env file does not hold
# DOIT_REFUNDS_ENABLED, so its own switch check would be blind. This script
# reads the switch from api.env, worker.env and migrator.env and from the api
# and worker containers (a container started before an env file change still
# carries the old value), refuses --apply unless every one is absent, false
# or 0 and both services have a container, and passes the result to the job
# as DOIT_REFUNDS_ENABLED, with LEGEND_RESET_WRAPPER=1. It also mounts the
# --ids file read-only at a fixed path in the container.
# It never prints env file contents, container environments or URLs: only
# file and container names.
set -eu
usage() {
  echo "Usage: $0 --env-file /absolute/path/to/compose.env [--dry-run | --apply] [--touched-before <ISO>] [--ids /absolute/path/to/ids.txt]" >&2
  exit 2
}
[ "${1:-}" = --env-file ] || usage
[ "$#" -ge 2 ] || usage
env_file=$2
shift 2
case "$env_file" in /*) ;; *) usage ;; esac
[ -f "$env_file" ] || { echo "Environment file not found" >&2; exit 1; }
mode=''
touched_before=''
ids=''
while [ "$#" -gt 0 ]; do
  case "$1" in
    --dry-run | --apply)
      [ -z "$mode" ] || usage
      mode=$1
      shift
      ;;
    --touched-before)
      [ "$#" -ge 2 ] && [ -z "$touched_before" ] && [ -n "$2" ] || usage
      touched_before=$2
      shift 2
      ;;
    --ids)
      [ "$#" -ge 2 ] && [ -z "$ids" ] || usage
      ids=$2
      shift 2
      ;;
    *) usage ;;
  esac
done
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
compose() { docker compose --env-file "$env_file" -f "$script_dir/compose.yaml" "$@"; }
fail() { echo "Pre-switch refund reset refused: $*" >&2; exit 1; }
# The --ids file inside the container. Fixed, so the job never sees a host path.
container_ids=/tmp/refund-ids.txt

# value_of, defines, ascii_keys and service_file: copied from
# provision-roles.sh, keep them in step.
# Last KEY=value (or KEY: value) in an env file, with optional `export `,
# spaces around the separator and matching quotes removed: the forms Compose's
# env_file parser accepts, last one winning. Empty when the key is absent.
value_of() {
  sed -n "s/^[[:space:]]*\(export[[:space:]][[:space:]]*\)\{0,1\}$2[[:space:]]*[=:][[:space:]]*//p" "$1" |
    tail -n 1 | sed -e 's/[[:space:]]*$//' -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'\$/\1/"
}
# A bare KEY line also counts: Compose then copies the value from its shell.
defines() { grep -Eq "^[[:space:]]*(export[[:space:]]+)?$2[[:space:]]*([=:]|\$)" "$1"; }
# Refuse any byte outside printable ASCII (tab and CR aside) before the first
# =, : or # of a line, so a byte-order mark cannot hide a key. Only the line
# number is shown. Lines inside a multi-line quoted value are skipped.
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

# Compose lets the shell override compose.env, so an exported API_ENV_FILE
# (or the others) would swap in a file this script never checked, and an
# exported COMPOSE_PROJECT_NAME would make `ps` list another project's
# containers (or none). Refuse a conflicting export, then pin the checked
# paths for every Compose call.
ascii_keys "$env_file"
for key in MIGRATOR_ENV_FILE API_ENV_FILE WEB_ENV_FILE WORKER_ENV_FILE COMPOSE_PROJECT_NAME; do
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

if [ -n "$ids" ]; then
  case "$ids" in /*) ;; *) fail "--ids must be an absolute path on this machine." ;; esac
  case "$ids" in *:*) fail "--ids must not contain a colon (docker cannot mount it)." ;; esac
  [ -f "$ids" ] && [ -r "$ids" ] || fail "the --ids file is not a readable file."
  # The image runs as user node, which reads the file through the mount.
  [ -n "$(find "$ids" -prune -perm -0004)" ] ||
    fail "the --ids file must be readable by all users (for example chmod 0644) so the job's user can read it."
fi

# Every source of the switch. on=1 when any source is anything other than
# absent, false or 0 (a bare KEY, an empty value or a ${...} reference count
# as on: their real value is not known here), or when a service has no
# container to read.
on=0
off_value() { case "$1" in false | 0) return 0 ;; *) return 1 ;; esac; }
mark_on() {
  on=1
  echo "DOIT_REFUNDS_ENABLED is not off (absent, false or 0) in $1." >&2
}
for file in "$api_env" "$worker_env" "$migrator_env"; do
  ascii_keys "$file"
  name=$(basename "$file")
  if defines "$file" DOIT_REFUNDS_ENABLED; then
    # The last line naming the key wins. A bare KEY there takes the value
    # from Compose's shell, whatever an earlier KEY=false line says.
    if grep -E '^[[:space:]]*(export[[:space:]]+)?DOIT_REFUNDS_ENABLED[[:space:]]*([=:]|$)' "$file" | tail -n 1 |
      grep -Eq '^[[:space:]]*(export[[:space:]]+)?DOIT_REFUNDS_ENABLED[[:space:]]*$'; then
      mark_on "$name (its last DOIT_REFUNDS_ENABLED line is a bare key)"
    else
      off_value "$(value_of "$file" DOIT_REFUNDS_ENABLED)" || mark_on "$name"
    fi
  fi
  # The name anywhere else (not a comment, not a key line this script reads)
  # could be a key Compose sees and the lines above do not: fail closed.
  if grep -v '^[[:space:]]*#' "$file" | grep -F DOIT_REFUNDS_ENABLED |
    grep -Evq '^[[:space:]]*(export[[:space:]]+)?DOIT_REFUNDS_ENABLED[[:space:]]*([=:]|$)'; then
    mark_on "$name (an unusual line names it; keep it as a plain DOIT_REFUNDS_ENABLED=false line or remove it)"
  fi
done
# The containers, stopped ones included (restart: unless-stopped brings them
# back). Their environment holds secrets: it goes straight into sed, which
# keeps only this key's value.
for service in api worker; do
  container_list=$(compose ps -a -q "$service" 2>/dev/null) ||
    fail "could not list the $service containers (docker compose ps failed)."
  # No container (wrong project, removed by hand): the switch it last ran
  # with is unknown, so --apply refuses and a dry-run warns.
  if [ -z "$container_list" ]; then
    on=1
    echo "No $service container found (docker compose ps -a), so its DOIT_REFUNDS_ENABLED is unknown." >&2
  fi
  for id in $container_list; do
    container_env=$(docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$id" 2>/dev/null) ||
      fail "could not read the environment of a $service container (docker inspect failed)."
    if printf '%s\n' "$container_env" | grep -q '^DOIT_REFUNDS_ENABLED='; then
      off_value "$(printf '%s\n' "$container_env" | sed -n 's/^DOIT_REFUNDS_ENABLED=//p' | tail -n 1)" ||
        mark_on "the $service container"
    fi
  done
done
container_env=''

if [ "$on" -eq 1 ]; then
  [ "$mode" != --apply ] ||
    fail "the DOIT refund switch is on or unknown (see above), nothing was written. Reset BEFORE the switch, never after: a reset refund would be sent to DOIT."
  resolved=true
else
  resolved=false
fi

compose config --quiet >/dev/null 2>&1 ||
  fail "docker compose could not read the configuration (output hidden because it can contain secrets). Check compose.env and the env files for unbalanced quotes or invalid lines."

# Build the job's arguments in "$@" (the original arguments were consumed).
set -- node dist/reset-preswitch-refunds.js
[ -z "$mode" ] || set -- "$@" "$mode"
[ -z "$touched_before" ] || set -- "$@" --touched-before "$touched_before"
if [ -n "$ids" ]; then
  set -- -v "$ids:$container_ids:ro" migrate "$@" --ids "$container_ids"
else
  set -- migrate "$@"
fi
# LEGEND_RESET_WRAPPER tells the job it was started here: a raw `compose run`
# --apply exits 2 without it, even if migrator.env sets the switch.
compose --profile migration run --rm -e "DOIT_REFUNDS_ENABLED=$resolved" -e LEGEND_RESET_WRAPPER=1 "$@"
