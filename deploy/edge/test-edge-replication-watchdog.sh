#!/bin/sh
# Exercise edge-replication-watchdog.sh with a stubbed psql, sync and clock.
# Nothing here touches PostgreSQL.
set -eu
root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
tmp=$(mktemp -d /tmp/legend-edge-wd-test.XXXXXXXX)
trap 'rm -rf "$tmp"' EXIT HUP INT TERM
bin="$tmp/bin"
state="$tmp/state"
sqllog="$tmp/sql.log"
namesdb="$tmp/names.db"
mkdir "$bin"
for tool in sh cat rm printf mv grep sed tr; do
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
stub sync 'printf "SYNC\n" >>"$TEST_SQLLOG"'
# psql -X -qAt -v ON_ERROR_STOP=1 -c SQL: the answer depends on the statement.
# synchronous_standby_names lives in $TEST_NAMESDB so ALTER SYSTEM changes it.
stub psql 'for a; do last=$a; done
printf "%s\n" "$last" >>"$TEST_SQLLOG"
[ -z "${TEST_PSQL_FAIL:-}" ] || exit 1
case $last in
  "ALTER SYSTEM SET synchronous_standby_names = "*)
    [ -f "$TEST_STATE/replication-async.flag" ] && [ -f "$TEST_STATE/replication-sync-names" ] && printf "FLAG_BEFORE_ALTER\n" >>"$TEST_SQLLOG"
    sq=$(printf "\047")
    v=${last#*= }
    v=${v#"$sq"}
    v=${v%"$sq"}
    printf "%s\n" "$v" >"$TEST_NAMESDB" ;;
  "SHOW synchronous_standby_names") cat "$TEST_NAMESDB" ;;
  *pg_replication_slots*) printf "%s" "$TEST_SLOTS" ;;
  *application_name*) printf "%s" "$TEST_CAUGHT" ;;
  *sync_state*) printf "%s\n" "$TEST_HEALTHY" ;;
  *) : ;;
esac'

reset() {
  rm -rf "$state"
  mkdir "$state"
  chmod 700 "$state"
  : >"$sqllog"
  printf 'FIRST 1 (edge_standby)\n' >"$namesdb"
  TEST_NOW=1000
  TEST_HEALTHY=1
  TEST_CAUGHT=
  TEST_SLOTS=
  TEST_PSQL_FAIL=
  export TEST_SQLLOG="$sqllog" TEST_NAMESDB="$namesdb" TEST_STATE="$state" TEST_NOW TEST_HEALTHY TEST_CAUGHT TEST_SLOTS TEST_PSQL_FAIL
}
run() {
  status=0
  out=$(PATH="$bin" sh "$root/edge-replication-watchdog.sh" --state-dir "$state" --once "$@" 2>&1) || status=$?
}
# ticks FROM TO: one check every 2 s (the default interval), like the loop.
ticks() {
  t=$1
  while [ "$t" -le "$2" ]; do
    TEST_NOW=$t
    export TEST_NOW
    run
    t=$((t + 2))
  done
}
at() {
  TEST_NOW=$1
  export TEST_NOW
}
fail() {
  printf 'FAIL test %s\n' "$*" >&2
  exit 1
}
altered() { grep -c 'ALTER SYSTEM' "$sqllog" || true; }
flag_is() { grep -Fx "status=$1" "$state/replication-async.flag" >/dev/null 2>&1; }
names_now() { cat "$namesdb"; }
has_out() { case $out in *"$1"*) ;; *) fail "$2: output lacks $1: $out" ;; esac; }

# 0. Usage.
status=0
PATH="$bin" sh "$root/edge-replication-watchdog.sh" >/dev/null 2>&1 || status=$?
[ "$status" -eq 2 ] || fail 'usage: expected exit 2'
status=0
PATH="$bin" sh "$root/edge-replication-watchdog.sh" --state-dir "$tmp" --grace x >/dev/null 2>&1 || status=$?
[ "$status" -eq 2 ] || fail 'usage-grace: expected exit 2'

