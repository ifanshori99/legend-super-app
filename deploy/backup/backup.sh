#!/bin/sh
# Schedule daily as the postgres OS user after stanza-create; each repository
# needs its own base backup. WAL archiving alone cannot restore a database.
set -eu
if [ "$(id -u)" -eq 0 ]; then
  echo 'Run as the postgres OS user.' >&2
  exit 1
fi
pgbackrest --stanza=legend --repo=1 --type=full backup
pgbackrest --stanza=legend --repo=2 --type=full backup
