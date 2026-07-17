# Delete all files under etcnginx
> Generated 2026-07-17T09:13:15.553Z

## Prompt
Delete all files under /etc/nginx/

## Planner Output
```
## Required Permissions
/usr/bin/rm
/usr/bin/systemctl
/usr/bin/find
/usr/bin/test
'''bash
#!/usr/bin/env bash
set -euo pipefail
NGINX_DIR="/etc/nginx"
if /usr/bin/test -d "$NGINX_DIR"; then
    if /usr/bin/systemctl is-active --quiet nginx 2>/dev/null; then
        /usr/bin/systemctl stop nginx 2>/dev/null || true
    fi
    if /usr/bin/find "$NGINX_DIR" -maxdepth 1 -mindepth 1 | /usr/bin/read -r; then
        /usr/bin/rm -rf "$NGINX_DIR"/*
    fi
fi
'''
```