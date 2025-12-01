#!/bin/bash

# Dual WasmEmulator Sync Test Runner
# This script starts a Vite dev server and opens the test page
# The test runs entirely in the browser

set -e

cd "$(dirname "$0")"

echo "============================================================"
echo " DUAL WASEMULATOR SYNC TEST"
echo "============================================================"
echo ""
echo "Starting Vite dev server on port 9999..."
echo ""

# Kill any existing Vite process on this port
pkill -f "vite.*9999" 2>/dev/null || true

# Start Vite server
npx vite --port 9999 --host &
VITE_PID=$!

# Wait for server to start
sleep 3

echo ""
echo "============================================================"
echo " TEST PAGE READY"
echo "============================================================"
echo ""
echo " Open in browser: http://localhost:9999/"
echo ""
echo " Instructions:"
echo "   1. Wait for both emulators to initialize"
echo "   2. Click 'Start Full Test' to run the sync test"
echo "   3. The test will advance frames and compare checksums"
echo "   4. Results will be shown in the statistics panel"
echo ""
echo " Press Ctrl+C to stop the server"
echo ""

# Wait for user to stop
trap "echo; echo 'Stopping server...'; kill $VITE_PID 2>/dev/null; exit 0" INT
wait $VITE_PID
