#!/bin/sh
# Edge primary watchdog for synchronous replication (legend 1269 F11a). With
# synchronous commit, a dead standby would block every sale. When no synchronous
# standby has streamed for GRACE seconds (default 10) this writes the async flag
# and the saved synchronous_standby_names to disk (fsync), then empties the
# setting (ALTER SYSTEM, reload) and logs an ALARM line. When a standby whose
# application_name is in the saved value has caught up, it restores the saved
# value. The flag is never deleted automatically: it moves to
# "recovered-awaiting-reconcile" and only --ack-reconciled (F11b, after the open
# bills are matched with the cloud) removes it. Async mode without a flag of ours
# is "async-unknown": it raises an ALARM, writes the flag and is never restored
# automatically. A physical slot in wal_status unreserved or lost also raises an
# ALARM (the standby needs a rebuild).
# Run it as the postgres user (unix socket, PG* settings from the environment).
# It never prints connection settings. Fails closed: when a query fails or returns
# something unexpected, it changes nothing (commits keep waiting for the standby
# rather than being acknowledged without a copy).
set -eu

usage() {
  cat >&2 <<'USAGE'
usage: edge-replication-watchdog.sh --state-dir DIR [--grace SECONDS] [--interval SECONDS] [--once]
       edge-replication-watchdog.sh --state-dir DIR --ack-reconciled
  --state-dir        directory for the marker files, owned by the running user (mode 0700)
  --grace            seconds without a synchronous standby before async (default 10)
  --interval         seconds between checks (default 2); a gap of more than 3 intervals
                     between two checks (restart, hang) restarts the grace clock
  --once             run one check and exit (used by the tests)
  --ack-reconciled   remove the flag; only allowed in the recovered-awaiting-reconcile state
Files in the state directory: replication-down-since, replication-sync-names,
replication-async.flag (status=async | async-unknown | recovered-awaiting-reconcile),
replication-async-history, replication-slot-alarm.
USAGE
  exit 2
}

state_dir=
grace=10
interval=2
mode=loop
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
      mode=once
      shift
      ;;
    --ack-reconciled)
      mode=ack
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

# A standby counts as caught up when it replayed all but this many bytes of WAL.
max_lag_bytes=1048576
# Characters allowed in synchronous_standby_names for the watchdog to put it back.
safe_names() { case $1 in '' | *[!A-Za-z0-9_\ ,\(\)\"*]*) return 1 ;; *) return 0 ;; esac; }

q() { psql -X -qAt -v ON_ERROR_STOP=1 -c "$1"; }
log() { printf '%s %s\n' "$1" "$2" >&2; }
is_uint() { case $1 in '' | *[!0-9]*) return 1 ;; *) return 0 ;; esac; }

down_file=$state_dir/replication-down-since
names_file=$state_dir/replication-sync-names
flag_file=$state_dir/replication-async.flag
history_file=$state_dir/replication-async-history
slot_file=$state_dir/replication-slot-alarm

# write_durable FILE TEXT: temp file, flush to disk, rename, flush again.
write_durable() {
  printf '%s\n' "$2" >"$1.tmp" && sync && mv "$1.tmp" "$1" && sync
}
append_history() {
  printf '%s\n' "$1" >>"$history_file" && sync
}
# flag_status: none, or the status= value of the flag file.
flag_status() {
  [ -f "$flag_file" ] || { printf 'none'; return 0; }
  s=
  while IFS= read -r l; do
    case $l in status=*) s=${l#status=} ;; esac
  done <"$flag_file"
  printf '%s' "$s"
}

if [ "$mode" = ack ]; then
  [ -d "$state_dir" ] || { log ERROR "state directory is missing"; exit 1; }
  if [ "$(flag_status)" != recovered-awaiting-reconcile ]; then
    log ERROR "the flag is not in the recovered-awaiting-reconcile state; nothing removed"
    exit 1
  fi
  now=$(date +%s)
  is_uint "$now" || exit 1
  append_history "reconciled=$now" || exit 1
  rm -f "$flag_file" && sync
  log INFO "flag removed after reconciliation"
  exit 0
fi

command -v sync >/dev/null 2>&1 || { log ERROR "sync not found; cannot write the flag durably"; exit 1; }

# slots_check: ALARM when a physical slot can no longer keep the WAL the standby needs.
slots_check() {
  bad=$(q "SELECT slot_name || ':' || wal_status FROM pg_replication_slots WHERE slot_type = 'physical' AND wal_status IN ('unreserved', 'lost')") || { log ERROR "cannot read pg_replication_slots"; return 1; }
  if [ -n "$bad" ]; then
    prev=$(cat "$slot_file" 2>/dev/null || true)
    if [ "$bad" != "$prev" ]; then
      printf '%s\n' "$bad" >"$slot_file"
      append_history "slot_alarm=$bad" || true
      log ALARM "replication slot is unreserved or lost ($bad): the standby may need a rebuild, free disk or check max_slot_wal_keep_size"
    fi
  else
    rm -f "$slot_file"
  fi
  return 0
}

