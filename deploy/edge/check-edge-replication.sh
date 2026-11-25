#!/bin/sh
# Read-only preflight for edge PostgreSQL replication (legend 1269 F11a). Changes
# nothing and never prints setting values. Fails closed: a setting that cannot be
# read or confirmed is a FAIL. Exit 0: no FAIL. Exit 1: at least one FAIL. Exit 2:
# bad usage.
set -eu

usage() {
  cat >&2 <<'USAGE'
usage: check-edge-replication.sh --role primary --conf FILE --hba FILE --replication-role NAME [--app-env-file FILE]
       check-edge-replication.sh --role standby --conf FILE --replication-role NAME --data-dir DIR [--app-env-file FILE]
  --role              primary or standby
  --conf              the PostgreSQL settings file (see postgresql-edge-*.conf.example)
  --hba               pg_hba.conf (primary only)
  --replication-role  login used only for replication (for example edge_replicator)
  --data-dir          standby data directory (standby only); must hold standby.signal
  --app-env-file      edge API env file; its database logins must differ from the replication role
USAGE
  exit 2
}

role=
conf=
hba=
repl_role=
data_dir=
app_env=
while [ $# -gt 0 ]; do
  case $1 in
    --role | --conf | --hba | --replication-role | --data-dir | --app-env-file)
      [ $# -ge 2 ] || usage
      case $1 in
        --role) role=$2 ;;
        --conf) conf=$2 ;;
        --hba) hba=$2 ;;
        --replication-role) repl_role=$2 ;;
        --data-dir) data_dir=$2 ;;
        --app-env-file) app_env=$2 ;;
      esac
      shift 2
      ;;
    *) usage ;;
  esac
done
case $role in primary | standby) ;; *) usage ;; esac
[ -n "$conf" ] || usage
[ -n "$repl_role" ] || usage
case $repl_role in *[!A-Za-z0-9_]*) usage ;; esac
if [ "$role" = primary ]; then
  [ -n "$hba" ] || usage
else
  [ -n "$data_dir" ] || usage
fi

failures=0
pass() { printf 'PASS %s\n' "$1"; }
warn() { printf 'WARN %s\n' "$1"; }
fail() {
  printf 'FAIL %s\n' "$1"
  failures=$((failures + 1))
}

# conf_value NAME: value of the last uncommented "NAME = value" line, quotes and
# trailing comment removed. Empty when absent.
conf_value() {
  v=$(grep -E "^[[:space:]]*$1[[:space:]]*=" "$conf" 2>/dev/null | tail -n 1 |
    sed -e 's/^[^=]*=[[:space:]]*//')
  case $v in
    \'*) v=$(printf '%s\n' "$v" | sed -e "s/^'\\(.*\\)'[[:space:]]*\\(#.*\\)\\{0,1\\}\$/\\1/") ;;
    *) v=$(printf '%s\n' "$v" | sed -e 's/[[:space:]]*#.*$//' -e 's/[[:space:]]*$//') ;;
  esac
  printf '%s\n' "$v"
}

is_uint() {
  case $1 in '' | *[!0-9]*) return 1 ;; *) return 0 ;; esac
}

# 1. The settings file must be readable; nothing else can be judged without it.
if [ ! -r "$conf" ]; then
  fail "conf: cannot read the settings file"
  printf '%s check(s) failed\n' "$failures"
  exit 1
fi

# A password in the settings file would sit in the repository or a backup.
if grep -v '^[[:space:]]*#' "$conf" | grep -Ei '(^|[^a-z_])password[[:space:]]*=[[:space:]]*[^[:space:]#]' >/dev/null 2>&1; then
  fail "secret: the settings file holds a password; use a passfile (mode 0600) instead"
else
  pass "secret: the settings file holds no password"
fi

