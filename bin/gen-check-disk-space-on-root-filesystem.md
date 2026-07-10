# Check disk space on root filesystem
> Generated 2026-07-10T21:10:34.420Z

## Prompt
Check disk space on root filesystem

## Planner Output
```
timestamp=2026-07-10T21:09:50.743Z level=INFO run=be1751d6 message="creating instance" directory=/opt/wireguard-ops-cockpit
timestamp=2026-07-10T21:09:50.745Z level=INFO run=be1751d6 message=fromDirectory directory=/opt/wireguard-ops-cockpit
timestamp=2026-07-10T21:09:50.855Z level=INFO run=be1751d6 message=bootstrapping directory=/opt/wireguard-ops-cockpit
timestamp=2026-07-10T21:09:50.872Z level=INFO run=be1751d6 message=loading path=/var/lib/wireguard-ops-cockpit/.config/opencode/config.json
timestamp=2026-07-10T21:09:50.875Z level=INFO run=be1751d6 message=loading path=/var/lib/wireguard-ops-cockpit/.config/opencode/opencode.json
timestamp=2026-07-10T21:09:50.875Z level=INFO run=be1751d6 message=loading path=/var/lib/wireguard-ops-cockpit/.config/opencode/opencode.jsonc
timestamp=2026-07-10T21:09:51.048Z level=INFO run=be1751d6 message="all LSPs are disabled"
timestamp=2026-07-10T21:09:51.050Z level=INFO run=be1751d6 message="all formatters are disabled"
timestamp=2026-07-10T21:09:51.050Z level=INFO run=be1751d6 message=init
timestamp=2026-07-10T21:09:51.246Z level=INFO run=be1751d6 message=created id=ses_0b22279f1ffeUOndob5kLoESgz slug=witty-star version=1.17.18 projectID=global directory=/opt/wireguard-ops-cockpit path=opt/wireguard-ops-cockpit workspaceID=undefined parentID=undefined title="New session - 2026-07-10T21:09:51.246Z" agent=undefined model=undefined metadata=undefined permission="[{\"permission\":\"question\",\"pattern\":\"*\",\"action\":\"deny\"},{\"permission\":\"plan_enter\",\"pattern\":\"*\",\"action\":\"deny\"},{\"permission\":\"plan_exit\",\"pattern\":\"*\",\"action\":\"deny\"}]" cost=0 tokens.input=0 tokens.output=0 tokens.reasoning=0 tokens.cache.read=0 tokens.cache.write=0 time.created=1783717791246 time.updated=1783717791246
timestamp=2026-07-10T21:09:51.271Z level=INFO run=be1751d6 message="event connected"
timestamp=2026-07-10T21:09:52.089Z level=INFO run=be1751d6 message=loop session.id=ses_0b22279f1ffeUOndob5kLoESgz step=0
timestamp=2026-07-10T21:09:52.108Z level=INFO run=be1751d6 message="shell tool using shell" shell=/bin/bash
timestamp=2026-07-10T21:09:52.122Z level=INFO run=be1751d6 message=init count=1
[0m
> build · deepseek-v4-pro
[0m
timestamp=2026-07-10T21:09:52.180Z level=INFO run=be1751d6 message=stream providerID=deepseek modelID=deepseek-v4-pro session.id=ses_0b22279f1ffeUOndob5kLoESgz small=true agent=title mode=primary
timestamp=2026-07-10T21:09:52.231Z level=INFO run=be1751d6 message="llm runtime selected" llm.runtime=ai-sdk llm.provider=deepseek llm.model=deepseek-v4-pro
timestamp=2026-07-10T21:09:52.446Z level=INFO run=be1751d6 message="watcher backend" directory=/opt/wireguard-ops-cockpit platform=linux backend=inotify
timestamp=2026-07-10T21:09:52.462Z level=INFO run=be1751d6 message="project copy refresh started" projectID=global
timestamp=2026-07-10T21:09:52.464Z level=INFO run=be1751d6 message="project copy refresh done" projectID=global updated=[] removed=[]
timestamp=2026-07-10T21:09:52.554Z level=INFO run=be1751d6 message="booting location services" directory=/opt/wireguard-ops-cockpit workspaceID=undefined
timestamp=2026-07-10T21:09:52.739Z level=INFO run=be1751d6 message=process session.id=ses_0b22279f1ffeUOndob5kLoESgz messageID=msg_f4ddd895e001vcgrNx8aVgRpng
timestamp=2026-07-10T21:09:52.741Z level=INFO run=be1751d6 message=stream providerID=deepseek modelID=deepseek-v4-pro session.id=ses_0b22279f1ffeUOndob5kLoESgz small=false agent=build mode=primary
timestamp=2026-07-10T21:09:52.746Z level=INFO run=be1751d6 message="llm runtime selected" llm.runtime=ai-sdk llm.provider=deepseek llm.model=deepseek-v4-pro
timestamp=2026-07-10T21:09:56.447Z level=INFO run=be1751d6 message=evaluated permission=bash pattern="ls /opt/wireguard-ops-cockpit/bin/ 2>/dev/null" action.permission=* action.action=allow action.pattern=*
timestamp=2026-07-10T21:09:56.447Z level=INFO run=be1751d6 message=evaluated permission=bash pattern="echo \"DIR_NOT_FOUND\"" action.permission=* action.action=allow action.pattern=*
[0m$ [0mls /opt/wireguard-ops-cockpit/bin/ 2>/dev/null || echo "DIR_NOT_FOUND"
apt-check-updates.sh
apt-upgrade-count.sh
apt-upgrade-report.sh
disk-health-check.sh
gen-check-system-uptime-and-disk-usage-output-a-summar.sh
gen-run-aptget-update-and-count-upgradable-packages.sh
gen-run-aptget-update-and-report-how-many-packages-can.md
gen-run-aptget-update-and-report-the-number-of-upgrada.md
gen-show-current-time-and-memory-usage.md
lib
nextcloud-disable-maintenance.sh
nextcloud-enable-maintenance.sh
nextcloud-occ-upgrade.sh
nextcloud-post-update-verify.sh
nextcloud-rollback-restore.sh
nextcloud-rollback-verify.sh
nextcloud-update-plan.sh
restart-nextcloud-web-stack.sh
system-uptime-disk-summary.sh
ttyd-session-attach.sh
[0m
timestamp=2026-07-10T21:09:57.000Z level=INFO run=be1751d6 message=evaluated permission=grep pattern=slug|runbook action.permission=* action.action=allow action.pattern=*
[0m✱ [0mGrep "slug|runbook"[90m in apps/api/src · 100 matches[0m
timestamp=2026-07-10T21:09:57.117Z level=INFO run=be1751d6 message=loop session.id=ses_0b22279f1ffeUOndob5kLoESgz step=1
timestamp=2026-07-10T21:09:57.168Z level=INFO run=be1751d6 message=process session.id=ses_0b22279f1ffeUOndob5kLoESgz messageID=msg_f4ddd9d00001LhAWMIsx9U6DN5
timestamp=2026-07-10T21:09:57.170Z level=INFO run=be1751d6 message=stream providerID=deepseek modelID=deepseek-v4-pro session.id=ses_0b22279f1ffeUOndob5kLoESgz small=false agent=build mode=primary
timestamp=2026-07-10T21:09:57.171Z level=INFO run=be1751d6 message="llm runtime selected" llm.runtime=ai-sdk llm.provider=deepseek llm.model=deepseek-v4-pro
timestamp=2026-07-10T21:09:59.401Z level=INFO run=be1751d6 message=evaluated permission=read pattern=opt/wireguard-ops-cockpit/bin/disk-health-check.sh action.permission=read action.pattern=* action.action=allow
timestamp=2026-07-10T21:09:59.495Z level=INFO run=be1751d6 message="touching file" file=/opt/wireguard-ops-cockpit/bin/disk-health-check.sh
[0m→ [0mRead bin/disk-health-check.sh
timestamp=2026-07-10T21:09:59.757Z level=INFO run=be1751d6 message=evaluated permission=read pattern=opt/wireguard-ops-cockpit/bin/system-uptime-disk-summary.sh action.permission=read action.pattern=* action.action=allow
timestamp=2026-07-10T21:09:59.901Z level=INFO run=be1751d6 message="touching file" file=/opt/wireguard-ops-cockpit/bin/system-uptime-disk-summary.sh
[0m→ [0mRead bin/system-uptime-disk-summary.sh
timestamp=2026-07-10T21:10:00.433Z level=INFO run=be1751d6 message=evaluated permission=read pattern=opt/wireguard-ops-cockpit/apps/api/src/registries.ts action.permission=read action.pattern=* action.action=allow
timestamp=2026-07-10T21:10:00.558Z level=INFO run=be1751d6 message=loop session.id=ses_0b22279f1ffeUOndob5kLoESgz step=2
timestamp=2026-07-10T21:10:00.566Z level=INFO run=be1751d6 message="touching file" file=/opt/wireguard-ops-cockpit/apps/api/src/registries.ts
[0m→ [0mRead apps/api/src/registries.ts[90m [offset=100, limit=100][0m
timestamp=2026-07-10T21:10:00.627Z level=INFO run=be1751d6 message=process session.id=ses_0b22279f1ffeUOndob5kLoESgz messageID=msg_f4dddaa70001v3yXwcmnPr9TPS
timestamp=2026-07-10T21:10:00.628Z level=INFO run=be1751d6 message=stream providerID=deepseek modelID=deepseek-v4-pro session.id=ses_0b22279f1ffeUOndob5kLoESgz small=false agent=build mode=primary
timestamp=2026-07-10T21:10:00.631Z level=INFO run=be1751d6 message="llm runtime selected" llm.runtime=ai-sdk llm.provider=deepseek llm.model=deepseek-v4-pro
timestamp=2026-07-10T21:10:15.196Z level=INFO run=be1751d6 message=loop session.id=ses_0b22279f1ffeUOndob5kLoESgz step=3
timestamp=2026-07-10T21:10:15.199Z level=INFO run=be1751d6 message="exiting loop" session.id=ses_0b22279f1ffeUOndob5kLoESgz
`check-root-disk-space` is the slug. Writing the script now.

'''bash
#!/usr/bin/env bash
set -euo pipefail

echo "== Root filesystem disk space check =="
echo "Timestamp: $(date --iso-8601=seconds)"
echo "Host: $(/usr/bin/hostname -f 2>/dev/null || /usr/bin/hostname)"
echo

echo "-- Root filesystem usage --"
/bin/df -h /
echo

echo "-- Root filesystem inode usage --"
/bin/df -ih /
echo

echo "-- Root filesystem details --"
root_device=$(/bin/df / --output=source 2>/dev/null | /usr/bin/tail -n 1 || echo "unknown")
root_usage_pct=$(/bin/df / --output=pcent 2>/dev/null | /usr/bin/tail -n 1 | /usr/bin/tr -d ' %' || echo "0")
root_avail=$(/bin/df / --output=avail 2>/dev/null | /usr/bin/tail -n 1 || echo "unknown")
root_total=$(/bin/df -h / --output=size 2>/dev/null | /usr/bin/tail -n 1 | /usr/bin/tr -d ' ' || echo "unknown")

echo "Device:       ${root_device}"
echo "Total size:   ${root_total}"
echo "Available:    ${root_avail}"
echo "Usage:        ${root_usage_pct}%"
echo

if (( root_usage_pct >= 95 )); then
    echo "WARNING: Root filesystem usage at ${root_usage_pct}% — critically low space."
    echo "ACTION: Free up space immediately to prevent service disruption."
elif (( root_usage_pct >= 85 )); then
    echo "WARNING: Root filesystem usage at ${root_usage_pct}% — consider freeing space soon."
elif (( root_usage_pct >= 70 )); then
    echo "NOTICE: Root filesystem usage at ${root_usage_pct}% — monitor closely."
else
    echo "OK: Root filesystem usage at ${root_usage_pct}% is within normal range."
fi
echo

echo "-- Largest directories under / (one level deep, top 15) --"
/usr/bin/du -h -d 1 / 2>/dev/null | /usr/bin/sort -h -r | /usr/bin/head -n 15 || echo "(unable to read / sizes)"
echo

echo "Done."
'''
timestamp=2026-07-10T21:10:15.210Z level=INFO run=be1751d6 message="disposing instance" directory=/opt/wireguard-ops-cockpit
```