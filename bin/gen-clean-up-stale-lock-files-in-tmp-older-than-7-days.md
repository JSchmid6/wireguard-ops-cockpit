# Clean up stale lock files in tmp older than 7 days
> Generated 2026-07-12T10:09:15.059Z

## Prompt
Clean up stale lock files in /tmp/ older than 7 days

## Planner Output
```
## Required Permissions
/usr/bin/find
/usr/bin/rm
'''bash
#!/usr/bin/env bash
set -euo pipefail
LOCK_PATTERNS=(
    -name '*.lock'
    -o -name '*.lck'
    -o -name '*.LOCK'
    -o -name 'lockfile*'
    -o -name '.lock*'
    -o -name '*.lockfile'
)
/usr/bin/find /tmp -maxdepth 1 -type f \( "${LOCK_PATTERNS[@]}" \) -mtime
 +6 -print0 | \
    /usr/bin/xargs -0 --no-run-if-empty /usr/bin/rm -f --
'''
```