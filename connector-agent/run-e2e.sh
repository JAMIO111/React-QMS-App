#!/usr/bin/env bash
# Builds the agent and runs it against the real API and a migrated throwaway Postgres (api/test/connector-agent-binary.e2e-spec.ts).
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
export PATH="$HOME/.dotnet:$PATH" DOTNET_CLI_TELEMETRY_OPTOUT=1 DOTNET_NOLOGO=1
dotnet build "$here/src/Fortress.Agent.Host" -c Release -o "$here/bin/agent" >/dev/null
export AGENT_BINARY="$here/bin/agent/FortressAgent.dll"
cd "$here/.."
DB_CHECK_SKIP_TESTS=1 DB_CHECK_COMMAND="npm --workspace api run test:e2e -- connector-agent-binary" bash scripts/db-check.sh
