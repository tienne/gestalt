#!/usr/bin/env bash
# Start this checkout's MCP server for Grok. Picks Node >= 20 even when the
# parent PATH still points at an older nvm default.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

node_major() {
  "$1" -p 'process.versions.node.split(".")[0]' 2>/dev/null || true
}

pick_node() {
  local candidate major
  local best="" best_major=0
  local candidates=()

  if [[ -n "${GESTALT_NODE:-}" ]]; then
    candidates+=("$GESTALT_NODE")
  fi

  if [[ -d "$HOME/.nvm/versions/node" ]]; then
    shopt -s nullglob
    for dir in "$HOME/.nvm/versions/node"/v*; do
      candidates+=("$dir/bin/node")
    done
    shopt -u nullglob
  fi

  shopt -s nullglob
  candidates+=(
    "$HOME/.local/share/fnm/node-versions/"*/installation/bin/node
    "$HOME/.fnm/node-versions/"*/installation/bin/node
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

TSX="$ROOT/node_modules/tsx/dist/cli.mjs"
if [[ ! -f "$TSX" ]]; then
  echo "gestalt MCP: missing $TSX — install dependencies in $ROOT" >&2
  exit 1
fi

export PATH="$(dirname "$NODE"):$PATH"
export GESTALT_CLIENT="${GESTALT_CLIENT:-grok}"

exec "$NODE" "$TSX" "$ROOT/bin/gestalt.ts" serve
