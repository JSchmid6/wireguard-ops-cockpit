#!/bin/bash
# =============================================================================
# cockpit-disk-action — Offline-Simulationsharness
# -----------------------------------------------------------------------------
# Prüft den Helfer ohne echte RAID-Hardware: /proc/mdstat wird durch Fixtures
# ersetzt, mdadm/blkid/sysfs durch Stubs (COCKPIT_DISK_ACTION_*-Hooks). Es wird
# der ORIGINALE deploy/helpers/cockpit-disk-action ausgeführt, keine Kopie.
# Ein eigener Fall spiegelt die Sandbox-Anordnung des Capability-Runners:
# mdstat read-only auf neutralem Pfad (z. B. /run/mdstat), SYSBLOCK aus sysfs.
#
# Aufruf (kein mdadm nötig; auf Lab0 direkt als root, sonst mit sudo):
#   sudo bash test/cockpit-disk-action.test.sh
#
# Ohne root laufen nur die nicht-mutierenden Fälle (usage/status/device); die
# remove/add-Fälle werden übersprungen. Das Skript endet nur dann mit RC != 0,
# wenn ein ausgeführter Fall fehlschlägt.
# =============================================================================
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
HELPER="$(cd "$HERE/.." && pwd)/deploy/helpers/cockpit-disk-action"
[ -f "$HELPER" ] || { echo "FEHLER: $HELPER nicht gefunden" >&2; exit 1; }

WORK="$(mktemp -d /tmp/cockpit-disk-action-test.XXXXXX)"
trap 'rm -rf "$WORK"' EXIT
FIXTURES="$WORK/fixtures"
SYSBLOCK="$WORK/sysblock"
mkdir -p "$FIXTURES" "$SYSBLOCK"
for disk in sda sdb sdc sdd sde sdf; do : > "$SYSBLOCK/$disk"; done   # sdz fehlt absichtlich

PASS=0; FAIL=0
ok()  { PASS=$((PASS + 1)); printf '  ok   %s\n' "$1"; }
bad() { FAIL=$((FAIL + 1)); printf '  FAIL %s\n' "$1"; }
assert_rc() { # name, erwartet
  if [ "$RC" -eq "$2" ]; then ok "$1 (rc=$2)"; else bad "$1 (rc=$RC, erwartet $2)"; fi
}
assert_out() { if printf '%s' "$OUT" | grep -q -- "$2"; then ok "$1"; else bad "$1 — stdout fehlt: $2"; fi }
assert_no_out() { if printf '%s' "$OUT" | grep -q -- "$2"; then bad "$1 — stdout enthält unerwartet: $2"; else ok "$1"; fi }
assert_err() { if printf '%s' "$ERR" | grep -q -- "$2"; then ok "$1"; else bad "$1 — stderr fehlt: $2 (stderr: $ERR)"; fi }
assert_json() { # name, json
  if printf '%s' "$2" | json_valid; then ok "$1"; else bad "$1 — kein valides JSON: $2"; fi
}
assert_field() { # name, json, python-Ausdruck über d
  if command -v python3 >/dev/null 2>&1; then
    if printf '%s' "$2" | python3 -c "import json,sys; d=json.load(sys.stdin); sys.exit(0 if ($3) else 1)" 2>/dev/null; then
      ok "$1"
    else
      bad "$1 — Bedingung $3 auf $2 verletzt"
    fi
  else
    ok "$1 (übersprungen: python3 fehlt)"
  fi
}
json_valid() {
  if command -v jq >/dev/null 2>&1; then jq -e . >/dev/null 2>&1
  elif command -v python3 >/dev/null 2>&1; then python3 -m json.tool >/dev/null 2>&1
  else return 0
  fi
}

# ---------------------------------------------------------------------------
# Stubs (werden vom Helfer über die COCKPIT_DISK_ACTION_*-Hooks aufgerufen)
# ---------------------------------------------------------------------------
cat > "$WORK/stub-mdadm" <<'STUB_EOF'
#!/bin/bash
# stub-mdadm — simuliert die vom Helfer erlaubten mdadm-Aufrufe auf der Fake-mdstat.
set -u
MD="${STUB_MDSTAT:?STUB_MDSTAT fehlt}"
printf 'mdadm %s\n' "$*" >> "${STUB_LOG:-/dev/null}"
if [ -n "${STUB_MDADM_FAIL:-}" ]; then
  echo "mdadm: simulierter Fehler" >&2
  exit 2
