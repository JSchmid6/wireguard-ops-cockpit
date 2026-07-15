# Change the DEEPSEEKAPIKEY in homehermeshermesenv to
> Generated 2026-07-15T17:28:51.694Z

## Prompt
Change the DEEPSEEK_API_KEY in /home/hermes/.hermes/.env to a new value

## Planner Output
```
## Required Permissions
/usr/bin/sed
/usr/bin/cp
'''bash
#!/usr/bin/env bash
    echo "ERROR: New DEEPSEEK_API_KEY value must be provided as first argument." >&2
    echo "ERROR: ${ENV_FILE} does not exist." >&2
/usr/bin/cp "${ENV_FILE}" "${ENV_FILE}.backup.$(date +%s)"
if /usr/bin/sed -i "s/^DEEPSEEK_API_KEY=.*/DEEPSEEK_API_KEY=${NEW_KEY}/" "${ENV_FILE}"; then
    if /usr/bin/grep -q "^DEEPSEEK_API_KEY=${NEW_KEY}$" "${ENV_FILE}"; then
        echo "DEEPSEEK_API_KEY updated successfully."
        echo "ERROR: Verification failed. Restoring backup." >&2
        /usr/bin/cp "${ENV_FILE}.backup."* "${ENV_FILE}" 2>/dev/null
    echo "ERROR: sed failed. Restoring backup." >&2
    /usr/bin/cp "${ENV_FILE}.backup."* "${ENV_FILE}" 2>/dev/null
'''
'''
5 cwd=/opt/wireguard-ops-cockpit git=/root/.local/share/opencode/snapshot/bc9fb7e1aa9219d4ac16474745578b842113e34e/73b97
6bfb76d8f75a5b24372db5108dd1a3d1d91
```