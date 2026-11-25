#!/bin/sh
# Exercise check-edge-replication.sh with stubbed host tools and sample files.
# Nothing here touches PostgreSQL or the network.
set -eu
root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
tmp=$(mktemp -d /tmp/legend-edge-repl-test.XXXXXXXX)
trap 'chmod -R u+rwx "$tmp" 2>/dev/null || true; rm -rf "$tmp"' EXIT HUP INT TERM
bin="$tmp/bin"
mkdir "$bin"
for tool in sh awk grep sed ls tr cat tail head; do
  real=$(command -v "$tool" || true)
  [ -z "$real" ] || ln -s "$real" "$bin/$tool"
done
stub() {
  name=$1
  shift
  printf '#!/bin/sh\n%s\n' "$*" >"$bin/$name"
  chmod +x "$bin/$name"
}
# systemctl is-active --quiet UNIT: active when UNIT is in $TEST_ACTIVE.
stub systemctl 'for a; do last=$a; done
case " ${TEST_ACTIVE:-} " in *" $last "*) exit 0 ;; esac
exit 3'

secret='replsecretvalue0123456789'
pconf="$tmp/primary.conf"
phba="$tmp/pg_hba.conf"
sconf="$tmp/standby.conf"
appenv="$tmp/api.env"
datadir="$tmp/data"
passfile="$tmp/replication.pgpass"

# Samples are the shipped examples, so a drifting example fails here.
reset() {
  cp "$root/postgresql-edge-primary.conf.example" "$pconf"
  cp "$root/pg_hba-edge-replication.conf.example" "$phba"
  sed -e "s#passfile=[^ ']*#passfile=$passfile#" "$root/postgresql-edge-standby.conf.example" >"$sconf"
  printf 'DATABASE_URL=postgres://legend_app:%s@localhost/edge\nWORKER_DATABASE_URL=postgres://legend_worker:%s@localhost/edge\n' "$secret" "$secret" >"$appenv"
  rm -rf "$datadir"
  mkdir "$datadir"
  : >"$datadir/standby.signal"
  printf 'host:5432:replication:edge_replicator:%s\n' "$secret" >"$passfile"
  chmod 600 "$passfile"
  TEST_ACTIVE=
  export TEST_ACTIVE
}

run_primary() {
  status=0
  out=$(PATH="$bin" sh "$root/check-edge-replication.sh" --role primary --conf "$pconf" --hba "$phba" --replication-role edge_replicator --app-env-file "$appenv" "$@" 2>&1) || status=$?
}
run_standby() {
  status=0
  out=$(PATH="$bin" sh "$root/check-edge-replication.sh" --role standby --conf "$sconf" --data-dir "$datadir" --replication-role edge_replicator --app-env-file "$appenv" "$@" 2>&1) || status=$?
}

expect_ok() {
  if [ "$status" -ne 0 ]; then
    printf 'FAIL test %s: expected exit 0, got %s\n%s\n' "$1" "$status" "$out" >&2
    exit 1
  fi
}
expect_fail() {
  if [ "$status" -ne 1 ]; then
    printf 'FAIL test %s: expected exit 1, got %s\n%s\n' "$1" "$status" "$out" >&2
    exit 1
  fi
}
expect_out() {
  if ! printf '%s\n' "$out" | grep -F -- "$2" >/dev/null; then
    printf 'FAIL test %s: output lacks "%s"\n%s\n' "$1" "$2" "$out" >&2
    exit 1
  fi
}
no_secret() {
  if printf '%s\n' "$out" | grep -F -- "$secret" >/dev/null; then
    printf 'FAIL test %s: a secret was printed\n' "$1" >&2
    exit 1
  fi
}
# set_line FILE NAME VALUE: replace the setting line (value without quotes).
set_line() {
  sed -e "s#^$2 *=.*#$2 = $3#" "$1" >"$1.new"
  mv "$1.new" "$1"
}