# Number of standbys required and their application names, from a saved value
# such as "FIRST 1 (a, b)", "ANY 2 (a,b,c)", "2 (a,b)" or "a,b".
required_count() {
  r=$(printf '%s\n' "$1" | sed -e 's/^ *FIRST *//' -e 's/^ *ANY *//' -e 's/^\([0-9][0-9]*\).*$/\1/')
  if is_uint "$r"; then printf '%s' "$r"; else printf '1'; fi
}
name_list() {
  printf '%s\n' "$1" | sed -e 's/^ *FIRST *//' -e 's/^ *ANY *//' -e 's/^ *[0-9][0-9]* *//' | tr -d '"() ' | tr ',' '\n'
}

go_async() {
  case $names in '') return 1 ;; esac
  safe_names "$names" || { log ERROR "synchronous_standby_names has characters the watchdog will not restore"; return 1; }
  # Durable record first: if the host dies right after the ALTER, the flag and the
  # value to restore are already on disk.
  write_durable "$names_file" "$names" || return 1
  write_durable "$flag_file" "status=async
since=$now" || return 1
  q "ALTER SYSTEM SET synchronous_standby_names = ''" >/dev/null || return 1
  q "SELECT pg_reload_conf()" >/dev/null || return 1
  append_history "async_start=$now" || true
  rm -f "$down_file"
  log ALARM "no synchronous standby for ${grace}s: commits are asynchronous, open bills must be reconciled with the cloud after a promotion"
  return 0
}

try_restore() {
  saved=$(cat "$names_file" 2>/dev/null) || { log ERROR "saved synchronous_standby_names is missing"; return 1; }
  safe_names "$saved" || { log ERROR "saved synchronous_standby_names is missing or not safe to restore"; return 1; }
  need=$(required_count "$saved")
  [ "$need" -gt 0 ] || return 1
  # Standbys that stream and have replayed (almost) all the WAL written.
  caught=$(q "SELECT application_name FROM pg_stat_replication WHERE state = 'streaming' AND replay_lsn IS NOT NULL AND pg_wal_lsn_diff(pg_current_wal_lsn(), replay_lsn) <= $max_lag_bytes") || return 1
  [ -n "$caught" ] || return 0
  wanted=$(name_list "$saved")
  matches=0
  case $wanted in
    *'*'*) matches=$(printf '%s\n' "$caught" | grep -c .) ;;
    *)
      for c in $caught; do
        for w in $wanted; do
          if [ "$c" = "$w" ]; then
            matches=$((matches + 1))
            break
          fi
        done
      done
      ;;
  esac
  [ "$matches" -ge "$need" ] || return 0
  q "ALTER SYSTEM SET synchronous_standby_names = '$saved'" >/dev/null || return 1
  q "SELECT pg_reload_conf()" >/dev/null || return 1
  # The flag stays: it only moves to "recovered, waiting to be reconciled".
  write_durable "$flag_file" "status=recovered-awaiting-reconcile
since=$now" || return 1
  append_history "async_end=$now" || true
  log INFO "standby caught up: synchronous commit restored; the flag stays until the open bills are reconciled (--ack-reconciled)"
  return 0
}

# tick: one check. Returns non-zero without changing anything on any doubt.
tick_main() {
  [ -d "$state_dir" ] || { log ERROR "state directory is missing"; return 1; }
  names=$(q "SHOW synchronous_standby_names") || { log ERROR "cannot read synchronous_standby_names"; return 1; }
  now=$(date +%s)
  is_uint "$now" || return 1
  st=$(flag_status)

  if [ -n "$names" ]; then
    # Synchronous mode: healthy means a streaming standby that is in sync or quorum.
    healthy=$(q "SELECT count(*) FROM pg_stat_replication WHERE state = 'streaming' AND sync_state IN ('sync', 'quorum')") || { log ERROR "cannot read pg_stat_replication"; return 1; }
    is_uint "$healthy" || { log ERROR "unexpected replication count"; return 1; }
    if [ "$healthy" -gt 0 ]; then
      rm -f "$down_file"
      # A flag still saying async while a synchronous standby is healthy: the
      # restore finished but its flag update did not. Show recovered, keep the flag.
      if [ "$st" = async ]; then
        write_durable "$flag_file" "status=recovered-awaiting-reconcile
since=$now" || return 1
        append_history "async_end=$now" || true
      fi
      return 0
    fi
    since=
    last=
    if [ -f "$down_file" ]; then
      read -r since last <"$down_file" || true
    fi
    # A missing, garbled or stale file (the watchdog was not running) restarts the clock.
    if ! is_uint "$since" || ! is_uint "$last" || [ $((now - last)) -gt $((3 * interval)) ]; then
      printf '%s %s\n' "$now" "$now" >"$down_file"
      return 0
    fi
    printf '%s %s\n' "$since" "$now" >"$down_file"
    [ $((now - since)) -ge "$grace" ] || return 0
    go_async
    return $?
  fi

  # Asynchronous mode (names empty).
  case $st in
    async) try_restore; return $? ;;
    async-unknown) return 0 ;;
    *)
      # Async that this watchdog did not start (or a flag already recovered):
      # record it and alarm, never restore it automatically.
      write_durable "$flag_file" "status=async-unknown
since=$now" || return 1
      append_history "async_unknown_start=$now" || true
      log ALARM "synchronous_standby_names is empty and this watchdog did not set it: async mode is unknown, restore it by hand after checking the standby"
      return 0
      ;;
  esac
}

tick() {
  rc=0
  tick_main || rc=1
  slots_check || rc=1
  return $rc
}

if [ "$mode" = once ]; then
  tick
  exit $?
fi
while :; do
  tick || true
  sleep "$interval"
done
