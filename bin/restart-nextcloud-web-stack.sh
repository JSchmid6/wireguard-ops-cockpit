#!/usr/bin/env bash
set -euo pipefail

echo "== Restart Nextcloud web stack =="
echo "Timestamp: $(date --iso-8601=seconds)"
echo

systemctl restart php8.3-fpm apache2

echo "-- Service status --"
systemctl is-active php8.3-fpm apache2
echo

echo "-- Nextcloud status --"
runuser -u www-data -- /usr/bin/php /var/www/nextcloud/occ status
