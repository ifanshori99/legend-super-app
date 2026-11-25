#!/bin/sh
# Read-only preflight for an outlet edge host (legend-svy91). Changes nothing and
# never prints environment values. Exit 0: no FAIL. Exit 1: at least one FAIL.
# Exit 2: bad usage.
set -eu

usage() {
  cat >&2 <<'USAGE'
usage: check-edge-host.sh --env-file FILE [--service-user USER] [--cert FILE]
                          [--web-env-file FILE] [--web-output DIR]
                          [--selfie-dir DIR] [--state-dir DIR] [--max-bytes N] [--margin-bytes N]
  --env-file      edge API environment file (required); checks seal key and audit maintenance setup
  --service-user  account that runs the edge API (default: legend)
  --cert          HTTPS certificate file served to outlet devices
  --web-env-file  edge web environment file (legend-edge-web.service); checks the deployment settings
  --web-output    web build folder (default /opt/legend/apps/web/.output); checked with --web-env-file
  --selfie-dir    default: EDGE_SELFIE_DIR in the env file, else /var/lib/legend/edge-selfies
  --state-dir     default: EDGE_STATE_DIR in the env file, else /var/lib/legend/edge-state
  --max-bytes     default: EDGE_SELFIE_MAX_BYTES in the env file, else 2147483648
  --margin-bytes  extra free space required on top of --max-bytes (default 536870912)
USAGE
  exit 2
}

env_file=
service_user=legend
cert=
web_env_file=
web_output=/opt/legend/apps/web/.output
selfie_dir=
state_dir=
max_bytes=
margin_bytes=536870912
while [ $# -gt 0 ]; do
  case $1 in
    --env-file | --service-user | --cert | --web-env-file | --web-output | --selfie-dir | --state-dir | --max-bytes | --margin-bytes)
      [ $# -ge 2 ] || usage
      case $1 in
        --env-file) env_file=$2 ;;
        --service-user) service_user=$2 ;;
        --cert) cert=$2 ;;
        --web-env-file) web_env_file=$2 ;;
        --web-output) web_output=$2 ;;
        --selfie-dir) selfie_dir=$2 ;;
        --state-dir) state_dir=$2 ;;
        --max-bytes) max_bytes=$2 ;;
        --margin-bytes) margin_bytes=$2 ;;
      esac
      shift 2
      ;;
    *) usage ;;
  esac
done
[ -n "$env_file" ] || usage
# Validate options before printing anything, so a usage error never follows
# partial output.
for n in "$max_bytes" "$margin_bytes"; do
  case $n in *[!0-9]*) usage ;; esac
done
[ -n "$margin_bytes" ] || usage

failures=0
pass() { printf 'PASS %s\n' "$1"; }
warn() { printf 'WARN %s\n' "$1"; }
fail() {
  printf 'FAIL %s\n' "$1"
  failures=$((failures + 1))
}

is_uint() {
  case $1 in '' | *[!0-9]*) return 1 ;; *) return 0 ;; esac
}

