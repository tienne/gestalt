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
#
# scripts/grok-mcp-serve.sh looks at the same places but decides differently:
# this one takes PATH's node the moment it is new enough, drops old nvm installs
# by directory name, and knows about Volta. Change one and the other does not
# follow — they pick different binaries on a machine with several Node versions.
#
# Among the candidates it does collect, the newest wins. npm and the SDK both
# move faster than the oldest supported Node, so an old-but-adequate install is
# the worse bet. The name-based filter above keeps that from costing much.
pick_node() {
  local candidate major
  local best="" best_major=0
  local candidates=()

  # An explicit override skips the search entirely. Collecting it as one
  # candidate among many meant a newer nvm install could outrank it, which is
  # the opposite of what someone setting this variable is asking for.
  if [[ -n "${GESTALT_NODE:-}" ]]; then
    major="$(node_major "$GESTALT_NODE")" || true
    if [[ "$major" =~ ^[0-9]+$ ]] && (( major >= 20 )); then
      printf '%s\n' "$GESTALT_NODE"
      return 0
    fi
    echo "gestalt MCP: GESTALT_NODE=$GESTALT_NODE is not Node >= 20, searching instead." >&2
  fi

  # Terminal-launched sessions almost always land here on the first try. Probing
  # every version manager costs a process spawn each, and this is the hot path.
  if command -v node >/dev/null 2>&1; then
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
# Losing the pin lands us back on whatever npm calls latest. That is the state
# this script exists to avoid, so say it out loud rather than degrade quietly.
if [[ "$SPEC" == "@tienne/gestalt" ]]; then
  echo "gestalt MCP: no version pin (unreadable $ROOT/package.json) — resolving latest." >&2
fi

# An escape hatch for people running a build of their own. Whoever can set this
# in the host's spawn environment can already edit the manifest's command, so
# the trust boundary is the same either way — but an override that silently
# replaces the server is worth a line in the log.
if [[ -n "${GESTALT_MCP_BIN:-}" ]]; then
  echo "gestalt MCP: GESTALT_MCP_BIN override — running $GESTALT_MCP_BIN." >&2
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
# `--offline` answers from the npm cache. Measured on npm 10 it did not open a
# socket — 1.5s on a hit, and a 0.4s miss against the 70s the online path hangs
# for when the registry is unreachable. Nothing here depends on that holding: a
# miss just falls through to the online call below. </dev/null keeps npx away
# from the client's stdin, which the server itself needs intact.
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
