#!/usr/bin/env bash
set -euo pipefail

echo "== APT Upgrade Report =="
echo "Timestamp: $(/usr/bin/date --iso-8601=seconds)"
echo "Host: $(/usr/bin/hostname -f 2>/dev/null || /usr/bin/hostname)"
echo

echo "-- Refreshing package index --"
/usr/bin/sudo -n /usr/bin/apt-get update -qq 2>&1 | /usr/bin/tail -n 5 || {
  echo "WARNING: apt-get update failed or partial failure; proceeding with cached data"
}
echo

echo "-- Upgradable packages --"
UPGRADABLE_COUNT=$(/usr/bin/apt list --upgradable 2>/dev/null | /usr/bin/grep -c -v '^Listing...' || echo "0")
echo "Packages with available upgrades: ${UPGRADABLE_COUNT}"
echo

if [ "${UPGRADABLE_COUNT}" -gt 0 ]; then
  echo "-- Upgrade list --"
  /usr/bin/apt list --upgradable 2>/dev/null | /usr/bin/grep -v '^Listing...' || true
  echo
fi

echo "-- System state --"
if [ -f /var/run/reboot-required ]; then
  echo "WARNING: A reboot is required (kernel or critical library was updated)."
else
  echo "No reboot required."
fi

echo
echo "Done."
