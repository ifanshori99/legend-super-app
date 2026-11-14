#!/bin/sh
# Restore only into a new directory on an isolated machine. Never point this
# at production; recovery starts without a TCP listener.
set -eu
if [ "$#" -lt 1 ] || [ "$#" -gt 3 ]; then
  echo "Usage: $0 /absolute/new/restore-directory [repository 1|2] [recovery timestamp]" >&2
  exit 2
fi
target=$1
repo=${2:-2}
case "$target" in /*) ;; *) echo 'Target must be an absolute path.' >&2; exit 2;; esac
case "$repo" in 1|2) ;; *) echo 'Repository must be 1 or 2.' >&2; exit 2;; esac
if [ "$(id -u)" -eq 0 ] || [ -e "$target" ] || [ -L "$target" ]; then
  echo 'Run unprivileged and select a path that does not exist.' >&2
  exit 1
fi
mkdir -m 700 "$target"
socket_dir=$(mktemp -d "/tmp/legend-restore.XXXXXXXX")
started=0
cleanup() {
  if [ "$started" -eq 1 ]; then
    pg_ctl -D "$target" -m fast -w stop || true
  fi
  rmdir "$socket_dir" || true
}
trap cleanup EXIT HUP INT TERM
start=$(date +%s)
if [ "$#" -eq 3 ]; then
  pgbackrest --stanza=legend --repo="$repo" --pg1-path="$target" --type=time --target="$3" --target-action=promote restore
else
  pgbackrest --stanza=legend --repo="$repo" --pg1-path="$target" restore
fi
# No listener and a private socket prevent accidental access from the network.
pg_ctl -D "$target" -o "-c archive_mode=off -c listen_addresses='' -c unix_socket_directories='$socket_dir' -c port=55432" -w start
started=1
psql -X -v ON_ERROR_STOP=1 -h "$socket_dir" -p 55432 -U "${POSTGRES_USER:-replace_me}" -d postgres -c 'SELECT now() AS restored_at, pg_is_in_recovery() AS in_recovery;'
end=$(date +%s)
echo "Restore and startup completed in $((end - start)) seconds; verify data and archived WAL timestamps against the recovery target."
