#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
source "$SCRIPT_DIR/lib/nextcloud-maintenance-common.sh"

lock_nextcloud_maintenance_flow
ensure_nextcloud_root
require_nextcloud_phase "maintenance-disabled"

print_nextcloud_header "Verify Nextcloud post-update state"

echo "-- Nextcloud status --"
run_occ status
echo

echo "-- Maintenance mode --"
run_occ config:system:get maintenance || true
echo

echo "-- Service status --"
systemctl is-active php8.3-fpm apache2
echo

clear_rollback_state
set_nextcloud_phase "verification-complete"
echo "-- Stored maintenance phase --"
echo "verification-complete"