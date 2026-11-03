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
: > "$tmp/compose.env"
export TEST_LOG="$tmp/log"
PATH="$tmp/bin:$PATH"
export PATH
"$root/deploy.sh" --env-file "$tmp/compose.env" --dry-run >/dev/null
[ "$(wc -l < "$TEST_LOG" | tr -d ' ')" -eq 1 ]
grep -F 'config --quiet' "$TEST_LOG" >/dev/null
: > "$TEST_LOG"
"$root/deploy.sh" --env-file "$tmp/compose.env"
[ "$(wc -l < "$TEST_LOG" | tr -d ' ')" -eq 4 ]
sed -n '2p' "$TEST_LOG" | grep -F 'up -d --wait postgres' >/dev/null
sed -n '3p' "$TEST_LOG" | grep -F -- '--profile migration run --rm migrate' >/dev/null
sed -n '4p' "$TEST_LOG" | grep -F 'up -d --wait api web worker caddy' >/dev/null
if "$root/deploy.sh" --env-file relative --dry-run >/dev/null 2>&1; then
  echo 'legend-8br: relative environment file was accepted' >&2
  exit 1
fi
echo 'legend-8br: deploy dry-run and ordering checks passed'