# 1. A healthy synchronous standby changes nothing.
reset
run
[ "$status" -eq 0 ] || fail "healthy: exit $status"
[ "$(altered)" -eq 0 ] || fail 'healthy: changed settings'
[ ! -e "$state/replication-async.flag" ] || fail 'healthy: flag written'

# 2. No synchronous standby: nothing before the grace period.
reset
TEST_HEALTHY=0
export TEST_HEALTHY
ticks 1000 1008
[ "$(altered)" -eq 0 ] || fail 'down-8s: switched to async too early'
[ -f "$state/replication-down-since" ] || fail 'down: no clock file'

# 3. A standby that comes back inside the grace period resets the clock.
TEST_HEALTHY=1
export TEST_HEALTHY
ticks 1010 1010
[ ! -e "$state/replication-down-since" ] || fail 'back-in-time: clock file kept'

# 4. Down for 10 s: flag and saved value are on disk (after a sync) BEFORE the
# ALTER; then async, history and ALARM.
reset
TEST_HEALTHY=0
export TEST_HEALTHY
ticks 1000 1010
[ "$status" -eq 0 ] || fail "async: exit $status"
grep -F "SET synchronous_standby_names = ''" "$sqllog" >/dev/null || fail 'async: names not emptied'
grep -F 'pg_reload_conf' "$sqllog" >/dev/null || fail 'async: no reload'
grep -Fx 'FLAG_BEFORE_ALTER' "$sqllog" >/dev/null || fail 'async: flag and names were not on disk before ALTER'
# A SYNC line must precede the first ALTER line.
before=$(sed -n '/ALTER SYSTEM/q;p' "$sqllog")
case $before in *SYNC*) ;; *) fail 'async: no sync before ALTER' ;; esac
flag_is async || fail 'async: flag status is not async'
[ "$(cat "$state/replication-sync-names")" = 'FIRST 1 (edge_standby)' ] || fail 'async: value not saved'
grep -F 'async_start=1010' "$state/replication-async-history" >/dev/null || fail 'async: no history'
has_out ALARM async
[ -z "$(names_now)" ] || fail 'async: names not empty'

# 5. In async mode with no caught-up standby: nothing happens, flag stays async.
: >"$sqllog"
ticks 1012 1020
[ "$(altered)" -eq 0 ] || fail 'async-idle: changed settings'
flag_is async || fail 'async-idle: flag changed'

# 6. A caught-up standby with another application_name is not enough.
TEST_CAUGHT='someone_else
'
export TEST_CAUGHT
ticks 1022 1022
[ "$(altered)" -eq 0 ] || fail 'wrong-name: restored for the wrong standby'
flag_is async || fail 'wrong-name: flag changed'

# 7. The right standby has caught up: sync restored, flag KEPT as recovered.
TEST_CAUGHT='edge_standby
'
export TEST_CAUGHT
ticks 1024 1024
[ "$status" -eq 0 ] || fail "resync: exit $status"
[ "$(names_now)" = 'FIRST 1 (edge_standby)' ] || fail 'resync: value not restored'
[ -f "$state/replication-async.flag" ] || fail 'resync: flag was deleted'
flag_is recovered-awaiting-reconcile || fail 'resync: flag is not recovered-awaiting-reconcile'
grep -F 'async_end=1024' "$state/replication-async-history" >/dev/null || fail 'resync: history lacks end'
grep -F 'async_start=1010' "$state/replication-async-history" >/dev/null || fail 'resync: history lost start'

# 8. Later healthy ticks never delete the flag.
TEST_HEALTHY=1
export TEST_HEALTHY
ticks 1026 1040
flag_is recovered-awaiting-reconcile || fail 'after-resync: flag changed or deleted'

