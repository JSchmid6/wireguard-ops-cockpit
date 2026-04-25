#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
source "$SCRIPT_DIR/lib/nextcloud-maintenance-common.sh"

lock_nextcloud_maintenance_flow
ensure_nextcloud_root
require_nextcloud_phase "maintenance-enabled"

print_nextcloud_header "Run Nextcloud occ upgrade"

echo "-- Run occ upgrade --"
run_occ upgrade
echo

echo "-- Nextcloud status --"
run_occ status
echo

set_nextcloud_phase "upgrade-complete"
echo "-- Stored maintenance phase --"
echo "upgrade-complete"