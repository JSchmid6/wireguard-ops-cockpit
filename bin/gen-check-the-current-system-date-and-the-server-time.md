# Check the current system date and the server time
> Generated 2026-07-12T09:37:11.843Z

## Prompt
Check the current system date and the server time

## Planner Output
```
## Required Permissions
/usr/bin/date
/usr/bin/timedatectl
'''bash
#!/usr/bin/env bash
set -euo pipefail
echo "=== System Date & Time ==="
echo ""
echo "Current date/time (date):"
/usr/bin/date
echo ""
echo "Detailed time info (timedatectl):"
/usr/bin/timedatectl status 2>/dev/null || /usr/bin/date "+%Y-%m-%d %H:%M
:%S %Z (fallback - timedatectl unavailable)"
echo ""
echo "Uptime:"
/usr/bin/uptime
echo ""
echo "Hardware clock (RTC):"
/usr/bin/hwclock -r 2>/dev/null || echo "hwclock not accessible"
'''
```