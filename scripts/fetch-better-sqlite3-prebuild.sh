#!/usr/bin/env bash
#
# better-sqlite3's own "install" script (prebuild-install, falling back to
# node-gyp) refuses to do anything useful when Bun is the one running it:
# prebuild-install detects `globalThis.Bun` and bails out with a warning,
# and the node-gyp fallback needs a C++ toolchain this project does not
# require anywhere else. root package.json's `trustedDependencies` list
# deliberately excludes better-sqlite3 so Bun never attempts that broken
# script in the first place; this postinstall step does the equivalent
# work itself, through a real Node process instead of Bun's own engine.
#
# Why "a real Node process" is not automatic: Bun prepends a directory
# containing its own fake `node` (a shim that points back to Bun) to PATH
# for every lifecycle script it runs, specifically so plain `node` inside
# a script always means Bun. That defeats prebuild-install's Node-version
# detection, so we look past that shim for the actual Node binary that
# will run this project's code.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

BETTER_SQLITE3_DIR="node_modules/better-sqlite3"
if [ ! -d "$BETTER_SQLITE3_DIR" ]; then
  # Nothing to do: dependency not installed (e.g. it was removed).
  exit 0
fi

real_node=""
while IFS= read -r dir; do
  case "$dir" in
    */bun-node-*) continue ;;
  esac
  if [ -x "$dir/node" ]; then
    real_node="$dir/node"
    break
  fi
done <<EOF
$(printf '%s' "$PATH" | tr ':' '\n')
EOF

if [ -z "$real_node" ]; then
  echo "postinstall: no real Node binary found on PATH (only Bun's own node shim)." >&2
  echo "postinstall: better-sqlite3 was not built. Install Node, then re-run 'bun install'." >&2
  exit 1
fi

prebuild_install="$(pwd)/node_modules/.bin/prebuild-install"
if [ ! -f "$prebuild_install" ]; then
  echo "postinstall: $prebuild_install not found -- is prebuild-install still a dependency of better-sqlite3?" >&2
  exit 1
fi

echo "postinstall: building better-sqlite3's native binding with $real_node ($("$real_node" --version))"
(cd "$BETTER_SQLITE3_DIR" && "$real_node" "$prebuild_install")
