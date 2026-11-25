#!/bin/sh
# Exercise check-edge-host.sh with stubbed host tools. Nothing here touches the
# real clock, disks or network, and no environment values are printed.
set -eu
root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
tmp=$(mktemp -d /tmp/legend-edge-host-test.XXXXXXXX)
trap 'chmod -R u+rwx "$tmp" 2>/dev/null || true; rm -rf "$tmp"' EXIT HUP INT TERM
bin="$tmp/bin"
mkdir "$bin"

# The script under test sees only these tools plus the stubs below.
for tool in sh awk grep sed ls tr find openssl wc head tail cat; do
  real=$(command -v "$tool")
  ln -s "$real" "$bin/$tool"
done

stub() {
  name=$1
  shift
  printf '#!/bin/sh\n%s\n' "$*" > "$bin/$name"
  chmod +x "$bin/$name"
}
unstub() { rm -f "$bin/$1"; }

stub uname 'printf "%s\n" "$TEST_OS"'
stub df 'for a; do last=$a; done
dev=/dev/sdb1
[ "$last" = / ] && dev=/dev/mapper/root
printf "Filesystem 1024-blocks Used Available Capacity Mounted on\n%s 999999999 1 %s 1%% /\n" "$dev" "$TEST_AVAIL_KB"'
stub chronyc '[ "$1" = tracking ] || exit 1
printf "Reference ID    : C0A80001 (ntp.example.invalid)\nStratum         : 3\nSystem time     : %s seconds %s of NTP time\nLeap status     : %s\n" "$TEST_OFFSET" "${TEST_DIRECTION:-fast}" "$TEST_LEAP"'
stub timedatectl 'printf "NTPSynchronized=%s\n" "$TEST_NTPSYNC"'
stub lsblk 'for a; do last=$a; done
if [ "$last" = /dev/sdb1 ]; then printf "%s\n" "$TEST_LSBLK_SELFIE"; else printf "%s\n" "$TEST_LSBLK"; fi'
stub fdesetup 'printf "%s\n" "$TEST_FDE"'

me=$(id -un)
selfies="$tmp/selfies"
state="$tmp/state"
cert="$tmp/edge.crt"
key="$tmp/edge.key"
envfile="$tmp/edge.env"
secret='sealsecretvalue0123456789'

openssl req -x509 -newkey rsa:2048 -nodes -keyout "$key" -out "$cert" -days 90 -subj '/CN=edge.invalid' >/dev/null 2>&1
openssl req -x509 -newkey rsa:2048 -nodes -keyout "$tmp/short.key" -out "$tmp/short.crt" -days 5 -subj '/CN=edge.invalid' >/dev/null 2>&1

reset() {
  rm -rf "$selfies"
  mkdir "$selfies"
  chmod 700 "$selfies"
  mkdir "$selfies/tenant-a"
  chmod 700 "$selfies/tenant-a"
  rm -rf "$state"
  mkdir "$state"
  chmod 700 "$state"
  printf 'EDGE_MODE=true\nWEB_URL=https://edge.outlet.invalid\nBETTER_AUTH_URL=https://edge.outlet.invalid\n# ATTENDANCE_SELFIE_SEAL_KEYS=%s\nATTENDANCE_SELFIE_SEAL_ACTIVE_KID=\nEDGE_SELFIE_DIR=%s\nEDGE_SELFIE_MAX_BYTES=1073741824\n' "$secret" "$selfies" > "$envfile"
  export TEST_OS=Linux TEST_AVAIL_KB=4194304 TEST_OFFSET=0.000123456 TEST_LEAP=Normal \
    TEST_NTPSYNC=yes TEST_LSBLK='crypt' TEST_LSBLK_SELFIE='crypt' TEST_FDE='FileVault is On.'
  unset TEST_DIRECTION || true
  stub chronyc '[ "$1" = tracking ] || exit 1
printf "Reference ID    : C0A80001 (ntp.example.invalid)\nStratum         : 3\nSystem time     : %s seconds %s of NTP time\nLeap status     : %s\n" "$TEST_OFFSET" "${TEST_DIRECTION:-fast}" "$TEST_LEAP"'
  stub timedatectl 'printf "NTPSynchronized=%s\n" "$TEST_NTPSYNC"'
  cert_path=$cert
}

