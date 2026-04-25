#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
source "$SCRIPT_DIR/lib/nextcloud-maintenance-common.sh"

lock_nextcloud_maintenance_flow
ensure_nextcloud_root
require_nextcloud_phase "upgrade-complete" "rollback-verified"

print_nextcloud_header "Disable Nextcloud maintenance mode"

echo "-- Disable maintenance mode --"
run_occ maintenance:mode --off
echo

echo "-- Maintenance mode --"
run_occ config:system:get maintenance || true
echo

set_nextcloud_phase "maintenance-disabled"
echo "-- Stored maintenance phase --"
echo "maintenance-disabled"