# 9. --ack-reconciled removes it, and only in the recovered state.
status=0
PATH="$bin" sh "$root/edge-replication-watchdog.sh" --state-dir "$state" --ack-reconciled >/dev/null 2>&1 || status=$?
[ "$status" -eq 0 ] || fail "ack: exit $status"
[ ! -e "$state/replication-async.flag" ] || fail 'ack: flag kept'
grep -F 'reconciled=' "$state/replication-async-history" >/dev/null || fail 'ack: no history'
status=0
PATH="$bin" sh "$root/edge-replication-watchdog.sh" --state-dir "$state" --ack-reconciled >/dev/null 2>&1 || status=$?
[ "$status" -ne 0 ] || fail 'ack-no-flag: exit 0'
reset
printf 'status=async\nsince=1\n' >"$state/replication-async.flag"
status=0
PATH="$bin" sh "$root/edge-replication-watchdog.sh" --state-dir "$state" --ack-reconciled >/dev/null 2>&1 || status=$?
[ "$status" -ne 0 ] || fail 'ack-while-async: exit 0'
[ -f "$state/replication-async.flag" ] || fail 'ack-while-async: flag removed'
printf 'status=async-unknown\nsince=1\n' >"$state/replication-async.flag"
status=0
PATH="$bin" sh "$root/edge-replication-watchdog.sh" --state-dir "$state" --ack-reconciled >/dev/null 2>&1 || status=$?
[ "$status" -ne 0 ] || fail 'ack-while-unknown: exit 0'

# 10. Async with no flag of ours is async-unknown: ALARM, flag, never restored.
reset
printf '\n' >"$namesdb"
run
[ "$status" -eq 0 ] || fail "unknown: exit $status"
has_out ALARM unknown
flag_is async-unknown || fail 'unknown: flag not written'
grep -F 'async_unknown_start=1000' "$state/replication-async-history" >/dev/null || fail 'unknown: no history'
TEST_CAUGHT='edge_standby
'
export TEST_CAUGHT
: >"$sqllog"
at 1002
run
case $out in *ALARM*) fail "unknown: alarm repeated: $out" ;; esac
[ "$(altered)" -eq 0 ] || fail 'unknown: restored automatically'
[ -z "$(names_now)" ] || fail 'unknown: names changed'
# A recovered flag with empty names is unknown async again.
reset
printf '\n' >"$namesdb"
printf 'status=recovered-awaiting-reconcile\nsince=1\n' >"$state/replication-async.flag"
run
flag_is async-unknown || fail 'recovered-then-empty: not treated as unknown'
has_out ALARM recovered-then-empty

# 11. A flag still saying async while a synchronous standby is healthy
# (restore done, flag update lost): shown as recovered, not deleted.
reset
printf 'status=async\nsince=1\n' >"$state/replication-async.flag"
run
flag_is recovered-awaiting-reconcile || fail 'stuck-async-flag: not upgraded'

# 12. A second outage after a recovered flag goes async again with a fresh flag.
reset
printf 'status=recovered-awaiting-reconcile\nsince=1\n' >"$state/replication-async.flag"
TEST_HEALTHY=0
export TEST_HEALTHY
ticks 1000 1010
flag_is async || fail 'second-outage: flag not async'
[ -z "$(names_now)" ] || fail 'second-outage: not async'

# 13. ANY 2: both standbys must have caught up; wildcard accepts any.
reset
printf 'ANY 2 (a, b, c)\n' >"$namesdb"
TEST_HEALTHY=0
export TEST_HEALTHY
ticks 1000 1010
[ -z "$(names_now)" ] || fail 'any2: not async'
TEST_CAUGHT='a
'
export TEST_CAUGHT
ticks 1012 1012
[ -z "$(names_now)" ] || fail 'any2: restored with one standby'
TEST_CAUGHT='a
c
'
export TEST_CAUGHT
ticks 1014 1014
[ "$(names_now)" = 'ANY 2 (a, b, c)' ] || fail 'any2: not restored with two'
reset
printf 'FIRST 1 (*)\n' >"$namesdb"
TEST_HEALTHY=0
export TEST_HEALTHY
ticks 1000 1010
TEST_CAUGHT='whatever
'
export TEST_CAUGHT
ticks 1012 1012
[ "$(names_now)" = 'FIRST 1 (*)' ] || fail 'wildcard: not restored'

