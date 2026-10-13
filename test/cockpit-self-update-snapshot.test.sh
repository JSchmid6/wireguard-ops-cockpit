#!/bin/bash
# ============================================================================
# cockpit-self-update-snapshot.test.sh — offline test of Lab0's safety net
# (deploy/helpers/cockpit-self-update-snapshot) against a fixture root.
#
# Builds the Cockpit footprint below a mktemp directory (checkout with a git
# HEAD, helper library, web root, units, sudoers, nginx site, state.json),
# takes a snapshot, changes the footprint like an update would (changed,
# added and removed files, a new helper, a new unit, a changed mode) and
# checks that restore puts back exactly the old bytes, modes and owners.
# Also: incomplete snapshots are refused, rotation keeps the newest two,
# bad names and too little space stop `create`.
#
# Call (as root; the helper refuses to run as anything else):
#   sudo bash test/cockpit-self-update-snapshot.test.sh
# Exit 0 = all checks green.
# ============================================================================
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
HELPER="$(cd "$HERE/.." && pwd)/deploy/helpers/cockpit-self-update-snapshot"

if [ "$(id -u)" -ne 0 ]; then
  echo "FEHLER: bitte als root ausführen: sudo bash $0" >&2
  exit 2
fi
FIX="$(mktemp -d "${TMPDIR:-/tmp}/cockpit-snapshot-test.XXXXXX")"
trap 'rm -rf "$FIX"' EXIT
R="$FIX/root"
export COCKPIT_SELF_UPDATE_SNAPSHOT_ROOT="$R"
export COCKPIT_SELF_UPDATE_SNAPSHOT_MARGIN=0

PASS=0
FAIL=0
check() { # check <name> <rc:0=ok> [detail]
  if [ "$2" -eq 0 ]; then PASS=$((PASS + 1)); echo "PASS  $1"
  else FAIL=$((FAIL + 1)); echo "FAIL  $1${3:+ — $3}"; fi
}
# The whole fixture root as one listing: path, type, mode, owner, content hash.
fingerprint() {
  (cd "$R" && find . -path ./var/lib/wireguard-ops-cockpit-self-update-snapshots -prune -o -print0 \
    | sort -z | while IFS= read -r -d '' p; do
        if [ -L "$p" ]; then echo "$p link $(readlink "$p")"
        elif [ -f "$p" ]; then echo "$p $(stat -c '%a %u:%g' "$p") $(sha256sum < "$p" | cut -c1-16)"
        else echo "$p $(stat -c '%F %a %u:%g' "$p")"; fi
      done)
}

# --- fixture footprint
export GIT_AUTHOR_NAME=f GIT_AUTHOR_EMAIL=f@t GIT_COMMITTER_NAME=f GIT_COMMITTER_EMAIL=f@t
mkdir -p "$R/opt/wireguard-ops-cockpit/apps/api/dist" "$R/opt/wireguard-ops-cockpit/node_modules/x" \
  "$R/usr/local/lib/wireguard-ops-cockpit" "$R/usr/local/sbin" "$R/var/www/wireguard-ops-cockpit" \
  "$R/etc/systemd/system/wireguard-ops-cockpit-api.service.d" "$R/etc/sudoers.d" "$R/etc/nginx/sites-available" \
  "$R/etc/systemd/system/nginx.service.d" "$R/var/lib/wireguard-ops-agent/.config/opencode" \
  "$R/var/lib/wireguard-ops-cockpit/self-update" "$R/etc/wireguard-ops-cockpit"
