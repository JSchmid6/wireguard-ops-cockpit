# Find the apache config file for nextcloudwejosde Run fin
> Generated 2026-07-12T11:35:42.756Z

## Prompt
Find the apache config file for nextcloud.wejos.de. Run: find /etc/apache2 -type f -name "*.conf" | xargs grep -l "nextcloud.wejos.de" | head -5. Then cat each file found. Then check if /exapps/ is already in there with: grep -n "/exapps/" <file>. Output the results.

## Planner Output
```
## Required Permissions
/usr/bin/find
/usr/bin/xargs
/usr/bin/grep
/usr/bin/head
/usr/bin/cat
'''bash
#!/usr/bin/env bash
FILES=$(/usr/bin/find /etc/apache2 -type f -name "*.conf" 2>/dev/null | /
usr/bin/xargs /usr/bin/grep -l "nextcloud.wejos.de" 2>/dev/null | /usr/bi
    echo "No Apache config files found containing nextcloud.wejos.de"
echo "=== Found config files ==="
echo "$FILES"
echo ""
    echo "=== Content of: $f ==="
    /usr/bin/cat "$f"
    echo ""
    echo "=== /exapps/ matches in: $f ==="
    /usr/bin/grep -n "/exapps/" "$f" || echo "(no /exapps/ entries found)
    echo ""
'''
```