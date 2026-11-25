#!/bin/sh
# DOIT_REFUNDS_ENABLED must be the same in api.env and worker.env (legend-3gna):
# the API queues refunds and the worker pays them, so a split would queue
# refunds nobody pays (or pay ones the API never recorded as on). Read-only,
# needs no docker. A missing line, 0 and false mean off, 1 and true mean on, the
# same as apps/api/src/config/env.ts; an empty value (KEY= or only empty quotes)
# and any other value fail the check, fail closed like env.ts. A trailing comment
# is dropped only after a space and `#` (as Compose does); a TAB before `#` is
# part of the value, so it fails.
# The two Duitku settings follow the same rules (legend-osqou.1):
# DUITKU_ALLOW_SANDBOX is such a flag, DUITKU_ENABLED_METHODS is a comma list
# compared as a set (missing or empty = all locked, an unknown method fails).
# DUITKU_ALLOW_SANDBOX on is refused in production mode or with real data.
# Prints only file and setting names, never values or URLs.
#
#   check-refund-flag.sh --env-file /absolute/path/compose.env
set -eu
usage() { echo "Usage: $0 --env-file /absolute/path/to/compose.env" >&2; exit 2; }
[ "${1:-}" = --env-file ] && [ "$#" -eq 2 ] || usage
env_file=$2
case "$env_file" in /*) ;; *) usage ;; esac
[ -f "$env_file" ] || { echo "Environment file not found" >&2; exit 1; }
fail() { echo "Env agreement check failed: $*" >&2; exit 1; }

# value_of: copied from reset-preswitch-refunds.sh, keep them in step.
# Last KEY=value (or KEY: value) in an env file, with optional `export `,
# spaces around the separator and matching quotes removed. Empty when absent.
value_of() {
  sed -n "s/^[[:space:]]*\(export[[:space:]][[:space:]]*\)\{0,1\}$2[[:space:]]*[=:][[:space:]]*//p" "$1" |
    tail -n 1 | sed -e 's/[[:space:]]*$//' -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'\$/\1/"
}
# Compose gives a shell variable priority over the same key in compose.env, so
# the checker does too: a set (even empty) API_ENV_FILE / WORKER_ENV_FILE in the
# shell wins, an empty one fails closed. Otherwise the compose.env value is used.
service_file() {
  case "$1" in
    API_ENV_FILE) if [ "${API_ENV_FILE+set}" = set ]; then path=$API_ENV_FILE; from=shell; else path=$(value_of "$env_file" "$1"); from=compose; fi ;;
    WORKER_ENV_FILE) if [ "${WORKER_ENV_FILE+set}" = set ]; then path=$WORKER_ENV_FILE; from=shell; else path=$(value_of "$env_file" "$1"); from=compose; fi ;;
  esac
  case "$path" in /*) ;; *) fail "$1 (from the $from environment) must be an absolute path." ;; esac
  [ -r "$path" ] || fail "the file named by $1 is not readable."
  printf '%s\n' "$path"
}
# Fails on a bare KEY line (no = or :): it would take its value from Compose's
# shell, which this check cannot see reliably, so it fails closed.
no_bare_line() {
  if grep -Eq "^[[:space:]]*(export[[:space:]]+)?$2[[:space:]]*\$" "$1"; then
    fail "$(basename "$1") has a bare $2 line${3:-}. Give $2 an explicit value on that line."
  fi
}
has_line() { grep -Eq "^[[:space:]]*(export[[:space:]]+)?$2[[:space:]]*[=:]" "$1"; }
# Compose drops a trailing ` #comment` (space, then #; not a TAB), so drop it
# before reading the value.
clean_value() {
  value_of "$1" "$2" |
    sed -e 's/ #.*$//' -e 's/[[:space:]]*$//' -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'\$/\1/"
}
# Prints 0 (off) or 1 (on) for one boolean setting in one env file.
flag_of() {
  no_bare_line "$1" "$2"
  # No line at all means off. A line with an empty value is refused below.
  if ! has_line "$1" "$2"; then
    echo 0
    return
  fi
  case "$(clean_value "$1" "$2")" in
    0 | false) echo 0 ;;
    1 | true) echo 1 ;;
    *) fail "$(basename "$1") has an empty or invalid $2. It must be true, false, 1 or 0" ;;
  esac
}
# Prints the methods of DUITKU_ENABLED_METHODS sorted, one per line.
methods_of() {
  no_bare_line "$1" DUITKU_ENABLED_METHODS
  list=$(clean_value "$1" DUITKU_ENABLED_METHODS | tr ',' '\n' |
    sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' -e '/^$/d' | sort -u)
  if printf '%s\n' "$list" | grep -Evq '^(qris|va|ewallet|card)?$'; then
    fail "$(basename "$1") has an unknown method in DUITKU_ENABLED_METHODS."
  fi
  printf '%s\n' "$list"
}
# The Duitku sandbox switch is for staging: refused unless the file states (or
# defaults to) a mode other than production and synthetic data. Anything this
# check cannot read for certain (bare, empty, interpolated) is refused too.
sandbox_allowed_in() {
  for key in DEPLOYMENT_MODE DATA_CLASSIFICATION; do
    no_bare_line "$1" "$key" " while DUITKU_ALLOW_SANDBOX is on"
    has_line "$1" "$key" || continue
    case "$key:$(clean_value "$1" "$key")" in
      DEPLOYMENT_MODE:development | DEPLOYMENT_MODE:staging | DATA_CLASSIFICATION:synthetic) ;;
      *) fail "DUITKU_ALLOW_SANDBOX is on in $(basename "$1"), whose $key does not allow it. The Duitku sandbox is for staging with synthetic data only." ;;
    esac
  done
}
same_or_fail() {
  # same_or_fail <setting> <api value> <worker value>
  [ "$2" = "$3" ] ||
    fail "$1 differs between $(basename "$api_env") and $(basename "$worker_env"). Set the same value in both files and deploy again."
}

api_env=$(service_file API_ENV_FILE)
worker_env=$(service_file WORKER_ENV_FILE)
for flag in DOIT_REFUNDS_ENABLED DUITKU_ALLOW_SANDBOX; do
  api_flag=$(flag_of "$api_env" "$flag")
  worker_flag=$(flag_of "$worker_env" "$flag")
  same_or_fail "$flag" "$api_flag" "$worker_flag"
done
# The loop ends on DUITKU_ALLOW_SANDBOX, equal in both files here.
if [ "$api_flag" = 1 ]; then
  sandbox_allowed_in "$api_env"
  sandbox_allowed_in "$worker_env"
fi
api_methods=$(methods_of "$api_env")
worker_methods=$(methods_of "$worker_env")
same_or_fail DUITKU_ENABLED_METHODS "$api_methods" "$worker_methods"