# env_value NAME: value of the last uncommented NAME=value line. Quoted values
# keep their content; unquoted values lose a trailing "# comment" and whitespace.
# Non-secret settings (directory and size), or a private pipe that checks only
# whether the maintenance URL is blank. Never print that URL.
env_value() {
  v=$(grep -E "^[[:space:]]*(export[[:space:]]+)?$1=" "$env_file" 2>/dev/null | tail -n 1 |
    sed -e 's/^[^=]*=//' -e 's/^[[:space:]]*//')
  case $v in
    \"*) v=$(printf '%s\n' "$v" | sed -e 's/^"\([^"]*\)".*$/\1/') ;;
    \'*) v=$(printf '%s\n' "$v" | sed -e "s/^'\\([^']*\\)'.*\$/\\1/") ;;
    *) v=$(printf '%s\n' "$v" | sed -e 's/[[:space:]][[:space:]]*#.*$//' -e 's/[[:space:]]*$//') ;;
  esac
  printf '%s\n' "$v"
}

# env_is_set NAME: true when NAME has a non-empty value; prints nothing.
env_is_set() {
  grep -E "^[[:space:]]*(export[[:space:]]+)?$1=[[:space:]]*([\"'][^\"']|[^[:space:]\"'#])" "$env_file" >/dev/null 2>&1
}

os=$(uname -s)

# 1. Edge env file: readable, and never holds the cloud seal private key.
if [ ! -r "$env_file" ]; then
  fail "env-file: cannot read the edge env file"
else
  leaked=
  for name in ATTENDANCE_SELFIE_SEAL_KEYS ATTENDANCE_SELFIE_SEAL_ACTIVE_KID; do
    if env_is_set "$name"; then leaked="$leaked $name"; fi
  done
  if [ -n "$leaked" ]; then
    fail "seal-key: edge env file sets$leaked; the edge must hold only the public key (arrives by snapshot), remove them"
  else
    pass "seal-key: edge env file holds no seal private key"
  fi
  # Presence only: the API validates URL syntax before starting components,
  # then probes the connection and restricted role during initialization.
  # Missing configuration must warn without preventing offline POS startup.
  if env_value MAINTENANCE_DATABASE_URL | grep -q '[^[:space:]]'; then
    pass "audit-retention: MAINTENANCE_DATABASE_URL is configured; runtime verifies the connection and restricted role"
  else
    warn "audit-retention: MAINTENANCE_DATABASE_URL is missing; audit purge is skipped, restore configuration and check the local startup error and owner alarm"
  fi
  # Caddy is the one proxy in front of the API; without the hop count every
  # outlet device shares one per-IP rate-limit bucket.
  trust_proxy=$(env_value TRUST_PROXY)
  if [ "$trust_proxy" = 1 ]; then
    pass "trust-proxy: TRUST_PROXY is 1"
  else
    warn "trust-proxy: TRUST_PROXY is not 1; set it so each outlet device has its own rate limit"
  fi
  # One origin for the web app and the API (1269 E8). WEB_URL and
  # BETTER_AUTH_URL must both be the edge HTTPS origin; the defaults point at
  # localhost and would make the browser call the wrong host. The session
  # cookie stays host-only (no COOKIE_DOMAIN) and no other origin is trusted.
  web_url=$(env_value WEB_URL)
  auth_url=$(env_value BETTER_AUTH_URL)
  if [ -z "$web_url" ] || [ -z "$auth_url" ]; then
    fail "origin: WEB_URL and BETTER_AUTH_URL must both be set to the edge HTTPS origin"
  elif [ "$web_url" != "$auth_url" ]; then
    fail "origin: WEB_URL and BETTER_AUTH_URL differ; the edge serves web and API from one origin"
  else
    case $web_url in
      https://*) pass "origin: WEB_URL and BETTER_AUTH_URL are the same HTTPS origin" ;;
      *) fail "origin: the edge origin must be https (the camera needs a secure context)" ;;
    esac
  fi
  if env_is_set COOKIE_DOMAIN; then
    fail "origin: COOKIE_DOMAIN is set; leave it empty so the session cookie stays on the edge host"
  else
    pass "origin: COOKIE_DOMAIN is empty (host-only cookie)"
  fi
  if env_is_set TRUSTED_ORIGINS; then
    fail "origin: TRUSTED_ORIGINS is set; leave it empty, the edge trusts only its own origin"
  else
    pass "origin: TRUSTED_ORIGINS is empty"
  fi
  [ -n "$selfie_dir" ] || selfie_dir=$(env_value EDGE_SELFIE_DIR)
  [ -n "$state_dir" ] || state_dir=$(env_value EDGE_STATE_DIR)
  [ -n "$max_bytes" ] || max_bytes=$(env_value EDGE_SELFIE_MAX_BYTES)
fi
[ -n "$selfie_dir" ] || selfie_dir=/var/lib/legend/edge-selfies
[ -n "$state_dir" ] || state_dir=/var/lib/legend/edge-state
[ -n "$max_bytes" ] || max_bytes=2147483648
space_inputs=ok
if ! is_uint "$max_bytes"; then
  fail "disk-space: EDGE_SELFIE_MAX_BYTES is not a whole number"
  space_inputs=bad
fi

# 1b. Edge web env file and build (legend-edge-web.service, 1269 E8). Names only:
# no value is printed.
if [ -z "$web_env_file" ]; then
  warn "web-env: --web-env-file not given; the edge web app settings were not checked"
elif [ ! -r "$web_env_file" ]; then
  fail "web-env: cannot read the edge web env file"
else
  saved_env_file=$env_file
  env_file=$web_env_file
  for name in DEPLOYMENT_MODE DATA_CLASSIFICATION; do
    if env_is_set "$name"; then
      pass "web-env: $name is set"
    else
      fail "web-env: $name is missing; the web server refuses to start without it"
    fi
  done
  web_secrets=
  for name in DATABASE_URL WORKER_DATABASE_URL MAINTENANCE_DATABASE_URL BETTER_AUTH_SECRET EDGE_NODE_CREDENTIAL ATTENDANCE_SELFIE_SEAL_KEYS; do
    if env_is_set "$name"; then web_secrets="$web_secrets $name"; fi
  done
  if [ -n "$web_secrets" ]; then
    fail "web-env: the web env file sets$web_secrets; these belong to the API only, remove them"
  else
    pass "web-env: the web env file holds no API-only secret"
  fi
  env_file=$saved_env_file
  if [ -r "$web_output/server/index.mjs" ]; then
    pass "web-build: the web build is in place"
  else
    fail "web-build: server/index.mjs is missing in the web build folder; copy .output from the edge web image"
  fi
fi

# 2. Clock: edge and phones must agree within one 30 s QR window.
if command -v chronyc >/dev/null 2>&1; then
  tracking=$(chronyc tracking 2>/dev/null || true)
  leap=$(printf '%s\n' "$tracking" | awk -F: '/^Leap status/ { gsub(/^[ \t]+|[ \t]+$/, "", $2); print $2 }')
  offset=$(printf '%s\n' "$tracking" | awk -F: '/^System time/ { split($2, a, " "); print a[1] }')
  if [ -z "$leap" ] || [ "$leap" = "Not synchronised" ] || [ -z "$offset" ]; then
    fail "clock: chrony is not synchronised"
  else
    verdict=$(awk -v o="$offset" 'BEGIN { if (o < 0) o = -o; if (o > 10) print "fail"; else if (o > 2) print "warn"; else print "ok" }')
    case $verdict in
      fail) fail "clock: offset ${offset}s exceeds 10s" ;;
      warn) warn "clock: offset ${offset}s exceeds 2s" ;;
      *) pass "clock: chrony synchronised, offset ${offset}s" ;;
    esac
  fi