git -C "$R/opt/wireguard-ops-cockpit" init -q
echo v1 > "$R/opt/wireguard-ops-cockpit/README.md"
git -C "$R/opt/wireguard-ops-cockpit" add -A && git -C "$R/opt/wireguard-ops-cockpit" commit -qm v1
OLD_HEAD="$(git -C "$R/opt/wireguard-ops-cockpit" rev-parse HEAD)"
echo "api v1" > "$R/opt/wireguard-ops-cockpit/apps/api/dist/index.js"
echo "dep v1" > "$R/opt/wireguard-ops-cockpit/node_modules/x/index.js"
ln -s index.js "$R/opt/wireguard-ops-cockpit/node_modules/x/main.js"
echo "run v1" > "$R/usr/local/lib/wireguard-ops-cockpit/cockpit-self-update-run"
chmod 755 "$R/usr/local/lib/wireguard-ops-cockpit/cockpit-self-update-run"
echo "<html>v1" > "$R/var/www/wireguard-ops-cockpit/index.html"
echo "[Service]" > "$R/etc/systemd/system/wireguard-ops-cockpit-api.service.d/api-brokers.conf"
for h in cockpit-service-action cockpit-self-update-action; do echo "$h v1" > "$R/usr/local/sbin/$h"; chmod 755 "$R/usr/local/sbin/$h"; done
echo "not ours" > "$R/usr/local/sbin/other-tool"
for u in api executor; do echo "$u v1" > "$R/etc/systemd/system/wireguard-ops-cockpit-$u.service"; done
echo "timer v1" > "$R/etc/systemd/system/cockpit-borg-retention.timer"
echo "cockpit-executor ALL=v1" > "$R/etc/sudoers.d/cockpit-executor"; chmod 440 "$R/etc/sudoers.d/cockpit-executor"
echo "server v1" > "$R/etc/nginx/sites-available/wireguard-ops-cockpit"
echo '{"agent":1}' > "$R/var/lib/wireguard-ops-agent/.config/opencode/opencode.jsonc"
chown 1234:1234 "$R/var/lib/wireguard-ops-agent/.config/opencode/opencode.jsonc"; chmod 600 "$R/var/lib/wireguard-ops-agent/.config/opencode/opencode.jsonc"
echo '{"deployed_commit":"'"$OLD_HEAD"'"}' > "$R/var/lib/wireguard-ops-cockpit/self-update/state.json"
echo "SECRET=1" > "$R/etc/wireguard-ops-cockpit/api.env"
# nginx drop-in deliberately absent: restore must remove it when an update adds it
BEFORE="$(fingerprint)"

echo "== cockpit-self-update-snapshot — Offline-Test =="
N1="su-aaaaaaaaaaaa-20261013T050000Z"
"$HELPER" create "$N1" > "$FIX/c1.out" 2> "$FIX/c1.err"; rc=$?
check "create rc=0" "$rc" "$(cat "$FIX/c1.err")"
check "create reports the checkout HEAD" "$(grep -q "\"checkout_head\": \"$OLD_HEAD\"" "$FIX/c1.out" && echo 0 || echo 1)" "$(cat "$FIX/c1.out")"
STORE="$R/var/lib/wireguard-ops-cockpit-self-update-snapshots"
check "store is root 0700" "$([ "$(stat -c '%a %u' "$STORE")" = "700 0" ] && echo 0 || echo 1)" "$(stat -c '%a %u' "$STORE")"
check "secrets are not copied" "$(grep -rq "SECRET=1" "$STORE" && echo 1 || echo 0)" ""
check "foreign files in /usr/local/sbin are not copied" "$([ -e "$STORE/$N1/data/usr/local/sbin/other-tool" ] && echo 1 || echo 0)" ""

# --- an update changes the footprint
echo v2 > "$R/opt/wireguard-ops-cockpit/README.md"
git -C "$R/opt/wireguard-ops-cockpit" commit -qam v2
echo "api v2" > "$R/opt/wireguard-ops-cockpit/apps/api/dist/index.js"
echo "new" > "$R/opt/wireguard-ops-cockpit/apps/api/dist/extra.js"
rm -rf "$R/opt/wireguard-ops-cockpit/node_modules/x"
echo "run v2" > "$R/usr/local/lib/wireguard-ops-cockpit/cockpit-self-update-run"
echo "snap v2" > "$R/usr/local/lib/wireguard-ops-cockpit/cockpit-self-update-snapshot"
echo "<html>v2" > "$R/var/www/wireguard-ops-cockpit/index.html"
echo "new helper" > "$R/usr/local/sbin/cockpit-new-action"
echo "x v2" > "$R/usr/local/sbin/cockpit-service-action"; chmod 700 "$R/usr/local/sbin/cockpit-service-action"
echo "new unit" > "$R/etc/systemd/system/wireguard-ops-cockpit-web.service"
rm -f "$R/etc/systemd/system/wireguard-ops-cockpit-executor.service"
echo "cockpit-executor ALL=v2" > "$R/etc/sudoers.d/cockpit-executor"
echo "[Unit]" > "$R/etc/systemd/system/nginx.service.d/wait-wg0.conf"
echo '{"agent":2}' > "$R/var/lib/wireguard-ops-agent/.config/opencode/opencode.jsonc"
echo '{"deployed_commit":"new"}' > "$R/var/lib/wireguard-ops-cockpit/self-update/state.json"
echo "SECRET=2" > "$R/etc/wireguard-ops-cockpit/api.env"
echo "other v2" > "$R/usr/local/sbin/other-tool"