fi
action=""; device=""; args=("$@"); i=0
while [ "$i" -lt "${#args[@]}" ]; do
  case "${args[$i]:-}" in
    --remove) action="remove"; device="${args[$((i + 1))]:-}"; i=$((i + 1)) ;;
    --add)    action="add";    device="${args[$((i + 1))]:-}"; i=$((i + 1)) ;;
  esac
  i=$((i + 1))
done
device="${device#/dev/}"
tmp="$(mktemp)"
case "$action" in
  remove)
    awk -v dev="$device" '
      {
        if ($1 == "md127" && $2 == ":") {
          n = split($0, toks, " "); out = ""
          for (i = 1; i <= n; i++) {
            if (toks[i] ~ "^" dev "\\[[0-9]+\\]") continue
            out = out (out == "" ? "" : " ") toks[i]
          }
          print out; next
        }
        print
      }' "$MD" > "$tmp" && mv "$tmp" "$MD"
    exit 0 ;;
  add)
    slot="$(awk '
      /^md127 :/ { for (i = 1; i <= NF; i++) if ($i ~ /^sd[a-z]\[[0-9]+\]/) { s = $i; sub(/^sd[a-z]\[/, "", s); sub(/\].*/, "", s); if (s + 0 >= m) m = s + 0 + 1 } }
      END { printf "%d", m + 0 }' "$MD")"
    awk -v dev="$device" -v slot="$slot" '
      { if ($1 == "md127" && $2 == ":") { print $0 " " dev "[" slot "](S)" } else print }' \
      "$MD" > "$tmp" && mv "$tmp" "$MD"
    counts="$(grep -oE '\[[0-9]+/[0-9]+\]' "$MD" | head -n1 || true)"
    total="${counts%%/*}"; total="${total#\[}"
    active="${counts##*/}"; active="${active%\]}"
    if [ -n "$counts" ] && [ "$total" != "$active" ]; then
      awk -v dev="$device" -v slot="$slot" '
        { if ($1 == "md126" && $2 == ":") { print $0 " " dev "[" slot "]" }
          else if ($0 ~ /\[[0-9]+\/[0-9]+\] \[U/) { print; print "      [>....................]  recovery =  0.4% (1000/1999872) finish=170.0min speed=190K/sec" }
          else print }' "$MD" > "$tmp" && mv "$tmp" "$MD"
    fi
    exit 0 ;;
esac
echo "stub-mdadm: unerwartete Argumente: $*" >&2
exit 2
STUB_EOF

cat > "$WORK/stub-blkid" <<'STUB_EOF'
#!/bin/bash
# stub-blkid — liefert Werte aus STUB_BLKID_TYPE / STUB_BLKID_PTTYPE.
set -u
printf 'blkid %s\n' "$*" >> "${STUB_LOG:-/dev/null}"
field=""; prev=""
for arg in "$@"; do
  if [ "$prev" = "-s" ]; then field="$arg"; fi
  prev="$arg"
done
case "$field" in
  TYPE)   if [ -n "${STUB_BLKID_TYPE:-}" ]; then printf '%s\n' "$STUB_BLKID_TYPE"; exit 0; fi ;;
  PTTYPE) if [ -n "${STUB_BLKID_PTTYPE:-}" ]; then printf '%s\n' "$STUB_BLKID_PTTYPE"; exit 0; fi ;;
esac
exit 2
STUB_EOF
chmod +x "$WORK/stub-mdadm" "$WORK/stub-blkid"

# ---------------------------------------------------------------------------
# Fixtures (Struktur wie echte IMSM-mdstat; [4/3] = degraded, [4/4] = ok)
# ---------------------------------------------------------------------------
write_fixture() { cat > "$FIXTURES/$1"; }
write_fixture degraded <<'EOF'
Personalities : [raid10] 
md126 : active raid10 sdb[0] sdc[2] sdd[3]
      3907018752 blocks super external:/md127/0 512K chunks 2 near-copies [4/3] [UUU_]
      
