#!/usr/bin/env bash
# Build the Paste MCP Bundle (.mcpb) for the Claude Desktop extension directory.
# Self-contained: bundles the built bridge + its production deps so it runs on
# Claude Desktop's built-in Node — the user never installs npm or our package.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
stage="$root/.mcpb-build"
out="$root/paste.mcpb"

rm -rf "$stage" "$out"
mkdir -p "$stage/server"

# 1. Build the TypeScript bridge (needs devDeps).
npm ci
npm run build

# 2. Stage the compiled server.
cp -R "$root/dist/." "$stage/server/"

# 3. Production-only dependency tree, bundled at the root so Node resolves
#    `@modelcontextprotocol/sdk` from server/index.js by walking up.
npm ci --omit=dev
cp -R "$root/node_modules" "$stage/node_modules"
# Restore the full tree so the working copy stays dev-ready.
npm ci

# 4. Manifest + icon at the bundle root.
cp "$root/manifest.json" "$stage/manifest.json"
cp "$root/assets/icon.png" "$stage/icon.png"

# 5. Validate, then pack.
npx -y @anthropic-ai/mcpb validate "$stage/manifest.json"
npx -y @anthropic-ai/mcpb pack "$stage" "$out"

echo "Built $out"
