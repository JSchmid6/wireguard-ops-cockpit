#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
source "$SCRIPT_DIR/lib/nextcloud-maintenance-common.sh"

lock_nextcloud_maintenance_flow
ensure_nextcloud_root
require_nextcloud_phase "preflight-complete"

print_nextcloud_header "Enable Nextcloud maintenance mode"

echo "-- Enable maintenance mode --"
run_occ maintenance:mode --on
echo

echo "-- Maintenance mode --"
run_occ config:system:get maintenance || true
echo

set_nextcloud_phase "maintenance-enabled"
echo "-- Stored maintenance phase --"
echo "maintenance-enabled"