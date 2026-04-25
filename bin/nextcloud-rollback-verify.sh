#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
source "$SCRIPT_DIR/lib/nextcloud-maintenance-common.sh"

lock_nextcloud_maintenance_flow
ensure_nextcloud_root
require_nextcloud_phase "rollback-restored"
load_rollback_manifest
require_maintenance_mode_on

stored_manifest_digest=$(read_rollback_state_value MANIFEST_DIGEST)
stored_backup_id=$(read_rollback_state_value BACKUP_ID)
stored_expected_version=$(read_rollback_state_value EXPECTED_VERSION)

if [[ "$stored_manifest_digest" != "$ROLLBACK_MANIFEST_DIGEST" ]]; then
  echo "Rollback verification manifest digest mismatch."
  echo "Expected: $ROLLBACK_MANIFEST_DIGEST"
  echo "Actual:   $stored_manifest_digest"
  exit 1
fi
if [[ "$stored_backup_id" != "$ROLLBACK_BACKUP_ID" ]]; then
  echo "Rollback verification backup id mismatch."
  exit 1
fi
if [[ "$stored_expected_version" != "$ROLLBACK_EXPECTED_VERSION" ]]; then
  echo "Rollback verification expected version mismatch."
  exit 1
fi

print_nextcloud_header "Verify Nextcloud rollback state"

echo "-- Approved rollback manifest --"
echo "Manifest: $ROLLBACK_MANIFEST_PATH"
echo "Manifest digest: $ROLLBACK_MANIFEST_DIGEST"
echo "Backup id: $ROLLBACK_BACKUP_ID"
echo

live_version=$(nextcloud_version_string)
if [[ "$live_version" != "$ROLLBACK_EXPECTED_VERSION" ]]; then
  echo "Restored version mismatch."
  echo "Expected: $ROLLBACK_EXPECTED_VERSION"
  echo "Actual:   $live_version"
  exit 1
fi

echo "-- Maintenance mode --"
run_occ config:system:get maintenance || true
echo

echo "-- Live version --"
echo "$live_version"
echo

echo "-- Nextcloud status --"
run_occ status
echo

echo "-- Service status --"
systemctl is-active php8.3-fpm apache2
echo

set_nextcloud_phase "rollback-verified"
echo "-- Stored maintenance phase --"
echo "rollback-verified"