#!/bin/sh
# Run from a protected systemd unit on the VM; env file contains private paths.
set -eu
[ "$#" -eq 1 ] || { echo 'Usage: run-scheduled.sh /absolute/path/to/compose.env' >&2; exit 2; }
case "$1" in /*) ;; *) echo 'Compose env file must be absolute.' >&2; exit 2 ;; esac
[ -f "$1" ] || { echo 'Compose env file not found.' >&2; exit 1; }
here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec docker compose --env-file "$1" -f "$here/../single-vm/compose.yaml" exec -T -u postgres postgres /usr/local/bin/legend-backup
