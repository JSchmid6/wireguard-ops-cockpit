#!/usr/bin/env bash
# =============================================================================
# cockpit-borg-action.test.sh — Offline-Harness für den Borg-Helfer.
# -----------------------------------------------------------------------------
# Prüft den ORIGINALEN deploy/helpers/cockpit-borg-action ohne borgmatic, Borg
# oder ein Repo: borgmatic/systemctl/journalctl/curl sind PATH-Stubs, Sperr-,
# Log- und Statuspfade kommen über die COCKPIT_BORG_ACTION_*-Hooks in ein
# Wegwerf-Verzeichnis. Geprüft werden:
#   * die gepinnte Grammatik (kein Argument, unbekanntes Verb, --help),
#   * status im VPS-Fall (Timer, Journal, Archive, Repo-Kennzahlen, Kiste),
#   * status im Kiste-Fall (kein borgmatic: Repo-Verzeichnis + Mount),
#   * status bei unerreichbarem Repo (rc=2, repo_erreichbar: nein),
#   * dass /etc/borgmatic/config.yaml NIE im Ausgabestrom landet,
#   * check/repair: Ablehnung während borgmatic läuft (rc=3), Ablehnung bei
#     laufender Wartung (rc=3), Repair ohne borgmatic (rc=67), und der
#     abgesetzte Lauf selbst (Log wächst, Verb und Freigabe-Variable stimmen).
#
# Aufruf (braucht root wegen der Rechteprüfung des Helfers):
#   docker --context werkstatt run --rm \
#     --mount type=bind,src=<HOST-Pfad des Klons>,dst=/w,readonly \
#     bash:5 bash /w/test/cockpit-borg-action.test.sh
# =============================================================================
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
HELPER="$(cd "$HERE/.." && pwd)/deploy/helpers/cockpit-borg-action"
[ -f "$HELPER" ] || { echo "FEHLER: $HELPER nicht gefunden" >&2; exit 1; }

if [ "$(id -u)" -ne 0 ]; then
  echo "FEHLER: bitte als root ausführen (der Helfer prüft seine Rechte)." >&2
  exit 2
fi

WORK="$(mktemp -d /tmp/cockpit-borg-action-test.XXXXXX)"
trap 'rm -rf "$WORK"' EXIT
STUBS="$WORK/bin"; mkdir -p "$STUBS"
BASH_BIN="$(command -v bash)"   # im Prüf-Image liegt bash nicht unter /bin/bash

PASS=0; FAIL=0
ok()  { PASS=$((PASS + 1)); printf '  ok   %s\n' "$1"; }
bad() { FAIL=$((FAIL + 1)); printf '  FAIL %s\n' "$1"; }
assert_rc() { if [ "$RC" -eq "$2" ]; then ok "$1 (rc=$2)"; else bad "$1 (rc=$RC, erwartet $2)"; fi; }
assert_out() { if printf '%s' "$OUT" | grep -qF -- "$2"; then ok "$1"; else bad "$1 — Ausgabe ohne: $2"; fi; }
assert_no_out() { if printf '%s' "$OUT" | grep -qF -- "$2"; then bad "$1 — Ausgabe enthält unerwartet: $2"; else ok "$1"; fi; }
assert_err() { if printf '%s' "$ERR" | grep -qF -- "$2"; then ok "$1"; else bad "$1 — stderr ohne: $2"; fi; }

run_helper() { # alle Argumente an den Helfer
  # über `bash` gestartet: im Prüf-Image (bash:5) liegt bash nicht unter
  # /bin/bash, auf den Zielsystemen (Ubuntu) schon — der Shebang bleibt dort.
  OUT="$(PATH="$STUBS:$PATH" "$BASH_BIN" "$HELPER" "$@" 2>"$WORK/stderr")"; RC=$?
  ERR="$(cat "$WORK/stderr")"
}

# --- Fixtures ---------------------------------------------------------------
mkdir -p "$WORK/state" "$WORK/logs" "$WORK/repo/data"
printf '%s\n' "# borgmatic — Klartext-Zugangsdaten" "PASSWORD=GEHEIM" > "$WORK/config.yaml"
: > "$WORK/borgmatic-busy"          # existiert => borgmatic.service ist aktiv
FIXTURE_STATUS="$WORK/status.txt"
cat > "$FIXTURE_STATUS" <<'EOF'
DATE: 2026-09-27T23:09:42+02:00
LOAD: 11.73 12.23 12.57
FAILED: 4 units
FAILED-UNIT: ● coturn.service loaded failed failed coTURN STUN/TURN Server
MDSTAT:
md126 : active raid10 sda[4] sdb[2] sdc[1] sdd[0]
      5860528128 blocks super external:/md127/0 64K chunks 2 near-copies [4/4] [UUUU]