# run_check [extra args]: sets $status and $out; the default arguments are valid.
run_check() {
  status=0
  out=$(PATH="$bin" sh "$root/check-edge-host.sh" --env-file "$envfile" --service-user "$me" --cert "$cert_path" --selfie-dir "$selfies" --state-dir "$state" "$@" 2>&1) || status=$?
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
    printf 'FAIL test %s: an env value was printed\n' "$1" >&2
    exit 1
  fi
}

# 1. Healthy host passes and prints no env values.
reset
run_check
expect_ok healthy
expect_out healthy 'PASS'
no_secret healthy

# 1b. One edge origin (1269 E8): both URLs equal and https, host-only cookie,
# no extra trusted origin.
reset
printf 'WEB_URL=https://edge.outlet.invalid\nBETTER_AUTH_URL=https://other.invalid\n' > "$envfile"
run_check
expect_fail origin-differ
expect_out origin-differ 'origin: WEB_URL and BETTER_AUTH_URL differ'
reset
printf 'EDGE_MODE=true\n' > "$envfile"
run_check
expect_fail origin-missing
reset
printf 'WEB_URL=http://edge.outlet.invalid\nBETTER_AUTH_URL=http://edge.outlet.invalid\n' > "$envfile"
run_check
expect_fail origin-http
reset
printf 'COOKIE_DOMAIN=.outlet.invalid\n' >> "$envfile"
run_check
expect_fail cookie-domain
expect_out cookie-domain 'origin: COOKIE_DOMAIN is set'
reset
printf 'TRUSTED_ORIGINS=https://other.invalid\n' >> "$envfile"
run_check
expect_fail trusted-origins
expect_out trusted-origins 'origin: TRUSTED_ORIGINS is set'
reset
printf 'COOKIE_DOMAIN=\nTRUSTED_ORIGINS=\n' >> "$envfile"
run_check
expect_ok origins-blank

# 1c. Edge web env file and build.
reset
run_check
expect_ok web-env-skipped
expect_out web-env-skipped 'WARN web-env: --web-env-file not given'
reset
webenv="$tmp/web.env"
webout="$tmp/web-output"
mkdir -p "$webout/server"
: > "$webout/server/index.mjs"
printf 'DEPLOYMENT_MODE=production\nDATA_CLASSIFICATION=real\n' > "$webenv"
run_check --web-env-file "$webenv" --web-output "$webout"
expect_ok web-env-ok
expect_out web-env-ok 'PASS web-build'
printf 'DEPLOYMENT_MODE=production\n' > "$webenv"
run_check --web-env-file "$webenv" --web-output "$webout"
expect_fail web-env-missing
expect_out web-env-missing 'web-env: DATA_CLASSIFICATION is missing'
printf 'DEPLOYMENT_MODE=production\nDATA_CLASSIFICATION=real\nDATABASE_URL=postgres://u:pw@h/db\n' > "$webenv"
run_check --web-env-file "$webenv" --web-output "$webout"
expect_fail web-env-secret
expect_out web-env-secret 'DATABASE_URL'
if printf '%s\n' "$out" | grep -F 'postgres://' >/dev/null; then echo 'FAIL web-env-secret: a value was printed' >&2; exit 1; fi
printf 'DEPLOYMENT_MODE=production\nDATA_CLASSIFICATION=real\n' > "$webenv"
rm -f "$webout/server/index.mjs"
run_check --web-env-file "$webenv" --web-output "$webout"
expect_fail web-build-missing

# 2. Clock offset: warn above 2 s, fail above 10 s, fail when unsynchronised.
reset
TEST_OFFSET=3.5 run_check
expect_ok offset-warn
expect_out offset-warn 'WARN'
reset
TEST_OFFSET=12 TEST_DIRECTION=slow run_check
expect_fail offset-fail
expect_out offset-fail 'FAIL'
reset
TEST_LEAP='Not synchronised' run_check
expect_fail unsynchronised

