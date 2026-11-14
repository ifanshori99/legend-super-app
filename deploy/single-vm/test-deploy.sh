#!/bin/sh
# Exercise deploy ordering without contacting Docker or exposing environment values.
set -eu
root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
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
printf 'APP_DATABASE_URL=%s\n' "$app" > "$tmp/api.env"
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
[ "$(wc -l < "$TEST_LOG" | tr -d ' ')" -eq 9 ]
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
sed -n '9p' "$TEST_LOG" | grep -F 'up -d --wait api web worker caddy' >/dev/null
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
expect_same '' 0
expect_same 0 ''
expect_same '' --absent
expect_same --absent false
expect_same false 0
expect_differ true false
expect_differ false true
expect_differ true --absent
expect_differ --absent true
expect_differ true ''
expect_differ 0 true
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
