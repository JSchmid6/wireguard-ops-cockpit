#!/usr/bin/env bash
set -euo pipefail

echo "== APT upgrade availability check =="
echo "Timestamp: $(date --iso-8601=seconds)"
echo "Host: $(hostname -f 2>/dev/null || hostname)"
echo

echo "-- Refreshing package lists --"
sudo -n apt-get update -qq 2>&1 | tail -5 || true
echo

echo "-- Available upgrades --"
UPGRADE_COUNT=$(apt list --upgradable 2>/dev/null | grep -c -v '^Listing...' || true)
echo "Packages with available upgrades: ${UPGRADE_COUNT}"
echo

if [ "${UPGRADE_COUNT}" -gt 0 ]; then
  echo "-- Upgrade list (top 50) --"
  apt list --upgradable 2>/dev/null | grep -v '^Listing...' | head -50 || true
fi

echo
echo "Done."
