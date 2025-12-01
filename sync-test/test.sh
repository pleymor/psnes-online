#!/bin/bash

# Dual WasmEmulator Sync Test
# This script starts the Vite server and opens the test page in your browser.
# The test runs in the browser and reports results.

set -e
cd "$(dirname "$0")"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color
BOLD='\033[1m'

echo -e "${CYAN}============================================================${NC}"
echo -e "${BOLD}${CYAN} DUAL WASEMULATOR SYNC TEST${NC}"
echo -e "${CYAN}============================================================${NC}"
echo ""

# Kill any existing Vite processes on our ports
pkill -f "vite.*999" 2>/dev/null || true
sleep 1

# Start Vite server
echo -e "${BLUE}[1/3] Starting Vite dev server...${NC}"
npx vite --port 9999 --host &
VITE_PID=$!

# Wait for server to start
sleep 3

# Find the actual port
PORT=9999
if ! curl -s "http://localhost:$PORT/" > /dev/null 2>&1; then
    PORT=10000
fi

echo -e "${GREEN}✓ Vite server running on port $PORT${NC}"

# Create results file location
RESULTS_FILE="/tmp/sync-test-results.json"
rm -f "$RESULTS_FILE"

echo -e "${BLUE}[2/3] Opening test page in browser...${NC}"
echo ""
echo -e "${YELLOW}Instructions:${NC}"
echo "  1. Wait for both emulators to initialize (may take 30-60 seconds)"
echo "  2. Click '${BOLD}Start Full Test${NC}' to run the sync test"
echo "  3. Watch the Statistics panel for results"
echo "  4. Press Ctrl+C here when done"
echo ""

# Try to open in Windows browser
if command -v explorer.exe &> /dev/null; then
    explorer.exe "http://localhost:$PORT/"
    echo -e "${GREEN}✓ Opened in Windows browser${NC}"
elif command -v wslview &> /dev/null; then
    wslview "http://localhost:$PORT/"
    echo -e "${GREEN}✓ Opened in default browser${NC}"
else
    echo -e "${YELLOW}Could not auto-open browser. Please open:${NC}"
    echo "  http://localhost:$PORT/"
fi

echo ""
echo -e "${CYAN}============================================================${NC}"
echo -e "${BOLD} Test URL: http://localhost:$PORT/${NC}"
echo -e "${CYAN}============================================================${NC}"
echo ""
echo "Press Ctrl+C to stop the server and exit"
echo ""

# Wait for user to stop
trap "echo ''; echo -e '${YELLOW}Stopping server...${NC}'; kill $VITE_PID 2>/dev/null; exit 0" INT
wait $VITE_PID
