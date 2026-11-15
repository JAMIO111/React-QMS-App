#!/usr/bin/env bash
# AG0 spike (docs/connector-agent-plan.md §13): runs the .NET half and the Node half against each other, then the PostgreSQL extraction check.
# Needs the .NET 10 SDK on PATH (or in ~/.dotnet), Node 20+, and Postgres server binaries for the last part (PGBIN, default /usr/lib/postgresql/16/bin).
set -euo pipefail
cd "$(dirname "$0")"
export PATH="$HOME/.dotnet:$PATH" DOTNET_CLI_TELEMETRY_OPTOUT=1 DOTNET_NOLOGO=1
OUT="$(mktemp -d)"
dotnet build Spike -c Release -v q
dotnet run --project Spike -c Release --no-build -- keys "$OUT"
node verify.mjs seal "$OUT"
dotnet run --project Spike -c Release --no-build -- run "$OUT"
node verify.mjs check "$OUT"
rm -rf "$OUT"

PGBIN="${PGBIN:-/usr/lib/postgresql/16/bin}"
[ -x "$PGBIN/initdb" ] || { echo "skipping the PostgreSQL part (no initdb at $PGBIN)"; exit 0; }
T="$(mktemp -d)"; RUNAS=()
if [ "$(id -u)" = "0" ]; then chown -R postgres "$T"; RUNAS=(runuser -u postgres --); fi
trap '"${RUNAS[@]}" "$PGBIN/pg_ctl" -D "$T/data" -m immediate stop >/dev/null 2>&1 || true; rm -rf "$T"' EXIT
"${RUNAS[@]}" "$PGBIN/initdb" -D "$T/data" -U postgres --auth=trust >/dev/null
"${RUNAS[@]}" "$PGBIN/pg_ctl" -D "$T/data" -o "-p 54351 -k $T -c listen_addresses=127.0.0.1" -l "$T/log" -w start >/dev/null
psql -X -q -h "$T" -p 54351 -U postgres -d postgres -v ON_ERROR_STOP=1 -c "create schema erp; create table erp.\"work orders\" (id bigint primary key, \"order no\" text not null, qty numeric(12,3), due date, \"on hold\" boolean, notes text, \"modified at\" timestamptz not null); insert into erp.\"work orders\" select g, 'WO-'||g, g*1.5, date '2026-01-01' + (g % 300), g % 10 = 0, null, timestamptz '2026-01-01 00:00Z' + (g || ' hours')::interval from generate_series(1, 2500) g; create role fortress_reader login password 'reader-pass'; grant usage on schema erp to fortress_reader; grant select on all tables in schema erp to fortress_reader;"
dotnet run --project Spike -c Release --no-build -- pg "Host=127.0.0.1;Port=54351;Database=postgres;Username=fortress_reader;Password=reader-pass" | node -e '
let s=""; process.stdin.on("data",d=>s+=d).on("end",()=>{ const r=JSON.parse(s);
  const ok = r.rows===2500 && r.changedSince===340 && r.columns.find(c=>c.Name==="id").PrimaryKey && r.injectionRefused.startsWith("Unknown column") && r.writeInReadOnlyRefused==="25006";
  console.log(JSON.stringify({rows:r.rows, changedSince:r.changedSince, keyFound:r.columns.find(c=>c.Name==="id").PrimaryKey, injectionRefused:!!r.injectionRefused, writeRefused:r.writeInReadOnlyRefused}));
  if(!ok){console.error("PostgreSQL part FAILED");process.exit(1)} console.log("PostgreSQL part: all checks pass"); });'