# 3. Without chronyc: timedatectl decides; with neither, fail.
reset
unstub chronyc
run_check
expect_ok timedatectl-yes
reset
unstub chronyc
TEST_NTPSYNC=no run_check
expect_fail timedatectl-no
reset
unstub chronyc
unstub timedatectl
run_check
expect_fail no-ntp-tool

# 4. Selfie volume: missing, loose mode, wrong owner, loose entry below it.
reset
rm -rf "$selfies"
run_check
expect_fail dir-missing
reset
chmod 755 "$selfies"
run_check
expect_fail dir-loose
reset
run_check --service-user no-such-user-xyz
expect_fail dir-wrong-owner
reset
chmod 755 "$selfies/tenant-a"
run_check
expect_fail child-loose
reset
: > "$selfies/tenant-a/obj.lss"
chmod 600 "$selfies/tenant-a/obj.lss"
run_check
expect_ok child-ok
reset
: > "$selfies/tenant-a/obj.lss"
chmod 644 "$selfies/tenant-a/obj.lss"
run_check
expect_fail file-loose

# 5. Free space must cover EDGE_SELFIE_MAX_BYTES (1 GiB in the env file) plus margin.
reset
TEST_AVAIL_KB=1048576 run_check
expect_fail space-low
reset
TEST_AVAIL_KB=1048576 run_check --max-bytes 1024 --margin-bytes 1024
expect_ok space-override

# 6. Full-disk encryption.
reset
TEST_LSBLK='disk' run_check
expect_fail fde-linux-off
reset
TEST_OS=Darwin TEST_FDE='FileVault is Off.' run_check
expect_fail fde-mac-off
reset
TEST_OS=Darwin TEST_FDE='FileVault is On.' run_check
expect_ok fde-mac-on

# 7. HTTPS certificate: missing and expiring within 30 days both fail.
reset
cert_path="$tmp/absent.crt" run_check
expect_fail cert-missing
reset
cert_path="$tmp/short.crt" run_check
expect_fail cert-expiring

# 8. The edge env file must never carry the cloud seal private key.
reset
printf 'EDGE_MODE=true\nATTENDANCE_SELFIE_SEAL_KEYS=%s\n' "$secret" > "$envfile"
run_check
expect_fail seal-keys
no_secret seal-keys
reset
printf 'EDGE_MODE=true\nexport ATTENDANCE_SELFIE_SEAL_ACTIVE_KID="k1"\n' > "$envfile"
run_check
expect_fail seal-kid
reset
printf 'WEB_URL=https://edge.outlet.invalid\nBETTER_AUTH_URL=https://edge.outlet.invalid\nEDGE_MODE=true\nATTENDANCE_SELFIE_SEAL_KEYS=""\n' > "$envfile"
run_check
expect_ok seal-empty

# 9. Usage: --env-file is required; an unreadable one fails.
status=0
out=$(PATH="$bin" sh "$root/check-edge-host.sh" --cert "$cert" 2>&1) || status=$?
[ "$status" -eq 2 ] || { printf 'FAIL test usage: expected exit 2, got %s\n' "$status" >&2; exit 1; }
reset
rm -f "$envfile"
run_check
expect_fail env-missing

# 10. Review findings. An unreadable subtree must fail, never pass silently.
if [ "$(id -u)" -ne 0 ]; then
  reset
  chmod 000 "$selfies/tenant-a"
  run_check
  chmod 700 "$selfies/tenant-a"
  expect_fail find-unreadable
  expect_out find-unreadable 'cannot inspect'
fi

# The selfie volume (not only /) must be encrypted; root too.
reset
TEST_LSBLK_SELFIE='disk' run_check
expect_fail fde-selfie-volume-off
expect_out fde-selfie-volume-off 'selfie'
reset
TEST_LSBLK='disk' run_check
expect_fail fde-root-off

# Space: free >= max(max_bytes - bytes stored in *.lss, 0) + margin.
reset
dd if=/dev/zero of="$selfies/tenant-a/obj.lss" bs=6000 count=1 2>/dev/null
chmod 600 "$selfies/tenant-a/obj.lss"
TEST_AVAIL_KB=5 run_check --max-bytes 10000 --margin-bytes 0
expect_ok space-minus-stored
TEST_AVAIL_KB=3 run_check --max-bytes 10000 --margin-bytes 0
expect_fail space-minus-stored-short
TEST_AVAIL_KB=1 run_check --max-bytes 1000 --margin-bytes 0
expect_ok space-stored-over-max
TEST_AVAIL_KB=1 run_check --max-bytes 1000 --margin-bytes 2000
expect_fail space-margin-added

