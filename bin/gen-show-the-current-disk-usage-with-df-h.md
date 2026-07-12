# Show the current disk usage with df h
> Generated 2026-07-12T10:08:33.109Z

## Prompt
Show the current disk usage with df -h

## Planner Output
```
## Required Permissions
/usr/bin/df
'''bash
#!/usr/bin/env bash
set -euo pipefail
/usr/bin/df -h
'''
```