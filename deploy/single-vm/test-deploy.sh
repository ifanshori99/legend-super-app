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