# 0. Usage errors exit 2 and print nothing to stdout.
status=0
sh "$root/check-edge-replication.sh" >/dev/null 2>&1 || status=$?
[ "$status" -eq 2 ] || { echo 'FAIL test usage: expected exit 2' >&2; exit 1; }
status=0
sh "$root/check-edge-replication.sh" --role primary --conf "$tmp/x" --replication-role 'a b' >/dev/null 2>&1 || status=$?
[ "$status" -eq 2 ] || { echo 'FAIL test usage-role: expected exit 2' >&2; exit 1; }

# 0b. The shipped examples hold no secret.
for f in postgresql-edge-primary.conf.example postgresql-edge-standby.conf.example pg_hba-edge-replication.conf.example; do
  if grep -v '^[[:space:]]*#' "$root/$f" | grep -Ei 'password[[:space:]]*=[[:space:]]*[^[:space:]#]' >/dev/null; then
    printf 'FAIL test examples: %s holds a password\n' "$f" >&2
    exit 1
  fi
done

# 1. Healthy primary and standby pass and print no secret.
reset
run_primary
expect_ok primary-healthy
expect_out primary-healthy 'edge replication checks passed'
no_secret primary-healthy
run_standby
expect_ok standby-healthy
expect_out standby-healthy 'PASS conninfo: sslmode=verify-full'
no_secret standby-healthy

# 2. Missing or unreadable settings file fails closed.
reset
rm "$pconf"
run_primary
expect_fail primary-conf-missing
expect_out primary-conf-missing 'conf: cannot read'

# 3. Primary settings.
reset
set_line "$pconf" wal_level minimal
run_primary
expect_fail primary-wal-minimal
expect_out primary-wal-minimal 'wal_level'
reset
set_line "$pconf" ssl off
run_primary
expect_fail primary-ssl-off
expect_out primary-ssl-off 'tls: ssl must be on'
reset
set_line "$pconf" synchronous_commit local
run_primary
expect_fail primary-sync-local
expect_out primary-sync-local 'synchronous_commit'
reset
set_line "$pconf" synchronous_commit off
run_primary
expect_fail primary-sync-off
reset
set_line "$pconf" synchronous_standby_names "''"
run_primary
expect_fail primary-names-empty
expect_out primary-names-empty 'synchronous_standby_names is empty'
reset
set_line "$pconf" max_wal_senders 1
run_primary
expect_fail primary-senders
reset
set_line "$pconf" max_replication_slots 0
run_primary
expect_fail primary-slots
reset
set_line "$pconf" password_encryption md5
run_primary
expect_fail primary-md5
reset
printf "password = '%s'\n" "$secret" >>"$pconf"
run_primary
expect_fail primary-password-in-conf
expect_out primary-password-in-conf 'secret: the settings file holds a password'
no_secret primary-password-in-conf

# 4. pg_hba: only hostssl, the replication role, scram or cert, narrow address.
bad_hba() {
  reset
  printf '%s\n' "$2" >"$phba"
  run_primary
  expect_fail "hba-$1"
  expect_out "hba-$1" 'hba:'
}
bad_hba plain-host 'host replication edge_replicator 192.0.2.20/32 scram-sha-256'
bad_hba nossl 'hostnossl replication edge_replicator 192.0.2.20/32 scram-sha-256'
bad_hba trust 'hostssl replication edge_replicator 192.0.2.20/32 trust'
bad_hba md5 'hostssl replication edge_replicator 192.0.2.20/32 md5'
bad_hba all-users 'hostssl replication all 192.0.2.20/32 scram-sha-256'
bad_hba other-user 'hostssl replication legend_app 192.0.2.20/32 scram-sha-256'
bad_hba open-v4 'hostssl replication edge_replicator 0.0.0.0/0 scram-sha-256'
bad_hba open-v6 'hostssl replication edge_replicator ::/0 scram-sha-256'
bad_hba wide-net 'hostssl replication edge_replicator 10.0.0.0/8 scram-sha-256'
bad_hba no-mask 'hostssl replication edge_replicator 192.0.2.20 scram-sha-256'
bad_hba none '# no replication line'
reset
printf '# ok line and a bad one\nhostssl replication edge_replicator 192.0.2.20/32 scram-sha-256\nhost replication all 0.0.0.0/0 trust\n' >"$phba"
run_primary
expect_fail hba-one-good-one-bad
reset
printf 'hostssl replication edge_replicator 192.0.2.0/24 cert # comment\nhostssl all all 192.0.2.0/24 scram-sha-256\n' >"$phba"
run_primary
expect_ok hba-cert-and-other-lines
reset
printf 'hostssl replication edge_replicator 2001:db8::20/128 scram-sha-256\n' >"$phba"
run_primary
expect_ok hba-v6-narrow

