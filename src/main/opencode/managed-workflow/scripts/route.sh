#!/usr/bin/env bash
# Print this project's memory route.
#
# This wrapper exists so a skill's first instruction can be ONE short line. The
# previous design inlined eleven lines of node-resolution boilerplate into the
# skill, which read as configuration documentation rather than as an action to
# perform — and every observed session skipped it, across two model families.
#
# Output (stdout, KEY=value lines):
#   MEMORY_ROUTE=vault|legacy-bank|legacy-root|abort
#   MEMORY_HOME=<path>          (absent when MEMORY_ROUTE=abort)
#   WORKSPACE_ROOT=<path>
#   REASON=<text>               (only when MEMORY_ROUTE=abort)
#   BOOTSTRAP=required + PROPOSED_MEMORY_HOME=<path>   (when not yet on the vault)

CFG="${OPENCODE_CONFIG_DIR:-$HOME/.config/cadence/opencode}"

NODE="$(command -v node 2>/dev/null || true)"
if [ -z "$NODE" ] && [ -s "$HOME/.nvm/nvm.sh" ]; then
  # shellcheck disable=SC1091
  . "$HOME/.nvm/nvm.sh" >/dev/null 2>&1
  NODE="$(command -v node 2>/dev/null || true)"
fi
if [ -z "$NODE" ]; then
  NODE="$(ls -d "$HOME"/.nvm/versions/node/*/bin/node 2>/dev/null | tail -1)"
fi

if [ -z "$NODE" ]; then
  echo "MEMORY_ROUTE=abort"
  echo "REASON=node not found, so the memory route cannot be resolved. Refusing to guess."
  exit 0
fi

RESOLVER="$CFG/scripts/resolve-memory-route.mjs"
if [ ! -f "$RESOLVER" ]; then
  echo "MEMORY_ROUTE=abort"
  echo "REASON=resolver missing at $RESOLVER. Refusing to guess."
  exit 0
fi

OUTPUT="$("$NODE" "$RESOLVER" 2>&1)"
case "$OUTPUT" in
  *MEMORY_ROUTE=*) printf '%s\n' "$OUTPUT" ;;
  *)
    # Never emit empty or malformed output: silence is the worst possible input
    # to a caller that will otherwise fall back to guessing a route.
    echo "MEMORY_ROUTE=abort"
    echo "REASON=resolver produced no route. Refusing to guess. Raw output: $OUTPUT"
    ;;
esac
