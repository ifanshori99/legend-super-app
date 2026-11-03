#!/bin/sh
# Fast, offline contract checks for safety guards and command selection.
set -eu
root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
tmp=$(mktemp -d /tmp/legend-backup-test.XXXXXXXX)
trap 'rm -rf "$tmp"' EXIT HUP INT TERM
mkdir "$tmp/bin" "$tmp/existing"
for command in pgbackrest pg_ctl psql; do
  cat > "$tmp/bin/$command" <<'STUB'
#!/bin/sh
printf '%s\n' "$(basename "$0") $*" >> "$TEST_LOG"
STUB
  chmod +x "$tmp/bin/$command"
done
export TEST_LOG="$tmp/commands"
PATH="$tmp/bin:$PATH"
export PATH
if "$root/restore-drill.sh" "$tmp/existing" >/dev/null 2>&1; then
  echo 'legend-cqr: existing target was accepted' >&2
  exit 1
fi
if "$root/restore-drill.sh" "$tmp/new" 3 >/dev/null 2>&1; then
  echo 'legend-cqr: invalid repository was accepted' >&2
  exit 1
fi
"$root/restore-drill.sh" "$tmp/restored" 2 '2026-01-01 00:00:00+00' >/dev/null
grep -F -- '--repo=2' "$TEST_LOG" >/dev/null
grep -F -- '--type=time' "$TEST_LOG" >/dev/null
grep -F -- "listen_addresses=''" "$TEST_LOG" >/dev/null
grep -F -- 'archive_mode=off' "$TEST_LOG" >/dev/null
grep -F -- 'pg_ctl -D' "$TEST_LOG" >/dev/null
"$root/backup.sh"
grep -F -- '--repo=1 --type=full backup' "$TEST_LOG" >/dev/null
grep -F -- '--repo=2 --type=full backup' "$TEST_LOG" >/dev/null
echo 'legend-cqr: offline script safety checks passed'
