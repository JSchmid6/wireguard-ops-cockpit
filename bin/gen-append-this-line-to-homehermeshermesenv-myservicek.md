# Append this line to homehermeshermesenv MYSERVICEKE
> Generated 2026-07-15T17:30:03.906Z

## Prompt
Append this line to /home/hermes/.hermes/.env: MY_SERVICE_KEY=abc123

## Planner Output
```
## Required Permissions
/usr/bin/mkdir
/usr/bin/grep
'''bash
#!/usr/bin/env bash
/usr/bin/mkdir -p "${ENV_FILE%/*}"
if ! /usr/bin/grep -qFx "$LINE" "$ENV_FILE" 2>/dev/null; then
'''
9 cwd=/opt/wireguard-ops-cockpit git=/root/.local/share/opencode/snapshot/bc9fb7e1aa9219d4ac16474745578b842113e34e/73b97
6bfb76d8f75a5b24372db5108dd1a3d1d91
8iM
```