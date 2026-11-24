#!/bin/sh
# Exercise deploy ordering without contacting Docker or exposing environment values.
set -eu
root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
# The caller's shell must not leak into the checks (shell wins over env files).
unset API_ENV_FILE WORKER_ENV_FILE DOIT_REFUNDS_ENABLED
tmp=$(mktemp -d /tmp/legend-deploy-test.XXXXXXXX)
trap 'rm -rf "$tmp"' EXIT HUP INT TERM
mkdir "$tmp/bin"
cat > "$tmp/bin/docker" <<'STUB'
#!/bin/sh
printf '%s\n' "$*" >> "$TEST_LOG"
STUB
chmod +x "$tmp/bin/docker"
password=0123456789abcdef0123456789abcdef0123456789abcdef
app="postgresql://legend_runtime_0123456789abcdef:$password@postgres:5432/legend"
worker="postgresql://legend_worker_0123456789abcdef:$password@postgres:5432/legend"
printf 'MIGRATION_DATABASE_URL=postgresql://owner:secret@postgres:5432/legend\n' > "$tmp/migrator.env"
grantor="postgresql://legend_grant_0123456789abcdef:$password@postgres:5432/legend"
printf 'APP_DATABASE_URL=%s\nPAYOUT_GRANTOR_DATABASE_URL=%s\n' "$app" "$grantor" > "$tmp/api.env"
: > "$tmp/web.env"
printf 'APP_DATABASE_URL=%s\nWORKER_DATABASE_URL=%s\n' "$app" "$worker" > "$tmp/worker.env"
for name in MIGRATOR API WEB WORKER; do
  printf '%s_ENV_FILE=%s/%s.env\n' "$name" "$tmp" "$(printf '%s' "$name" | tr 'A-Z' 'a-z')"
done > "$tmp/compose.env"
printf 'MIGRATOR_IMAGE=example.invalid/migrator:1\n' >> "$tmp/compose.env"
export TEST_LOG="$tmp/log"
PATH="$tmp/bin:$PATH"
export PATH
: > "$TEST_LOG"
"$root/deploy.sh" --env-file "$tmp/compose.env" --dry-run >/dev/null
[ "$(wc -l < "$TEST_LOG" | tr -d ' ')" -eq 2 ]
[ "$(grep -c 'config --quiet' "$TEST_LOG")" -eq 2 ]
: > "$TEST_LOG"
"$root/deploy.sh" --env-file "$tmp/compose.env" >/dev/null
[ "$(wc -l < "$TEST_LOG" | tr -d ' ')" -eq 10 ]
sed -n '2p' "$TEST_LOG" | grep -F 'up -d --wait postgres' >/dev/null
# legend-jtnd, legend-k1np: the pre-deploy check runs before migrate.
sed -n '3p' "$TEST_LOG" | grep -F -- '--profile migration run --rm migrate node dist/predeploy-check.js' >/dev/null
sed -n '4p' "$TEST_LOG" | grep -F -- '--profile migration run --rm migrate' >/dev/null
if sed -n '4p' "$TEST_LOG" | grep -F 'predeploy-check' >/dev/null; then
  echo 'legend-jtnd: line 4 is not the migration' >&2
  exit 1
fi
# Lines 6-7: the effective Compose configuration piped into its checker.
sed -n '6,7p' "$TEST_LOG" | grep -F 'config --format json' >/dev/null
sed -n '6,7p' "$TEST_LOG" | grep -E -- '^run --rm -i --network none .* /tmp/check-compose-env\.mjs$' >/dev/null
sed -n '8p' "$TEST_LOG" | grep -F -- '--profile provisioning run --rm provision-roles node dist/provision-roles.js --audit' >/dev/null
# The api must not depend on clamav: `up -d --wait api` would then wait for the
# slow scanner to become healthy and the first deploy would hang.
awk '/^  api:/{f=1;next} f&&/^  [a-z]/{f=0} f' "$root/compose.yaml" > "$tmp/api-service.yml"
[ -s "$tmp/api-service.yml" ]
if grep -E '^[[:space:]]+clamav:' "$tmp/api-service.yml" >/dev/null; then
  echo 'legend-w9hwh: api depends on clamav' >&2
  exit 1
