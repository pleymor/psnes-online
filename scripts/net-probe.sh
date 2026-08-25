#!/usr/bin/env bash
# Where is the lockstep link losing its time?
#
# Pings four targets *simultaneously* for 90s and prints them side by side.
# Simultaneity is the whole point: the path varies minute to minute, so
# sequential measurements compare different networks and prove nothing.
#
# Reading it:
#   box slow                  -> Wi-Fi / the local machine
#   box fast, Cloudflare slow -> your uplink is saturated (some host here)
#   box + Cloudflare fast,
#     Google + VPS slow       -> congestion in the ISP's transit. Not yours.
#
# Usage: scripts/net-probe.sh [seconds]   (default 90)
set -u
SECS="${1:-90}"
COUNT=$(( SECS * 5 ))
GW="$(ip route | awk '/^default/{print $3; exit}')"
# From WSL the default route is the Windows host; ask Windows for the real one.
if command -v powershell.exe >/dev/null 2>&1; then
  WGW=$(powershell.exe -NoProfile -Command \
    "(Get-NetRoute -DestinationPrefix '0.0.0.0/0' | Sort-Object RouteMetric | Select-Object -First 1).NextHop" \
    2>/dev/null | tr -d '\r\n ')
  [ -n "$WGW" ] && GW="$WGW"
fi
D=$(mktemp -d)
trap 'rm -rf "$D"' EXIT
declare -A T=([box]="$GW" [cloudflare]=1.1.1.1 [google]=8.8.8.8 [vps]=pleymor.com)
echo "Measuring ${SECS}s, four targets at once (box = $GW)..."
for k in "${!T[@]}"; do
  timeout $(( SECS + 5 )) ping -i 0.2 -c "$COUNT" -n "${T[$k]}" > "$D/$k" 2>&1 &
done
wait
printf '\n%-12s %8s %8s %8s %8s %7s\n' target min avg max mdev loss
for k in box cloudflare google vps; do
  line=$(grep -oP 'rtt min/avg/max/mdev = \K[\d./]+' "$D/$k")
  loss=$(grep -oP '\K[\d.]+(?=% packet loss)' "$D/$k")
  IFS=/ read -r mn av mx md <<<"${line:-//}"
  printf '%-12s %8s %8s %8s %8s %6s%%\n' "$k" "${mn:-?}" "${av:-?}" "${mx:-?}" "${md:-?}" "${loss:-?}"
done
