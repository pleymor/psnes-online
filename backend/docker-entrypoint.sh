#!/bin/bash
set -e

# Fix permissions for mounted volumes (runs as root initially)
chown -R node:node /app/data /app/roms /app/saves 2>/dev/null || true

# Switch to node user and execute the main command
exec gosu node "$@"
