#!/bin/sh
# Exercise edge-replication-watchdog.sh with a stubbed psql and clock. Nothing
# here touches PostgreSQL.
set -eu
root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
tmp=$(mktemp -d /tmp/legend-edge-wd-test.XXXXXXXX)
trap 'rm -rf "$tmp"' EXIT HUP INT TERM
bin="$tmp/bin"
state="$tmp/state"
sqllog="$tmp/sql.log"
mkdir "$bin"
for tool in sh cat rm printf; do
  real=$(command -v "$tool" || true)
  [ -z "$real" ] || ln -s "$real" "$bin/$tool"
done
stub() {
  name=$1
  shift
  printf '#!/bin/sh\n%s\n' "$*" >"$bin/$name"
  chmod +x "$bin/$name"
}
stub date 'printf "%s\n" "$TEST_NOW"'
# psql -X -qAt -v ON_ERROR_STOP=1 -c SQL: the answer depends on the statement.
stub psql 'for a; do last=$a; done
printf "%s\n" "$last" >>"$TEST_SQLLOG"
[ -z "${TEST_PSQL_FAIL:-}" ] || exit 1
case $last in
  "SHOW synchronous_standby_names") printf "%s\n" "$TEST_NAMES" ;;
  *"count(*)"*"replay_lsn"*) printf "%s\n" "$TEST_BEHIND" ;;
  *"count(*)"*) printf "%s\n" "$TEST_STREAMING" ;;
  *) : ;;
esac'

reset() {
  rm -rf "$state"
  mkdir "$state"
  chmod 700 "$state"
  : >"$sqllog"
  TEST_NOW=1000
  TEST_NAMES='FIRST 1 (edge_standby)'
  TEST_STREAMING=1
  TEST_BEHIND=0
  TEST_PSQL_FAIL=
  export TEST_SQLLOG="$sqllog" TEST_NOW TEST_NAMES TEST_STREAMING TEST_BEHIND TEST_PSQL_FAIL
}
run() {
  status=0
  out=$(PATH="$bin" sh "$root/edge-replication-watchdog.sh" --state-dir "$state" --once "$@" 2>&1) || status=$?
}
at() {
  TEST_NOW=$1
  export TEST_NOW
}
fail() {
  printf 'FAIL test %s\n' "$*" >&2
  exit 1
}
changed() { grep -c 'ALTER SYSTEM' "$sqllog" || true; }

# 0. Usage.
status=0
PATH="$bin" sh "$root/edge-replication-watchdog.sh" >/dev/null 2>&1 || status=$?
[ "$status" -eq 2 ] || fail 'usage: expected exit 2'
status=0
PATH="$bin" sh "$root/edge-replication-watchdog.sh" --state-dir "$tmp" --grace x >/dev/null 2>&1 || status=$?
[ "$status" -eq 2 ] || fail 'usage-grace: expected exit 2'

# 1. A streaming standby changes nothing.
reset
run
[ "$status" -eq 0 ] || fail "healthy: exit $status"
[ "$(changed)" -eq 0 ] || fail 'healthy: changed settings'
[ ! -e "$state/replication-async.flag" ] || fail 'healthy: flag written'

# 2. Standby gone: the clock starts, nothing changes before the grace period.
reset
TEST_STREAMING=0
export TEST_STREAMING
run
[ "$status" -eq 0 ] || fail "down-first: exit $status"
[ -f "$state/replication-down-since" ] || fail 'down-first: no timestamp'
at 1009
run
[ "$(changed)" -eq 0 ] || fail 'down-9s: switched to async too early'

# 3. A standby that comes back inside the grace period resets the clock.
TEST_STREAMING=1
export TEST_STREAMING
at 1005
run
[ ! -e "$state/replication-down-since" ] || fail 'back-in-time: timestamp kept'