md127 : active raid10 sda[1](S) sdb[0](S) sdc[2](S) sdd[3](S)
      7814037504 blocks super external:imsm
      
unused devices: <none>
EOF
write_fixture degraded_removed <<'EOF'
Personalities : [raid10] 
md126 : active raid10 sdb[0] sdc[2] sdd[3]
      3907018752 blocks super external:/md127/0 512K chunks 2 near-copies [4/3] [UUU_]
      
md127 : active raid10 sdb[0](S) sdc[2](S) sdd[3](S)
      7814037504 blocks super external:imsm
      
unused devices: <none>
EOF
write_fixture degraded_active <<'EOF'
Personalities : [raid10] 
md126 : active raid10 sda[1] sdb[0] sdc[2]
      2929693184 blocks super external:/md127/0 512K chunks 2 near-copies [4/3] [UUU_]
      
md127 : active raid10 sda[1](S) sdb[0](S) sdc[2](S) sdd[3](S)
      7814037504 blocks super external:imsm
      
unused devices: <none>
EOF
write_fixture clean <<'EOF'
Personalities : [raid10] 
md126 : active raid10 sda[1] sdb[0] sdc[2] sdd[3]
      3907018752 blocks super external:/md127/0 512K chunks 2 near-copies [4/4] [UUUU]
      
md127 : active raid10 sda[1](S) sdb[0](S) sdc[2](S) sdd[3](S)
      7814037504 blocks super external:imsm
      
unused devices: <none>
EOF
write_fixture rebuild <<'EOF'
Personalities : [raid10] 
md126 : active raid10 sdb[0] sdc[2] sdd[3]
      3907018752 blocks super external:/md127/0 512K chunks 2 near-copies [4/3] [UUU_]
      [>....................]  recovery =  4.2% (8388608/1999872) finish=160.3min speed=190K/sec
      
md127 : active raid10 sda[1](S) sdb[0](S) sdc[2](S) sdd[3](S)
      7814037504 blocks super external:imsm
      
unused devices: <none>
EOF
write_fixture nocontainer <<'EOF'
Personalities : [raid10] 
md126 : active raid10 sdb[0] sdc[2] sdd[3]
      2929693184 blocks super external:imsm 512K chunks 2 near-copies [4/3] [UUU_]
      
unused devices: <none>
EOF
write_fixture foreign_member <<'EOF'
Personalities : [raid10] 
md126 : active raid10 sdb[0] sdc[2] sdd[3] sdf[9]
      3907018752 blocks super external:/md127/0 512K chunks 2 near-copies [4/3] [UUU_]
      
md127 : active raid10 sdb[0](S) sdc[2](S) sdd[3](S)
      7814037504 blocks super external:imsm
      
unused devices: <none>
EOF

# ---------------------------------------------------------------------------
# Helfer-Aufruf
# ---------------------------------------------------------------------------
RC=0; OUT=""; ERR=""
STUB_BLKID_TYPE=""; STUB_BLKID_PTTYPE=""; STUB_MDADM_FAIL=""

run_helper() { # [fixture|-] args...
  local fixture="$1"; shift
  if [ "$fixture" != "-" ]; then cp "$FIXTURES/$fixture" "$WORK/mdstat"; fi
  : > "$WORK/mdadm.log"
  OUT="$(COCKPIT_DISK_ACTION_MDSTAT="$WORK/mdstat" \
         COCKPIT_DISK_ACTION_SYSBLOCK="$SYSBLOCK" \
         COCKPIT_DISK_ACTION_MDADM="$WORK/stub-mdadm" \
         COCKPIT_DISK_ACTION_BLKID="$WORK/stub-blkid" \
         STUB_MDSTAT="$WORK/mdstat" STUB_LOG="$WORK/mdadm.log" \
         STUB_BLKID_TYPE="$STUB_BLKID_TYPE" STUB_BLKID_PTTYPE="$STUB_BLKID_PTTYPE" \
         STUB_MDADM_FAIL="$STUB_MDADM_FAIL" \
         "$HELPER" "$@" 2>"$WORK/stderr")"
  RC=$?
  ERR="$(cat "$WORK/stderr")"
}