fi
# The scanner starts before the services, without --wait (its signature download is slow).
sed -n '9p' "$TEST_LOG" | grep -E -- 'up -d clamav$' >/dev/null
sed -n '10p' "$TEST_LOG" | grep -F 'up -d --wait api web worker caddy' >/dev/null
if grep -F "$password" "$TEST_LOG" >/dev/null; then
  echo 'legend-zoqc: a password reached the docker command line' >&2
  exit 1
fi
# A failed pre-deploy check stops the deploy before the migration, the audit
# and any service.
cat > "$tmp/bin/docker" <<'STUB'
#!/bin/sh
printf '%s\n' "$*" >> "$TEST_LOG"
case "$*" in *predeploy-check*) exit 1 ;; esac
STUB
: > "$TEST_LOG"
if "$root/deploy.sh" --env-file "$tmp/compose.env" >/dev/null 2>&1; then
  echo 'legend-jtnd: deploy continued after a failed pre-deploy check' >&2
  exit 1
fi
if grep -F -e 'api web worker caddy' -e 'dist/provision-roles.js --audit' -e 'run --rm migrate' "$TEST_LOG" | grep -v 'predeploy-check' >/dev/null; then
  echo 'legend-jtnd: migration, audit or services ran after a failed pre-deploy check' >&2
  exit 1
fi
# A failed role audit stops the deploy before any service starts.
cat > "$tmp/bin/docker" <<'STUB'
#!/bin/sh
printf '%s\n' "$*" >> "$TEST_LOG"
case "$*" in *--audit*) exit 1 ;; esac
STUB
: > "$TEST_LOG"
if "$root/deploy.sh" --env-file "$tmp/compose.env" >/dev/null 2>&1; then
  echo 'legend-zoqc: deploy continued after a failed role audit' >&2
  exit 1
fi
if grep -F 'api web worker caddy' "$TEST_LOG" >/dev/null; then
  echo 'legend-zoqc: services started after a failed role audit' >&2
  exit 1
fi
# So does a configuration Compose would apply differently from the checked
# env files.
cat > "$tmp/bin/docker" <<'STUB'
#!/bin/sh
printf '%s\n' "$*" >> "$TEST_LOG"
case "$*" in *check-compose-env*) exit 1 ;; esac
STUB
: > "$TEST_LOG"
if "$root/deploy.sh" --env-file "$tmp/compose.env" >/dev/null 2>&1; then
  echo 'legend-zoqc: deploy continued after the Compose configuration check failed' >&2
  exit 1
fi
if grep -F -e 'api web worker caddy' -e 'dist/provision-roles.js --audit' "$TEST_LOG" >/dev/null; then
  echo 'legend-zoqc: the audit or services ran after the Compose configuration check failed' >&2
  exit 1
fi
if "$root/deploy.sh" --env-file relative --dry-run >/dev/null 2>&1; then
  echo 'legend-8br: relative environment file was accepted' >&2
  exit 1
fi
echo 'legend-8br: deploy dry-run and ordering checks passed'
# legend-8cf3: the pre-switch refund reset wrapper reads DOIT_REFUNDS_ENABLED
# from api.env, worker.env and the api and worker containers, refuses --apply
# when any has it on or a service has no container, and passes the value to
# the job. The stub lists one container per service (no worker when
# TEST_NO_WORKER is set) and answers docker inspect from TEST_*_CONTAINER_ENV,
# next to a URL that must never be printed.
cat > "$tmp/bin/docker" <<'STUB'
#!/bin/sh
printf '%s\n' "$*" >> "$TEST_LOG"
case "$*" in
  *" ps -a -q api") echo legend-api-1 ;;
  *" ps -a -q worker") [ -n "${TEST_NO_WORKER:-}" ] || echo legend-worker-1 ;;
  "inspect "*" legend-api-1") printf 'APP_DATABASE_URL=%s\n%s\n' "$TEST_APP_URL" "$TEST_API_CONTAINER_ENV" ;;
  "inspect "*" legend-worker-1") printf 'APP_DATABASE_URL=%s\n%s\n' "$TEST_APP_URL" "$TEST_WORKER_CONTAINER_ENV" ;;
