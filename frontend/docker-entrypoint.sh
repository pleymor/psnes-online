#!/bin/sh
set -e

# Fix permissions for build directory if it exists
if [ -d /app/build ]; then
  chown -R node:node /app/build 2>/dev/null || true
fi

# Switch to node user and execute the main command
exec su-exec node "$@"
