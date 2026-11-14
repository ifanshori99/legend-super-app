#!/bin/sh
# DOIT_REFUNDS_ENABLED must be the same in api.env and worker.env (legend-3gna):
# the API queues refunds and the worker pays them, so a split would queue
# refunds nobody pays (or pay ones the API never recorded as on). Read-only,
# needs no docker. Absent, empty, 0 and false mean off, 1 and true mean on, the
# same as apps/api/src/config/env.ts; any other value fails the check.
# Prints only file names, never values or URLs.
#
#   check-refund-flag.sh --env-file /absolute/path/compose.env
set -eu
usage() { echo "Usage: $0 --env-file /absolute/path/to/compose.env" >&2; exit 2; }
[ "${1:-}" = --env-file ] && [ "$#" -eq 2 ] || usage
env_file=$2
case "$env_file" in /*) ;; *) usage ;; esac
[ -f "$env_file" ] || { echo "Environment file not found" >&2; exit 1; }
fail() { echo "Refund flag check failed: $*" >&2; exit 1; }

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
# Prints 0 (off) or 1 (on) for DOIT_REFUNDS_ENABLED in one env file. A bare
# KEY line (no = or :) would take its value from Compose's shell, which this
# check cannot see reliably, so it fails closed.
flag_of() {
  if grep -Eq '^[[:space:]]*(export[[:space:]]+)?DOIT_REFUNDS_ENABLED[[:space:]]*$' "$1"; then
    fail "$(basename "$1") has a bare DOIT_REFUNDS_ENABLED line. Give DOIT_REFUNDS_ENABLED an explicit value of true or false on that line."
  fi
  # Compose drops a trailing ` #comment`, so drop it before reading the value.
  value=$(value_of "$1" DOIT_REFUNDS_ENABLED |
    sed -e 's/[[:space:]][[:space:]]*#.*$//' -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'\$/\1/")
  case "$value" in
    '' | 0 | false) echo 0 ;;
    1 | true) echo 1 ;;
    *) fail "DOIT_REFUNDS_ENABLED must be true, false, 1 or 0" ;;
  esac
}

api_env=$(service_file API_ENV_FILE)
worker_env=$(service_file WORKER_ENV_FILE)
api_flag=$(flag_of "$api_env")
worker_flag=$(flag_of "$worker_env")
[ "$api_flag" = "$worker_flag" ] ||
  fail "DOIT_REFUNDS_ENABLED differs between $(basename "$api_env") and $(basename "$worker_env"). Set the same value (true or false) in both files and deploy again."