# 2. Separate role: the replication login is not an application login.
if [ -n "$app_env" ]; then
  if [ ! -r "$app_env" ]; then
    fail "role: cannot read the app env file"
  else
    clash=
    for name in DATABASE_URL WORKER_DATABASE_URL MAINTENANCE_DATABASE_URL; do
      # Only the login name is extracted: the text between "://" and the first ":" or "@".
      u=$(grep -E "^[[:space:]]*(export[[:space:]]+)?$name=" "$app_env" 2>/dev/null | tail -n 1 |
        sed -e 's/^[^=]*=//' -e "s/[\"']//g" -e 's#^[A-Za-z0-9+.-]*://##' -e 's/[:@].*$//')
      if [ "$u" = "$repl_role" ]; then clash="$clash $name"; fi
    done
    if [ -n "$clash" ]; then
      fail "role: the replication role is also the login in$clash; use a separate role"
    else
      pass "role: the replication role is not an application login"
    fi
  fi
else
  warn "role: --app-env-file not given; the separation from application logins was not checked"
fi

if [ "$role" = primary ]; then
  # 3p. WAL and senders.
  wal=$(conf_value wal_level)
  case $wal in
    replica | logical) pass "wal: wal_level allows streaming" ;;
    *) fail "wal: wal_level must be replica or logical" ;;
  esac
  senders=$(conf_value max_wal_senders)
  if is_uint "$senders" && [ "$senders" -ge 2 ]; then
    pass "wal: max_wal_senders is at least 2"
  else
    fail "wal: max_wal_senders must be at least 2 (standby plus base backup)"
  fi
  slots=$(conf_value max_replication_slots)
  if is_uint "$slots" && [ "$slots" -ge 1 ]; then
    pass "wal: max_replication_slots is at least 1"
  else
    fail "wal: max_replication_slots must be at least 1 (the standby keeps a slot)"
  fi

  # 4p. TLS on, scram passwords.
  if [ "$(conf_value ssl)" = on ]; then
    pass "tls: ssl is on"
  else
    fail "tls: ssl must be on"
  fi
  if [ -n "$(conf_value ssl_cert_file)" ] && [ -n "$(conf_value ssl_key_file)" ]; then
    pass "tls: ssl_cert_file and ssl_key_file are set"
  else
    fail "tls: ssl_cert_file and ssl_key_file must both be set"
  fi
  if [ "$(conf_value password_encryption)" = scram-sha-256 ]; then
    pass "auth: password_encryption is scram-sha-256"
  else
    fail "auth: password_encryption must be scram-sha-256"
  fi

  # 5p. Synchronous commit with a named standby.
  case $(conf_value synchronous_commit) in
    on | remote_write | remote_apply) pass "sync: synchronous_commit waits for the standby" ;;
    *) fail "sync: synchronous_commit must be on, remote_write or remote_apply" ;;
  esac
  if [ -n "$(conf_value synchronous_standby_names)" ]; then
    pass "sync: synchronous_standby_names is set"
  else
    fail "sync: synchronous_standby_names is empty; the watchdog (not this file) switches to async"
  fi

  # 6p. pg_hba: every replication line is hostssl, one named role, scram or cert,
  # a narrow address. At least one such line, none of any other kind.
  if [ ! -r "$hba" ]; then
    fail "hba: cannot read pg_hba.conf"
  else
    good=0
    bad=0
    # Fields: type database user address method. Comments and blank lines skipped.
    lines=$(sed -e 's/#.*$//' "$hba" | awk 'NF >= 5 && $2 ~ /(^|,)replication(,|$)/ { print $1, $2, $3, $4, $5 }')
    if [ -n "$lines" ]; then
      while IFS=' ' read -r htype hdb huser haddr hmethod; do
        ok=1
        [ "$htype" = hostssl ] || ok=0
        [ "$hdb" = replication ] || ok=0
        [ "$huser" = "$repl_role" ] || ok=0
        case $hmethod in scram-sha-256 | cert) ;; *) ok=0 ;; esac
        case $haddr in
          */*) ;;
          *) ok=0 ;;
        esac
        case $haddr in
          0.0.0.0/* | all | samehost | samenet | */0) ok=0 ;;
        esac
        # Prefix length: IPv4 at least /24, IPv6 at least /64.
        pre=${haddr#*/}
        if is_uint "$pre"; then
          case $haddr in
            *:*) [ "$pre" -ge 64 ] || ok=0 ;;
            *) [ "$pre" -ge 24 ] || ok=0 ;;
          esac
        else
          ok=0
        fi
        if [ "$ok" = 1 ]; then good=$((good + 1)); else bad=$((bad + 1)); fi
      done <<HBA
