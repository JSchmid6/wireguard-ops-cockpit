#!/usr/bin/env bash
# =============================================================================
# cockpit-borg-action.test.sh — Offline-Harness für den Borg-Helfer.
# -----------------------------------------------------------------------------
# Prüft den ORIGINALEN deploy/helpers/cockpit-borg-action ohne borgmatic, Borg,
# systemd oder ein Repo: borgmatic/systemctl/journalctl/systemd-run/curl sind
# PATH-Stubs, Sperr-, Zustands- und Statuspfade kommen über die
# COCKPIT_BORG_ACTION_*-Hooks in ein Wegwerf-Verzeichnis. Der systemd-run-Stub
# bildet die Unit-Semantik nach, die der Helfer benutzt: `--wait --pipe --collect`
# läuft im Vordergrund und gibt den Rückgabecode der Nutzlast weiter; ein Start
# ohne `--wait` läuft abgesetzt weiter und ist "aktiv", solange keine
# rc-Datei existiert (so wie systemd eine Unit mit --collect erst nach dem Ende
# abräumt).
#
# Geprüft werden:
#   * die gepinnte Grammatik (kein Argument, unbekanntes Verb, Extra-Argument,
#     Payload-Verben nur aus der eigenen Unit),
#   * status im VPS-Fall über eine eigene Unit (--wait --pipe --collect),
#     inklusive Frist-, Timer- und Journalangaben,
#   * status im Kiste-Fall (kein borgmatic: Repo-Verzeichnis + Mount),
#   * status bei unerreichbarem Repo (rc=2 durch die Unit hindurch),
#   * status bei belegtem Repo: Backup oder Wartungs-Unit aktiv => keine
#     list/info-Abfrage, "repo: belegt", rc=0 (Befund B4),
#   * dass /etc/borgmatic/config.yaml NIE im Ausgabestrom landet,
#   * check mit --force (Befund B2) und repair mit --repair --force + Freigabe,
#   * check/repair als benannte Unit ohne Warten, Laufzustand über die Unit und
#     ihr Journal statt PID-Datei (Befund B1),
#   * Ablehnung während borgmatic läuft, bei laufender Wartungs-Unit und bei
#     belegter Sperre (rc=3),
#   * die Fristprüfung gegen den nächsten borgmatic.timer-Lauf (Befund B3, R1):
#     die Zeit kommt als Zahl aus `systemctl list-timers --output=json`, dazu das
#     CEST-Beispiel aus dem Review mit festgelegtem „jetzt", fail closed bei
#     `null`, leerer Liste und unlesbarem Wert, inaktiver Timer ohne Frist,
#   * Nice=10 und IOSchedulingClass=idle auf den check/repair-Units (R3) — und
#     nicht auf der kurzen status-Abfrage,
#   * check/repair ohne borgmatic (Kiste) => rc=67, Startfehler => rc=69.
#
# Aufruf (braucht root wegen der Rechteprüfung des Helfers):
#   docker --context werkstatt run --rm \
#     --mount type=bind,src=<HOST-Pfad des Klons>,dst=/w,readonly \
#     bash:5 bash /w/test/cockpit-borg-action.test.sh
#
# Aus dem Hermes-Container derselbe Lauf über den Austauschordner (die Werkstatt
# sieht ihn unter /austausch), bash:5 oder ubuntu:24.04 — beide grün:
#   docker --context werkstatt run --rm -v /austausch/<klon>:/w:ro \
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
STUBS="$WORK/bin"; mkdir -p "$STUBS" "$WORK/units"
BASH_BIN="$(command -v bash)"   # im Prüf-Image liegt bash nicht unter /bin/bash

# Die Unit startet den Helfer direkt (Shebang #!/bin/bash). Auf den Zielsystemen
# (Ubuntu) liegt bash dort auch — im Prüf-Image nicht, also nachlegen, damit der
# Unit-Start wirklich denselben Weg nimmt wie in Produktion.
if [ ! -x /bin/bash ]; then
  mkdir -p /bin
  ln -sf "$BASH_BIN" /bin/bash
fi
PREFIX="cockpit-borg"           # Unit-Präfix wie in Produktion (Vorgabe im Helfer)

