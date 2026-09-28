#!/usr/bin/env bash
# =============================================================================
# borg-status.test.sh — Offline-Harness für bin/borg-status.sh.
# -----------------------------------------------------------------------------
# Prüft den lesenden Katalog-Einstieg ohne Netz, ohne systemd, ohne Journal und
# ohne Rechte: curl, systemctl und journalctl sind PATH-Stubs, die jeden Aufruf
# protokollieren und feste Ausgaben liefern. Damit ist belegbar,
#   * dass das Skript keine Argumente annimmt (rc=64) und ohne Argumente läuft,
#   * dass es die drei Quellen abfragt (Statusdatei, systemd, Journal),
#   * dass es bei unerreichbarer Kiste und unlesbarem Journal weiterläuft (rc=0)
#     und den Grund nennt — eine lesende Anzeige scheitert nicht,
#   * dass es KEIN sudo, KEINEN Borg-Helfer und KEIN Verb aufruft
#     (Aufrufprotokoll + Quelltextprüfung): der Shell-Weg zum Repair existiert
#     damit nicht,
#   * dass es nichts startet (nur is-active / list-timers / Journal lesen).
#
# Aufruf (aus dem Hermes-Container über den Austauschordner):
#   docker --context werkstatt run --rm -v /austausch/<klon>:/w:ro \
#     bash:5 bash /w/test/borg-status.test.sh
# =============================================================================
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"
SCRIPT="$REPO/bin/borg-status.sh"
[ -f "$SCRIPT" ] || { echo "FEHLER: $SCRIPT nicht gefunden" >&2; exit 1; }

WORK="$(mktemp -d /tmp/borg-status-test.XXXXXX)"
trap 'rm -rf "$WORK"' EXIT
STUBS="$WORK/bin"
mkdir -p "$STUBS"
CALLLOG="$WORK/calls.log"
: > "$CALLLOG"
BASH_BIN="$(command -v bash)"

PASS=0; FAIL=0
ok()  { PASS=$((PASS + 1)); printf '  ok   %s\n' "$1"; }
bad() { FAIL=$((FAIL + 1)); printf '  FAIL %s\n' "$1"
  if [ "${HARNESS_DEBUG:-0}" = "1" ]; then
    printf '  ---- Ausgabe ----\n%s\n' "${OUT:-}"
    printf '  ---- stderr ----\n%s\n' "${ERR:-}"
    printf '  ---- Aufrufe ----\n%s\n' "$(cat "$CALLLOG")"
  fi
}
assert_rc()  { if [ "$RC" -eq "$2" ]; then ok "$1 (rc=$2)"; else bad "$1 (rc=$RC, erwartet $2)"; fi; }
assert_out() { if printf '%s' "$OUT" | grep -qF -- "$2"; then ok "$1"; else bad "$1 — Ausgabe ohne: $2"; fi; }
assert_no_out() { if printf '%s' "$OUT" | grep -qF -- "$2"; then bad "$1 — Ausgabe enthält unerwartet: $2"; else ok "$1"; fi; }
assert_err() { if printf '%s' "$ERR" | grep -qF -- "$2"; then ok "$1"; else bad "$1 — stderr ohne: $2"; fi; }
assert_calls_absent() { if grep -qE -- "$2" "$CALLLOG"; then bad "$1 — Aufruf gefunden: $(grep -E -- "$2" "$CALLLOG" | head -3 | tr '\n' ' ')"; else ok "$1"; fi; }

# --- Stubs ------------------------------------------------------------------
cat > "$STUBS/curl" <<EOF
#!/usr/bin/env bash
printf 'curl %s\n' "\$*" >> "$CALLLOG"
if [ "\${CURL_FAIL:-0}" = "1" ]; then
  printf 'curl: (7) Failed to connect to 10.0.0.5 port 8088\n' >&2
  exit 7
fi
cat "$WORK/status.txt"
exit 0
EOF

cat > "$STUBS/systemctl" <<EOF
#!/usr/bin/env bash
printf 'systemctl %s\n' "\$*" >> "$CALLLOG"
case "\$1" in
  is-active) printf 'active\n' ;;
  list-timers)
    printf 'NEXT                          LEFT   LAST                           PASSED  UNIT            ACTIVATES\n'
    printf 'Tue 2026-09-29 01:53:08 CEST  15h    Mon 2026-09-28 02:28:41 CEST   7h ago  borgmatic.timer borgmatic.service\n'
    ;;
  *) : ;;
esac
exit 0
EOF

cat > "$STUBS/journalctl" <<EOF
#!/usr/bin/env bash
printf 'journalctl %s\n' "\$*" >> "$CALLLOG"
if [ "\${JOURNAL_FAIL:-0}" = "1" ]; then
  printf -- '-- No journal files were found.\n' >&2
  exit 1