# 14. A physical slot unreserved or lost raises an ALARM once; clears when fine.
reset
TEST_SLOTS='edge_standby_slot:lost
'
export TEST_SLOTS
run
[ "$status" -eq 0 ] || fail "slot: exit $status"
has_out 'ALARM replication slot' slot
at 1002
run
case $out in *ALARM*) fail "slot: alarm repeated: $out" ;; esac
TEST_SLOTS=
export TEST_SLOTS
at 1004
run
[ ! -e "$state/replication-slot-alarm" ] || fail 'slot: alarm marker kept'
TEST_SLOTS='edge_standby_slot:unreserved
'
export TEST_SLOTS
run
has_out 'ALARM replication slot' slot-unreserved

# 15. A stale clock file (the watchdog was not running) restarts the grace period.
reset
TEST_HEALTHY=0
export TEST_HEALTHY
ticks 1000 1004
ticks 1100 1100
[ "$(altered)" -eq 0 ] || fail 'stale: async from a stale clock file'
ticks 1102 1108
[ "$(altered)" -eq 0 ] || fail 'stale: async too early'
ticks 1110 1110
[ -z "$(names_now)" ] || fail 'stale: not async after a full grace period'
printf 'garbage\n' >"$state/replication-down-since"
reset
printf 'garbage\n' >"$state/replication-down-since"
TEST_HEALTHY=0
export TEST_HEALTHY
run
[ "$(altered)" -eq 0 ] || fail 'garbled-clock: async'

# 16. Failures change nothing (fail closed).
reset
TEST_HEALTHY=0
TEST_PSQL_FAIL=1
export TEST_HEALTHY TEST_PSQL_FAIL
ticks 1000 1012
[ "$status" -ne 0 ] || fail 'psql-fail: exit 0'
[ "$(altered)" -eq 0 ] || fail 'psql-fail: changed settings'
[ ! -e "$state/replication-async.flag" ] || fail 'psql-fail: flag written'
reset
TEST_HEALTHY=oops
export TEST_HEALTHY
run
[ "$status" -ne 0 ] || fail 'garbled: exit 0'
[ "$(altered)" -eq 0 ] || fail 'garbled: changed settings'
reset
rm -rf "$state"
run
[ "$status" -ne 0 ] || fail 'no-state-dir: exit 0'

# 17. Unsafe characters are never put into SQL.
reset
printf "x'; DROP TABLE t; --\n" >"$namesdb"
TEST_HEALTHY=0
export TEST_HEALTHY
ticks 1000 1010
[ "$status" -ne 0 ] || fail 'unsafe-names: exit 0'
[ "$(altered)" -eq 0 ] || fail 'unsafe-names: changed settings'
reset
printf '\n' >"$namesdb"
printf 'status=async\nsince=1\n' >"$state/replication-async.flag"
printf "x'; DROP TABLE t; --\n" >"$state/replication-sync-names"
TEST_CAUGHT='edge_standby
'
export TEST_CAUGHT
run
[ "$status" -ne 0 ] || fail 'unsafe-saved: exit 0'
[ "$(altered)" -eq 0 ] || fail 'unsafe-saved: changed settings'
[ -f "$state/replication-async.flag" ] || fail 'unsafe-saved: flag removed'

# 18. No sync command: refuse to run (the flag could not be made durable).
reset
rm "$bin/sync"
run
[ "$status" -ne 0 ] || fail 'no-sync: exit 0'

echo 'edge-replication-watchdog tests passed'