PASS=0; FAIL=0
ok()  { PASS=$((PASS + 1)); printf '  ok   %s\n' "$1"; }
bad() { FAIL=$((FAIL + 1)); printf '  FAIL %s\n' "$1"
  if [ "${HARNESS_DEBUG:-0}" = "1" ]; then
    printf '  ---- letzte Helfer-Ausgabe ----\n%s\n' "$(printf '%s' "${OUT:-}" | head -n 40)"
    printf '  ---- letzte Helfer-Fehlerausgabe ----\n%s\n' "$(printf '%s' "${ERR:-}" | head -n 20)"
    printf '  ---- Units ----\n%s\n' "$(ls -1 "$WORK/units" 2>/dev/null | tr '\n' ' ')"
    for f in "$WORK"/units/*.log; do
      [ -f "$f" ] || continue
      printf '  ---- Unit-Log %s ----\n%s\n' "$(basename "$f")" "$(cat "$f")"
    done
  fi
}
assert_rc() { if [ "$RC" -eq "$2" ]; then ok "$1 (rc=$2)"; else bad "$1 (rc=$RC, erwartet $2)"; fi; }
assert_out() { if printf '%s' "$OUT" | grep -qF -- "$2"; then ok "$1"; else bad "$1 — Ausgabe ohne: $2"; fi; }
assert_no_out() { if printf '%s' "$OUT" | grep -qF -- "$2"; then bad "$1 — Ausgabe enthält unerwartet: $2"; else ok "$1"; fi; }
assert_err() { if printf '%s' "$ERR" | grep -qF -- "$2"; then ok "$1"; else bad "$1 — stderr ohne: $2"; fi; }
assert_file() { if [ -f "$2" ]; then ok "$1"; else bad "$1 — fehlt: $2"; fi; }
assert_no_file() { if [ -e "$2" ]; then bad "$1 — existiert: $2"; else ok "$1"; fi; }

run_helper() { # alle Argumente an den Helfer
  # über `bash` gestartet: im Prüf-Image (bash:5) liegt bash nicht unter
  # /bin/bash, auf den Zielsystemen (Ubuntu) schon — der Shebang bleibt dort.
  OUT="$(PATH="$STUBS:$PATH" "$BASH_BIN" "$HELPER" "$@" 2>"$WORK/stderr")"; RC=$?
  ERR="$(cat "$WORK/stderr")"
}

run_helper_env() { # run_helper_env VAR=WERT [VAR=WERT …] -- <Argumente…>
  local envs=()
  while [ "$#" -gt 0 ] && [ "$1" != "--" ]; do envs+=("$1"); shift; done
  [ "$1" = "--" ] && shift
  OUT="$(PATH="$STUBS:$PATH" env "${envs[@]}" "$BASH_BIN" "$HELPER" "$@" 2>"$WORK/stderr")"; RC=$?
  ERR="$(cat "$WORK/stderr")"
}

run_helper_clock() { # wie run_helper_env, aber mit festgelegtem „jetzt“ (R1)
  local envs=()
  while [ "$#" -gt 0 ] && [ "$1" != "--" ]; do envs+=("$1"); shift; done
  [ "$1" = "--" ] && shift
  OUT="$(PATH="$WORK/clock:$STUBS:$PATH" env "${envs[@]}" "$BASH_BIN" "$HELPER" "$@" 2>"$WORK/stderr")"; RC=$?
  ERR="$(cat "$WORK/stderr")"
}

wait_for_file() { # wait_for_file <pfad> [sekunden]
  local i limit="${2:-60}"
  for _ in $(seq 1 "$limit"); do [ -e "$1" ] && return 0; sleep 0.1; done
  return 1
}

wait_for_rc_file() { # wait_for_rc_file <unit> — bis die Unit abgeräumt ist
  wait_for_file "$WORK/units/$1.rc" "${2:-100}"
}

# --- Fixtures ---------------------------------------------------------------
mkdir -p "$WORK/state" "$WORK/repo/data"
printf '%s\n' "# borgmatic — Klartext-Zugangsdaten" "PASSWORD=GEHEIM" > "$WORK/config.yaml"
# Marker: dieser Host hat borgmatic (der VPS). Die Kiste-Prüfung nimmt ihn weg —
# dort gibt es weder Dienst noch Journal, und der Datenblock muss das "unbekannt"
# nennen statt eines erfundenen Erfolgs.
: > "$WORK/borgmatic-here"
# borgmatic.service gilt als aktiv, solange "$WORK/borgmatic-busy" existiert; die
# Tests setzen die Datei dort, wo das nächtliche Backup laufen soll.
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
# Frist bis zum nächsten Timer-Lauf: der Helfer liest `systemctl list-timers
# --output=json`. Dort steht `next` in Mikrosekunden seit der Epoche (systemd
# 255), `null`, wenn kein nächster Lauf feststeht. Der Stub gibt genau diese Form
# aus — die alten Wanduhr-Formen „Tue 2026-09-29 01:53:08 CEST“ gibt es hier
# bewusst nicht mehr.
NOW="$(date -u +%s)"
timer_json() { # timer_json <next-Wert>: Mikrosekunden, null, [] oder Unsinn
  printf '[{"next":%s,"left":%s,"last":1780017744000000,"passed":1780017744000000,"unit":"borgmatic.timer","activates":"borgmatic.service"}]\n' \
    "$1" "$1" > "$WORK/list-timers.json"
}
timer_usec() { printf '%s\n' "$(( $1 * 1000000 ))"; }
timer_json "$(timer_usec "$(( NOW + 16 * 3600 ))")"

# Uhr des Helfers: nur `date -u +%s` wird auf $WORK/fake-now festgelegt, alles
# andere geht an das echte date. Die CEST-Probe (R1) ist ein fester Zeitpunkt und
# braucht ein festes „jetzt"; die übrigen Proben rechnen relativ zu NOW.
REAL_DATE="$(command -v date)"
mkdir -p "$WORK/clock"
cat > "$WORK/clock/date" <<CLOCK
#!/bin/sh
[ "\$*" = "-u +%s" ] && [ -f "$WORK/fake-now" ] && { cat "$WORK/fake-now"; exit 0; }
exec "$REAL_DATE" "\$@"
CLOCK
chmod 755 "$WORK/clock/date"
# Das Beispiel aus dem Review als Epoche: „Tue 2026-09-29 01:53:08 CEST“ ist
# 2026-09-28 23:53:08 UTC = 1790639588 s.
CEST_NEXT=1790639588
fake_now() { # fake_now <Epoche> — „jetzt“ für den Helfer festlegen
  printf '%s\n' "$1" > "$WORK/fake-now"
}

cat > "$STUBS/borgmatic" <<EOF
#!/usr/bin/env bash
echo "borgmatic \$*" >> "$WORK/borgmatic.log"
case "\$*" in
  *" list --last 5"*|*" info --last 1"*)
    if [ -e "$WORK/state/fail-repo" ]; then
      echo "ssh: connect to host 10.0.0.5 port 22: Connection refused" >&2
      exit 2
    fi
    ;;
esac
case "\$*" in
  *" list --last 5"*) printf '%s\n' "home_server: Listing archives" "vmd61162-2026-09-27T02:40:56.874046  Sun, 2026-09-27 02:41:08" ;;
  *" info --last 1"*) printf '%s\n' "Archive name: vmd61162-2026-09-27T02:40:56.874046" "Duration: 8 minutes 26.47 seconds" "All archives:                3.52 TB              3.37 TB            581.67 GB" ;;
  *"check"*"--repair"*) printf 'REPAIR args=%s env=%s\n' "\$*" "\${BORG_CHECK_I_KNOW_WHAT_I_AM_DOING:-unset}" >> "$WORK/repo/data/repair.run" ;;
  *"check"*) printf 'CHECK args=%s env=%s\n' "\$*" "\${BORG_CHECK_I_KNOW_WHAT_I_AM_DOING:-unset}" >> "$WORK/repo/data/check.run" ;;
esac
[ -e "$WORK/hold-check" ] && sleep 6
exit 0
EOF

# Fixture: Journal des borgmatic-Dienstes in der Form `-o short-iso` (so liest es
# der VPS). Enthält bewusst beides: den übersprungenen Konsistenz-Check des
# nächtlichen Laufs (borgmatic fährt ihn nur nach seiner Frequenz — deshalb ist
# "kein Check" kein grüner Check) und eine ältere CRITICAL-Zeile eines echten
# fehlgeschlagenen Checks. Tests, die den roten Fall wollen, überschreiben die
# Fixture über $WORK/journal-borgmatic.txt.
cat > "$WORK/journal-borgmatic.default" <<'EOF'
2026-09-21T03:45:06+02:00 vmd61162 borgmatic[456]: CRITICAL Command 'borg check --glob-archives {hostname}-* --info ssh://borg@10.0.0.5/media/RAID/backup_VServer/borg' returned non-zero exit status 2.
2026-09-27T02:39:04+02:00 vmd61162 systemd[1]: Starting borgmatic.service - borgmatic backup...
2026-09-27T02:49:36+02:00 vmd61162 borgmatic[123]: INFO home_server: Running consistency checks
2026-09-27T02:49:36+02:00 vmd61162 borgmatic[123]: INFO Skipping archives check due to configured frequency; 25 days, 1:21:54.018526 until next check (use --force to check anyway)
2026-09-27T02:49:36+02:00 vmd61162 systemd[1]: Finished borgmatic.service - borgmatic backup.
2026-09-27T02:49:36+02:00 vmd61162 systemd[1]: borgmatic.service: Succeeded.
EOF

# _payload-run: führt eine gestartete (nicht wartende) Unit aus und schreibt
# ihren Rückgabecode weg — damit ist "aktiv" = "noch keine rc-Datei".
cat > "$STUBS/_payload-run" <<EOF
#!/usr/bin/env bash
unit="\$1"; shift
rc=0
"\$@" || rc=\$?
printf '%s\n' "\$rc" > "$WORK/units/\$unit.rc"
exit 0
EOF

cat > "$STUBS/systemd-run" <<EOF
#!/usr/bin/env bash
# systemd-run-Stub: --wait läuft im Vordergrund und gibt den Rückgabecode der
# Nutzlast weiter (wie --wait --pipe), ohne --wait läuft die Nutzlast abgesetzt.
UNITDIR="$WORK/units"
printf '%s\n' "\$*" >> "$WORK/systemd-run.log"
unit=""; wait=0; seen_sep=0
payload=(); setenvs=()
for a in "\$@"; do
  if [ "\$seen_sep" -eq 1 ]; then payload+=("\$a"); continue; fi
  case "\$a" in
    --) seen_sep=1 ;;
    --wait) wait=1 ;;
    --unit=*) unit="\${a#--unit=}" ;;
    --setenv=*) setenvs+=("\${a#--setenv=}") ;;
  esac
done
[ -n "\$unit" ] || { echo "systemd-run-Stub: Aufruf ohne --unit" >&2; exit 99; }
for kv in \${setenvs[@]+"\${setenvs[@]}"}; do export "\$kv"; done
if [ "\$wait" -eq 1 ]; then
  out="\$(mktemp)"; err="\$(mktemp)"
  "\${payload[@]}" >"\$out" 2>"\$err"; rc=\$?
  cat "\$err" >>"\$UNITDIR/\$unit.log"; cat "\$out" >>"\$UNITDIR/\$unit.log"
  printf '%s\n' "\$rc" > "\$UNITDIR/\$unit.rc"
  cat "\$err" >&2; cat "\$out"
  rm -f "\$out" "\$err"
  exit "\$rc"
fi
setsid "$STUBS/_payload-run" "\$unit" "\${payload[@]}" </dev/null >>"\$UNITDIR/\$unit.log" 2>&1 &
exit 0
EOF

cat > "$STUBS/systemctl" <<EOF
#!/usr/bin/env bash
UNITDIR="$WORK/units"
cmd="\$1"; shift || true
case "\$cmd" in
  is-active)
    quiet=0; unit=""
    for a in "\$@"; do case "\$a" in --quiet|-q) quiet=1 ;; -*) ;; *) unit="\$a" ;; esac; done
    case "\$unit" in
      borgmatic.service)
        if [ -e "$WORK/borgmatic-busy" ]; then state=active; rc=0; else state=inactive; rc=3; fi ;;
      borgmatic.timer)
        if [ -e "$WORK/timer-off" ]; then state=inactive; rc=3; else state=active; rc=0; fi ;;
      *)
        if [ -f "\$UNITDIR/\${unit%.service}.rc" ]; then
          [ "\$(cat "\$UNITDIR/\${unit%.service}.rc")" = 0 ] && state=inactive || state=failed
          rc=3
        else
          state=active; rc=0
        fi ;;
    esac
    [ "\$quiet" -eq 1 ] || echo "\$state"
    exit "\$rc" ;;
  list-timers)
    # Der Weg der Fristprüfung (R1) ist `--output=json`; der Aufruf wird
    # protokolliert, damit die Prüfung ihn belegen kann. Ohne --output=json bleibt
    # die menschliche Tabelle für `status`.
    case " \$* " in
      *" --output=json "*)
        printf '%s\n' "list-timers \$*" >> "$WORK/list-timers.log"
        cat "$WORK/list-timers.json" 2>/dev/null || true
        exit 0 ;;
    esac
    printf '%s\n' "NEXT                         LEFT     LAST                         PASSED UNIT            ACTIVATES" "Mon 2026-09-28 02:26:08 CEST 3h 10min Sun 2026-09-27 02:39:04 CEST 20h ago borgmatic.timer borgmatic.service"
    exit 0 ;;
  show)
    # `systemctl show <unit> -p Result -p ExecMainStatus`: genau die zwei Werte,
    # die der Datenblock für den letzten Backup-Lauf übernimmt. Über
    # \$WORK/borgmatic-failed lässt sich ein fehlgeschlagener Lauf nachstellen.
    unit=""
    while [ "\$#" -gt 0 ]; do
      case "\$1" in
        -p|--property) shift 2 ;;
        -*) shift ;;
        *) unit="\$1"; shift ;;
      esac
    done
    case "\$unit" in
      borgmatic.service)
        [ -f "$WORK/borgmatic-here" ] || { printf 'Unit %s could not be found.\\n' "\$unit" >&2; exit 4; }
        if [ -e "$WORK/borgmatic-failed" ]; then
          printf 'Result=exit-code\nExecMainStatus=1\n'
        else
          printf 'Result=success\nExecMainStatus=0\n'
        fi
        exit 0 ;;
      *)
        # Wie echtes systemd für eine unbekannte Unit: keine Eigenschaften, rc=4.
        # Auf der Kiste gibt es keinen borgmatic-Dienst — dort bleiben die Werte
        # „unbekannt" statt eines erfundenen Erfolgs.
        printf 'Unit %s could not be found.\\n' "\$unit" >&2
        exit 4 ;;
    esac ;;
  list-units)
    # Nur noch nicht abgeräumte (aktive) borg-Unit-*.service zeigen — genau das,
    # was systemd mit --collect übrig lässt.
    for f in "\$UNITDIR"/*.log; do
      [ -f "\$f" ] || continue
      n="\$(basename "\$f" .log)"
      case "\$n" in
        $PREFIX-check-*|$PREFIX-repair-*) ;;
        *) continue ;;
      esac
      [ -f "\$UNITDIR/\$n.rc" ] && continue
      printf '%s %s %s %s %s\n' "\$n.service" loaded active running "stub"
    done
    exit 0 ;;
esac
exit 0
EOF

cat > "$STUBS/journalctl" <<EOF
#!/usr/bin/env bash
unit=""; lines=""
while [ "\$#" -gt 0 ]; do
  case "\$1" in
    -u|--unit) unit="\$2"; shift 2 ;;
    -n|--lines) lines="\$2"; shift 2 ;;
    *) shift ;;
  esac
done
case "\$unit" in
  $PREFIX-*)
    f="$WORK/units/\${unit%.service}.log"
    [ -f "\$f" ] || { echo "-- No entries --" >&2; exit 1; }
    if [ -n "\$lines" ]; then tail -n "\$lines" "\$f"; else cat "\$f"; fi
    exit 0 ;;
esac
[ -f "$WORK/borgmatic-here" ] || exit 0
if [ -f "$WORK/journal-borgmatic.txt" ]; then cat "$WORK/journal-borgmatic.txt"; else cat "$WORK/journal-borgmatic.default"; fi
exit 0
EOF
cat > "$STUBS/curl" <<EOF
#!/usr/bin/env bash
cat "$FIXTURE_STATUS"
EOF

# Kaputter systemd-run: der Start muss als rc=69 auffallen, nicht still scheitern.
mkdir -p "$WORK/bin-broken"
cat > "$WORK/bin-broken/systemd-run" <<'EOF'
#!/usr/bin/env bash
echo "systemd-run: Failed to start transient service unit" >&2
exit 1
EOF
chmod 755 "$STUBS"/* "$WORK/bin-broken"/*

export PATH="$STUBS:$PATH"
export COCKPIT_BORG_ACTION_LOCK="$WORK/borg.lock"
export COCKPIT_BORG_ACTION_STATE_DIR="$WORK/state"
export COCKPIT_BORG_ACTION_CONFIG="$WORK/config.yaml"
export COCKPIT_BORG_ACTION_KISTE_URL="http://10.0.0.5:8088/status.txt"
export COCKPIT_BORG_ACTION_KISTE_REPO="$WORK/repo"

echo "== Grammatik =="
run_helper; assert_rc "kein Argument wird abgelehnt" 64; assert_err "Usage auf stderr" "cockpit-borg-action"
run_helper bogus; assert_rc "unbekanntes Verb wird abgelehnt" 64
run_helper status extra; assert_rc "zweites Argument wird abgelehnt" 64
run_helper check extra; assert_rc "check mit Argument wird abgelehnt" 64
run_helper repair --force; assert_rc "repair mit --force wird abgelehnt" 64
run_helper --payload status
assert_rc "Payload-Verb ohne Unit-Kontext wird abgelehnt" 64
assert_err "Grund genannt (nur aus der Unit)" "nur aus der eigenen Unit"
run_helper_env COCKPIT_BORG_ACTION_IN_UNIT=fremd-status-1 -- --payload status
assert_rc "Payload-Verb mit fremdem Unit-Namen wird abgelehnt" 64
run_helper_env COCKPIT_BORG_ACTION_IN_UNIT="$PREFIX-status-1" -- --payload bogus
assert_rc "unbekanntes Payload-Verb wird abgelehnt" 64
if grep -q "last.pid" "$HELPER"; then
  bad "Helfer kennt noch eine PID-Datei"
else
  ok "Helfer kennt keine PID-Datei mehr"
fi

echo "== status (VPS, über eine eigene Unit) =="
: > "$WORK/systemd-run.log"
run_helper status
assert_rc "status läuft durch" 0
assert_out "Rolle erkannt" "Rolle: VPS"
assert_out "Timerzustand" "Timer: active"
assert_out "Journalzeile des Backups" "borgmatic.service: Succeeded."
assert_out "Archivliste" "vmd61162-2026-09-27T02:40:56.874046"
assert_out "Repo-Kennzahlen" "All archives:"
assert_out "Repo erreichbar" "repo_erreichbar: ja"
assert_out "keine Wartung gemeldet" "wartung_laeuft: nein"
assert_out "Kiste: Array vollständig" "Array vollständig (4/4, [UUUU])"
assert_out "Kiste: Platz" "86% /media/RAID"
assert_no_out "Konfigdatei bleibt draussen" "GEHEIM"
if grep -q -- "--wait --pipe --collect --quiet --unit=$PREFIX-status-" "$WORK/systemd-run.log"; then
  ok "status läuft als Unit mit --wait --pipe --collect"
else
  bad "status nicht als Unit gestartet: $(cat "$WORK/systemd-run.log")"
fi
if ls "$WORK/units/$PREFIX-status-"*.log >/dev/null 2>&1; then
  ok "status-Nutzlast lief in der Unit (Unit-Log vorhanden)"
else
  bad "kein Unit-Log für status"
fi

echo "== status (Repo unerreichbar) =="
: > "$WORK/state/fail-repo"
run_helper status
assert_rc "unerreichbares Repo meldet rc=2 (durch die Unit hindurch)" 2
assert_out "Repo nicht erreichbar" "repo_erreichbar: nein"
rm -f "$WORK/state/fail-repo"

echo "== status (Kiste, kein borgmatic) =="
# borgmatic wird über einen PATH ohne borgmatic-Stub ausgeblendet (die Kiste hat
# keins); systemctl/journalctl/curl/systemd-run bleiben sichtbar.
mkdir -p "$WORK/kiste-bin"
for tool in systemctl journalctl curl systemd-run; do ln -sf "$STUBS/$tool" "$WORK/kiste-bin/$tool"; done
OUT="$(PATH="$WORK/kiste-bin:/usr/bin:/bin" COCKPIT_BORG_ACTION_LOCK="$WORK/borg.lock" \
  COCKPIT_BORG_ACTION_STATE_DIR="$WORK/state" COCKPIT_BORG_ACTION_CONFIG="$WORK/config.yaml" \
  COCKPIT_BORG_ACTION_KISTE_REPO="$WORK/repo" \
  COCKPIT_BORG_ACTION_KISTE_URL="http://10.0.0.5:8088/status.txt" "$BASH_BIN" "$HELPER" status 2>"$WORK/stderr")"; RC=$?
ERR="$(cat "$WORK/stderr")"
assert_rc "status auf der Kiste läuft durch" 0
assert_out "Rolle Kiste" "Rolle: Kiste"
assert_out "Repo-Verzeichnis vorhanden" "vorhanden: ja"
assert_out "jüngstes Segment" "jüngstes Datensegment:"
assert_out "Mountzeile der Kiste" "/media/RAID"

echo "== B4: status bei belegtem Repo (Backup läuft) =="
: > "$WORK/borgmatic-busy"
: > "$WORK/borgmatic.log"
run_helper status
assert_rc "status bleibt rc=0, wenn nur das Backup läuft" 0
assert_out "Repo als belegt gemeldet" "repo: belegt (Backup läuft)"
assert_out "Zusammenfassung nennt belegt" "repo_erreichbar: belegt (nicht abgefragt)"
assert_out "Backup aktiv gemeldet" "borgmatic_busy: ja"
if grep -qE "list --last 5|info --last 1" "$WORK/borgmatic.log"; then
  bad "status hat das Repo trotz laufendem Backup abgefragt: $(cat "$WORK/borgmatic.log")"
else
  ok "status überspringt list/info während des Backups"
fi
rm -f "$WORK/borgmatic-busy"

echo "== B1: check/repair als benannte Unit ohne Warten =="
run_helper check
assert_rc "check startet" 0
assert_out "Kommando benannt" "gestartet: borgmatic --verbosity 1 check --force"
assert_out "Frist wird berichtet" "Frist: nächster borgmatic.timer-Lauf in"
assert_out "Unit wird benannt" "Unit: $PREFIX-check-"
assert_no_out "kein PID mehr" "PID:"
CHECK_UNIT="$(sed -n 's/^Unit: //p' <<<"$OUT" | head -n 1)"
if grep -qF -- "--unit=$CHECK_UNIT --description=Cockpit borg check" "$WORK/systemd-run.log" \
   && ! grep -q -- "--wait.*--unit=$CHECK_UNIT" "$WORK/systemd-run.log"; then
  ok "check-Unit wurde ohne --wait gestartet"
else
  bad "check-Unit-Aufruf falsch: $(grep -- "$CHECK_UNIT" "$WORK/systemd-run.log")"
fi
if grep -q -- "--collect" "$WORK/systemd-run.log" \
   && grep -q -- "--property=Type=exec" "$WORK/systemd-run.log" \
   && grep -q -- "--setenv=COCKPIT_BORG_ACTION_IN_UNIT=$CHECK_UNIT" "$WORK/systemd-run.log"; then
  ok "check-Unit mit --collect, Type=exec und Unit-Kontext gestartet"
else
  bad "check-Unit ohne --collect/Type=exec/setenv"
fi
assert_file "Zustand: last.unit" "$WORK/state/last.unit"
assert_file "Zustand: last.kind" "$WORK/state/last.kind"
assert_no_file "Zustand: keine last.pid" "$WORK/state/last.pid"
if [ "$(cat "$WORK/state/last.kind")" = "check" ]; then ok "last.kind = check"; else bad "last.kind falsch: $(cat "$WORK/state/last.kind")"; fi
wait_for_file "$WORK/repo/data/check.run" && ok "die Unit hat borgmatic wirklich gestartet" || bad "die Unit hat borgmatic nicht gestartet"
if grep -q -- "check --force" "$WORK/repo/data/check.run"; then
  ok "B2: check läuft mit --force"
else
  bad "B2: check ohne --force: $(cat "$WORK/repo/data/check.run")"
fi
if wait_for_rc_file "$CHECK_UNIT" 100 && [ "$(cat "$WORK/units/$CHECK_UNIT.rc")" = "0" ]; then
  ok "Unit beendet sich mit rc=0"
else
  bad "Unit-Ergebnis: $(cat "$WORK/units/$CHECK_UNIT.rc" 2>/dev/null)"
fi

echo "== status nach der Wartung: Laufzustand aus Unit + Journal =="
run_helper status
assert_rc "status läuft durch" 0
assert_out "letzte Wartung aus dem Zustand" "letzte Wartung: $CHECK_UNIT (Art check)"
assert_out "Journal der Unit wird gezeigt" "Unit $CHECK_UNIT: borgmatic --verbosity 1 check --force"
assert_out "keine Wartung aktiv" "wartung_laeuft: nein"
assert_no_out "kein PID-Log mehr" "letztes Log:"

echo "== B4b: status während eine Wartungs-Unit läuft =="
: > "$WORK/hold-check"
: > "$WORK/borgmatic.log"
run_helper check
assert_rc "Wartung mit Halte-Marker startet" 0
HOLD_UNIT="$(sed -n 's/^Unit: //p' <<<"$OUT" | head -n 1)"
wait_for_file "$WORK/repo/data/check.run" && sleep 0.3
run_helper status
assert_rc "status bleibt rc=0, wenn nur die Wartung läuft" 0
assert_out "laufende Wartung mit Unit und Art" "läuft: ja (Unit $HOLD_UNIT, Art check)"
assert_out "Repo als belegt gemeldet" "repo: belegt (check läuft)"
assert_out "Wartung in der Zusammenfassung" "wartung_laeuft: ja"
assert_out "Unit in der Zusammenfassung" "wartung_unit: $HOLD_UNIT"
assert_out "Journal der laufenden Unit" "Unit $HOLD_UNIT: borgmatic --verbosity 1 check --force"
if grep -qE "list --last 5|info --last 1" "$WORK/borgmatic.log"; then
  bad "status hat das Repo trotz laufender Wartung abgefragt"
else
  ok "status überspringt list/info während der Wartung"
fi
run_helper check
assert_rc "zweiter check bei laufender Wartung wird abgewiesen" 3
assert_err "Grund nennt die Unit" "es läuft bereits eine Wartung: Unit $HOLD_UNIT"
rm -f "$WORK/hold-check"
wait_for_rc_file "$HOLD_UNIT" 200

echo "== repair =="
run_helper repair
assert_rc "repair startet" 0
assert_out "Repair-Form benannt" "--verbosity 1 check --repair --force"
REPAIR_UNIT="$(sed -n 's/^Unit: //p' <<<"$OUT" | head -n 1)"
assert_out "repair-Unit benannt" "Unit: $PREFIX-repair-"
wait_for_file "$WORK/repo/data/repair.run" && ok "die Unit hat borgmatic wirklich gestartet" || bad "repair lief nicht"
if grep -q "env=YES" "$WORK/repo/data/repair.run" 2>/dev/null; then
  ok "repair setzt BORG_CHECK_I_KNOW_WHAT_I_AM_DOING=YES"
else
  bad "repair ohne Freigabe-Variable: $(cat "$WORK/repo/data/repair.run" 2>/dev/null)"
fi
if grep -q -- "check --repair --force" "$WORK/repo/data/repair.run"; then
  ok "repair ruft check --force mit --repair auf"
else
  bad "repair-Aufruf falsch: $(cat "$WORK/repo/data/repair.run")"
fi
wait_for_rc_file "$REPAIR_UNIT" 100
if [ "$(cat "$WORK/state/last.kind")" = "repair" ]; then ok "last.kind = repair"; else bad "last.kind falsch: $(cat "$WORK/state/last.kind")"; fi

echo "== R3: Wartungs-Units laufen mit Nice=10 und IOSchedulingClass=idle =="
# Ein Repo-Check über Stunden darf Nextcloud und GitLab nicht ausbremsen: die
# Wartungs-Units bekommen CPU und Platte nur, wenn sonst niemand will. `status`
# ist eine kurze Abfrage und bleibt davon unberührt.
for probe in "$CHECK_UNIT" "$HOLD_UNIT" "$REPAIR_UNIT"; do
  line="$(grep -F -- "--unit=$probe" "$WORK/systemd-run.log" | head -n 1)"
  if [ -n "$line" ] && [[ "$line" == *"--property=Nice=10"* && "$line" == *"--property=IOSchedulingClass=idle"* ]]; then
    ok "R3: $probe läuft mit Nice=10 und IOSchedulingClass=idle"
  else
    bad "R3: $probe ohne Nice/IOSchedulingClass: $line"
  fi
done
STATUS_CALL="$(grep -F -- "--unit=$PREFIX-status-" "$WORK/systemd-run.log" | head -n 1)"
if [ -n "$STATUS_CALL" ] && [[ "$STATUS_CALL" != *"Nice="* ]]; then
  ok "R3: status bleibt ohne Nice (kurze Abfrage)"
else
  bad "R3: status-Aufruf unerwartet: $STATUS_CALL"
fi

echo "== Ablehnungen (rc=3) =="
: > "$WORK/borgmatic-busy"
run_helper check
assert_rc "check während borgmatic läuft wird abgewiesen" 3
assert_err "Grund genannt" "nächtliches Backup"
rm -f "$WORK/borgmatic-busy"

exec 9>>"$WORK/borg.lock"
flock -n 9 && ok "Sperre im Harness gehalten" || bad "Sperre nicht haltbar"
run_helper check
assert_rc "check bei belegter Sperre wird abgewiesen" 3
assert_err "Grund genannt (Sperre)" "$WORK/borg.lock ist belegt"
flock -u 9; exec 9>&-

echo "== R1/B3: Frist bis zum nächsten borgmatic.timer-Lauf =="
# R1: der Helfer holt die Zeit als Zahl aus `systemctl list-timers --output=json`.
# Eine formatierte Wanduhr — und damit jede Zeitzonen- oder Sommerzeitrechnung —
# kommt im Helfer nicht mehr vor.
if grep -qE "NextElapseUSecRealtime|parse_next_elapse" "$HELPER"; then
  bad "R1: Helfer parst noch eine formatierte Timerzeit"
else
  ok "R1: Helfer kennt keine formatierte Timerzeit mehr"
fi

timer_json "$(timer_usec "$(( NOW + 2 * 3600 ))")"
RUNS_BEFORE="$(wc -l < "$WORK/systemd-run.log")"
run_helper check
assert_rc "weniger als 8 h bis zum Timer => rc=3" 3
assert_err "Abstand genannt" "zu wenig Abstand"
if grep -qF "list-timers --output=json --no-pager borgmatic.timer" "$WORK/list-timers.log"; then
  ok "R1: Frist kommt aus systemctl list-timers --output=json"
else
  bad "R1: Aufruf ohne --output=json: $(tr '\n' ' ' < "$WORK/list-timers.log")"
fi
RUNS_AFTER="$(wc -l < "$WORK/systemd-run.log")"
if [ "$RUNS_BEFORE" = "$RUNS_AFTER" ]; then ok "trotz Fristverletzung keine Unit gestartet"; else bad "trotz Fristverletzung gestartet"; fi

timer_json "$(timer_usec "$(( NOW + 2 * 3600 ))")"
run_helper repair
assert_rc "repair mit weniger als 8 h => rc=3" 3

timer_json "$(timer_usec "$(( NOW + 16 * 3600 ))")"
run_helper check
assert_rc "Mikrosekundenform mit Abstand => rc=0" 0
assert_out "Frist in Ordnung" "in Ordnung"
SHORT_UNIT="$(sed -n 's/^Unit: //p' <<<"$OUT" | head -n 1)"
wait_for_rc_file "$SHORT_UNIT" 100

timer_json "$(timer_usec "$(( NOW + 3600 ))")"
run_helper check
assert_rc "Mikrosekundenform mit 1 h => rc=3" 3

# `null` ist systemds „kein nächster Lauf steht fest" (`next` ist dann nicht
# gesetzt), `[]` ein leeres Ergebnis. Beides heisst: keine Frist — also fail closed
# wie bei einem unlesbaren Wert, nicht „kein Grund zur Vorsicht".
timer_json null
run_helper check
assert_rc "next=null => rc=3 (fail closed)" 3
printf '[]\n' > "$WORK/list-timers.json"
run_helper check
assert_rc "leere Timerliste => rc=3 (fail closed)" 3

printf '%s\n' "kaputt" > "$WORK/list-timers.json"
RUNS_BEFORE="$(wc -l < "$WORK/systemd-run.log")"
run_helper check
assert_rc "unlesbarer Timerwert => rc=3 (fail closed)" 3
assert_err "Wert wird zitiert" "list-timers --output=json: 'kaputt'"
RUNS_AFTER="$(wc -l < "$WORK/systemd-run.log")"
if [ "$RUNS_BEFORE" = "$RUNS_AFTER" ]; then ok "bei unlesbarem Wert keine Unit gestartet"; else bad "trotz unlesbarem Wert gestartet"; fi

echo "== R1: das CEST-Beispiel aus dem Review =="
# Auf dem Host lieferte `systemctl show -p NextElapseUSecRealtime` die Wanduhr
# „Tue 2026-09-29 01:53:08 CEST". Der alte Weg entfernte das Zonenkürzel und las
# die Wanduhr als UTC (03:53:08 UTC) — zwei Stunden zu viel Frist; im Winter eine.
# Hier steht dieselbe Zeit als das, was systemd im JSON ausgibt, und das „jetzt"
# wird festgelegt, damit die Zahl selbst geprüft wird.
# Der feste Wert wird gegen die Datumsrechnung des Prüf-Images geprüft: mit tzdata
# als „Tue 2026-09-29 01:53:08 CEST", ohne tzdata (bash:5, ubuntu:24.04) als
# derselbe Zeitpunkt in UTC — Sommerzeit heisst hier +2 h.
if [ "$(TZ=Europe/Berlin date -d "@$CEST_NEXT" '+%a %F %T %Z' 2>/dev/null)" = "Tue 2026-09-29 01:53:08 CEST" ]; then
  ok "CEST-Beispiel: $CEST_NEXT s = Tue 2026-09-29 01:53:08 CEST"
elif [ "$(TZ=UTC date -u -d "@$CEST_NEXT" '+%a %F %T UTC' 2>/dev/null)" = "Mon 2026-09-28 23:53:08 UTC" ]; then
  ok "CEST-Beispiel: $CEST_NEXT s = 2026-09-28 23:53:08 UTC (= 01:53:08 CEST beim Prüf-Image ohne tzdata)"
else
  bad "CEST-Beispiel: $CEST_NEXT s passt nicht (Image: $(TZ=UTC date -u -d "@$CEST_NEXT" 2>&1))"
fi
timer_json "$(timer_usec "$CEST_NEXT")"

fake_now "$(( CEST_NEXT - 6 * 3600 ))"
RUNS_BEFORE="$(wc -l < "$WORK/systemd-run.log")"
run_helper_clock -- check
assert_rc "CEST: 6 h bis zum Termin => rc=3" 3
assert_err "CEST: Abstand mit 6 h gerechnet (alt: 8 h => Start)" "in 6 h 0 min"
RUNS_AFTER="$(wc -l < "$WORK/systemd-run.log")"
if [ "$RUNS_BEFORE" = "$RUNS_AFTER" ]; then ok "CEST: keine Unit gestartet"; else bad "CEST: trotz Fristverletzung gestartet"; fi

fake_now "$(( CEST_NEXT - 10 * 3600 ))"
run_helper_clock -- check
assert_rc "CEST: 10 h bis zum Termin => rc=0" 0
assert_out "CEST: Frist mit 10 h gerechnet (alt: 12 h)" "in 10 h 0 min"
CEST_UNIT="$(sed -n 's/^Unit: //p' <<<"$OUT" | head -n 1)"
wait_for_rc_file "$CEST_UNIT" 100
rm -f "$WORK/fake-now"

: > "$WORK/timer-off"
run_helper check
assert_rc "Timer nicht aktiv => kein Fristgrund, Lauf startet" 0
assert_out "Hinweis zum inaktiven Timer" "ist nicht aktiv"
OFF_UNIT="$(sed -n 's/^Unit: //p' <<<"$OUT" | head -n 1)"
wait_for_rc_file "$OFF_UNIT" 100
rm -f "$WORK/timer-off"
timer_json "$(timer_usec "$(( NOW + 16 * 3600 ))")"

echo "== Startfehler und falscher Host =="
OUT="$(PATH="$WORK/bin-broken:$STUBS:$PATH" COCKPIT_BORG_ACTION_LOCK="$WORK/borg.lock" \
  COCKPIT_BORG_ACTION_STATE_DIR="$WORK/state" COCKPIT_BORG_ACTION_CONFIG="$WORK/config.yaml" \
  COCKPIT_BORG_ACTION_KISTE_REPO="$WORK/repo" "$BASH_BIN" "$HELPER" check 2>"$WORK/stderr")"; RC=$?
ERR="$(cat "$WORK/stderr")"
assert_rc "Startfehler der Unit => rc=69" 69
assert_err "Grund genannt (Unit nicht gestartet)" "konnte nicht starten"

OUT="$(PATH="$WORK/kiste-bin:/usr/bin:/bin" COCKPIT_BORG_ACTION_LOCK="$WORK/borg.lock" \
  COCKPIT_BORG_ACTION_STATE_DIR="$WORK/state" COCKPIT_BORG_ACTION_CONFIG="$WORK/config.yaml" \
  COCKPIT_BORG_ACTION_KISTE_REPO="$WORK/repo" "$BASH_BIN" "$HELPER" repair 2>"$WORK/stderr")"; RC=$?
ERR="$(cat "$WORK/stderr")"
assert_rc "repair ohne borgmatic (Kiste) wird abgewiesen" 67
assert_err "Grund genannt (VPS nötig)" "check/repair laufen auf dem VPS"

echo "== status: Datenblock für die Cockpit-Anzeige =="
# Der Datenblock ist die einzige Schnittstelle zwischen Helfer und Anzeige
# (apps/api/src/borg-status.ts). Geprüft wird nicht nur, dass er da ist, sondern
# dass er nur trägt, was er tragen darf: ISO-Zeit mit Zone, Zahlen, Einheiten,
# feste Aufzählungen — keine Pfade, keine Zugangsdaten, keine leeren Werte.
block_has() { if grep -qF -- "$2" <<<"$BLOCK"; then ok "$1"; else bad "$1 — Block ohne: $2"; fi; }
block_grep() { if grep -qE -- "$2" <<<"$BLOCK"; then ok "$1"; else bad "$1 — Block ohne Muster: $2"; fi; }
read_block() { BLOCK="$(sed -n '/^== DATEN (cockpit-borg-status\/v1) ==$/,$p' <<<"$OUT")"; }

# Ein abgeschlossener Cockpit-Check: die Unit räumt sich mit --collect selbst ab,
# ihr Journal bleibt — daraus kommt rc.
printf '%s\n' \
  "Unit $PREFIX-check-block1: borgmatic --verbosity 1 check --force" \
  "Start: 2026-09-28T11:00:00+02:00" \
  "Ende: 2026-09-28T12:41:12+02:00 (rc=0)" > "$WORK/units/$PREFIX-check-block1.log"
printf '0\n' > "$WORK/units/$PREFIX-check-block1.rc"
printf '%s\n' "$PREFIX-check-block1" > "$WORK/state/last.unit"
printf '%s\n' "check" > "$WORK/state/last.kind"

run_helper status
assert_rc "status liefert den Datenblock" 0
read_block
if [ -n "$BLOCK" ]; then ok "Datenblock vorhanden"; else bad "Datenblock fehlt"; fi
block_has "Schema" "schema=cockpit-borg-status/v1"
block_grep "Messzeitpunkt mit Zone" '^measured_at=[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[+-][0-9]{2}:[0-9]{2}$'
block_has "Rolle VPS" "role=vps"
block_has "letzter Lauf: Beginn aus dem Journal" "last_run_start=2026-09-27T02:39:04+02:00"
block_has "letzter Lauf: Ende aus dem Journal" "last_run_end=2026-09-27T02:49:36+02:00"
block_has "letzter Lauf: Ergebnis aus systemd" "last_run_result=success"
block_has "letzter Lauf: Exit-Status aus systemd" "last_run_exit=0"
block_has "Nachtcheck ist übersprungen (kein grüner Check)" "scheduled_check=skipped"
block_has "Nachtcheck mit seinem Zeitstempel" "scheduled_check_at=2026-09-27T02:49:36+02:00"
block_has "Wartung: Ergebnis aus dem Unit-Journal" "maintenance_rc=0"
block_has "Wartung: Ende aus dem Unit-Journal" "maintenance_end=2026-09-28T12:41:12+02:00"
block_has "Wartung: Quelle benannt" "maintenance_source=unit-journal"
block_has "Wartung: Art benannt" "maintenance_kind=check"
block_has "Wartung: läuft nicht" "maintenance_running=no"
block_grep "Timer: nächster Lauf als UTC-Zeit" '^timer_next=[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$'

VALUES="$(grep -E '^[a-z][a-z0-9_]*=' <<<"$BLOCK" | grep -v '^schema=')"
if grep -q '/' <<<"$VALUES"; then bad "Datenblock enthält einen Pfad"; else ok "Datenblock enthält keinen Pfad"; fi
if grep -qE 'GEHEIM|passphrase|password|ssh://|BEGIN ' <<<"$BLOCK"; then bad "Datenblock enthält Zugangsdaten"; else ok "Datenblock enthält keine Zugangsdaten"; fi
if grep -qE '^[a-z][a-z0-9_]*=$' <<<"$VALUES"; then bad "Datenblock enthält einen leeren Wert"; else ok "Datenblock enthält keine leeren Werte"; fi
if grep -qE '^[A-Za-z_]+=.*[;|&$`]' <<<"$VALUES"; then bad "Datenblock enthält Shell-Metazeichen"; else ok "Datenblock enthält keine Shell-Metazeichen"; fi

echo "== status: roter Check im nächtlichen Journal =="
cat > "$WORK/journal-borgmatic.txt" <<'EOF'
2026-09-28T02:26:10+02:00 vmd61162 systemd[1]: Starting borgmatic.service - borgmatic backup...
2026-09-28T02:56:06+02:00 vmd61162 borgmatic[123]: CRITICAL Command 'borg check --glob-archives {hostname}-* --info ssh://borg@10.0.0.5/media/RAID/backup_VServer/borg' returned non-zero exit status 2.
EOF
run_helper status
read_block
block_has "roter Nachtcheck wird als failed gemeldet" "scheduled_check=failed"
block_has "roter Nachtcheck mit seinem Zeitstempel" "scheduled_check_at=2026-09-28T02:56:06+02:00"
# Die alte CRITICAL-Zeile bleibt im Block draussen — nur die jüngste zählt, und
# die ist der übersprungene Check. Genau das war der Befund vom 28.09.
rm -f "$WORK/journal-borgmatic.txt"
run_helper status
read_block
block_has "jüngste Zeile entscheidet (wieder skipped)" "scheduled_check=skipped"
if grep -q 'returned non-zero exit status' <<<"$BLOCK"; then
  bad "Block trägt Journal-Prosa (die alte CRITICAL-Zeile) hinein"
else
  ok "Block trägt nur Werte, keine Journal-Prosa"
fi

echo "== status: fehlgeschlagener Backup-Lauf =="
: > "$WORK/borgmatic-failed"
run_helper status
read_block
block_has "Ergebnis des Laufs kommt von systemd" "last_run_result=exit-code"
block_has "Exit-Status des Laufs" "last_run_exit=1"
rm -f "$WORK/borgmatic-failed"

echo "== status: laufende Wartung =="
printf '%s\n' "Unit $PREFIX-repair-block2: borgmatic --verbosity 1 check --repair --force" \
  "Start: 2026-09-28T13:00:00+02:00" > "$WORK/units/$PREFIX-repair-block2.log"
printf '%s\n' "$PREFIX-repair-block2" > "$WORK/state/last.unit"
printf '%s\n' "repair" > "$WORK/state/last.kind"
run_helper status
read_block
block_has "laufende Wartung gemeldet" "maintenance_running=yes"
block_has "laufende Wartung: Art repair" "maintenance_kind=repair"
block_has "laufende Wartung: noch kein Ergebnis" "maintenance_rc=unknown"
block_has "laufende Wartung: Quelle ist der Laufzustand" "maintenance_source=running-unit"
rm -f "$WORK/units/$PREFIX-repair-block2.log"
printf '%s\n' "$PREFIX-check-block1" > "$WORK/state/last.unit"
printf '%s\n' "check" > "$WORK/state/last.kind"

echo "== status: Datenblock bleibt bei unerreichbarem Repo =="
: > "$WORK/state/fail-repo"
run_helper status
assert_rc "unerreichbares Repo meldet weiter rc=2" 2
read_block
if [ -n "$BLOCK" ]; then ok "Datenblock kommt auch bei rc=2"; else bad "Datenblock fehlt bei rc=2"; fi
block_has "Befund und Zustand gleichzeitig" "last_run_exit=0"
rm -f "$WORK/state/fail-repo"

echo "== status (Kiste): Datenblock erfindet nichts =="
rm -f "$WORK/state/last.unit" "$WORK/state/last.kind" "$WORK/borgmatic-here"
OUT="$(PATH="$WORK/kiste-bin:/usr/bin:/bin" COCKPIT_BORG_ACTION_LOCK="$WORK/borg.lock" \
  COCKPIT_BORG_ACTION_STATE_DIR="$WORK/state" COCKPIT_BORG_ACTION_CONFIG="$WORK/config.yaml" \
  COCKPIT_BORG_ACTION_KISTE_REPO="$WORK/repo" \
  COCKPIT_BORG_ACTION_KISTE_URL="http://10.0.0.5:8088/status.txt" "$BASH_BIN" "$HELPER" status 2>"$WORK/stderr")"; RC=$?
ERR="$(cat "$WORK/stderr")"
assert_rc "status auf der Kiste liefert den Block" 0
read_block
block_has "Kiste: Rolle" "role=kiste"
block_has "Kiste: kein Backup-Lauf bekannt" "last_run_end=unknown"
block_has "Kiste: kein Ergebnis behauptet" "last_run_result=unknown"
block_has "Kiste: keine Wartung bekannt" "maintenance_rc=unknown"
: > "$WORK/borgmatic-here"

echo
printf 'bestanden: %s, fehlgeschlagen: %s\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
