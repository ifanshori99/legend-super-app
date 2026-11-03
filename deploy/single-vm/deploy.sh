#!/bin/sh
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
# Validate without printing resolved secrets.
compose config --quiet
if [ "$dry_run" -eq 1 ]; then
  echo 'Validated compose configuration; would start database, run migrations, then start services.'
  exit 0
fi
compose up -d --wait postgres
compose --profile migration run --rm migrate
compose up -d --wait api web worker caddy
