#!/bin/sh
# DOIT_REFUNDS_ENABLED must be the same in api.env and worker.env (legend-3gna):
# the API queues refunds and the worker pays them, so a split would queue
# refunds nobody pays (or pay ones the API never recorded as on). Read-only,
# needs no docker. Absent, empty, 0 and false all mean off; anything else is on.
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
service_file() {
  path=$(value_of "$env_file" "$1")
  case "$path" in /*) ;; *) fail "$1 in the compose env file must be an absolute path." ;; esac
  [ -r "$path" ] || fail "the file named by $1 is not readable."
  printf '%s\n' "$path"
}
# Prints 0 (off) or 1 (on) for DOIT_REFUNDS_ENABLED in one env file. A bare
# KEY line last takes its value from Compose's shell, so read it from there.
flag_of() {
  if grep -E '^[[:space:]]*(export[[:space:]]+)?DOIT_REFUNDS_ENABLED[[:space:]]*([=:]|$)' "$1" | tail -n 1 |
    grep -Eq '^[[:space:]]*(export[[:space:]]+)?DOIT_REFUNDS_ENABLED[[:space:]]*$'; then
    value=$(printenv DOIT_REFUNDS_ENABLED || true)
  else
    value=$(value_of "$1" DOIT_REFUNDS_ENABLED)
  fi
  case "$value" in '' | 0 | false) echo 0 ;; *) echo 1 ;; esac
}

api_env=$(service_file API_ENV_FILE)
worker_env=$(service_file WORKER_ENV_FILE)
api_flag=$(flag_of "$api_env")
worker_flag=$(flag_of "$worker_env")
[ "$api_flag" = "$worker_flag" ] ||
  fail "DOIT_REFUNDS_ENABLED differs between $(basename "$api_env") and $(basename "$worker_env"). Set the same value (true or false) in both files and deploy again."