DF: /dev/md126      5,5T    4,7T  787G   86% /media/RAID
EOF

cat > "$STUBS/borgmatic" <<EOF
#!/usr/bin/env bash
echo "borgmatic \$*" >> "$WORK/borgmatic.log"
if [ -e "$WORK/state/fail-repo" ]; then echo "ssh: connect to host 10.0.0.5 port 22: Connection refused" >&2; exit 2; fi
case "\$*" in
  *" list --last 5"*) printf '%s\n' "home_server: Listing archives" "vmd61162-2026-09-27T02:40:56.874046  Sun, 2026-09-27 02:41:08" ;;
  *" info --last 1"*) printf '%s\n' "Archive name: vmd61162-2026-09-27T02:40:56.874046" "Duration: 8 minutes 26.47 seconds" "All archives:                3.52 TB              3.37 TB            581.67 GB" ;;
  *" check --repair --force"*) printf 'REPAIR run marker env=%s\n' "\${BORG_CHECK_I_KNOW_WHAT_I_AM_DOING:-unset}" >> "$WORK/repo/data/repair.run"; sleep 0.2 ;;
  *" check"*) printf '%s\n' "CHECK run marker" >> "$WORK/repo/data/check.run"; sleep 0.2 ;;
esac
exit 0
EOF

cat > "$STUBS/systemctl" <<EOF
#!/usr/bin/env bash
unit=""
for a in "\$@"; do case "\$a" in borgmatic.service|borgmatic.timer) unit="\$a" ;; esac; done
case "\$1" in
  is-active) case "\$unit" in
      borgmatic.service) [ -e "$WORK/borgmatic-busy" ] && { echo active; exit 0; }; echo inactive; exit 3 ;;
      borgmatic.timer) echo active; exit 0 ;;
    esac; echo inactive; exit 3 ;;
  list-timers) printf '%s\n' "NEXT                         LEFT     LAST                         PASSED UNIT            ACTIVATES" "Mon 2026-09-28 02:26:08 CEST 3h 10min Sun 2026-09-27 02:39:04 CEST 20h ago borgmatic.timer borgmatic.service" ;;
esac
exit 0
EOF

cat > "$STUBS/journalctl" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "2026-09-27T02:39:04+02:00 vmd61162 borgmatic[123]: Starting borgmatic" "2026-09-27T02:49:36+02:00 vmd61162 borgmatic[123]: Finished borgmatic in 8 minutes" "2026-09-27T02:49:36+02:00 vmd61162 systemd[1]: borgmatic.service: Succeeded."
exit 0
EOF