# 4. Down for 10 s: async, saved value, flag, history, ALARM.
reset
TEST_STREAMING=0
export TEST_STREAMING
run
at 1010
run
[ "$status" -eq 0 ] || fail "async: exit $status"
grep -F "SET synchronous_standby_names = ''" "$sqllog" >/dev/null || fail 'async: names not emptied'
grep -F 'pg_reload_conf' "$sqllog" >/dev/null || fail 'async: no reload'
[ -f "$state/replication-async.flag" ] || fail 'async: no flag'
[ "$(cat "$state/replication-sync-names")" = 'FIRST 1 (edge_standby)' ] || fail 'async: value not saved'
grep -F 'async_start=1010' "$state/replication-async-history" >/dev/null || fail 'async: no history'
case $out in *ALARM*) ;; *) fail "async: no ALARM line: $out" ;; esac

# 5. In async mode with no standby, nothing more happens and the flag stays.
TEST_NAMES=''
TEST_STREAMING=0
export TEST_NAMES TEST_STREAMING
: >"$sqllog"
at 1100
run
[ "$(changed)" -eq 0 ] || fail 'async-idle: changed settings'
[ -f "$state/replication-async.flag" ] || fail 'async-idle: flag removed'

# 6. Standby back but still behind: keep async.
TEST_STREAMING=1
TEST_BEHIND=1
export TEST_STREAMING TEST_BEHIND
run
[ "$(changed)" -eq 0 ] || fail 'behind: restored too early'
[ -f "$state/replication-async.flag" ] || fail 'behind: flag removed'

# 7. Caught up: sync restored, flag removed, history keeps the period.
TEST_BEHIND=0
export TEST_BEHIND
at 1200
run
[ "$status" -eq 0 ] || fail "resync: exit $status"
grep -F "SET synchronous_standby_names = 'FIRST 1 (edge_standby)'" "$sqllog" >/dev/null || fail 'resync: value not restored'
[ ! -e "$state/replication-async.flag" ] || fail 'resync: flag kept'
grep -F 'async_end=1200' "$state/replication-async-history" >/dev/null || fail 'resync: history lacks end'
grep -F 'async_start=1010' "$state/replication-async-history" >/dev/null || fail 'resync: history lost start'

# 8. Empty names without our flag (set by an operator): never touched.
reset
TEST_NAMES=''
export TEST_NAMES
run
[ "$(changed)" -eq 0 ] || fail 'operator-async: touched'

# 9. A failing query changes nothing and fails the check (fail closed).
reset
TEST_STREAMING=0
TEST_PSQL_FAIL=1
export TEST_STREAMING TEST_PSQL_FAIL
run
[ "$status" -ne 0 ] || fail 'psql-fail: exit 0'
[ "$(changed)" -eq 0 ] || fail 'psql-fail: changed settings'
[ ! -e "$state/replication-async.flag" ] || fail 'psql-fail: flag written'

# 10. A garbled count changes nothing.
reset
TEST_STREAMING='oops'
export TEST_STREAMING
run
[ "$status" -ne 0 ] || fail 'garbled: exit 0'
[ "$(changed)" -eq 0 ] || fail 'garbled: changed settings'

# 11. Unsafe characters in the saved value are never put back into SQL.
reset
TEST_STREAMING=0
TEST_NAMES="x'; DROP TABLE t; --"
export TEST_STREAMING TEST_NAMES
run
at 1010
run
[ "$status" -ne 0 ] || fail 'unsafe-names: exit 0'
[ "$(changed)" -eq 0 ] || fail 'unsafe-names: changed settings'
reset
TEST_NAMES=''
export TEST_NAMES
printf 'async since=1\n' >"$state/replication-async.flag"
printf "x'; DROP TABLE t; --\n" >"$state/replication-sync-names"
run
[ "$status" -ne 0 ] || fail 'unsafe-saved: exit 0'
[ "$(changed)" -eq 0 ] || fail 'unsafe-saved: changed settings'
[ -f "$state/replication-async.flag" ] || fail 'unsafe-saved: flag removed'

# 12. Missing state directory fails.
reset
rm -rf "$state"
run
[ "$status" -ne 0 ] || fail 'no-state-dir: exit 0'

echo 'edge-replication-watchdog tests passed'
