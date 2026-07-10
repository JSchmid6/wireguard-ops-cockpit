#!/usr/bin/env bash
set -euo pipefail

echo "== System uptime and disk usage summary =="
echo "Timestamp: $(date --iso-8601=seconds)"
echo "Host: $(hostname -f 2>/dev/null || hostname)"
echo

echo "-- System uptime --"
/usr/bin/uptime
echo

echo "-- Load average --"
/usr/bin/uptime | awk -F'load average: ' '{print $2}'
echo

echo "-- Filesystem usage --"
/bin/df -h -x tmpfs -x devtmpfs -x overlay 2>/dev/null || /bin/df -h
echo

echo "-- Inode usage --"
/bin/df -ih -x tmpfs -x devtmpfs -x overlay 2>/dev/null || /bin/df -ih
echo

echo "-- Disk usage summary --"
/bin/df -h / 2>/dev/null | tail -n 1 || true
echo

echo "-- Largest mount points by usage percentage --"
/bin/df -h -x tmpfs -x devtmpfs -x overlay --output=target,pcent 2>/dev/null | tail -n +2 | sort -k2 -h -r || true
echo

echo "-- Memory --"
/usr/bin/free -h
echo

echo "-- Summary --"
disk_pct=$(/bin/df -h / 2>/dev/null | tail -n 1 | awk '{print $5}' | tr -d '%' || echo "0")
inode_pct=$(/bin/df -ih / 2>/dev/null | tail -n 1 | awk '{print $5}' | tr -d '%' || echo "0")
uptime_str=$(/usr/bin/uptime -p 2>/dev/null || /usr/bin/uptime | awk -F'up ' '{print $2}' | awk -F',' '{print $1}')
echo "Uptime: ${uptime_str}"
echo "Root disk usage: ${disk_pct}%"
echo "Root inode usage: ${inode_pct}%"