$lines
HBA
    fi
    if [ "$bad" -gt 0 ]; then
      fail "hba: $bad replication line(s) are not hostssl with the replication role, scram-sha-256 or cert, and a narrow address"
    elif [ "$good" -eq 0 ]; then
      fail "hba: no replication line for the replication role; replication would not connect"
    else
      pass "hba: replication allowed only by hostssl, the replication role and a narrow address"
    fi
    # Replication lines of other forms (host, local, all users) use a different
    # database field spelling; "all" never grants replication, so nothing more to check.
  fi
else
  # 3s. Standby: hot standby, slot, signal file.
  if [ "$(conf_value hot_standby)" = on ]; then
    pass "standby: hot_standby is on"
  else
    fail "standby: hot_standby must be on"
  fi
  if [ -n "$(conf_value primary_slot_name)" ]; then
    pass "standby: primary_slot_name is set"
  else
    fail "standby: primary_slot_name must be set so the primary keeps the WAL the standby needs"
  fi
  if [ -f "$data_dir/standby.signal" ]; then
    pass "standby: standby.signal exists"
  else
    fail "standby: standby.signal is missing in the data directory"
  fi

  # 4s. The connection string: key=value form, TLS verified, replication role,
  # sync name, password only through a passfile.
  ci=$(conf_value primary_conninfo)
  if [ -z "$ci" ]; then
    fail "conninfo: primary_conninfo is not set"
  else
    case $ci in
      postgres://* | postgresql://*) fail "conninfo: use key=value form, not a URI" ;;
      *)
        has() { case " $ci " in *" $1 "*) return 0 ;; *) return 1 ;; esac; }
        has sslmode=verify-full && pass "conninfo: sslmode=verify-full" || fail "conninfo: sslmode must be verify-full"
        case " $ci " in
          *" sslrootcert="?*) pass "conninfo: sslrootcert is set" ;;
          *) fail "conninfo: sslrootcert must name the internal CA file" ;;
        esac
        has "user=$repl_role" && pass "conninfo: connects as the replication role" || fail "conninfo: user must be the replication role"
        case " $ci " in
          *" application_name="?*) pass "conninfo: application_name is set (must match synchronous_standby_names on the primary)" ;;
          *) fail "conninfo: application_name must be set" ;;
        esac
        case " $ci " in
          *" password="*) fail "conninfo: a password is in primary_conninfo; use passfile=" ;;
          *) pass "conninfo: no password in primary_conninfo" ;;
        esac
        pf=
        for tok in $ci; do
          case $tok in passfile=*) pf=${tok#passfile=} ;; esac
        done
        if [ -z "$pf" ]; then
          fail "conninfo: passfile= is missing; the standby has no way to log in"
        elif [ ! -r "$pf" ]; then
          fail "passfile: cannot read the passfile named in primary_conninfo"
        else
          pmode=$(ls -lL "$pf" | awk '{ print substr($1, 1, 10) }')
          if [ "$pmode" = "-rw-------" ] || [ "$pmode" = "-r--------" ]; then
            pass "passfile: mode is 0600 or stricter"
          else
            fail "passfile: mode is $pmode, expected -rw------- (0600)"
          fi
        fi
        ;;
    esac
  fi

  # 5s. The standby runs PostgreSQL only.
  if ! command -v systemctl >/dev/null 2>&1; then
    fail "apps: systemctl not found, cannot confirm the application units are stopped"
  else
    running=
    for unit in legend-edge legend-edge-worker legend-edge-web; do
      if systemctl is-active --quiet "$unit" 2>/dev/null; then running="$running $unit"; fi
    done
    if [ -n "$running" ]; then
      fail "apps: the standby must not run the application, stop$running"
    else
      pass "apps: no application unit is active on the standby"
    fi
  fi
fi

if [ "$failures" -gt 0 ]; then
  printf '%s check(s) failed\n' "$failures"
  exit 1
fi
printf 'edge replication checks passed\n'
