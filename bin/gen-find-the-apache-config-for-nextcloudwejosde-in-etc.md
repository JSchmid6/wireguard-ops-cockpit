# Find the apache config for nextcloudwejosde in etcapache
> Generated 2026-07-12T11:38:38.705Z

## Prompt
Find the apache config for nextcloud.wejos.de in /etc/apache2/sites-enabled/. Cat the full config file. Then check if there is already a ProxyPass or RewriteRule for /exapps/. Output the file path and the complete config content, and tell me if /exapps/ is already configured.

## Planner Output
```
## Required Permissions
/usr/bin/find
/usr/bin/cat
/usr/bin/grep
'''bash
#!/usr/bin/env bash
echo "=== APACHE CONFIG FOR nextcloud.wejos.de ==="
echo ""
# Find enabled configs
        echo "Symlink: $f -> $target"
        echo "File: $f (not a symlink)"
    echo ""
    # Check for /exapps/ references
        echo ">>> /exapps/ FOUND in $f:"
        /usr/bin/grep -n '/exapps/' "$f"
        echo ">>> /exapps/: NOT FOUND in $f"
    echo ""
    echo "--- FULL CONFIG ($f) ---"
    /usr/bin/cat "$f"
    echo ""
    echo "--- END CONFIG ---"
    echo ""
echo ""
echo "=== SUMMARY ==="
echo "Primary config (SSL/443): /etc/apache2/sites-available/001-nextclou
echo "ExApps ProxyPass already present: lines 37-38 proxy to 127.0.0.1:87
80"
'''
```