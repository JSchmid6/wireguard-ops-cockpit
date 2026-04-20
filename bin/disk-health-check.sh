#!/usr/bin/env bash
set -euo pipefail

echo "== Disk and filesystem health check =="
echo "Timestamp: $(date --iso-8601=seconds)"
echo "Host: $(hostname -f 2>/dev/null || hostname)"
echo

echo "-- Filesystem usage --"
df -h /
echo
df -h /var || true
echo
df -h /var/www/nextcloud || true
echo

echo "-- Inode usage --"
df -ih /
echo

echo "-- Memory and swap --"
free -h
echo
swapon --show || true
echo

echo "-- Largest top-level directories under /var/www/nextcloud --"
du -sh /var/www/nextcloud/* 2>/dev/null | sort -h || true
