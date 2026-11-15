#!/usr/bin/env bash
# Builds the agent and runs it against the real API and a migrated throwaway Postgres that also listens on TCP, as a customer's server would:
#  1. the agent's own tests, including the PostgreSQL adapter against that server (AGENT_TEST_PG) and the MySQL adapter (AGENT_TEST_MYSQL);
#  2. api/test/connector-agent-binary.e2e-spec.ts: the built agent registers, comes online, answers a ping, takes a sealed password, tests,
#     browses and previews a real table, imports one through the pipeline twice (the second writes nothing), and stops when revoked.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
export PATH="$HOME/.dotnet:$PATH" DOTNET_CLI_TELEMETRY_OPTOUT=1 DOTNET_NOLOGO=1
dotnet build "$here/src/Fortress.Agent.Host" -c Release -o "$here/bin/agent" >/dev/null
dotnet build "$here/tests/Fortress.Agent.Tests" >/dev/null
export AGENT_BINARY="$here/bin/agent/FortressAgent.dll"
export PGLISTEN_CHECK=127.0.0.1
port="${PGPORT_CHECK:-54329}"
export AGENT_TEST_PG="Host=127.0.0.1;Port=$port;Username=postgres;Database=postgres"
export AGENT_TEST_PG_PORT="$port"
cd "$here/.."
# mysql-check.sh adds a throwaway MariaDB / MySQL (AGENT_TEST_MYSQL*) when one is installed: the agent's MySQL tests and the MySQL part of the
# binary test then run too (AG5a: one agent reading PostgreSQL and MySQL at once).
export DB_CHECK_SKIP_TESTS=1
export DB_CHECK_COMMAND="dotnet test '$here/tests/Fortress.Agent.Tests' --no-build && npm --workspace api run test:e2e -- connector-agent-binary"
bash "$here/mysql-check.sh" "bash scripts/db-check.sh"