cat > "$STUBS/curl" <<EOF
#!/usr/bin/env bash
cat "$FIXTURE_STATUS"
EOF
chmod 755 "$STUBS"/*

export PATH="$STUBS:$PATH"
export COCKPIT_BORG_ACTION_LOCK="$WORK/borg.lock"
export COCKPIT_BORG_ACTION_LOGDIR="$WORK/logs"
export COCKPIT_BORG_ACTION_STATE_DIR="$WORK/state"
export COCKPIT_BORG_ACTION_CONFIG="$WORK/config.yaml"
export COCKPIT_BORG_ACTION_KISTE_URL="http://10.0.0.5:8088/status.txt"
export COCKPIT_BORG_ACTION_KISTE_REPO="$WORK/repo"

echo "== Grammatik =="
run_helper; assert_rc "kein Argument wird abgelehnt" 64; assert_err "Usage auf stderr" "cockpit-borg-action"
run_helper bogus; assert_rc "unbekanntes Verb wird abgelehnt" 64
run_helper status extra; assert_rc "zweites Argument wird abgelehnt" 64

echo "== status (VPS) =="
run_helper status
assert_rc "status läuft durch" 0
assert_out "Rolle erkannt" "Rolle: VPS"
assert_out "Timerzustand" "Timer: active"
assert_out "Journalzeile" "borgmatic.service: Succeeded."
assert_out "Archivliste" "vmd61162-2026-09-27T02:40:56.874046"
assert_out "Repo-Kennzahlen" "All archives:"
assert_out "Repo erreichbar" "repo_erreichbar: ja"
assert_out "Kiste: Array vollständig" "Array vollständig (4/4, [UUUU])"
assert_out "Kiste: Platz" "86% /media/RAID"
assert_no_out "Konfigdatei bleibt draussen" "GEHEIM"

echo "== status (Repo unerreichbar) =="
: > "$WORK/state/fail-repo"
run_helper status
assert_rc "unerreichbares Repo meldet rc=2" 2
assert_out "Repo nicht erreichbar" "repo_erreichbar: nein"
rm -f "$WORK/state/fail-repo"

echo "== status (Kiste, kein borgmatic) =="
# borgmatic wird über einen PATH ohne borgmatic-Stub ausgeblendet (die Kiste hat
# keins); systemctl/journalctl/curl bleiben sichtbar.
mkdir -p "$WORK/kiste-bin"
for tool in systemctl journalctl curl; do ln -sf "$STUBS/$tool" "$WORK/kiste-bin/$tool"; done
OUT="$(PATH="$WORK/kiste-bin:/usr/bin:/bin" COCKPIT_BORG_ACTION_LOCK="$WORK/borg.lock" \
  COCKPIT_BORG_ACTION_LOGDIR="$WORK/logs" COCKPIT_BORG_ACTION_STATE_DIR="$WORK/state" \
  COCKPIT_BORG_ACTION_CONFIG="$WORK/config.yaml" COCKPIT_BORG_ACTION_KISTE_REPO="$WORK/repo" \
  COCKPIT_BORG_ACTION_KISTE_URL="http://10.0.0.5:8088/status.txt" "$BASH_BIN" "$HELPER" status 2>"$WORK/stderr")"; RC=$?
ERR="$(cat "$WORK/stderr")"
assert_rc "status auf der Kiste läuft durch" 0
assert_out "Rolle Kiste" "Rolle: Kiste"
assert_out "Repo-Verzeichnis vorhanden" "vorhanden: ja"
assert_out "jüngstes Segment" "jüngstes Datensegment:"
assert_out "Mountzeile der Kiste" "/media/RAID"

echo "== check/repair =="
: > "$WORK/borgmatic-busy"
OUT="$(PATH="$WORK/kiste-bin:/usr/bin:/bin" COCKPIT_BORG_ACTION_LOCK="$WORK/borg.lock" \
  COCKPIT_BORG_ACTION_LOGDIR="$WORK/logs" COCKPIT_BORG_ACTION_STATE_DIR="$WORK/state" \
  COCKPIT_BORG_ACTION_CONFIG="$WORK/config.yaml" COCKPIT_BORG_ACTION_KISTE_REPO="$WORK/repo" \
  "$BASH_BIN" "$HELPER" repair 2>"$WORK/stderr")"; RC=$?
ERR="$(cat "$WORK/stderr")"
assert_rc "repair ohne borgmatic (Kiste) wird abgewiesen" 67
assert_err "Grund genannt (VPS nötig)" "check/repair laufen auf dem VPS"
run_helper check
assert_rc "check während borgmatic läuft wird abgewiesen" 3
assert_err "Grund genannt" "nächtliches Backup"
rm -f "$WORK/borgmatic-busy"

sleep 60 & SLEEP_PID=$!
printf '%s\n' "$SLEEP_PID" > "$WORK/state/last.pid"
printf '%s\n' "check" > "$WORK/state/last.kind"
run_helper check
assert_rc "check bei laufender Wartung wird abgewiesen" 3
assert_err "Grund genannt (PID)" "es läuft bereits eine Wartung"
run_helper status
assert_out "status zeigt die laufende Wartung" "läuft: ja"
kill "$SLEEP_PID" 2>/dev/null
rm -f "$WORK/state/last.pid" "$WORK/state/last.kind"

run_helper check
assert_rc "check startet den abgesetzten Lauf" 0
assert_out "Kommando benannt" "gestartet: borgmatic --verbosity 1 check"
sleep 1
[ -f "$WORK/repo/data/check.run" ] && ok "abgesetzter check hat wirklich gelaufen" || bad "abgesetzter check lief nicht"

run_helper repair
assert_rc "repair startet den abgesetzten Lauf" 0
assert_out "Repair-Form benannt" "--repair --force"
sleep 1
if grep -q "env=YES" "$WORK/repo/data/repair.run" 2>/dev/null; then
  ok "repair setzt BORG_CHECK_I_KNOW_WHAT_I_AM_DOING=YES"
else
  bad "repair ohne Freigabe-Variable: $(cat "$WORK/repo/data/repair.run" 2>/dev/null)"
fi

echo
printf 'bestanden: %s, fehlgeschlagen: %s\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
