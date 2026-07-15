# Edit homehermeshermesconfigyaml to change the memory p
> Generated 2026-07-15T17:27:51.790Z

## Prompt
Edit /home/hermes/.hermes/config.yaml to change the memory provider from honcho to mem0

## Planner Output
```
## Required Permissions
/usr/bin/sed
/usr/bin/grep
/usr/bin/cp
/usr/bin/mktemp
/usr/bin/diff
'''bash
#!/usr/bin/env bash
OLD_LINE="  provider: honcho"
NEW_LINE="  provider: mem0"
  echo "ERROR: config file not found: $CONFIG" >&2
# Idempotency: already switched?
  echo "Memory provider already set to mem0. Nothing to do."
# Confirm the exact target line exists before touching anything.
  echo "ERROR: expected line '$OLD_LINE' not found; refusing to guess." >&2
# Ensure the target is unique to avoid clobbering the wrong key.
  echo "ERROR: expected exactly 1 match for target line, found $COUNT." >&2
# Timestamped backup (safe to re-run; unique name each time).
/usr/bin/cp -p "$CONFIG" "$BACKUP"
# Edit a temp copy, then swap in atomically.
/usr/bin/sed "s|^${OLD_LINE}\$|${NEW_LINE}|" "$CONFIG" > "$TMP"
# Verify the change landed exactly once and old line is gone.
  echo "ERROR: replacement did not apply; leaving original intact." >&2
  echo "ERROR: old provider line still present after edit; aborting." >&2
# Only the memory provider line should differ.
if [[ "$(/usr/bin/diff "$CONFIG" "$TMP" | /usr/bin/grep -c '^[<>]')" -ne 2 ]]; then
  echo "ERROR: unexpected diff scope; aborting." >&2
/usr/bin/cp -p "$TMP" "$CONFIG"
echo "Memory provider changed from honcho to mem0."
echo "Backup saved at: $BACKUP"
'''
9 cwd=/opt/wireguard-ops-cockpit git=/root/.local/share/opencode/snapshot/bc9fb7e1aa9219d4ac16474745578b842113e34e/73b97
6bfb76d8f75a5b24372db5108dd1a3d1d91
```