esac
STUB
reset="$root/reset-preswitch-refunds.sh"
printf '0193a5b0-0000-7000-8000-000000000001\n' > "$tmp/ids.txt"
chmod 0644 "$tmp/ids.txt"
cp "$tmp/api.env" "$tmp/api.env.orig"
cp "$tmp/worker.env" "$tmp/worker.env.orig"
export TEST_APP_URL="$app"
export TEST_API_CONTAINER_ENV='DOIT_REFUNDS_ENABLED=false'
export TEST_WORKER_CONTAINER_ENV='WORKER_TRANSPORT=builtin'
printf 'DOIT_REFUNDS_ENABLED=false\n' >> "$tmp/api.env"
apply_reset() {
  "$reset" --env-file "$tmp/compose.env" --apply --touched-before 2026-11-09T03:00:00Z --ids "$tmp/ids.txt"
}
: > "$TEST_LOG"
apply_reset >/dev/null 2>"$tmp/err"
grep -F -- "--profile migration run --rm -e DOIT_REFUNDS_ENABLED=false -e LEGEND_RESET_WRAPPER=1 -v $tmp/ids.txt:/tmp/refund-ids.txt:ro migrate node dist/reset-preswitch-refunds.js --apply --touched-before 2026-11-09T03:00:00Z --ids /tmp/refund-ids.txt" "$TEST_LOG" >/dev/null || {
  echo 'legend-8cf3: the reset job did not get the switch value and the read-only --ids mount' >&2
  exit 1
}
refused() {
  : > "$TEST_LOG"
  if apply_reset >/dev/null 2>"$tmp/err"; then
    echo "legend-8cf3: --apply ran with the switch on in $1" >&2
    exit 1
  fi
  if grep -F 'reset-preswitch-refunds.js' "$TEST_LOG" >/dev/null; then
    echo "legend-8cf3: the reset job started with the switch on in $1" >&2
    exit 1
  fi
  grep -F "$1" "$tmp/err" >/dev/null || {
    echo "legend-8cf3: the refusal does not name $1" >&2
    exit 1
  }
  if grep -F "$password" "$tmp/err" >/dev/null; then
    echo 'legend-8cf3: the wrapper printed a password' >&2
    exit 1
  fi
}
printf 'DOIT_REFUNDS_ENABLED=true\n' >> "$tmp/api.env"
refused api.env
cp "$tmp/api.env.orig" "$tmp/api.env"
printf 'export DOIT_REFUNDS_ENABLED = "1"\n' >> "$tmp/worker.env"
refused worker.env
cp "$tmp/worker.env.orig" "$tmp/worker.env"
TEST_API_CONTAINER_ENV='DOIT_REFUNDS_ENABLED=true'
refused 'the api container'
TEST_API_CONTAINER_ENV=''
TEST_WORKER_CONTAINER_ENV='DOIT_REFUNDS_ENABLED=1'
refused 'the worker container'
TEST_WORKER_CONTAINER_ENV=''
# A bare key after KEY=false takes the value from Compose's shell.
printf 'DOIT_REFUNDS_ENABLED=false\nDOIT_REFUNDS_ENABLED\n' >> "$tmp/worker.env"
refused 'worker.env (its last DOIT_REFUNDS_ENABLED line is a bare key)'
cp "$tmp/worker.env.orig" "$tmp/worker.env"
# Another project's containers (or none) would hide the switch.
COMPOSE_PROJECT_NAME=other-project
export COMPOSE_PROJECT_NAME
refused 'COMPOSE_PROJECT_NAME'
unset COMPOSE_PROJECT_NAME
export TEST_NO_WORKER=1
refused 'No worker container'
# A dry-run still runs, with the switch passed as on so the job warns.
: > "$TEST_LOG"
"$reset" --env-file "$tmp/compose.env" --dry-run --touched-before 2026-11-09T03:00:00Z >/dev/null 2>&1
grep -F -- '--profile migration run --rm -e DOIT_REFUNDS_ENABLED=true -e LEGEND_RESET_WRAPPER=1 migrate node dist/reset-preswitch-refunds.js --dry-run --touched-before 2026-11-09T03:00:00Z' "$TEST_LOG" >/dev/null || {
  echo 'legend-8cf3: the dry-run did not pass the switch as on' >&2
  exit 1
}
echo 'legend-8cf3: pre-switch refund reset wrapper checks passed'
# legend-3gna: api and worker must agree on DOIT_REFUNDS_ENABLED, or the API
# could queue refunds the worker then ignores (or the reverse). The deploy path
# gets a read-only check that compares the two env files named in compose.env.
# Names the implementer must create (this test calls them):
#   deploy/single-vm/check-refund-flag.sh --env-file /absolute/path/compose.env
#     reads API_ENV_FILE and WORKER_ENV_FILE from compose.env, exits 0 when both
#     resolve to the same boolean, exits non-zero (message on stderr naming
#     DOIT_REFUNDS_ENABLED and both files, never a value or URL) when they
#     differ. Absent, empty and 0/false all count as false. It must not need
#     docker. deploy.sh must call it before the first compose up and stop the
#     deploy on failure (no migration, no api/web/worker/caddy start).
# Assumption: the spec does not say what happens for an unreadable env file;
# not tested here.
cat > "$tmp/bin/docker" <<'STUB'
#!/bin/sh
printf '%s\n' "$*" >> "$TEST_LOG"
STUB
check="$root/check-refund-flag.sh"
cp "$tmp/api.env.orig" "$tmp/api.env"
cp "$tmp/worker.env.orig" "$tmp/worker.env"
set_flag() {
  # set_flag <file> <value|--absent>; value may be empty (KEY= with no value).
  grep -v 'DOIT_REFUNDS_ENABLED' "$1" > "$1.new" || true
  mv "$1.new" "$1"
  [ "$2" = --absent ] || printf 'DOIT_REFUNDS_ENABLED=%s\n' "$2" >> "$1"
}
expect_same() {
  set_flag "$tmp/api.env" "$1"
  set_flag "$tmp/worker.env" "$2"
  "$check" --env-file "$tmp/compose.env" >/dev/null 2>"$tmp/err" || {
    echo "legend-3gna: api=$1 worker=$2 was refused but means the same" >&2
    exit 1
  }
}
expect_differ() {
  set_flag "$tmp/api.env" "$1"
  set_flag "$tmp/worker.env" "$2"
  if "$check" --env-file "$tmp/compose.env" >/dev/null 2>"$tmp/err"; then
    echo "legend-3gna: api=$1 worker=$2 was accepted although they differ" >&2
    exit 1
  fi
  grep -F DOIT_REFUNDS_ENABLED "$tmp/err" >/dev/null || {
    echo 'legend-3gna: the mismatch message does not name DOIT_REFUNDS_ENABLED' >&2
    exit 1
  }
  if grep -F -e "$password" -e postgresql:// "$tmp/err" >/dev/null; then
    echo 'legend-3gna: the check printed a database URL' >&2
    exit 1
  fi
}
[ -x "$check" ] || {
  echo "legend-3gna: $check does not exist or is not executable" >&2
  exit 1
}
expect_same true true
expect_same false false
expect_same --absent --absent
expect_same --absent false
expect_same false 0
expect_differ true false
expect_differ false true
expect_differ true --absent
expect_differ --absent true
expect_differ 0 true
# Compose drops a trailing ` #comment` on an unquoted value; so does the check.
expect_differ 'false # off' true
expect_same 'false # off' false
expect_same 'true # on' 1
expect_same '"false" # off' 0
# env.ts accepts only lower case true/false/1/0, so anything else fails here too.
expect_invalid() {
  set_flag "$tmp/api.env" "$1"
  set_flag "$tmp/worker.env" true
  if "$check" --env-file "$tmp/compose.env" >/dev/null 2>"$tmp/err"; then
    echo "legend-3gna: api=$1 was accepted but env.ts rejects it" >&2
    exit 1
  fi
  # Wording is the implementer's; it must name the flag and the allowed values.
  { grep -F DOIT_REFUNDS_ENABLED "$tmp/err" && grep -F 'true, false, 1 or 0' "$tmp/err"; } >/dev/null || {
    echo "legend-3gna: api=$1 did not fail with the allowed-values message" >&2
    exit 1
  }
  if grep -F -e "$password" -e postgresql:// "$tmp/err" >/dev/null; then
    echo 'legend-3gna: the check printed a database URL' >&2
    exit 1
  fi
}
expect_invalid TRUE
expect_invalid yes
expect_invalid garbage
# The deploy stops before any docker work when the two files differ.
set_flag "$tmp/api.env" true
set_flag "$tmp/worker.env" false
: > "$TEST_LOG"
if "$root/deploy.sh" --env-file "$tmp/compose.env" >/dev/null 2>&1; then
  echo 'legend-3gna: deploy continued with DOIT_REFUNDS_ENABLED differing between api.env and worker.env' >&2
  exit 1