elif command -v timedatectl >/dev/null 2>&1; then
  if [ "$(timedatectl show -p NTPSynchronized 2>/dev/null || true)" = "NTPSynchronized=yes" ]; then
    pass "clock: NTP synchronised (offset unknown, install chrony to measure it)"
  else
    fail "clock: NTP is not synchronised"
  fi
else
  fail "clock: neither chronyc nor timedatectl found, cannot confirm NTP"
fi

# 3. Selfie volume: private, owned by the service user, large enough.
if [ ! -d "$selfie_dir" ]; then
  fail "selfie-dir: EDGE_SELFIE_DIR does not exist or is not a directory"
else
  listing=$(ls -ldL "$selfie_dir")
  mode=$(printf '%s\n' "$listing" | awk '{ print substr($1, 1, 10) }')
  owner=$(printf '%s\n' "$listing" | awk '{ print $3 }')
  if [ "$mode" != "drwx------" ]; then
    fail "selfie-dir: mode is $mode, expected drwx------ (0700)"
  else
    pass "selfie-dir: mode 0700"
  fi
  if [ "$owner" != "$service_user" ]; then
    fail "selfie-dir: owner is $owner, expected $service_user"
  else
    pass "selfie-dir: owned by $service_user"
  fi
  # A find error (unreadable subtree) must not read as "nothing loose".
  if loose_list=$(find -L "$selfie_dir" \( -perm -040 -o -perm -020 -o -perm -010 -o -perm -004 -o -perm -002 -o -perm -001 \) -print 2>/dev/null); then
    loose=$(printf '%s\n' "$loose_list" | grep -c . || true)
    if [ "$loose" -gt 0 ]; then
      fail "selfie-dir: $loose entries below it are group or other accessible"
    else
      pass "selfie-dir: no group or other access below it"
    fi
  else
    fail "selfie-dir: cannot inspect everything below it, run as root or the service user"
  fi
  if [ "$space_inputs" = ok ]; then
    # Bytes already stored count against the quota, as the API health does:
    # remaining = max - used, never below zero. Unreadable files count as 0,
    # which only makes the requirement stricter.
    used=$(find -L "$selfie_dir" -type f -name '*.lss' -exec wc -c {} + 2>/dev/null |
      awk '/\.lss$/ { s += $1 } END { printf "%d\n", s }' || true)
    is_uint "$used" || used=0
    remaining=$((max_bytes - used))
    [ "$remaining" -ge 0 ] || remaining=0
    avail_kb=$(df -Pk "$selfie_dir" 2>/dev/null | awk 'NR == 2 { print $4 }')
    if ! is_uint "$avail_kb"; then
      fail "disk-space: cannot read free space"
    else
      free=$((avail_kb * 1024))
      need=$((remaining + margin_bytes))
      if [ "$free" -lt "$need" ]; then
        fail "disk-space: $free bytes free, need $need (room for the remaining quota plus margin)"
      else
        pass "disk-space: $free bytes free, need $need"
      fi
    fi
  fi