# 5. The replication role is separate from the application logins.
reset
printf 'DATABASE_URL=postgres://edge_replicator:%s@localhost/edge\n' "$secret" >"$appenv"
run_primary
expect_fail role-clash
expect_out role-clash 'DATABASE_URL'
no_secret role-clash
reset
printf 'WORKER_DATABASE_URL="postgresql://edge_replicator@localhost/edge"\n' >"$appenv"
run_primary
expect_fail role-clash-worker
reset
rm "$appenv"
run_primary
expect_fail role-env-unreadable
reset
status=0
out=$(PATH="$bin" sh "$root/check-edge-replication.sh" --role primary --conf "$pconf" --hba "$phba" --replication-role edge_replicator 2>&1) || status=$?
expect_ok role-env-not-given
expect_out role-env-not-given 'WARN role:'

# 6. Standby settings.
reset
set_line "$sconf" hot_standby off
run_standby
expect_fail standby-hot-off
reset
rm "$datadir/standby.signal"
run_standby
expect_fail standby-signal-missing
expect_out standby-signal-missing 'standby.signal'
reset
sed -e '/primary_slot_name/d' "$sconf" >"$sconf.new"
mv "$sconf.new" "$sconf"
run_standby
expect_fail standby-slot-missing
reset
sed -e 's/sslmode=verify-full/sslmode=require/' "$sconf" >"$sconf.new"
mv "$sconf.new" "$sconf"
run_standby
expect_fail standby-sslmode
expect_out standby-sslmode 'verify-full'
reset
sed -e 's/sslmode=verify-full/sslmode=verify-ca/' "$sconf" >"$sconf.new"
mv "$sconf.new" "$sconf"
run_standby
expect_fail standby-verify-ca
reset
sed -e 's/ sslrootcert=[^ ]*//' "$sconf" >"$sconf.new"
mv "$sconf.new" "$sconf"
run_standby
expect_fail standby-no-rootcert
reset
sed -e 's/user=edge_replicator/user=legend_app/' "$sconf" >"$sconf.new"
mv "$sconf.new" "$sconf"
run_standby
expect_fail standby-wrong-user
reset
sed -e "s/ application_name=[^ ]*//" "$sconf" >"$sconf.new"
mv "$sconf.new" "$sconf"
run_standby
expect_fail standby-no-appname
reset
sed -e "s/ passfile=[^ ']*/ password=$secret/" "$sconf" >"$sconf.new"
mv "$sconf.new" "$sconf"
run_standby
expect_fail standby-password-in-conninfo
no_secret standby-password-in-conninfo
reset
printf "primary_conninfo = 'host=h user=edge_replicator application_name=a sslmode=verify-full sslrootcert=/x'\n" >>"$sconf"
run_standby
expect_fail standby-no-passfile
expect_out standby-no-passfile 'passfile'
reset
printf "primary_conninfo = 'postgresql://edge_replicator@h/?sslmode=verify-full'\n" >>"$sconf"
run_standby
expect_fail standby-uri
reset
chmod 644 "$passfile"
run_standby
expect_fail standby-passfile-open
expect_out standby-passfile-open 'passfile: mode'
no_secret standby-passfile-open
reset
rm "$passfile"
run_standby
expect_fail standby-passfile-missing

# 7. The standby must not run the application.
reset
TEST_ACTIVE='legend-edge-worker'
export TEST_ACTIVE
run_standby
expect_fail standby-app-running
expect_out standby-app-running 'legend-edge-worker'
reset
rm "$bin/systemctl"
run_standby
expect_fail standby-no-systemctl
expect_out standby-no-systemctl 'systemctl not found'

echo 'check-edge-replication tests passed'
