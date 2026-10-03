#!/usr/bin/env bash
# Claude Code plugin hook launcher for the code graph (hooks/hooks.json).
#
# This runs on every prompt in every repo that has the gestalt plugin installed,
# so the common case has to cost nothing: no graph, or hooks not switched on,
# means exit 0 before any Node process starts. Every other path also ends in
# exit 0 — a hook that fails must never block the user's turn.
#
# Finding the entry follows scripts/mcp-serve.sh: GESTALT_HOOK_BIN override
# (absolute paths only), then a global install, then the pinned version from
# the npx cache. That resolution costs 1.5s on a warm npx cache and much more
# on a cold one, far past a per-prompt budget, so it runs once in the background
# and the answer is cached in the plugin data dir. Until it lands the hook just
# stays quiet.
set -u

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

if [[ "${1:-}" == "--resolve" ]]; then
  MODE=resolve
  CACHE="${2:-}"
else
  MODE=run
  EVENT="${1:-}"
fi

if [[ "$MODE" == run ]]; then
  PROJECT="${CLAUDE_PROJECT_DIR:-$PWD}"
  [[ -f "$PROJECT/.gestalt/code-graph.db" ]] || exit 0

  # A coarse pre-filter only. The Node side reads gestalt.json properly and
  # decides; this just keeps repos that never mention hooks from paying for it.
  case "${GESTALT_CODE_GRAPH_HOOKS:-}" in
    0 | false | FALSE | False) exit 0 ;;
    1 | true | TRUE | True) ;;
    *) grep -q '"hooks"' "$PROJECT/gestalt.json" 2>/dev/null || exit 0 ;;
  esac

  # Relative paths are refused on purpose: opening someone else's repo must not
  # run an executable that happens to sit at that relative path inside it.
  if [[ -n "${GESTALT_HOOK_BIN:-}" ]]; then
    if [[ "$GESTALT_HOOK_BIN" == /* && -x "$GESTALT_HOOK_BIN" ]]; then
      exec "$GESTALT_HOOK_BIN" "$EVENT"
    fi
    echo "gestalt hook: GESTALT_HOOK_BIN must be an absolute path to an executable, ignoring it." >&2
  fi
fi

VERSION="$(sed -n 's/^[[:space:]]*"version":[[:space:]]*"\([^"]*\)".*/\1/p' "$ROOT/package.json" 2>/dev/null | head -n 1)"
SPEC="@tienne/gestalt${VERSION:+@$VERSION}"

if [[ "$MODE" == run ]]; then
  CACHE_DIR="${CLAUDE_PLUGIN_DATA:-${XDG_CACHE_HOME:-$HOME/.cache}/gestalt}"
  CACHE="$CACHE_DIR/hook-launcher-${VERSION:-unpinned}"

  if [[ -f "$CACHE" ]]; then
    NODE="" ENTRY=""
    { IFS= read -r NODE; IFS= read -r ENTRY; } <"$CACHE" || true
    if [[ "$NODE" == /* && "$ENTRY" == /* && -x "$NODE" && -f "$ENTRY" ]]; then
      exec "$NODE" "$ENTRY" "$EVENT"
    fi
  fi

  # A failed resolution is remembered for an hour so a machine without the
  # package does not start a background npx on every single prompt.
  if [[ -f "$CACHE.miss" ]] && [[ -n "$(find "$CACHE.miss" -mmin -60 2>/dev/null)" ]]; then
    exit 0
  fi

  mkdir -p "$CACHE_DIR" 2>/dev/null || exit 0
  "$0" --resolve "$CACHE" </dev/null >/dev/null 2>&1 &
  exit 0
fi

# --- resolve mode: runs detached, writes "$NODE\n$ENTRY" to the cache ---------

[[ "$CACHE" == /* ]] || exit 0
miss() {
  : >"$CACHE.miss"
  exit 0
}

# shellcheck source=lib/pick-node.sh
. "$ROOT/scripts/lib/pick-node.sh"
NODE="$(pick_node)" || miss
export PATH="$(dirname "$NODE"):$PATH"

realpath_of() {
  "$NODE" -p 'require("fs").realpathSync(process.argv[1])' "$1" 2>/dev/null
}

ENTRY=""
GLOBAL_BIN="$(command -v gestalt-hook || true)"
if [[ -n "$GLOBAL_BIN" ]]; then
  ENTRY="$(realpath_of "$GLOBAL_BIN")"
fi

if [[ -z "$ENTRY" || ! -f "$ENTRY" ]]; then
  resolve_bin() {
    (cd / && npx -y "$@" --package "$SPEC" -c 'command -v gestalt-hook' </dev/null 2>/dev/null) | tail -n 1
  }
  BIN="$(resolve_bin --offline || true)"
  if [[ -z "$BIN" || ! -x "$BIN" ]]; then
    BIN="$(resolve_bin || true)"
  fi
  [[ -n "$BIN" && -x "$BIN" ]] && ENTRY="$(realpath_of "$BIN")"
fi

[[ "$ENTRY" == /* && -f "$ENTRY" ]] || miss

TMP="$CACHE.$$"
printf '%s\n%s\n' "$NODE" "$ENTRY" >"$TMP" && mv -f "$TMP" "$CACHE"
rm -f "$CACHE.miss"
