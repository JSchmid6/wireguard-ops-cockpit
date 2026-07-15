#!/usr/bin/env bash
set -euo pipefail

OCC="/var/www/nextcloud/occ"
PHP="/usr/bin/php8.4"
DAEMON="appapi_harp"

echo "== Unregister AppAPI daemon: $DAEMON =="
echo "Timestamp: $(date --iso-8601=seconds)"

REGISTERED=$(
    /usr/bin/sudo -u www-data "$PHP" "$OCC" app_api:daemon:list --output=json 2>/dev/null |
    /usr/bin/python3 -c "
import sys, json
data = json.load(sys.stdin)
found = any(d.get('name') == '$DAEMON' for d in data)
print('yes' if found else 'no')
"
)

if [[ "$REGISTERED" == "yes" ]]; then
    echo "Daemon '$DAEMON' is registered. Unregistering..."
    /usr/bin/sudo -u www-data "$PHP" "$OCC" app_api:daemon:unregister "$DAEMON" --no-interaction
    echo "Daemon '$DAEMON' unregistered successfully."
else
    echo "Daemon '$DAEMON' is not registered. Nothing to do."
fi
