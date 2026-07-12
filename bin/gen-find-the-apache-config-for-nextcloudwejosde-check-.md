# Find the apache config for nextcloudwejosde check if exa
> Generated 2026-07-12T11:26:37.426Z

## Prompt
Find the apache config for nextcloud.wejos.de, check if /exapps/ ProxyPass exists, and cat the config.

## Planner Output
```
## Required Permissions
/usr/bin/grep
/usr/bin/cat
/usr/bin/find
'''bash
#!/usr/bin/env bash
    FOUND=$(/usr/bin/grep -Rl "nextcloud\.wejos\.de" "$DIR" 2>/dev/null |
 /usr/bin/head -1) || true
  echo "ERROR: Could not find Apache config referencing nextcloud.wejos.d
echo "=== Config file: $CONFIG_FILE ==="
echo ""
if /usr/bin/grep -q "/exapps/" "$CONFIG_FILE" 2>/dev/null; then
  echo ">>> /exapps/ ProxyPass directive FOUND in config"
  echo ""
  echo "=== Matching lines for /exapps/ ==="
  /usr/bin/grep -n "/exapps/" "$CONFIG_FILE" || true
  echo ""
  echo ">>> /exapps/ ProxyPass directive NOT FOUND in config"
  echo ""
echo "=== Full config contents ==="
/usr/bin/cat "$CONFIG_FILE"
'''
```