# Env parsing: inline comments, quotes and whitespace around numbers; a
# symlinked directory is judged by its target; a bad number is a FAIL, not a
# half-finished usage error.
reset
printf 'WEB_URL=https://edge.outlet.invalid\nBETTER_AUTH_URL=https://edge.outlet.invalid\nEDGE_SELFIE_MAX_BYTES="1000"  # one thousand\nEDGE_SELFIE_DIR=%s # dir\n' "$selfies" > "$envfile"
TEST_AVAIL_KB=4 run_check --selfie-dir '' --margin-bytes 0
expect_ok env-number-comment
reset
printf 'EDGE_SELFIE_MAX_BYTES=lots\n' > "$envfile"
run_check
expect_fail env-number-bad
expect_out env-number-bad 'check(s) failed'
reset
chmod 755 "$selfies"
ln -s "$selfies" "$tmp/selfies-link"
run_check --selfie-dir "$tmp/selfies-link"
rm -f "$tmp/selfies-link"
expect_fail symlink-target-mode

# State volume (EDGE_STATE_DIR, owner alarm queue): must exist, mode 0700, owned
# by the service user. A missing or open directory is a FAIL.
reset
rm -rf "$state"
run_check
expect_fail state-dir-missing
expect_out state-dir-missing 'state-dir'
reset
chmod 755 "$state"
run_check
expect_fail state-dir-open-mode
expect_out state-dir-open-mode 'state-dir'
reset
run_check
expect_ok state-dir-ok
expect_out state-dir-ok 'PASS state-dir: mode 0700'
reset
printf 'WEB_URL=https://edge.outlet.invalid\nBETTER_AUTH_URL=https://edge.outlet.invalid\nEDGE_SELFIE_DIR=%s\nEDGE_STATE_DIR=%s\n' "$selfies" "$tmp/state-from-env" > "$envfile"
run_check --state-dir ''
expect_fail state-dir-from-env-missing
mkdir "$tmp/state-from-env"
chmod 700 "$tmp/state-from-env"
run_check --state-dir ''
expect_ok state-dir-from-env
rm -rf "$tmp/state-from-env"

# 10b. A forgotten proxy hop count warns but does not block the host.
reset
run_check
expect_ok trust-proxy-missing
expect_out trust-proxy-missing 'WARN trust-proxy:'
reset
printf 'TRUST_PROXY=1\n' >> "$envfile"
run_check
expect_ok trust-proxy-set
expect_out trust-proxy-set 'PASS trust-proxy:'

# 11. Missing maintenance URL disables audit purge but must not disable POS.
reset
run_check
expect_ok audit-retention-missing
expect_out audit-retention-missing 'WARN audit-retention:'
expect_out audit-retention-missing 'MAINTENANCE_DATABASE_URL'
reset
printf 'MAINTENANCE_DATABASE_URL="   "  # not configured\n' >> "$envfile"
run_check
expect_ok audit-retention-blank
expect_out audit-retention-blank 'WARN audit-retention:'
reset
printf 'export MAINTENANCE_DATABASE_URL="postgres://maint:%s@localhost/edge"\n' "$secret" >> "$envfile"
run_check
expect_ok audit-retention-configured
expect_out audit-retention-configured 'PASS audit-retention:'
no_secret audit-retention-configured
# The host check only checks presence; runtime validates the URL before boot.
reset
printf 'MAINTENANCE_DATABASE_URL=invalid-url-value\n' >> "$envfile"
run_check
expect_ok audit-retention-presence-only
expect_out audit-retention-presence-only 'PASS audit-retention:'
if printf '%s\n' "$out" | grep -F -- 'invalid-url-value' >/dev/null; then
  printf 'FAIL test audit-retention-presence-only: an env value was printed\n' >&2
  exit 1
fi

echo 'check-edge-host tests passed'
