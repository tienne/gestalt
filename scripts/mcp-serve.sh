#!/usr/bin/env bash
# Start the published gestalt MCP server for plugin hosts.
#
# `npx @tienne/gestalt` looks fine until it isn't. npx resolves the package
# through the registry on every single start — an exact version pin does not
# change that. Measured on a warm cache it costs 1.9s, on a cold cache 20s, and
# when the registry is unreachable it hangs for 70s before failing. Claude Code
# gives a stdio server 30s to finish initialize, so the cold and offline cases
# both surface as "Connection closed" with nothing in the log to explain it.
#
# So the order here is: an already-installed binary, then the npx cache with the
# network cut out, and only then the network. Plain npx stays as the last resort
# so a broken checkout still starts something.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

node_major() {
  "$1" -p 'process.versions.node.split(".")[0]' 2>/dev/null || true
}

# GUI-launched sessions (desktop app, Paseo, launchd) inherit a PATH without any
# version manager on it, so `npx` is simply not found and the server dies at 0s.
# Same search order as scripts/grok-mcp-serve.sh.
pick_node() {
  local candidate major
  local best="" best_major=0
  local candidates=()

  if [[ -n "${GESTALT_NODE:-}" ]]; then
    candidates+=("$GESTALT_NODE")
  fi

  # Terminal-launched sessions almost always land here on the first try. Probing
  # every version manager costs a process spawn each, and this is the hot path.
  if [[ -z "${GESTALT_NODE:-}" ]] && command -v node >/dev/null 2>&1; then
    candidate="$(command -v node)"
    major="$(node_major "$candidate")" || true
    if [[ "$major" =~ ^[0-9]+$ ]] && (( major >= 20 )); then
      printf '%s\n' "$candidate"
      return 0
    fi
  fi

  if [[ -d "$HOME/.nvm/versions/node" ]]; then
    shopt -s nullglob
    for dir in "$HOME/.nvm/versions/node"/v*; do
      # The directory name carries the version, so old installs get dropped
      # without paying for a process spawn to ask them.
      [[ "$(basename "$dir")" =~ ^v([0-9]+)\. ]] || continue
      (( BASH_REMATCH[1] >= 20 )) || continue
      candidates+=("$dir/bin/node")
    done
    shopt -u nullglob
  fi

  shopt -s nullglob
  candidates+=(
    "$HOME/.local/share/fnm/node-versions/"*/installation/bin/node
    "$HOME/.fnm/node-versions/"*/installation/bin/node
    "$HOME/.volta/bin/node"
    /opt/homebrew/bin/node
    /usr/local/bin/node
  )
  shopt -u nullglob

  if command -v node >/dev/null 2>&1; then
    candidates+=("$(command -v node)")
  fi

  for candidate in "${candidates[@]}"; do
    [[ -f "$candidate" ]] || continue
    major="$(node_major "$candidate")" || true
    if [[ "$major" =~ ^[0-9]+$ ]] && (( major >= 20 && major >= best_major )); then
      best="$candidate"
      best_major="$major"
    fi
  done

  if [[ -n "$best" ]]; then
    printf '%s\n' "$best"
    return 0
  fi
  return 1
}

NODE="$(pick_node)" || {
  echo "gestalt MCP: Node >= 20 required (package.json engines)." >&2
  echo "PATH node: $(command -v node || echo missing) $(node -v 2>/dev/null || true)" >&2
  echo "Set GESTALT_NODE to a Node >= 20 binary and retry." >&2
  exit 1
}
export PATH="$(dirname "$NODE"):$PATH"

# The plugin ships as a git checkout, so package.json sits next to this script and
# holds the version the bundled skills were written against. Pinning to it keeps
# the server and the skills in lockstep — a bare spec silently pulls whatever is
# newest on npm, which is how a 0.72.0 plugin ends up driving a 0.72.1 server.
SPEC="@tienne/gestalt"
if [[ -f "$ROOT/package.json" ]]; then
  VERSION="$("$NODE" -p "require('$ROOT/package.json').version" 2>/dev/null || true)"
  [[ -n "$VERSION" ]] && SPEC="@tienne/gestalt@$VERSION"
fi

if [[ -n "${GESTALT_MCP_BIN:-}" ]]; then
  exec "${GESTALT_MCP_BIN}" serve
fi

if command -v gestalt >/dev/null 2>&1; then
  exec gestalt serve
fi

# Resolve the bin path instead of letting npx spawn the server, for two reasons.
# npx picks the *local* project's bin first, so inside a gestalt checkout without
# node_modules it dies with "gestalt: command not found" — hence the `cd /`. And
# resolving separately means one npx round instead of a probe plus a real run.
#
# `--offline` reads the npm cache and never opens a socket: 1.5s on a hit, and a
# 0.4s miss instead of the 70s the online path hangs for when the registry is
# unreachable. </dev/null keeps npx away from the client's stdin, which the
# server itself needs intact.
resolve_bin() {
  (cd / && npx -y "$@" --package "$SPEC" -c 'command -v gestalt' </dev/null 2>/dev/null) | tail -n 1
}

BIN="$(resolve_bin --offline || true)"
if [[ -z "$BIN" || ! -x "$BIN" ]]; then
  BIN="$(resolve_bin || true)"
fi

if [[ -n "$BIN" && -x "$BIN" ]]; then
  exec "$BIN" serve
fi

exec npx -y "$SPEC" serve
