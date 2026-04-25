#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
source "$SCRIPT_DIR/lib/nextcloud-maintenance-common.sh"

lock_nextcloud_maintenance_flow
ensure_nextcloud_root

case "$(current_nextcloud_phase)" in
  idle|verification-complete)
    ;;
  *)
    echo "Cannot start a new Nextcloud preflight while the current maintenance flow is parked at phase $(current_nextcloud_phase)."
    exit 1
    ;;
esac

print_nextcloud_header "Nextcloud update preflight"
clear_rollback_state

echo "-- Current status --"
run_occ status
echo

echo "-- Maintenance mode --"
run_occ config:system:get maintenance || true
echo

echo "-- Filesystem capacity --"
df -h "$NEXTCLOUD_ROOT"
echo

echo "-- Data directory ownership --"
stat -c '%U:%G %a %n' "$NEXTCLOUD_ROOT" "$NEXTCLOUD_ROOT/config" "$NEXTCLOUD_ROOT/data" 2>/dev/null || true
echo

echo "-- Updater presence --"
if [[ -f "$NEXTCLOUD_ROOT/updater/updater.phar" ]]; then
  echo "updater.phar present"
else
  echo "updater.phar missing"
fi
echo

echo "-- Suggested manual sequence --"
cat <<'EOF'
1. Confirm current backups and snapshot state.
2. Use the bounded maintenance-mode runbook before a real update.
3. Run the bounded occ upgrade runbook.
4. Disable maintenance mode through the reviewed helper.
5. Run the post-update verification runbook and only restart services through the reviewed helper if needed.
6. If verification still fails, dispatch the approved rollback restore runbook followed by rollback verification before leaving the maintenance window.
EOF

set_nextcloud_phase "preflight-complete"
echo
echo "-- Stored maintenance phase --"
echo "preflight-complete"
