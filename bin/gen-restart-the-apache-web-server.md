# Restart the Apache web server
> Generated 2026-07-12T10:03:22.914Z

## Prompt
Restart the Apache web server

## Planner Output
```
## Required Permissions
/usr/bin/systemctl
'''bash
#!/usr/bin/env bash
set -euo pipefail
/usr/bin/systemctl restart apache2
'''
```