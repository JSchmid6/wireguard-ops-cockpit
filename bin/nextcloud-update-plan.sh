#!/usr/bin/env bash
set -euo pipefail

NEXTCLOUD_ROOT=/var/www/nextcloud
PHP_BIN=/usr/bin/php
LOCK_FILE=/run/wireguard-ops-cockpit/nextcloud-update-plan.lock

mkdir -p /run/wireguard-ops-cockpit
exec 9>"$LOCK_FILE"
flock -n 9 || {
  echo "Another Nextcloud update plan run is already active."
  exit 1
}

echo "== Nextcloud update plan =="
echo "Timestamp: $(date --iso-8601=seconds)"
echo "Host: $(hostname -f 2>/dev/null || hostname)"
echo "Root: $NEXTCLOUD_ROOT"
echo

if [[ ! -d "$NEXTCLOUD_ROOT" ]]; then
  echo "Nextcloud root not found at $NEXTCLOUD_ROOT"
  exit 1
fi

echo "-- Current status --"
runuser -u www-data -- "$PHP_BIN" "$NEXTCLOUD_ROOT/occ" status
echo

echo "-- Maintenance mode --"
runuser -u www-data -- "$PHP_BIN" "$NEXTCLOUD_ROOT/occ" config:system:get maintenance || true
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
2. Put Nextcloud into maintenance mode before a real update.
3. Run the updater or deployment-specific file replacement path.
4. Run occ upgrade as www-data.
5. Disable maintenance mode and verify status again.
EOF
