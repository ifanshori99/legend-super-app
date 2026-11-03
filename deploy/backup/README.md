# PostgreSQL backup integration (legend-cqr)

Use the `deploy/backup/Dockerfile` image for PostgreSQL 16. Persist its data and
`/var/spool/pgbackrest` independently; mount a private config based on
`pgbackrest.conf.example` read-only at `/etc/pgbackrest/pgbackrest.conf`,
owned and readable by the `postgres` OS user (mode 0600). Supply independent
S3 credentials and encryption passwords outside version control. Configure the
second repository in a separate failure domain/account, not just another prefix
in the same bucket. Test the object store's S3 compatibility and TLS; do not
disable certificate verification. Retention is two full backups per repository;
adjust after checking costs and the required recovery window.

For the postgres service, add these postgres arguments to its existing tuning:

```text
-c wal_level=replica
-c archive_mode=on
-c archive_timeout=60s
-c archive_command=pgbackrest --stanza=legend archive-push %p
```

The archive command is one argument to `-c` (use a YAML list or quote it). Mount
`deploy/backup/backup.sh` and `deploy/backup/restore-drill.sh` read-only as
`/usr/local/bin/legend-backup` and `/usr/local/bin/legend-restore-drill`.
After the database is healthy, run once as the `postgres` user inside the
container: `pgbackrest --stanza=legend stanza-create` and then
`pgbackrest --stanza=legend check`. Schedule `/usr/local/bin/legend-backup`
daily as the same user, and alert on any failure or overdue backup. Each run
backs up both repos separately; pgBackRest archives each WAL segment to both.
Monitor archive age, local free space and replication failures; a 60-second WAL
switch does not itself prove RPO <= 5 minutes. Archive failures retain WAL and
can fill the disk. Test the effect of an unavailable repository and alert.

Run restore drills only on an isolated machine with a copy of the private
config and a new empty destination, using the same major PostgreSQL version.
As the unprivileged postgres user invoke
`legend-restore-drill /absolute/path/new-directory 2 '2026-01-01 00:00:00+00'`.
Omit the timestamp to recover the latest available state; select repo 1 or 2.
The script refuses existing paths, starts with network listening and WAL archiving disabled,
queries the restored server, shuts it down, and reports elapsed seconds. Check
application data and compare the latest restored transaction with the failure
and recovery target, and record the drill's RPO and RTO. Do not restore real
production data into staging; use a restricted isolated production recovery
environment or synthetic data. A script check is not a completed restore drill.

Example `legend-backup.service.example` and `legend-backup.timer.example` files
provide a daily systemd schedule. Copy them into the VM's systemd unit directory,
replace the absolute paths, restrict access to the referenced compose environment
and pgBackRest configuration, then enable the timer. Test a backup manually and
set an independent alert for failures and missed runs. systemd prevents overlap
of the same service; do not schedule another concurrent backup for the stanza.
