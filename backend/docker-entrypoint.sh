#!/bin/bash
set -e

# Fix permissions for mounted volumes (runs as root initially).
# The unprivileged user is `bun` since the image moved off the Node base. It is
# still uid/gid 1000, the same as the old `node` user, so files already in the
# volumes are already owned correctly - only the name changed.
chown -R bun:bun /app/data /app/roms /app/saves /app/avatars 2>/dev/null || true

# Switch to the bun user and execute the main command
exec gosu bun "$@"
