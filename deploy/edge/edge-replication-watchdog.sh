#!/bin/sh
# Edge primary watchdog for synchronous replication (legend 1269 F11a). With
# synchronous commit, a dead standby would block every sale. When no standby has
# streamed for GRACE seconds (default 10) this empties synchronous_standby_names
# (ALTER SYSTEM, reload), writes the permanent async marker and logs an ALARM
# line. When a standby streams again and has replayed everything, it restores the
# saved value and removes the marker; the history file keeps one line per async
# period. Run it as the postgres user (unix socket, PG* settings from the
# environment). It never prints connection settings. Fails closed: when a query
# fails or returns something unexpected, it changes nothing (commits keep waiting
# for the standby rather than being acknowledged without a copy).
set -eu

usage() {
  cat >&2 <<'USAGE'
usage: edge-replication-watchdog.sh --state-dir DIR [--grace SECONDS] [--interval SECONDS] [--once]
  --state-dir  directory for the marker files, owned by the running user (mode 0700)
  --grace      seconds without a streaming standby before async (default 10)
  --interval   seconds between checks (default 2)
  --once       run one check and exit (used by the tests)
Files in the state directory: replication-down-since, replication-sync-names,
replication-async.flag (present while async), replication-async-history.
USAGE
  exit 2
}

state_dir=
grace=10
interval=2
once=0
while [ $# -gt 0 ]; do
  case $1 in
    --state-dir | --grace | --interval)
      [ $# -ge 2 ] || usage
      case $1 in
        --state-dir) state_dir=$2 ;;
        --grace) grace=$2 ;;
        --interval) interval=$2 ;;
      esac
      shift 2
      ;;
    --once)
      once=1
      shift
      ;;
    *) usage ;;
  esac
done
[ -n "$state_dir" ] || usage
for n in "$grace" "$interval"; do
  case $n in '' | *[!0-9]*) usage ;; esac
done
[ "$interval" -gt 0 ] || usage

q() { psql -X -qAt -v ON_ERROR_STOP=1 -c "$1"; }
log() { printf '%s %s\n' "$1" "$2" >&2; }

down_file=$state_dir/replication-down-since
names_file=$state_dir/replication-sync-names
flag_file=$state_dir/replication-async.flag
history_file=$state_dir/replication-async-history

# tick: one check. Returns non-zero without changing anything on any doubt.
tick() {
  [ -d "$state_dir" ] || { log ERROR "state directory is missing"; return 1; }
  names=$(q "SHOW synchronous_standby_names") || { log ERROR "cannot read synchronous_standby_names"; return 1; }
  streaming=$(q "SELECT count(*) FROM pg_stat_replication WHERE state = 'streaming'") || { log ERROR "cannot read pg_stat_replication"; return 1; }
  case $streaming in '' | *[!0-9]*) log ERROR "unexpected replication count"; return 1 ;; esac
  now=$(date +%s)
  case $now in '' | *[!0-9]*) return 1 ;; esac

  if [ -n "$names" ]; then
    # Synchronous mode.
    if [ "$streaming" -gt 0 ]; then
      rm -f "$down_file"
      return 0
    fi
    if [ ! -f "$down_file" ]; then
      printf '%s\n' "$now" >"$down_file"
      return 0
    fi
    since=$(cat "$down_file")
    case $since in '' | *[!0-9]*) printf '%s\n' "$now" >"$down_file"; return 0 ;; esac
    [ $((now - since)) -ge "$grace" ] || return 0
    # Save the value first; refuse a value that cannot be restored safely.
    case $names in *[!A-Za-z0-9_\ ,\(\)\"*]*) log ERROR "synchronous_standby_names has characters the watchdog will not restore"; return 1 ;; esac
    printf '%s\n' "$names" >"$names_file"
    q "ALTER SYSTEM SET synchronous_standby_names = ''" >/dev/null || return 1
    q "SELECT pg_reload_conf()" >/dev/null || return 1
    printf 'async since=%s\n' "$now" >"$flag_file"
    printf 'async_start=%s\n' "$now" >>"$history_file"
    rm -f "$down_file"
    log ALARM "no standby for ${grace}s: commits are asynchronous, open bills must be reconciled with the cloud after a promotion"
    return 0
  fi

  # Asynchronous mode (names empty). Only act when this watchdog caused it.
  [ -f "$flag_file" ] || return 0
  [ "$streaming" -gt 0 ] || return 0
  saved=$(cat "$names_file" 2>/dev/null) || { log ERROR "saved synchronous_standby_names is missing"; return 1; }
  [ -n "$saved" ] || { log ERROR "saved synchronous_standby_names is empty"; return 1; }
  case $saved in *[!A-Za-z0-9_\ ,\(\)\"*]*) log ERROR "saved synchronous_standby_names is not safe to restore"; return 1 ;; esac
  # Restore only when every streaming standby has replayed all the WAL written.
  behind=$(q "SELECT count(*) FROM pg_stat_replication WHERE state = 'streaming' AND (replay_lsn IS NULL OR replay_lsn < pg_current_wal_lsn())") || return 1
  case $behind in '' | *[!0-9]*) return 1 ;; esac
  [ "$behind" -eq 0 ] || return 0
  q "ALTER SYSTEM SET synchronous_standby_names = '$saved'" >/dev/null || return 1
  q "SELECT pg_reload_conf()" >/dev/null || return 1
  printf 'async_end=%s\n' "$now" >>"$history_file"
  rm -f "$flag_file"
  log INFO "standby caught up: synchronous commit restored"
  return 0
}

if [ "$once" = 1 ]; then
  tick
  exit $?
fi
while :; do
  tick || true
  sleep "$interval"
done
