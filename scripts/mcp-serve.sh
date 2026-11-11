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
# So the order here is: an already-installed binary of the pinned version, then the
# npx cache with the network cut out, and only then the network. Plain npx stays as
# the last resort so a broken checkout still starts something.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# pick_node lives in a shared file so the code-graph hook launcher finds the same
# Node. See scripts/lib/pick-node.sh for the search order and why.
# shellcheck source=lib/pick-node.sh
. "$ROOT/scripts/lib/pick-node.sh"

# A global gestalt hands itself to the highest installed plugin version whenever
# the two versions differ, newer or older. Here the pin (or GESTALT_MCP_BIN)
# already decided which build runs, so turn that off for the override, the probe,
# and the server this script execs.
export GESTALT_FOLLOW_PLUGIN=0

# Before the Node search, because this branch does not need Node at all. Someone
# pointing at their own build on a machine without a usable Node install should
# not be turned away by a search whose result they were never going to use.
#
# An escape hatch, so it wins over the pinned resolution below. Whoever can set
# this in the host's spawn environment can already edit the manifest's command,
# so the trust boundary is the same either way — but an override that silently
# replaces the server is worth a line in the log.
if [[ -n "${GESTALT_MCP_BIN:-}" ]]; then
  echo "gestalt MCP: GESTALT_MCP_BIN override — running $GESTALT_MCP_BIN." >&2
  exec "${GESTALT_MCP_BIN}" serve
fi

NODE="$(pick_node)" || {
  echo "gestalt MCP: Node >= 22 required (package.json engines)." >&2
  echo "PATH node: $(command -v node || echo missing) $(node -v 2>/dev/null || true)" >&2
  echo "Set GESTALT_NODE to a Node >= 22 binary and retry." >&2
  exit 1
}
export PATH="$(dirname "$NODE"):$PATH"

# The plugin ships as a git checkout, so package.json sits next to this script and
# holds the version the bundled skills were written against. Pinning to it keeps
# the npx resolution below in lockstep with those skills — a bare spec silently
# pulls whatever is newest on npm, which is how a 0.72.0 plugin ends up driving a
# 0.72.1 server.
SPEC="@tienne/gestalt"
if [[ -f "$ROOT/package.json" ]]; then
  VERSION="$("$NODE" -p "require(process.argv[1]).version" "$ROOT/package.json" 2>/dev/null || true)"
  [[ -n "$VERSION" ]] && SPEC="@tienne/gestalt@$VERSION"
fi
# Losing the pin lands us back on whatever npm calls latest. That is the state
# this script exists to avoid, so say it out loud rather than degrade quietly.
if [[ "$SPEC" == "@tienne/gestalt" ]]; then
  echo "gestalt MCP: no version pin (unreadable $ROOT/package.json) — resolving latest." >&2
fi

# A global install is the fast path (no npx round), but only while it is the same
# version as the pin. A stale `npm i -g` that kept serving would leave the server
# behind the skills after a plugin update. The plugin version is what the user
# updates, so it is what decides. Someone who really wants a different build
# sets GESTALT_MCP_BIN above — that override is explicit and logged.
#
# `--version` runs an arbitrary binary found on PATH, so it gets a time limit when
# `timeout` exists (stock macOS has none) and its output is cut down to version
# characters before it reaches the log line or the comparison.
GLOBAL_BIN="$(command -v gestalt || true)"
if [[ -n "$GLOBAL_BIN" ]]; then
  if command -v timeout >/dev/null 2>&1; then
    GLOBAL_VERSION="$(timeout 5 "$GLOBAL_BIN" --version </dev/null 2>/dev/null | tail -n 1 | tr -cd '0-9A-Za-z.+-' || true)"
  else
    GLOBAL_VERSION="$("$GLOBAL_BIN" --version </dev/null 2>/dev/null | tail -n 1 | tr -cd '0-9A-Za-z.+-' || true)"
  fi
  if [[ "$SPEC" == "@tienne/gestalt" || "$SPEC" == "@tienne/gestalt@$GLOBAL_VERSION" ]]; then
    echo "gestalt MCP: using globally installed gestalt ($GLOBAL_BIN ${GLOBAL_VERSION:-unknown version})." >&2
    exec "$GLOBAL_BIN" serve
  fi
  echo "gestalt MCP: global gestalt ${GLOBAL_VERSION:-unknown version} ($GLOBAL_BIN) differs from pin $SPEC — ignoring it. Run \`npm i -g $SPEC\` to use the global one again." >&2
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
  echo "gestalt MCP: $SPEC is not in the npx cache — downloading it. The first start after a plugin update can take ~20s." >&2
  BIN="$(resolve_bin || true)"
fi

if [[ -n "$BIN" && -x "$BIN" ]]; then
  exec "$BIN" serve
fi

exec npx -y "$SPEC" serve
