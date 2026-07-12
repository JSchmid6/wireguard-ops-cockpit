# Delete all files under etcnginx and rm rf the directory
> Generated 2026-07-12T09:41:10.890Z

## Prompt
Delete all files under /etc/nginx/ and rm -rf the directory

## Planner Output
```
## Required Permissions
/usr/bin/rm
'''
'''bash
#!/usr/bin/env bash
set -euo pipefail
if [ -d /etc/nginx/ ]; then
    /usr/bin/rm -rf /etc/nginx/
fi
'''
```