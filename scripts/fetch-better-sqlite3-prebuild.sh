#!/bin/sh
#
# better-sqlite3's own "install" script (prebuild-install, falling back to
# node-gyp) refuses to do anything useful when Bun is the one running it:
# prebuild-install detects `globalThis.Bun` and bails out with a warning,
# and the node-gyp fallback needs a C++ toolchain this project does not
# require anywhere else. Root package.json's `trustedDependencies` list
# deliberately excludes better-sqlite3 so Bun never attempts that broken
# script in the first place; this script does the equivalent work itself,
# through a real Node process instead of Bun's own engine.
#
# Why "a real Node process" is not automatic: Bun prepends a directory
# containing its own fake `node` (a shim that points back to Bun) to PATH
# for every lifecycle script it runs, specifically so that plain `node`
# inside a script always means Bun. That defeats prebuild-install's
# Node-version detection, so we look past that shim for the actual Node
# binary that will run this project's code.
#
# This script is called two ways, and both matter:
#   - as this project's own root "postinstall", which Bun runs after a
#     plain `bun install` (no --filter) -- the local/host path;
#   - explicitly, as its own RUN step right after every
#     `bun install --filter=...` in the Dockerfiles. Bun does not run a
#     workspace member's own lifecycle scripts at all (verified: adding a
#     postinstall to backend/package.json never fires, filter or not), and
#     it does not run the *root* postinstall either once --filter narrows
#     the install to one workspace. Every real install site in this repo
#     uses --filter, so relying on any automatic hook there is a mistake --
#     call this script directly instead.
#
# Written in POSIX sh, not bash: it needs to run in whatever /bin/sh the
# current build stage has, without assuming bash is installed.
#
# Must be run from the repository root (Docker stages that call this
# directly do so from WORKDIR /app, which is the repo root in every image).
set -eu

backend_manifest="backend/package.json"

if [ ! -f "$backend_manifest" ] || ! grep -q '"better-sqlite3"' "$backend_manifest"; then
  # better-sqlite3 genuinely isn't a dependency here (e.g. it was removed,
  # or this script ended up somewhere it doesn't belong) -- nothing to do,
  # and nothing to treat as a failure.
  exit 0
fi

better_sqlite3_dir="node_modules/better-sqlite3"
if [ ! -d "$better_sqlite3_dir" ]; then
  # better-sqlite3 IS a declared dependency (checked above), so a missing
  # directory here is never "nothing to do" -- it means whatever installed
  # node_modules didn't actually include it (wrong --filter, hoisted to an
  # unexpected location, install ran in the wrong directory). Fail loudly:
  # a silent skip here is exactly how a later stage ships without a
  # working binding and finds out at runtime instead of at build time.
  echo "postinstall: better-sqlite3 is a dependency (see $backend_manifest) but $better_sqlite3_dir does not exist." >&2
  echo "postinstall: refusing to silently continue -- check what this install actually included." >&2
  exit 1
fi

real_node=""
while IFS= read -r dir; do
  case "$dir" in
    */bun-node-*) continue ;;
    "") continue ;;
  esac
  if [ -x "$dir/node" ]; then
    real_node="$dir/node"
    break
  fi
done <<PATHEOF
$(printf '%s' "$PATH" | tr ':' '\n')
PATHEOF

if [ -z "$real_node" ]; then
  echo "postinstall: no real Node binary found on PATH (only Bun's own node shim, if that)." >&2
  echo "postinstall: better-sqlite3 was not built. Install Node, then re-run this script." >&2
  exit 1
fi

prebuild_install="$(pwd)/node_modules/.bin/prebuild-install"
if [ ! -f "$prebuild_install" ]; then
  echo "postinstall: $prebuild_install not found -- is prebuild-install still a dependency of better-sqlite3?" >&2
  exit 1
fi

echo "postinstall: building better-sqlite3's native binding with $real_node ($("$real_node" --version))"
(cd "$better_sqlite3_dir" && "$real_node" "$prebuild_install")

# prebuild-install exits 0 as soon as *some* prebuild matches the ABI it
# detected -- which is not necessarily the ABI of the Node that will
# actually run this code. Today a mismatch there is loud only by luck
# (Bun's own compat version happens not to have a matching asset for this
# package's version). That's not a guarantee for the next version bump or
# the next Bun release, so verify the binding actually loads under the
# real Node we just found, rather than trusting prebuild-install's exit
# code alone.
echo "postinstall: verifying the installed binding actually loads"
if ! "$real_node" -e "
  const Database = require('better-sqlite3');
  const db = new Database(':memory:');
  db.exec('CREATE TABLE t (x)');
  db.close();
"; then
  echo "postinstall: better-sqlite3 installed a binding, but it does not load under $real_node." >&2
  echo "postinstall: this is very likely a wrong-ABI prebuild -- failing the build now instead of leaving a SIGSEGV for later." >&2
  exit 1
fi
echo "postinstall: better-sqlite3's native binding loads correctly"