fi
printf '2026-09-28T02:28:41+02:00 vmd61162 borgmatic[1234]: home_server: Backup creation successful\n'
exit 0
EOF

for stub in curl systemctl journalctl; do chmod +x "$STUBS/$stub"; done

cat > "$WORK/status.txt" <<'EOF'
DATE: 2026-09-28T08:00:01+02:00
MDSTAT:
md126 : active raid10 sda[4] sdb[2] sdc[1] sdd[0]
      5860528128 blocks super external:/md127/0 64K chunks 2 near-copies [4/4] [UUUU]
DF: /dev/md126      5,5T    4,7T  787G   86% /media/RAID
BORG: backup_VServer/borg  letzte Aenderung 2026-09-28T02:59:12+02:00
EOF

run_status() { # run_status [ENV=WERT …] -- [Argumente …]
  local envs=()
  while [ "$#" -gt 0 ] && [ "$1" != "--" ]; do envs+=("$1"); shift; done
  [ "${1:-}" = "--" ] && shift
  : > "$CALLLOG"
  OUT="$(PATH="$STUBS:$PATH" env "${envs[@]}" "$BASH_BIN" "$SCRIPT" "$@" 2>"$WORK/stderr")"; RC=$?
  ERR="$(cat "$WORK/stderr")"
}

printf '\n== borg-status.sh: lesender Katalog-Einstieg ==\n'

# 1. Grammatik: keine Argumente
run_status -- status
assert_rc "Argument wird abgelehnt" 64
assert_err "Grund genannt" "nimmt keine Argumente"

# 2. Normalfall: alle drei Quellen
run_status --
assert_rc "Lauf ohne Argumente ist grün" 0
assert_out "Kisten-Statusdatei erscheint" "md126 : active raid10"
assert_out "Plattenplatz erscheint" "86% /media/RAID"
assert_out "Timer-Zeile erscheint" "borgmatic.timer"
assert_out "Dienstzustand erscheint" "borgmatic.service: active"
assert_out "Journal-Zeile erscheint" "Backup creation successful"
assert_out "Verweis auf borg.status" "borg.status"
assert_out "Verweis auf borg.check" "borg.check"
assert_out "Verweis auf die Repair-Freigabe" "borg.repair"
assert_out "Kopfzeile nennt die Leserolle" "Unprivilegierter Katalog-Einstieg"
assert_calls_absent "kein sudo im Aufrufprotokoll" '(^sudo| sudo )'
assert_calls_absent "kein Borg-Helfer im Aufrufprotokoll" 'cockpit-borg-action'
assert_calls_absent "kein Verb check/repair im Aufrufprotokoll" ' (check|repair)([[:space:]]|$)'
assert_calls_absent "kein start/stop/restart/enable/disable" 'systemctl (start|stop|restart|enable|disable)'
assert_calls_absent "kein systemd-run" 'systemd-run'

# 3. Kiste nicht erreichbar: Grund nennen, weiterlaufen
run_status CURL_FAIL=1 --
assert_rc "unerreichbare Kiste beendet den Lauf nicht" 0
assert_out "Grund der Kiste genannt" "nicht abrufbar"
assert_out "Journal-Abschnitt trotzdem da" "Journal (borgmatic.service"

# 4. Journal unlesbar (keine Rechte): Grund nennen, weiterlaufen
run_status JOURNAL_FAIL=1 --
assert_rc "unlesbares Journal beendet den Lauf nicht" 0
assert_out "Grund des Journals genannt" "Journal nicht lesbar"
assert_out "Kiste wird trotzdem gezeigt" "md126 : active raid10"

# 5. Quelltext: keine privilegierten Wege im Skript selbst (Kommentare zählen
#    nicht mit — sie erklären die Grenzen und nennen sudo und den Helfer).
CODE="$(grep -vE '^[[:space:]]*#' "$SCRIPT")"
if printf '%s\n' "$CODE" | grep -qE '(^|[^[:alnum:]_])sudo([^[:alnum:]_]|$)'; then
  bad "Skript enthält sudo"
else
  ok "Skript enthält kein sudo"
fi
if printf '%s\n' "$CODE" | grep -qE 'cockpit-borg-action|systemd-run'; then
  bad "Skript ruft einen privilegierten Helfer auf"
else
  ok "Skript ruft keinen privilegierten Helfer auf"
fi
if printf '%s\n' "$CODE" | grep -qE '^[[:space:]]*(sudo|borg|borgmatic|systemd-run)[[:space:]]'; then
  bad "Skript startet borgmatic/borg direkt"
else
  ok "Skript startet borgmatic/borg nicht direkt"
fi

printf '\nbestanden: %s, fehlgeschlagen: %s\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
