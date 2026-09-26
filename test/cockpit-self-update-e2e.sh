#!/bin/bash
# ============================================================================
# cockpit-self-update-e2e.sh — End-to-End-Prüfung des Selbst-Update-Bausteins
# auf echtem systemd (Wegwerf-Container).
#
# Geprüft wird der AUSGELIEFERTE Stand:
#   deploy/helpers/cockpit-self-update-action  (typisierter Helfer)
#   deploy/helpers/cockpit-self-update-run     (deploy/activate-Runner)
#   deploy/systemd/wireguard-ops-cockpit-self-update@.service (Template-Unit)
#
# Ablauf im Container: Modul an die Produktionspfade installieren, Fixture-
# Repository + Fixture-Deploy-Skript + Fixture-Dienste/-Sockets/-Health-Server
# aufbauen und dann echte Läufe fahren:
#   1. Review-Diff und Update im Sandbox-Nachbau des Executor-Dienstes
#      (systemd-run mit ProtectSystem/ProtectHome/RestrictAddressFamilies) bis
#      inkl. Aktivierung; der Diff selbst läuft in einer transienten Unit
#   2. status über die sudoers-Strecke (User cockpit-executor -> root)
#   3. Review-Diff und Update über dieselbe sudoers-Strecke (zweiter Commit)
#   4. Refusals: nicht gemergter Commit, ungeprüftes Update (nur sha),
#      falscher Review-Hash (jeweils 65, Deploy-Skript läuft nicht)
#   5. Aktivierungs-Fehlschlag wird als solcher berichtet (Health-Server aus)
#
# Aufruf (auf dem VPS-Host ODER in der Hermes-Shell):
#   bash test/cockpit-self-update-e2e.sh [out-dir]
#
# Ergebnis: Log unter <out-dir>/e2e-selfupd-<zeitstempel>.log; Exit 0 = grün.
# Nichts am VPS oder an Lab0 wird verändert; der Container wird entfernt.
# ============================================================================
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"
OUT="${1:-/opt/data/out/cockpit-self-update-e2e}"
TS="$(date +%Y%m%d-%H%M%S)"
NAME="wgoc-selfupd-$TS"
LOG="$OUT/e2e-selfupd-$TS.log"

command -v docker >/dev/null 2>&1 || { echo "FEHLER: docker fehlt"; exit 2; }
[ -f "$HERE/cockpit-self-update-e2e-inner.sh" ] || { echo "FEHLER: $HERE/cockpit-self-update-e2e-inner.sh fehlt"; exit 2; }

# Container-Sicht -> Host-Sicht (auf dem VPS: /opt/data = /home/hermes/.hermes).
hostpath() {
  case "$1" in
    /opt/data)   printf '%s' "/home/hermes/.hermes" ;;
    /opt/data/*) printf '%s' "/home/hermes/.hermes${1#/opt/data}" ;;
    *)           printf '%s' "$1" ;;
  esac
}
OUT_HOST="$(hostpath "$OUT")"
REPO_HOST="$(hostpath "$REPO")"
mkdir -p "$OUT" "$OUT_HOST"

echo "== cockpit self-update — E2E (Wegwerf-Container, echtes systemd) =="
echo "Repo:    $REPO"
echo "Ausgabe: $LOG"

docker rm -f "$NAME" >/dev/null 2>&1 || true
# Ubuntu 24.04 = systemd 255 wie auf Lab0/VPS; python3/git/sudo kommen nach.
# Der Entrypoint installiert zuerst und übergibt dann an systemd als PID 1.
docker run -d --name "$NAME" \
  --privileged --cgroupns=host \
  -v /sys/fs/cgroup:/sys/fs/cgroup:rw --tmpfs /run --tmpfs /tmp \
  --mount "type=bind,source=$REPO_HOST,target=/pkg,readonly" \
  --mount "type=bind,source=$OUT_HOST,target=/out" \
  ubuntu:24.04 /bin/bash -c 'apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq systemd-sysv python3 git sudo curl ca-certificates iproute2 util-linux >/dev/null 2>&1; exec /sbin/init' >>"$LOG" 2>&1
if [ "$(docker inspect -f '{{.State.Running}}' "$NAME" 2>/dev/null)" != "true" ]; then
  echo "FEHLER: Container $NAME startet nicht." | tee -a "$LOG"
  docker logs "$NAME" >>"$LOG" 2>&1 || true
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  exit 2
fi

# systemd bereit? (max ~2 Minuten; 'degraded' zählt als bereit)
state=""
for _ in $(seq 1 60); do
  state="$(docker exec "$NAME" systemctl is-system-running 2>/dev/null || true)"
  case "$state" in running|degraded) break ;; esac
  sleep 2
done
if [ "$state" != "running" ] && [ "$state" != "degraded" ]; then
  echo "FEHLER: systemd im Container nicht bereit (state=$state)." | tee -a "$LOG"
  docker logs "$NAME" >>"$LOG" 2>&1 || true
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  exit 2
fi

docker exec "$NAME" bash /pkg/test/cockpit-self-update-e2e-inner.sh >"$LOG" 2>&1
rc=$?
docker rm -f "$NAME" >/dev/null 2>&1 || true

echo "--- letzte 60 Zeilen ---"
tail -n 60 "$LOG"
echo "------------------------------------------------------------"
if [ "$rc" -eq 0 ]; then
  echo "E2E ERGEBNIS: GRUEN (rc=0) — Log: $LOG"
else
  echo "E2E ERGEBNIS: ROT (rc=$rc) — Log: $LOG"
fi
exit "$rc"
