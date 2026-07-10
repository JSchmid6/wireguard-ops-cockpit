#!/usr/bin/env bash
set -euo pipefail

echo "== APT package update check =="
echo "Timestamp: $(date --iso-8601=seconds)"
echo "Host: $(hostname -f 2>/dev/null || hostname)"
echo

echo "-- Refreshing package index --"
apt-get update -qq 2>&1 | tail -n 5
echo

echo "-- Upgradable packages --"
upgradable_count=$(apt list --upgradable 2>/dev/null | grep -v "^Listing" | grep -c . || true)

if [[ "$upgradable_count" -eq 0 ]]; then
  echo "No packages are upgradable."
else
  echo "Count of upgradable packages: $upgradable_count"
  echo
  apt list --upgradable 2>/dev/null | grep -v "^Listing" || true
fi

echo
echo "-- APT state flags --"
if [[ -f /var/run/reboot-required ]]; then
  echo "REBOOT REQUIRED (kernel or critical library updated)"
else
  echo "No reboot required."
fi