printf '== cockpit-disk-action Simulationsharness ==\n'
printf 'Helfer: %s\n' "$HELPER"

# ---------------------------------------------------------------------------
printf '\n-- usage/Argumente --\n'
run_helper degraded
assert_rc "ohne Argumente -> 64" 64
assert_err "ohne Argumente nennt usage" "usage"
run_helper degraded status extra
assert_rc "status mit Extra-Argument -> 64" 64
run_helper degraded fail sda
assert_rc "unbekanntes Subkommando -> 64" 64
run_helper degraded remove
assert_rc "remove ohne Gerät -> 64" 64
run_helper degraded remove /dev/sda1
assert_rc "Partition wird abgelehnt -> 65" 65
run_helper degraded remove sdaa
assert_rc "sd[a-z]-Format erzwungen -> 65" 65
run_helper degraded remove /dev/disk/by-id/foo
assert_rc "Pfade/symlinks abgelehnt -> 65" 65

# ---------------------------------------------------------------------------
printf '\n-- status --\n'
run_helper degraded status
assert_rc "status degraded -> 0" 0
assert_json "status liefert JSON" "$OUT"
assert_field "Container gemeldet" "$OUT" 'd["container_present"] is True and d["container_state"] == "active"'
assert_field "vier Container-Mitglieder" "$OUT" '[m["device"] for m in d["members"]] == ["sda","sdb","sdc","sdd"]'
assert_field "sda als vorhanden markiert" "$OUT" '[m["present"] for m in d["members"] if m["device"]=="sda"] == [True]'
assert_field "Volume degraded erkannt" "$OUT" 'd["volumes"][0]["degraded"] is True and d["volumes"][0]["total"] == 4 and d["volumes"][0]["active"] == 3'
assert_field "Volume-Mitglieder ohne sda" "$OUT" 'd["volumes"][0]["members"] == ["sdb","sdc","sdd"]'
run_helper clean status
assert_field "sauberes Volume nicht degraded" "$OUT" 'd["volumes"][0]["degraded"] is False and d["volumes"][0]["active"] == 4'
run_helper nocontainer status
assert_rc "status ohne Container -> 0" 0
assert_field "ohne Container leere Listen" "$OUT" 'd["container_present"] is False and d["members"] == [] and d["volumes"] == []'
COCKPIT_DISK_ACTION_MDSTAT="$WORK/gibt-es-nicht" "$HELPER" status >"$WORK/o" 2>"$WORK/e"; RC=$?
OUT="$(cat "$WORK/o")"; ERR="$(cat "$WORK/e")"
assert_rc "fehlende mdstat -> 67" 67
assert_err "fehlende mdstat gemeldet" "not readable"

# ---------------------------------------------------------------------------
# Sandbox-Anordnung: der Runner bindet die echte mdstat read-only auf einen
# neutralen Pfad und setzt COCKPIT_DISK_ACTION_MDSTAT dorthin. Der Helfer muss
# dann ausschließlich diese Datei lesen (nie /proc/mdstat) und normal arbeiten.
printf '\n-- Sandbox-Anordnung (neutraler mdstat-Pfad) --\n'
mkdir -p "$WORK/run-neutral"
cp "$FIXTURES/degraded" "$WORK/run-neutral/mdstat"
OUT="$(COCKPIT_DISK_ACTION_MDSTAT="$WORK/run-neutral/mdstat" \
       COCKPIT_DISK_ACTION_SYSBLOCK="$SYSBLOCK" \
       "$HELPER" status 2>"$WORK/stderr")"
RC=$?; ERR="$(cat "$WORK/stderr")"
assert_rc "neutraler mdstat-Pfad -> 0" 0
assert_json "neutraler Pfad liefert JSON" "$OUT"
assert_field "neutraler Pfad: vier Mitglieder" "$OUT" '[m["device"] for m in d["members"]] == ["sda","sdb","sdc","sdd"]'
assert_field "neutraler Pfad: Volume degraded" "$OUT" 'd["volumes"][0]["degraded"] is True and d["volumes"][0]["members"] == ["sdb","sdc","sdd"]'

