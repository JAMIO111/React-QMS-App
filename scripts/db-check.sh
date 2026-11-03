#!/usr/bin/env bash
# Applies every migration in supabase/migrations to a throwaway local Postgres cluster, then runs
# the SQL tests in supabase/tests/*.test.sql. Needs Postgres server binaries (initdb, pg_ctl).
# Usage: npm run db:check
# Env: DB_CHECK_FIXTURES=<dir> (fixtures loaded after the migration of the same name),
#      DB_CHECK_EXTRA=<file.sql> (run after all migrations), DB_CHECK_SKIP_TESTS=1,
#      DB_CHECK_COMMAND="<cmd>" (run after migrations/tests with DATABASE_URL (qms_api login) and
#      DATABASE_ADMIN_URL (superuser, for seeding) pointing at the throwaway cluster)
set -euo pipefail
cd "$(dirname "$0")/.."

PGBIN="${PGBIN:-$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1)}"
[ -x "$PGBIN/initdb" ] || { echo "initdb not found; set PGBIN to your Postgres bin directory" >&2; exit 1; }

TMP="$(mktemp -d)"
PORT="${PGPORT_CHECK:-54329}"
cleanup() { "$PGBIN/pg_ctl" -D "$TMP/data" -m immediate stop >/dev/null 2>&1 || true; rm -rf "$TMP"; }
trap cleanup EXIT

RUNAS=()
if [ "$(id -u)" = "0" ]; then
  id -u postgres >/dev/null 2>&1 || { echo "running as root requires a 'postgres' user" >&2; exit 1; }
  chown -R postgres "$TMP"; RUNAS=(runuser -u postgres --)
fi

"${RUNAS[@]}" "$PGBIN/initdb" -D "$TMP/data" -U postgres --auth=trust >/dev/null
"${RUNAS[@]}" "$PGBIN/pg_ctl" -D "$TMP/data" -o "-p $PORT -k $TMP -c listen_addresses=''" -l "$TMP/log" -w start >/dev/null

PSQL=(psql -X -q -v ON_ERROR_STOP=1 -h "$TMP" -p "$PORT" -U postgres -d postgres)
"${PSQL[@]}" -f supabase/tests/supabase_stubs.sql

for f in supabase/migrations/*.sql; do
  echo "migrate  $f"
  "${PSQL[@]}" -1 -f "$f"
  # Optional fixture loaded right after a migration, so later migrations run against existing data
  # (exercises backfills). Named after the migration file.
  fixture="${DB_CHECK_FIXTURES:-supabase/tests/fixtures}/$(basename "$f")"
  if [ -f "$fixture" ]; then echo "fixture  $fixture"; "${PSQL[@]}" -1 -f "$fixture"; fi
done

# Optional: run an extra SQL file against the migrated database (e.g. a schema fingerprint).
if [ -n "${DB_CHECK_EXTRA:-}" ]; then "${PSQL[@]}" -At -f "$DB_CHECK_EXTRA"; fi

fail=0
if [ -z "${DB_CHECK_SKIP_TESTS:-}" ]; then
  shopt -s nullglob
  for t in supabase/tests/*.test.sql; do
    if "${PSQL[@]}" -f "$t" >"$TMP/out" 2>&1; then echo "pass     $t"; else echo "FAIL     $t"; cat "$TMP/out"; fail=1; fi
  done
fi

if [ -n "${DB_CHECK_COMMAND:-}" ] && [ $fail -eq 0 ]; then
  export DATABASE_URL="postgresql://qms_api@localhost:$PORT/postgres?host=$TMP"
  export DATABASE_ADMIN_URL="postgresql://postgres@localhost:$PORT/postgres?host=$TMP"
  echo "command  $DB_CHECK_COMMAND"
  bash -c "$DB_CHECK_COMMAND" || fail=1
fi
exit $fail

