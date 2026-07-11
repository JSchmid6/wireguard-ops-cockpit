#!/usr/bin/env bash
set -euo pipefail

echo "== Root filesystem disk space check =="
echo "Timestamp: $(/usr/bin/date --iso-8601=seconds)"
echo "Host: $(/usr/bin/hostname -f 2>/dev/null || /usr/bin/hostname)"
echo

echo "-- Root filesystem usage --"
/bin/df -h /
echo

echo "-- Root filesystem inode usage --"
/bin/df -ih /
echo

echo "-- Root filesystem summary (percentage) --"
disk_pct=$(/bin/df -h / 2>/dev/null | /usr/bin/tail -n 1 | /usr/bin/awk '{print $5}' | /usr/bin/tr -d '%' || echo "0")
inode_pct=$(/bin/df -ih / 2>/dev/null | /usr/bin/tail -n 1 | /usr/bin/awk '{print $5}' | /usr/bin/tr -d '%' || echo "0")
dusage_val=$(/bin/df -h / 2>/dev/null | /usr/bin/tail -n 1 | /usr/bin/awk '{print $3}' || echo "unknown")
davail_val=$(/bin/df -h / 2>/dev/null | /usr/bin/tail -n 1 | /usr/bin/awk '{print $4}' || echo "unknown")
dtotal_val=$(/bin/df -h / 2>/dev/null | /usr/bin/tail -n 1 | /usr/bin/awk '{print $2}' || echo "unknown")

echo "Root disk: ${dusage_val} used / ${davail_val} available / ${dtotal_val} total (${disk_pct}%)"
echo "Root inodes: ${inode_pct}% used"

# Alert if usage is high
if [ "${disk_pct:-0}" -ge 90 ]; then
    echo
    echo "WARNING: Root disk usage is at ${disk_pct}% - critically high!"
elif [ "${disk_pct:-0}" -ge 80 ]; then
    echo
    echo "NOTICE: Root disk usage is at ${disk_pct}% - elevated."
fi

if [ "${inode_pct:-0}" -ge 90 ]; then
    echo
    echo "WARNING: Root inode usage is at ${inode_pct}% - critically high!"
elif [ "${inode_pct:-0}" -ge 80 ]; then
    echo
    echo "NOTICE: Root inode usage is at ${inode_pct}% - elevated."
fi

echo
echo "-- Largest directories under / (top 10 by size) --"
/usr/bin/du -sh /* 2>/dev/null | /usr/bin/sort -h -r | /usr/bin/head -n 10 || true
echo

echo "Check complete."