# ---------------------------------------------------------------------------
if [ "$(id -u)" -eq 0 ]; then
  printf '\n-- remove --\n'
  run_helper degraded remove sde
  assert_rc "remove: kein Container-Mitglied -> 66" 66
  assert_err "remove nennt Mitgliedschaft" "not a member"
  run_helper degraded remove sdz
  assert_rc "remove: Gerät nicht vorhanden -> 66" 66
  assert_err "remove nennt fehlendes Gerät" "not present"
  run_helper degraded_active remove sda
  assert_rc "remove: degraded + aktives Mitglied -> 66" 66
  assert_err "remove nennt Ein-Platten-Regel" "already degraded"
  if [ -s "$WORK/mdadm.log" ]; then bad "refuse hat mdadm aufgerufen"; else ok "refuse ohne mdadm-Aufruf"; fi
  run_helper degraded remove sda
  assert_rc "remove: inaktives Mitglied -> 0" 0
  assert_json "remove liefert JSON" "$OUT"
  assert_field "members_after ohne sda" "$OUT" 'd["members_after"] == ["sdb","sdc","sdd"]'
  if grep -q "sda" "$WORK/mdstat"; then bad "sda noch in mdstat"; else ok "mdstat ohne sda"; fi
  run_helper - status
  assert_field "status nach remove: drei Mitglieder" "$OUT" 'len(d["members"]) == 3'
  STUB_MDADM_FAIL=1 run_helper degraded remove sda
  assert_rc "remove: mdadm-Fehler -> 69" 69
  STUB_MDADM_FAIL=""

  printf '\n-- add --\n'
  run_helper degraded add sda
  assert_rc "add: bereits Mitglied -> 66" 66
  assert_err "add nennt Mitgliedschaft" "already a member"
  run_helper rebuild add sde
  assert_rc "add: während Rebuild -> 66" 66
  assert_err "add nennt laufenden Rebuild" "rebuild/resync"
  run_helper degraded_removed add sdz
  assert_rc "add: Gerät nicht vorhanden -> 66" 66
  STUB_BLKID_TYPE="ext4" run_helper degraded_removed add sda
  assert_rc "add: Dateisystem -> 66" 66
  assert_err "add nennt Dateisystem" "filesystem or foreign metadata"
  STUB_BLKID_TYPE=""; STUB_BLKID_PTTYPE="dos"
  run_helper degraded_removed add sda
  assert_rc "add: Partitionstabelle -> 66" 66
  assert_err "add nennt Partitionstabelle" "partition table"
  STUB_BLKID_PTTYPE=""
  run_helper degraded_removed add sda
  assert_rc "add: leere Platte -> 0" 0
  assert_json "add liefert JSON" "$OUT"
  assert_field "members_after mit sda" "$OUT" 'd["members_after"] == ["sda","sdb","sdc","sdd"] or d["members_after"] == ["sdb","sdc","sdd","sda"]'
  assert_field "Rebuild wurde gemeldet" "$OUT" 'isinstance(d["volume_sync"], str) and "recovery" in d["volume_sync"]'
  STUB_BLKID_TYPE="isw_raid_member" run_helper degraded_removed add sda
  assert_rc "add: früheres IMSM-Mitglied -> 0" 0
  STUB_BLKID_TYPE=""
  STUB_MDADM_FAIL=1 run_helper degraded_removed add sda
  assert_rc "add: mdadm-Fehler -> 69" 69
  STUB_MDADM_FAIL=""
  run_helper foreign_member add sdf
  assert_rc "add: Mitglied eines anderen Arrays -> 66" 66
  assert_err "add nennt das andere Array" "already a member of md126"
else
  printf '\n-- remove/add übersprungen (kein root) --\n'
fi

# ---------------------------------------------------------------------------
printf '\n== Ergebnis: %d bestanden, %d fehlgeschlagen ==\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ] || exit 1
