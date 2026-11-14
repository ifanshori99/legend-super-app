#!/bin/sh
# Exercise restore-drill with stubbed PostgreSQL tools; no database is touched.
set -eu
root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT HUP INT TERM
mkdir "$tmp/bin"
cat > "$tmp/bin/id" <<'STUB'
#!/bin/sh
printf '1000\n'
STUB
cat > "$tmp/bin/pgbackrest" <<'STUB'
#!/bin/sh
exit 0
STUB
cp "$tmp/bin/pgbackrest" "$tmp/bin/pg_ctl"
cat > "$tmp/bin/psql" <<'STUB'
#!/bin/sh
printf '%s\n' "$@" > "$PSQL_ARGS"
STUB
chmod +x "$tmp/bin/"*
export PATH="$tmp/bin:$PATH" PSQL_ARGS="$tmp/args"
check_user() {
  expected=$1
  awk -v expected="$expected" '$0 == "-U" { if (getline && $0 == expected) found = 1 } END { exit !found }' "$PSQL_ARGS" || {
    echo "Expected psql -U $expected" >&2
    exit 1
  }
}
unset POSTGRES_USER
sh "$root/restore-drill.sh" "$tmp/default" >/dev/null
check_user replace_me
POSTGRES_USER=custom_restore_user
export POSTGRES_USER
sh "$root/restore-drill.sh" "$tmp/custom" >/dev/null
check_user "$POSTGRES_USER"
echo 'restore-drill PostgreSQL user checks passed'
