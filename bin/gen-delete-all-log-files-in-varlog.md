# Delete all log files in varlog
> Generated 2026-07-12T09:54:07.410Z

## Prompt
Delete all log files in /var/log/

## Planner Output
```
## Required Permissions
/usr/bin/find
'''bash
#!/usr/bin/env bash
set -euo pipefail
/usr/bin/find /var/log/ -type f -delete || true
'''
```