#!/bin/sh
# Deploy the single-VM stack: database, migrations, role audit, services.
# The restricted database logins must exist first (provision-roles.sh, see
# docs/deployment.md); the audit after migrating refuses to start the
# services when they are missing or a migration widened their rights.
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
# Validate without printing resolved secrets (Compose echoes unparsable lines).
compose config --quiet >/dev/null 2>&1 || {
  echo "docker compose could not read the configuration (output hidden because it can contain secrets). Check compose.env and the env files." >&2
  exit 1
}
if [ "$dry_run" -eq 1 ]; then
  "$script_dir/provision-roles.sh" --env-file "$env_file" --dry-run >/dev/null
  echo 'Validated compose configuration; would start database, run migrations, audit database roles, then start services.'
  exit 0
fi
compose up -d --wait postgres
compose --profile migration run --rm migrate
"$script_dir/provision-roles.sh" --env-file "$env_file" --audit ||
  { echo "Database role audit failed: services were not started. Run provision-roles.sh (docs/deployment.md) and deploy again." >&2; exit 1; }
compose up -d --wait api web worker caddy