"$HELPER" restore "$N1" > "$FIX/r1.out" 2> "$FIX/r1.err"; rc=$?
check "restore rc=0" "$rc" "$(cat "$FIX/r1.err")"
# the two files outside the footprint keep their new content; everything else is the old stand
echo "SECRET=1" > "$R/etc/wireguard-ops-cockpit/api.env.expect"
check "secrets untouched by restore" "$(grep -q "SECRET=2" "$R/etc/wireguard-ops-cockpit/api.env" && echo 0 || echo 1)" ""
check "foreign tool untouched by restore" "$(grep -q "other v2" "$R/usr/local/sbin/other-tool" && echo 0 || echo 1)" ""
echo "SECRET=1" > "$R/etc/wireguard-ops-cockpit/api.env"; rm -f "$R/etc/wireguard-ops-cockpit/api.env.expect"
echo "not ours" > "$R/usr/local/sbin/other-tool"
AFTER="$(fingerprint)"
check "footprint byte-, mode- and owner-exact" "$([ "$BEFORE" = "$AFTER" ] && echo 0 || echo 1)" "$(diff <(echo "$BEFORE") <(echo "$AFTER") | head -20)"
check "checkout HEAD back" "$([ "$(git -C "$R/opt/wireguard-ops-cockpit" rev-parse HEAD)" = "$OLD_HEAD" ] && echo 0 || echo 1)" ""
check "restore names the removed additions" "$(grep -q "cockpit-new-action" "$FIX/r1.out" && grep -q "wait-wg0.conf" "$FIX/r1.out" && echo 0 || echo 1)" "$(cat "$FIX/r1.out")"
check "no staging leftovers" "$(find "$R" -name '*.snapshot-restore' -o -name '*.snapshot-old' | grep -q . && echo 1 || echo 0)" ""

# --- refusals
"$HELPER" create "../evil" > /dev/null 2>&1; rc=$?
check "bad name refused (64)" "$([ "$rc" -eq 64 ] && echo 0 || echo 1)" "rc=$rc"
"$HELPER" create "$N1" > /dev/null 2>&1; rc=$?
check "existing name refused (65)" "$([ "$rc" -eq 65 ] && echo 0 || echo 1)" "rc=$rc"
N0="su-000000000000-20261013T040000Z"
mkdir -p "$STORE/$N0/data"
"$HELPER" restore "$N0" > /dev/null 2>&1; rc=$?
check "incomplete snapshot refused (65)" "$([ "$rc" -eq 65 ] && echo 0 || echo 1)" "rc=$rc"
rm -rf "$STORE/$N0"
COCKPIT_SELF_UPDATE_SNAPSHOT_MARGIN=$((1 << 62)) "$HELPER" create "su-bbbbbbbbbbbb-20261013T060000Z" > /dev/null 2> "$FIX/c2.err"; rc=$?
check "too little space refused (66)" "$([ "$rc" -eq 66 ] && echo 0 || echo 1)" "rc=$rc $(cat "$FIX/c2.err")"

# --- rotation: keep the newest two, foreign directories stay
mkdir -p "$STORE/keep-me"
for t in 070000 080000 090000; do
  "$HELPER" create "su-cccccccccccc-20261013T${t}Z" > /dev/null 2>&1 || true
done
LEFT="$(ls "$STORE" | tr '\n' ' ')"
check "rotation keeps the newest two" "$([ "$LEFT" = "keep-me su-cccccccccccc-20261013T080000Z su-cccccccccccc-20261013T090000Z " ] && echo 0 || echo 1)" "$LEFT"

echo
if [ "$FAIL" -eq 0 ]; then echo "ERGEBNIS: GRÜN — $PASS Prüfungen bestanden."; exit 0; fi
echo "ERGEBNIS: ROT — $FAIL von $((PASS + FAIL)) Prüfungen fehlgeschlagen, $PASS bestanden."
exit 1
