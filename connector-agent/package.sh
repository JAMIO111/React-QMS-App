#!/usr/bin/env bash
# Builds the Windows pilot package (docs/connector-agent-plan.md AG-D12): a self-contained FortressAgent.exe (no .NET install needed on the
# customer's machine) with install.ps1 / uninstall.ps1, zipped to bin/FortressConnectorAgent-<version>-win-x64.zip. Not code-signed yet (AG6).
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
export PATH="$HOME/.dotnet:$PATH" DOTNET_CLI_TELEMETRY_OPTOUT=1 DOTNET_NOLOGO=1
version="$(sed -n 's:.*<Version>\(.*\)</Version>.*:\1:p' "$here/Directory.Build.props")"
out="$here/bin/package"
rm -rf "$out" && mkdir -p "$out/app"
# Never pass -p:FortressTestHooks=true here: that build would trust a test release key from the environment (AG6b).
dotnet publish "$here/src/Fortress.Agent.Host" -c Release -r win-x64 --self-contained true \
  -p:PublishSingleFile=true -p:IncludeNativeLibrariesForSelfExtract=true -p:DebugType=none -o "$out/app" >/dev/null
cp "$here/install/install.ps1" "$here/install/uninstall.ps1" "$here/install/README.txt" "$out/"
zip="$here/bin/FortressConnectorAgent-$version-win-x64.zip"
rm -f "$zip"
(cd "$out" && zip -qr "$zip" .)
echo "$zip"