fi
if grep -F -e 'api web worker caddy' -e 'run --rm migrate' -e 'dist/provision-roles.js --audit' "$TEST_LOG" >/dev/null; then
  echo 'legend-3gna: migration, audit or services ran despite the refund flag mismatch' >&2
  exit 1
fi
# A matching pair still deploys.
set_flag "$tmp/api.env" true
set_flag "$tmp/worker.env" true
: > "$TEST_LOG"
"$root/deploy.sh" --env-file "$tmp/compose.env" >/dev/null 2>&1 || {
  echo 'legend-3gna: deploy refused matching DOIT_REFUNDS_ENABLED values' >&2
  exit 1
}
grep -F 'up -d --wait api web worker caddy' "$TEST_LOG" >/dev/null || {
  echo 'legend-3gna: services did not start with matching values' >&2
  exit 1
}
echo 'legend-3gna: refund flag mismatch checks passed'
# legend-3gna follow-up (brief 797, T1): Compose gives a shell variable
# (API_ENV_FILE, WORKER_ENV_FILE) priority over compose.env, so the check must
# compare the files Compose will really use. A set but empty variable is an
# error (fail closed). Assumption: the message wording is the implementer's;
# the tests need exit status, DOIT_REFUNDS_ENABLED in the message, no value or
# URL printed, and no `up` call to docker.
write_flag() {
  # write_flag <file> <flag line, may be empty>: keep the file's other lines,
  # replace every DOIT_REFUNDS_ENABLED line with the given one.
  [ -f "$1" ] || printf 'APP_DATABASE_URL=%s\n' "$app" > "$1"
  set_flag "$1" --absent
  [ -z "$2" ] || printf '%s\n' "$2" >> "$1"
}
no_compose_up() {
  # $1 = what the case is; the stub logged every docker call.
  if grep -F -e ' up ' -e 'run --rm migrate' -e 'api web worker caddy' "$TEST_LOG" >/dev/null ||
    grep -E '^up ' "$TEST_LOG" >/dev/null; then
    echo "legend-3gna: compose up or the migration ran with $1" >&2
    exit 1
  fi
}
check_refuses() {
  # check_refuses <case> [word the message must name, default the flag];
  # env assignments are inherited from the caller.
  if "$check" --env-file "$tmp/compose.env" >/dev/null 2>"$tmp/err"; then
    echo "legend-3gna: the check accepted $1" >&2
    exit 1
  fi
  grep -F "${2:-DOIT_REFUNDS_ENABLED}" "$tmp/err" >/dev/null || {
    echo "legend-3gna: the refusal for $1 does not name ${2:-DOIT_REFUNDS_ENABLED}" >&2
    exit 1
  }
  if grep -F -e "$password" -e postgresql:// -e 'DOIT_REFUNDS_ENABLED=' "$tmp/err" >/dev/null; then
    echo "legend-3gna: the refusal for $1 printed a value or URL" >&2
    exit 1
  fi
}
deploy_refuses() {
  : > "$TEST_LOG"
  if "$root/deploy.sh" --env-file "$tmp/compose.env" >/dev/null 2>&1; then
    echo "legend-3gna: deploy continued with $1" >&2
    exit 1
  fi
  no_compose_up "$1"
}
# compose.env names api.env and worker.env, both on here.
write_flag "$tmp/api.env" 'DOIT_REFUNDS_ENABLED=true'
write_flag "$tmp/worker.env" 'DOIT_REFUNDS_ENABLED=true'
write_flag "$tmp/worker-off.env" 'DOIT_REFUNDS_ENABLED=false'
write_flag "$tmp/api-off.env" 'DOIT_REFUNDS_ENABLED=false'
# T1: the shell overrides the worker file with one that has the flag off.
WORKER_ENV_FILE="$tmp/worker-off.env"
export WORKER_ENV_FILE
check_refuses 'a WORKER_ENV_FILE override with a different flag'
deploy_refuses 'a WORKER_ENV_FILE override with a different flag'
unset WORKER_ENV_FILE
# The same for API_ENV_FILE.
API_ENV_FILE="$tmp/api-off.env"
export API_ENV_FILE
check_refuses 'an API_ENV_FILE override with a different flag'
deploy_refuses 'an API_ENV_FILE override with a different flag'
unset API_ENV_FILE
# Reverse: the files named in compose.env differ, but the override makes the
# effective files equal, so the check accepts (the override is what counts).
write_flag "$tmp/worker.env" 'DOIT_REFUNDS_ENABLED=false'
write_flag "$tmp/worker-on.env" 'DOIT_REFUNDS_ENABLED=true'
WORKER_ENV_FILE="$tmp/worker-on.env" "$check" --env-file "$tmp/compose.env" >/dev/null 2>"$tmp/err" || {
  echo 'legend-3gna: the check ignored a WORKER_ENV_FILE override that makes both files agree' >&2
  exit 1
}
# A set but empty override fails closed.
WORKER_ENV_FILE=""
export WORKER_ENV_FILE
check_refuses 'an empty WORKER_ENV_FILE' WORKER_ENV_FILE
deploy_refuses 'an empty WORKER_ENV_FILE'
unset WORKER_ENV_FILE
API_ENV_FILE=""
export API_ENV_FILE
check_refuses 'an empty API_ENV_FILE' API_ENV_FILE
deploy_refuses 'an empty API_ENV_FILE'
unset API_ENV_FILE
# T2: a bare DOIT_REFUNDS_ENABLED line (no = or :) is refused, whatever the
# shell holds, because Compose would read it from the shell. api.env true then
# a bare line, worker false: refused (deploy stops).
write_flag "$tmp/api.env" 'DOIT_REFUNDS_ENABLED=true'
printf 'DOIT_REFUNDS_ENABLED\n' >> "$tmp/api.env"
write_flag "$tmp/worker.env" 'DOIT_REFUNDS_ENABLED=false'
check_refuses 'a bare key in api.env (true then bare, worker false)'
deploy_refuses 'a bare key in api.env (true then bare, worker false)'
# Reverse: the bare key in worker.env.
write_flag "$tmp/api.env" 'DOIT_REFUNDS_ENABLED=false'
write_flag "$tmp/worker.env" 'DOIT_REFUNDS_ENABLED=true'
printf 'DOIT_REFUNDS_ENABLED\n' >> "$tmp/worker.env"
check_refuses 'a bare key in worker.env (worker true then bare, api false)'
deploy_refuses 'a bare key in worker.env (worker true then bare, api false)'
# With a value in the shell that would make the two sides agree, a bare key is
# still refused (the old behavior read it from the shell and accepted).
write_flag "$tmp/api.env" 'DOIT_REFUNDS_ENABLED=true'
printf 'DOIT_REFUNDS_ENABLED\n' >> "$tmp/api.env"
write_flag "$tmp/worker.env" 'DOIT_REFUNDS_ENABLED=false'
DOIT_REFUNDS_ENABLED=false
export DOIT_REFUNDS_ENABLED
check_refuses 'a bare key in api.env with DOIT_REFUNDS_ENABLED=false in the shell'
deploy_refuses 'a bare key in api.env with DOIT_REFUNDS_ENABLED=false in the shell'
unset DOIT_REFUNDS_ENABLED
write_flag "$tmp/api.env" 'DOIT_REFUNDS_ENABLED=false'
write_flag "$tmp/worker.env" 'DOIT_REFUNDS_ENABLED=true'
printf 'export DOIT_REFUNDS_ENABLED\n' >> "$tmp/worker.env"
DOIT_REFUNDS_ENABLED=false
export DOIT_REFUNDS_ENABLED
check_refuses 'an exported bare key in worker.env with DOIT_REFUNDS_ENABLED=false in the shell'
deploy_refuses 'an exported bare key in worker.env with DOIT_REFUNDS_ENABLED=false in the shell'
unset DOIT_REFUNDS_ENABLED
# A lone bare key in both files with the shell on is refused too.
write_flag "$tmp/api.env" 'DOIT_REFUNDS_ENABLED'
write_flag "$tmp/worker.env" 'DOIT_REFUNDS_ENABLED'
DOIT_REFUNDS_ENABLED=true
export DOIT_REFUNDS_ENABLED
check_refuses 'bare keys in both files with DOIT_REFUNDS_ENABLED=true in the shell'
deploy_refuses 'bare keys in both files with DOIT_REFUNDS_ENABLED=true in the shell'
unset DOIT_REFUNDS_ENABLED
# A normal KEY=value pair still deploys after all of this.
write_flag "$tmp/api.env" 'DOIT_REFUNDS_ENABLED=true'
write_flag "$tmp/worker.env" 'DOIT_REFUNDS_ENABLED=true'
: > "$TEST_LOG"
"$root/deploy.sh" --env-file "$tmp/compose.env" >/dev/null 2>&1 || {
  echo 'legend-3gna: deploy refused two files with the same explicit value' >&2
  exit 1
}
echo 'legend-3gna: shell override and bare key checks passed'
# T4 (CTO approved): an empty DOIT_REFUNDS_ENABLED value is refused in api.env
# and in worker.env (KEY=, KEY="" and KEY=''), because env.ts rejects it and
# the API would not start. A key absent from both files still means off. A
# tab before a trailing comment is refused (Compose only drops a space-led
# ` #comment`); a space before it stays valid.
# Assumption: the message wording is the implementer's; the tests need exit
# status, DOIT_REFUNDS_ENABLED in the message, no value or URL printed, and no
# `up` call to docker.
tab=$(printf '\t')
for empty in 'DOIT_REFUNDS_ENABLED=' 'DOIT_REFUNDS_ENABLED=""' "DOIT_REFUNDS_ENABLED=''"; do
  for other in 'DOIT_REFUNDS_ENABLED=false' 'DOIT_REFUNDS_ENABLED=true' 'DOIT_REFUNDS_ENABLED='; do
    write_flag "$tmp/api.env" "$empty"
    write_flag "$tmp/worker.env" "$other"
    check_refuses "an empty value in api.env ($empty, other side $other)"
    deploy_refuses "an empty value in api.env ($empty, other side $other)"
    write_flag "$tmp/api.env" "$other"
    write_flag "$tmp/worker.env" "$empty"
    check_refuses "an empty value in worker.env ($empty, other side $other)"
    deploy_refuses "an empty value in worker.env ($empty, other side $other)"
  done
