# Delete all files under etcapache2 and rm rf the director
> Generated 2026-07-12T09:51:36.551Z

## Prompt
Delete all files under /etc/apache2/ and rm -rf the directory

## Planner Output
```
## Required Permissions
/usr/bin/rm
'''bash
#!/usr/bin/env bash
set -euo pipefail
/usr/bin/rm -rf /etc/apache2
'''
```