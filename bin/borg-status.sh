#!/usr/bin/env bash
# =============================================================================
# borg-status.sh — der LESENDE Katalog-Einstieg in den Borg-Betrieb.
# -----------------------------------------------------------------------------
# Aufruf: borg-status.sh   (keine Argumente; alles andere endet mit 64)
#
# Warum es dieses Skript gibt
#   Der Borg-Betrieb liegt in zwei Schichten. Die privilegierte Schicht ist der
#   root-Helfer `cockpit-borg-action` (status/check/repair) hinter dem
#   typisierten, auditierten Executor-Weg. Diese Datei ist die andere Schicht:
#   der EINSTIEG im Cockpit-Katalog, damit der Borg-Betrieb in der Oberfläche
#   sichtbar und anwählbar ist, ohne dafür eine neue Rechte-Regel zu brauchen.
#
# Grenzen (bewusst)
#   * Kein sudo, keine privilegierten Pfade, kein borgmatic, kein Blick in
#     /etc/borgmatic/config.yaml und kein Repo-Schlüssel: Runbook-Sitzungen
#     laufen als `wgops`, und `wgops` bekommt hier absichtlich NICHTS dazu.
#   * Rein lesend: keine Unit wird gestartet, nichts wird geschrieben.
#   * Keine freien Argumente und keine Shell-Durchreiche: das Skript führt nur
#     die fest eingebauten, harmlosen Abfragen unten aus.
#   * Kein check/repair. Ein Shell-Weg zum Repair existiert damit nicht; er
#     bleibt ausschliesslich der typisierten Aktion `borg.repair` hinter der
#     Operator-Freigabe.
#
# Was hier sichtbar wird
#   * die Statusdatei der Kiste (Array, letzter Lauf) über HTTP,
#   * Zustand und nächster Lauf des borgmatic-Timers,
#   * die letzten Journalzeilen von borgmatic (nur, wenn die Sitzung sie lesen
#     darf — sonst steht genau das da).
#   Die Kennzahlen des Repos selbst (Archive, Grösse, Integrität) brauchen root
#   und kommen aus `borg.status`; check/repair aus `borg.check`/`borg.repair`.
#
# Rückgabewerte: 0 immer (eine lesende Anzeige scheitert nicht), 64 Aufruffehler.
#
# Prüf-Haken (COCKPIT_BORG_STATUS_*: KISTE_URL, TIMER, SERVICE, LOG_LINES,
# TIMEOUT_SEC) leiten Quelle und Grenzen für die Offline-Prüfung um
# (test/borg-status.test.sh).
# =============================================================================
set -uo pipefail
umask 027

readonly BORG_STATUS_KISTE_URL="${COCKPIT_BORG_STATUS_KISTE_URL:-http://10.0.0.5:8088/status.txt}"
readonly BORG_STATUS_TIMER="${COCKPIT_BORG_STATUS_TIMER:-borgmatic.timer}"
readonly BORG_STATUS_SERVICE="${COCKPIT_BORG_STATUS_SERVICE:-borgmatic.service}"
readonly BORG_STATUS_LOG_LINES="${COCKPIT_BORG_STATUS_LOG_LINES:-20}"
readonly BORG_STATUS_TIMEOUT="${COCKPIT_BORG_STATUS_TIMEOUT_SEC:-10}"

if [ "$#" -ne 0 ]; then
  printf 'usage: borg-status.sh — nimmt keine Argumente (bekommen: %s)\n' "$*" >&2
  exit 64
fi

have() { command -v "$1" >/dev/null 2>&1; }
section() { printf '\n== %s ==\n' "$1"; }
stamp() { date --iso-8601=seconds 2>/dev/null || date -u +%Y-%m-%dT%H:%M:%SZ; }

printf 'Borg-Zustand (lesend) — %s · %s\n' "$(hostname -f 2>/dev/null || hostname)" "$(stamp)"
printf 'Unprivilegierter Katalog-Einstieg: liest keine Schlüssel, startet nichts, ändert nichts.\n'

section "Kiste (Statusdatei $BORG_STATUS_KISTE_URL)"
if have curl; then
  if body="$(curl -fsS --max-time "$BORG_STATUS_TIMEOUT" "$BORG_STATUS_KISTE_URL" 2>&1)"; then
    printf '%s\n' "$body"
  else
    printf 'nicht abrufbar: %s\n' "$body"
  fi
else
  printf 'curl fehlt auf diesem Host — die Kiste wurde nicht abgefragt.\n'
fi

section "systemd ($BORG_STATUS_SERVICE, $BORG_STATUS_TIMER)"
if have systemctl; then
  printf 'Dienst %s: %s\n' "$BORG_STATUS_SERVICE" "$(systemctl is-active "$BORG_STATUS_SERVICE" 2>&1)"
  printf 'Timer  %s: %s\n' "$BORG_STATUS_TIMER" "$(systemctl is-active "$BORG_STATUS_TIMER" 2>&1)"
  systemctl list-timers "$BORG_STATUS_TIMER" --no-pager 2>&1 | sed -n '1,3p'
else
  printf 'systemctl fehlt auf diesem Host.\n'
fi

section "Journal ($BORG_STATUS_SERVICE, letzte $BORG_STATUS_LOG_LINES Zeilen)"
if have journalctl; then
  if ! journalctl -u "$BORG_STATUS_SERVICE" -n "$BORG_STATUS_LOG_LINES" --no-pager --output=short-iso 2>&1; then
    printf 'Journal nicht lesbar — dafür fehlt der Runbook-Sitzung die Berechtigung.\n'
  fi
else
  printf 'journalctl fehlt auf diesem Host.\n'
fi

section "Woher die vollständige Sicht kommt (bewusst nicht hier)"
cat <<'EOF'
Dieser Einstieg ist rein lesend und unprivilegiert: er sieht die Statusdatei der
Kiste, den Timer und das Journal, aber nicht das Repo selbst. Die Kennzahlen des
Repos (Archivliste, Grösse, Integrität) und check/repair brauchen den
Repo-Schlüssel und laufen deshalb als typisierte, auditierte Aktionen über den
Cockpit-Executor:

  borg.status   Repo- und Kisten-Sicht als root — lesend, ohne Freigabe
  borg.check    Repo-Check (borgmatic check --force), läuft als eigene Unit
                weiter; Fortschritt über borg.status
  borg.repair   Check mit --repair --force — nur nach Operator-Freigabe
                (blocked_user_approval) und erst nach einem Check mit Befund

Schlüssel und /etc/borgmatic/config.yaml bleiben root und werden nie ausgegeben.
EOF

exit 0