fi

# 3b. State volume (owner alarm queue, brief 533 A5): it must exist and be
# writable by the service user only. The API creates it when its parent is
# writable; on a fresh host that is usually not the case, so create it first.
if [ ! -d "$state_dir" ]; then
  fail "state-dir: EDGE_STATE_DIR does not exist or is not a directory (create it, owned by $service_user, mode 0700)"
else
  state_listing=$(ls -ldL "$state_dir")
  state_mode=$(printf '%s\n' "$state_listing" | awk '{ print substr($1, 1, 10) }')
  state_owner=$(printf '%s\n' "$state_listing" | awk '{ print $3 }')
  if [ "$state_mode" != "drwx------" ]; then
    fail "state-dir: mode is $state_mode, expected drwx------ (0700)"
  else
    pass "state-dir: mode 0700"
  fi
  if [ "$state_owner" != "$service_user" ]; then
    fail "state-dir: owner is $state_owner, expected $service_user (the service user must be able to write it)"
  else
    pass "state-dir: owned by $service_user, writable by it"
  fi
fi

# 4. Full-disk encryption on the selfie volume and on the root volume.
check_crypt() {
  dev=$(df -P "$2" 2>/dev/null | awk 'NR == 2 { print $1 }')
  if [ -n "$dev" ] && lsblk -s -n -o TYPE "$dev" 2>/dev/null | grep -x 'crypt' >/dev/null; then
    pass "fde: $1 volume sits on an encrypted (crypt) device"
  else
    fail "fde: $1 volume is not on an encrypted (crypt) device"
  fi
}
case $os in
  Darwin)
    if fdesetup status 2>/dev/null | grep -F 'FileVault is On' >/dev/null; then
      pass "fde: FileVault is on"
    else
      fail "fde: FileVault is not on"
    fi
    ;;
  *)
    if [ -d "$selfie_dir" ]; then check_crypt selfie "$selfie_dir"; fi
    check_crypt root /
    ;;
esac

# 5. HTTPS certificate for outlet devices (camera needs a secure context).
if [ -z "$cert" ]; then
  fail "https: --cert not given"
elif [ ! -r "$cert" ]; then
  fail "https: certificate file is missing or unreadable"
elif openssl x509 -checkend 2592000 -noout -in "$cert" >/dev/null 2>&1; then
  pass "https: certificate valid for at least 30 more days"
else
  fail "https: certificate is invalid or expires within 30 days"
fi

if [ "$failures" -gt 0 ]; then
  printf '%s check(s) failed\n' "$failures"
  exit 1
fi
printf 'edge host checks passed\n'
