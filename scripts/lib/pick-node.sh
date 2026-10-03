# Shared by scripts/mcp-serve.sh and scripts/code-graph-hook.sh. Sourced, not run.
#
# Both launchers have to find the same Node: the hook resolves the bin that the
# MCP server would run, and a different Node there means a different
# better-sqlite3 ABI. Change the search here and both follow.

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
    if [[ "$major" =~ ^[0-9]+$ ]] && (( major >= 22 )); then
      printf '%s\n' "$GESTALT_NODE"
      return 0
    fi
    echo "gestalt MCP: GESTALT_NODE=$GESTALT_NODE is not Node >= 22, searching instead." >&2
  fi

  # Terminal-launched sessions almost always land here on the first try. Probing
  # every version manager costs a process spawn each, and this is the hot path.
  if command -v node >/dev/null 2>&1; then
    candidate="$(command -v node)"
    major="$(node_major "$candidate")" || true
    if [[ "$major" =~ ^[0-9]+$ ]] && (( major >= 22 )); then
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
      (( BASH_REMATCH[1] >= 22 )) || continue
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
    if [[ "$major" =~ ^[0-9]+$ ]] && (( major >= 22 && major >= best_major )); then
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