done
# Both files without the key: off on both sides, the deploy goes ahead.
write_flag "$tmp/api.env" ''
write_flag "$tmp/worker.env" ''
"$check" --env-file "$tmp/compose.env" >/dev/null 2>"$tmp/err" || {
  echo 'legend-3gna: the check refused two files that both lack DOIT_REFUNDS_ENABLED' >&2
  exit 1
}
: > "$TEST_LOG"
"$root/deploy.sh" --env-file "$tmp/compose.env" >/dev/null 2>&1 || {
  echo 'legend-3gna: deploy refused two files that both lack DOIT_REFUNDS_ENABLED' >&2
  exit 1
}
grep -F 'up -d --wait api web worker caddy' "$TEST_LOG" >/dev/null || {
  echo 'legend-3gna: services did not start with the flag absent from both files' >&2
  exit 1
}
# A tab then a comment is refused, in either file.
write_flag "$tmp/api.env" "DOIT_REFUNDS_ENABLED=true${tab}#c"
write_flag "$tmp/worker.env" 'DOIT_REFUNDS_ENABLED=true'
check_refuses 'a tab before a comment in api.env'
deploy_refuses 'a tab before a comment in api.env'
write_flag "$tmp/api.env" 'DOIT_REFUNDS_ENABLED=true'
write_flag "$tmp/worker.env" "DOIT_REFUNDS_ENABLED=true${tab}#c"
check_refuses 'a tab before a comment in worker.env'
deploy_refuses 'a tab before a comment in worker.env'
# A space then a comment stays valid and deploys.
write_flag "$tmp/api.env" 'DOIT_REFUNDS_ENABLED=true #c'
write_flag "$tmp/worker.env" 'DOIT_REFUNDS_ENABLED=true'
"$check" --env-file "$tmp/compose.env" >/dev/null 2>"$tmp/err" || {
  echo 'legend-3gna: the check refused a space before a comment' >&2
  exit 1
}
: > "$TEST_LOG"
"$root/deploy.sh" --env-file "$tmp/compose.env" >/dev/null 2>&1 || {
  echo 'legend-3gna: deploy refused a space before a comment' >&2
  exit 1
}
echo 'legend-3gna: empty value and comment checks passed'
