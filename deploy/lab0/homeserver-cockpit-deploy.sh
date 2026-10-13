#!/usr/bin/env bash
# =============================================================================
# Home-Server Cockpit — Deploy-Skript (wireguard-ops-cockpit)
# -----------------------------------------------------------------------------
# Ziel:   Agent-Cockpit auf dem Home-Server (10.0.0.5) für Fernadministration
# Autor:  James (Hermes VPS) — Kanban t_6a58ebc7
# Stand:  2026-09-25   (Pin: Repo-Commit 59dc679 — Merge #7; Node v20.19.1)
#         v2: installiert zusätzlich cockpit-disk-action (IMSM-Helfer für /dev/md127,
#         Capability disk.manage) samt Rückbau-Zeile; Zweit-Review eingearbeitet;
#         REPO_COMMIT und OPENCODE_VERSION per Env überschreibbar.
#         v3 (Auslieferung 24.09.): Pin auf den cockpit-disk-action-Merge (acaad2f).
#         v4 (25.09., Kanban t_ed91b634) — Lehre aus dem Disk-Helfer-Re-Run:
#         Die nginx-Site (/etc/nginx/sites-available/wireguard-ops-cockpit) wird
#         NICHT mehr blind überschrieben. Port + TLS werden aus dem Ist-Zustand
#         abgeleitet (Lab0: 10.0.0.5:8180 ssl, Zertifikate unter /etc/nginx/ssl/);
#         WEB_PORT=<port> übersteuert weiterhin (Default = vorhandener Site-Port,
#         bei Neuanlage 8080). Geschrieben wird nur bei echter Änderung, davor
#         automatisch ein Backup (…bak-<zeitstempel>). Die Verifikation prüft den
#         tatsächlich konfigurierten Port/Modus (http/https) — nie mehr blind 8080 —
#         und nginx wird nach dem Lauf neu geladen (ein laufender nginx bekam die
#         Datei-Änderung sonst nie zu sehen).
#         Site-Logik ist per Container-E2E abgedeckt: bash cockpit/test-deploy-container.sh
#         Update auf einen neuen Stand: REPO_COMMIT=<sha> bash <skript>
#         v5 (25.09., Kanban t_c344cf16) — Selbst-Update-Baustein + Dienste-Zyklus:
#         installiert cockpit-self-update-action/-run und die One-Shot-Unit
#         wireguard-ops-cockpit-self-update@.service samt State-/Log-Verzeichnis
#         (Vertrag: doc/setup/self-update.md); am Ende werden die vier Cockpit-Dienste
#         neu gestartet — 'enable --now' startet einen LAUFENDEN Dienst nicht neu,
#         ein Re-Run ließ API/Broker sonst mit altem In-Memory-Code laufen (übersprungen
#         bei COCKPIT_RESTART_MODE=defer: das Selbst-Update aktiviert später). Das Skript
#         verbucht den deployten Stand inkl. web_url unter
#         /var/lib/wireguard-ops-cockpit/self-update/state.json.
#         Pin auf den #7-Merge (59dc679: a7b33d6-Fix + SMART + Selbst-Update).
#         26.09.2026 (Merge #9): Pin-Default auf 2ba8ff2 gezogen (Pre-Install-Review
#         des Selbst-Updates im Stand; Helpers/Unit werden unverändert mitinstalliert).
#         27.09.2026 (Merge #11): Pin-Default auf 35d12b1 gezogen (Executor-Fix im
#         Stand: lesende Scopes prüfen den Unterbaum; Sockets/Geheimnisse fail-closed).
#         27.09.2026 (Merge #12): Pin-Default auf 70fc55e gezogen — vps-cockpit-deploy.sh,
#         zweite Nachbesserung 4ef4180 (Selbst-Update des VPS-Cockpits im Stand).
#         02.10.2026 (Claude): die eine Tür (cockpit-host-run, Backup-Riegel,
#         Resume-Unit) wie im VPS-Deploy; Pin 49ed9f3.
#         Grenze (Zweitprüfung James): Verändernde Läufe (mutates: true) scheitern auf
#         Lab0 im Preflight. Der Helfer ruft fest cockpit-vps-snapshot und
#         cockpit-borg-action, die es nur auf dem VPS gibt. Lab0 fährt durch die Tür
#         nur lesende Pläne (bleibt so, siehe 13.10.2026).
#         02.10.2026 (Kanban t_e50a1db7): Aufräum-Dienst des borg-Repos
#         (cockpit-borg-retention: Helfer, Grenzen, Service + Timer, Vertrag
#         doc/setup/borg-retention.md). Braucht einen Stand mit diesem Modul
#         (REPO_COMMIT=<Merge-sha des PR "Aufräum-Dienst für Backups">); ältere
#         Stände brechen in Schritt 8 klar benannt ab. Der Timer wird aktiviert; ohne
#         die einmalig abzulegende Passphrase (/etc/cockpit-borg-retention/passphrase,
#         root 0600) startet der Lauf nicht und steht sichtbar auf failed.
#         27.09.2026 (Merge #13): Pin-Default auf 1d64219 gezogen — Planer-Ausnahme für
#         geprüfte Installs (6047a96).
#         13.10.2026 (Kanban t_d25614f4): Skript liegt jetzt im Repo
#         (deploy/lab0/homeserver-cockpit-deploy.sh) und installiert sich selbst nach
#         /usr/local/lib/wireguard-ops-cockpit/homeserver-cockpit-deploy.sh — dort
#         erwartet es der Selbst-Update-Runner. Neu: Sicherheitsnetz des Selbst-Updates
#         (cockpit-self-update-snapshot): Kopie des Cockpit-Fußabdrucks vor jedem
#         Update, Rückfall bei Fehler (doc/setup/self-update.md, "Lab0: snapshot and
#         rollback"). Danach kommt Lab0 als Cockpit-Job auf neue Stände
#         (/usr/local/sbin/cockpit-self-update-action <sha>), ohne Root-Handarbeit.
#         Die Kopie deckt nur das Cockpit ab, keine Host-Änderungen: die allgemeine
#         Tür bleibt auf Lab0 für verändernde Läufe zu. Bootstrap-Kopie (NC
#         /Documents, vpsdrop) = diese Datei; abweichen darf nur der Pin-Default.
#
# Aufruf (als root AUF DER KISTE):
#   bash homeserver-cockpit-deploy.sh
#   WEB_PORT=8180 bash homeserver-cockpit-deploy.sh   # nur bei gewolltem Portwechsel
#
# Voraussetzungen (Das Skript prüft sie und bricht klar benannt ab):
#   - Debian/Ubuntu-artiges Linux, x86_64 (sonst: stoppen + melden)
#   - Internet: apt-Mirror, github.com, registry.npmjs.org, nodejs.org
#   - /root/cockpit-deploy/deepseek.env mit DEEPSEEK_API_KEY=... (kommt vom VPS)
#
# Sicherheit / Design:
#   - Rein additiv: berührt KEINE bestehenden Dienste oder Daten.
#     borgmatic, RAID, /media/* und alle vorhandenen systemd-Units bleiben unangetastet.
#     Ausnahme mit eigenem Vertrag: der Aufräum-Dienst cockpit-borg-retention.timer
#     (prune + compact auf dem borg-Repo als borg, doc/setup/borg-retention.md).
#   - API und ttyd binden nur auf 127.0.0.1; nach außen exponiert ist NUR das Web
#     auf der WireGuard-IP ($WG_BIND_IP) — auf dem effektiven Port/Modus der Site
#     (Ist-Zustand, i. d. R. TLS; Neuanlage: 8080/HTTP).
#   - Site-Schutz: Die bestehende nginx-Site wird aus dem Ist-Zustand abgeleitet
#     (Port, TLS, Zertifikatspfade) und nur bei echter Änderung ersetzt — mit
#     automatischem Backup davor. Ein Re-Run kann TLS/Port nicht mehr verlieren.
#   - Alle Secrets entstehen auf der Kiste (root, Modus 0600) — dieses Skript
#     enthält keine Secrets. Das Admin-Passwort wird NICHT auf stdout gedruckt.
#   - Idempotent genug für Wiederholung: vorhandene .env-Dateien bleiben erhalten,
#     Code wird per git auf den Pin-Stand gebracht und neu gebaut; nginx wird am
#     Ende neu geladen, die vier Cockpit-Dienste werden neu gestartet (außer
#     COCKPIT_RESTART_MODE=defer) — ein Re-Run aktiviert den neuen Stand wirklich.
#
# Rückbau: siehe Abschnitt "Rückbau" am Ende dieses Skripts (auskommentiert).
# =============================================================================
set -euo pipefail

# ---------------------------------------------------------------------------
# Konstanten
# ---------------------------------------------------------------------------
REPO_URL="https://github.com/JSchmid6/wireguard-ops-cockpit.git"
REPO_COMMIT="${REPO_COMMIT:-49ed9f376d253071afc0fdea1730612b9ebe5f70}"
OPENCODE_VERSION="${OPENCODE_VERSION:-1.18.31}"   # VPS-validierte Serie (VPS: 1.18.30)
NODE_DIR="/opt/node-v20.19.1-linux-x64"
NODE_SHA256="b6c4cedfc81fc544b9993bc8a3628b5c0aa7a169fbaa293460abc0418d0fabb6"
COCKPIT_DIR="/opt/wireguard-ops-cockpit"
ENV_DIR="/etc/wireguard-ops-cockpit"
STATE_DIR="/var/lib/wireguard-ops-cockpit"
AGENT_DIR="/var/lib/wireguard-ops-agent"
EXEC_DIR="/var/lib/wireguard-ops-executor"
WEBROOT="/var/www/wireguard-ops-cockpit"
SECRETS_DIR="/root/cockpit-deploy"
WG_BIND_IP="${WG_BIND_IP:-10.0.0.5}"
NODE_PKG_URL="https://nodejs.org/dist/v20.19.1/node-v20.19.1-linux-x64.tar.xz"
# Hinweis WEB_PORT: nicht hier vorbelegen — der effektive Wert wird in Abschnitt 0b
# aus dem Site-Ist-Zustand abgeleitet (Default = vorhandener Site-Port).

log()  { printf '\n=== %s ===\n' "$*"; }
die()  { printf '\nFEHLER: %s\n' "$*" >&2; exit 1; }

# ---------------------------------------------------------------------------
# 0) Preflight
# ---------------------------------------------------------------------------
log "0) Preflight"
[ "$(id -u)" -eq 0 ] || die "Als root auf der Kiste ausführen."
[ "$(uname -m)" = "x86_64" ] || die "Erwartet x86_64, gefunden: $(uname -m)"

if [ -r /etc/os-release ]; then . /etc/os-release; fi
case "${ID:-}${ID_LIKE:-}" in
  *debian*|*ubuntu*) log "OS: ${PRETTY_NAME:-unbekannt} — OK" ;;
  *) die "Debian/Ubuntu-artiges Linux erwartet (gefunden: ${PRETTY_NAME:-unbekannt}). Stoppen und Rückmeldung an Jochen — Plan ggf. anpassen." ;;
esac

free_kb=$(df -Pk /opt | awk 'NR==2{print $4}')
[ "$free_kb" -ge 5000000 ] || die "Weniger als 5 GB frei unter /opt (${free_kb} KB). Erst Platz schaffen."

mkdir -p "$SECRETS_DIR"; chmod 700 "$SECRETS_DIR"

# ---------------------------------------------------------------------------
# 0b) Web-Site: Ist-Zustand lesen, Port + TLS ableiten (Re-Run-sicher)
#     Befund 25.09.: Der v3-Lauf hat die TLS-Site (8180 ssl) auf 8080/HTTP
#     überschrieben; der laufende nginx behielt die alte In-Memory-Config, die
#     Verifikation traf Port 8080 (dort lauscht code-server) und brach ab.
#     Künftig gilt:
#       - Site-Datei wird gelesen; Port + TLS aus dem Ist-Zustand abgeleitet.
#       - Geschrieben wird nur bei echter Änderung, davor Backup.
#       - WEB_PORT explizit übersteuert; Default = vorhandener Site-Port.
#       - Verifikation (Schritt 12) prüft exakt den effektiven Port/Modus.
#     Der markierte Block wird vom Container-E2E (cockpit/test-deploy-inner.sh)
#     1:1 extrahiert und getestet — Marken daher nicht verschieben.
# ---------------------------------------------------------------------------
# >>> site-logik
SITE_FILE="${SITE_FILE:-/etc/nginx/sites-available/wireguard-ops-cockpit}"
SITE_LINK="${SITE_LINK:-/etc/nginx/sites-enabled/wireguard-ops-cockpit}"
TLS_CERT_FALLBACK="${TLS_CERT_FALLBACK:-/etc/nginx/ssl/wireguard-ops-cockpit.crt}"
TLS_KEY_FALLBACK="${TLS_KEY_FALLBACK:-/etc/nginx/ssl/wireguard-ops-cockpit.key}"

# WEB_PORT: explizit gesetzt? (Default wird in site_resolve bestimmt:
# vorhandener Site-Port; Neuanlage: 8080)
WEB_PORT_EXPLICIT="no"
if [ -n "${WEB_PORT:-}" ]; then WEB_PORT_EXPLICIT="yes"; fi
WEB_PORT="${WEB_PORT:-8080}"

# Liest die bestehende Site-Datei. Ergebnis in:
#   SITE_EXISTS        yes | no
#   SITE_PORT          Port aus listen-Zeile (leer, wenn keine parsebar)
#   SITE_TLS           yes | no (listen … ssl oder ssl on)
#   SITE_CERT/SITE_KEY Pfade aus ssl_certificate / ssl_certificate_key
#   SITE_LISTEN_COUNT  Anzahl listen-Zeilen (Hinweis bei >1)
site_detect() {
  SITE_EXISTS="no"; SITE_PORT=""; SITE_TLS="no"; SITE_CERT=""; SITE_KEY=""
  SITE_LISTEN_COUNT=0
  [ -f "$SITE_FILE" ] || return 0
  SITE_EXISTS="yes"
  local listens pick parsed port="" ssl="no"
  listens="$(grep -E '^[[:space:]]*listen[[:space:]]' "$SITE_FILE" || true)"
  SITE_LISTEN_COUNT="$(printf '%s\n' "$listens" | sed '/^[[:space:]]*$/d' | wc -l)"
  # Bevorzugt die ssl-Zeile, sonst die erste listen-Zeile
  pick="$(printf '%s\n' "$listens" | grep -w ssl | head -n1 || true)"
  if [ -z "$pick" ]; then pick="$(printf '%s\n' "$listens" | head -n1 || true)"; fi
  if [ -n "$pick" ]; then
    parsed="$(printf '%s\n' "$pick" | awk '{
      line=$0
      sub(/[[:space:]]*#.*/, "", line)
      sub(/;.*/, "", line)
      sub(/^[[:space:]]*listen[[:space:]]+/, "", line)
      n=split(line, tok, /[[:space:]]+/)
      addr=tok[1]; ssl="no"
      for (i=2; i<=n; i++) if (tok[i]=="ssl") ssl="yes"
      m=split(addr, a, ":")
      print a[m], ssl
    }' || true)"
    read -r port ssl <<< "$parsed" || true
    if [[ "$port" =~ ^[0-9]+$ ]]; then SITE_PORT="$port"; fi
    if [ "$ssl" = "yes" ]; then SITE_TLS="yes"; fi
  fi
  # Alte Schreibweise zusätzlich: ssl on;
  if grep -Eq '^[[:space:]]*ssl[[:space:]]+on[[:space:]]*;' "$SITE_FILE"; then SITE_TLS="yes"; fi
  SITE_CERT="$(grep -E '^[[:space:]]*ssl_certificate[[:space:]]' "$SITE_FILE" | head -n1 \
    | sed -E 's/^[[:space:]]*ssl_certificate[[:space:]]+//; s/[[:space:]]*;.*$//' || true)"
  SITE_KEY="$(grep -E '^[[:space:]]*ssl_certificate_key[[:space:]]' "$SITE_FILE" | head -n1 \
    | sed -E 's/^[[:space:]]*ssl_certificate_key[[:space:]]+//; s/[[:space:]]*;.*$//' || true)"
  return 0
}

# Bestimmt die effektiven Web-Werte und legt sie fest:
#   WEB_PORT (effektiv), WEB_PORT_QUELLE (Text), WEB_TLS (yes/no),
#   WEB_CERT, WEB_KEY (nur bei TLS)
site_resolve() {
  if [ "$SITE_EXISTS" = "yes" ] && [ -z "$SITE_PORT" ]; then
    die "Site-Datei $SITE_FILE vorhanden, aber keine brauchbare listen-Zeile gefunden — nichts geändert, bitte Datei prüfen."
  fi
  WEB_TLS="no"; WEB_CERT=""; WEB_KEY=""
  if [ "$SITE_EXISTS" = "yes" ]; then
    if [ "$WEB_PORT_EXPLICIT" = "yes" ]; then
      WEB_PORT_QUELLE="WEB_PORT explizit (${WEB_PORT})"
    else
      WEB_PORT="$SITE_PORT"
      WEB_PORT_QUELLE="Ist-Zustand (Port ${SITE_PORT})"
    fi
    if [ "$SITE_TLS" = "yes" ]; then
      WEB_TLS="yes"
      WEB_CERT="${SITE_CERT:-$TLS_CERT_FALLBACK}"
      WEB_KEY="${SITE_KEY:-$TLS_KEY_FALLBACK}"
      [ -r "$WEB_CERT" ] || die "Site nutzt TLS, aber Zertifikat fehlt/nicht lesbar: $WEB_CERT — nichts geändert."
      [ -r "$WEB_KEY" ]  || die "Site nutzt TLS, aber Schlüssel fehlt/nicht lesbar: $WEB_KEY — nichts geändert."
    fi
  else
    WEB_PORT_QUELLE="Default/Neuanlage (${WEB_PORT})"
  fi
}

# Rendert die Site-Konfiguration nach stdout:
#   $1=Binde-IP  $2=Port  $3=tls(yes/no)  $4=Zertifikat  $5=Key  $6=Webroot
# Bei tls=yes, gleichen Werten und WEBROOT ist die Ausgabe byte-identisch zur
# Referenz cockpit/nginx-wireguard-ops-cockpit.conf — ein Re-Run auf der
# unveränderten Kiste ist damit ein echter No-Op (kein Schreiben, kein Backup).
site_render() {
  local bind_ip="$1" port="$2" tls="$3" cert="$4" key="$5" webroot="$6"
  printf 'server {\n'
  if [ "$tls" = "yes" ]; then
    printf '  listen %s:%s ssl;\n' "$bind_ip" "$port"
  else
    printf '  listen %s:%s;\n' "$bind_ip" "$port"
  fi
  printf '  server_name _;\n'
  if [ "$tls" = "yes" ]; then
    printf '\n'
    printf '  ssl_certificate     %s;\n' "$cert"
    printf '  ssl_certificate_key %s;\n' "$key"
    printf '  ssl_protocols TLSv1.2 TLSv1.3;\n'
  fi
  printf '\n'
  printf '  root %s;\n' "$webroot"
  printf '  index index.html;\n'
  printf '\n'
  printf '  add_header X-Content-Type-Options nosniff always;\n'
  printf '  add_header Referrer-Policy same-origin always;\n'
  printf '  add_header X-Frame-Options SAMEORIGIN always;\n'
  printf '\n'
  printf '  location /api/ {\n'
  printf '    proxy_pass http://127.0.0.1:3001;\n'
  printf '    proxy_http_version 1.1;\n'
  printf '    proxy_set_header Host $host;\n'
  printf '    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;\n'
  printf '    proxy_set_header X-Forwarded-Proto $scheme;\n'
  printf '  }\n'
  printf '\n'
  printf '  location /terminal/ {\n'
  printf '    proxy_pass http://127.0.0.1:7681/terminal/;\n'
  printf '    proxy_http_version 1.1;\n'
  printf '    proxy_set_header Host $host;\n'
  printf '    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;\n'
  printf '    proxy_set_header X-Forwarded-Proto $scheme;\n'
  printf '    proxy_set_header Upgrade $http_upgrade;\n'
  printf '    proxy_set_header Connection "upgrade";\n'
  printf '    proxy_read_timeout 86400;\n'
  printf '  }\n'
  printf '\n'
  printf '  location / {\n'
  printf '    try_files $uri $uri/ /index.html;\n'
  printf '  }\n'
  printf '}\n'
}

# Schreibt die Site nur bei echter Änderung; die Vorgänger-Version wird vorher
# gesichert (Backup: $SITE_FILE.bak-<zeitstempel>). Nutzt die effektiven Werte
# aus site_resolve. Ausgaben beschreiben, was passiert ist.
site_install() {
  local tmp bak
  tmp="$(mktemp)"
  site_render "$WG_BIND_IP" "$WEB_PORT" "$WEB_TLS" "$WEB_CERT" "$WEB_KEY" "$WEBROOT" > "$tmp"
  if [ -f "$SITE_FILE" ] && cmp -s "$tmp" "$SITE_FILE"; then
    printf 'Site unverändert — kein Schreibvorgang (%s).\n' "$SITE_FILE"
    rm -f "$tmp"
    return 0
  fi
  if [ -f "$SITE_FILE" ]; then
    bak="${SITE_FILE}.bak-$(date +%Y%m%d-%H%M%S)"
    cp -a "$SITE_FILE" "$bak"
    printf 'Backup der bisherigen Site: %s\n' "$bak"
  fi
  install -m 0644 -o root -g root "$tmp" "$SITE_FILE"
  rm -f "$tmp"
  printf 'Site geschrieben: %s (Port %s, TLS %s).\n' "$SITE_FILE" "$WEB_PORT" "$WEB_TLS"
}

# Effektive Web-URL (Schema nach WEB_TLS) — für Logs und Verifikation.
site_url() {
  if [ "$WEB_TLS" = "yes" ]; then
    printf 'https://%s:%s' "$WG_BIND_IP" "$WEB_PORT"
  else
    printf 'http://%s:%s' "$WG_BIND_IP" "$WEB_PORT"
  fi
}
# <<< site-logik

site_detect
site_resolve
log "0b) Web-Site (Ist-Zustand)"
if [ "$SITE_EXISTS" = "yes" ]; then
  echo "Datei:     $SITE_FILE — vorhanden (${SITE_LISTEN_COUNT} listen-Zeile(n))"
  echo "Ist:       Port ${SITE_PORT}, TLS ${SITE_TLS}${SITE_CERT:+ — Zertifikat $SITE_CERT}"
  if [ "${SITE_LISTEN_COUNT:-0}" -gt 1 ]; then
    echo "HINWEIS:   mehrere listen-Zeilen — effektiv verwendet wird Port ${SITE_PORT}."
  fi
else
  echo "Datei:     $SITE_FILE — fehlt (Neuanlage)"
fi
echo "Effektiv:  ${WG_BIND_IP}:${WEB_PORT}, TLS ${WEB_TLS} (Quelle: ${WEB_PORT_QUELLE})"

# ---------------------------------------------------------------------------
# 1) Pakete (apt beweist zugleich Netz Richtung Mirror)
# ---------------------------------------------------------------------------
log "1) Pakete installieren"
export DEBIAN_FRONTEND=noninteractive
# Additiv bleiben: nginx-Zustand VOR der Installation merken
NGINX_PREEXISTED="no"; command -v nginx >/dev/null 2>&1 && NGINX_PREEXISTED="yes"
apt-get update -qq || die "apt-get update fehlgeschlagen (Netz/Mirror?)."
apt-get install -y -qq --no-install-recommends \
  ca-certificates curl git tmux ttyd nginx openssl python3 sudo \
  || die "Paketinstallation fehlgeschlagen (ttyd/nginx verfügbar? Universe aktiv?)."
if [ "$NGINX_PREEXISTED" = "no" ]; then
  systemctl disable --now nginx >/dev/null 2>&1 || true   # frisch installiert: erst nach Konfiguration aktivieren
fi

# Netz Richtung github + npm prüfen
curl -fsS --max-time 15 -o /dev/null "https://github.com/JSchmid6/wireguard-ops-cockpit" \
  || die "github.com nicht erreichbar. Fallback (Offline-Transfer über den VPS) nötig — stoppen und melden."
curl -fsS --max-time 15 -o /dev/null "https://registry.npmjs.org/" \
  || die "registry.npmjs.org nicht erreichbar. Stoppen und melden."

# ---------------------------------------------------------------------------
# 2) Node-Runtime v20.19.1 (gepinnt, Prüfsumme verifiziert)
# ---------------------------------------------------------------------------
log "2) Node $NODE_DIR sicherstellen"
if [ ! -x "$NODE_DIR/bin/node" ]; then
  tarball="$SECRETS_DIR/node-v20.19.1-linux-x64.tar.xz"
  if [ ! -f "$tarball" ]; then
    curl -fL --max-time 300 -o "$tarball" "$NODE_PKG_URL" || die "Node-Tarball-Download fehlgeschlagen."
  fi
  echo "$NODE_SHA256  $tarball" | sha256sum -c - >/dev/null || die "Node-Tarball-Prüfsumme stimmt nicht — abgebrochen."
  tar -xJf "$tarball" -C /opt
else
  echo "Node bereits vorhanden."
fi
[ -x "$NODE_DIR/bin/node" ] || die "Node-Installation unvollständig."
"$NODE_DIR/bin/node" --version | grep -q "v20.19.1" || die "Falsche Node-Version aktiv."

# /usr/bin/node für Helper-Shebang (#!/usr/bin/node) — 20.19.1, falls nichts vorhanden
if [ ! -e /usr/bin/node ]; then ln -s "$NODE_DIR/bin/node" /usr/bin/node; fi

# ---------------------------------------------------------------------------
# 3) Service-User und Gruppen (angelehnt an VPS-Referenz)
# ---------------------------------------------------------------------------
log "3) Benutzer/Gruppen"
getent group wgops >/dev/null || groupadd --system wgops
id -u wgops >/dev/null 2>&1 || useradd --system -m -d "$STATE_DIR" -s /bin/bash -g wgops wgops

getent group cockpit-agent-client >/dev/null || groupadd --system cockpit-agent-client
id -u cockpit-agent >/dev/null 2>&1 || useradd --system -m -d "$AGENT_DIR" -s /usr/sbin/nologin -g cockpit-agent-client cockpit-agent

getent group cockpit-executor-client >/dev/null || groupadd --system cockpit-executor-client
id -u cockpit-executor >/dev/null 2>&1 || useradd --system -m -d "$EXEC_DIR" -s /usr/sbin/nologin -g cockpit-executor-client cockpit-executor

usermod -aG cockpit-agent-client wgops
usermod -aG cockpit-executor-client wgops

# ---------------------------------------------------------------------------
# 4) Verzeichnisse
# ---------------------------------------------------------------------------
log "4) Verzeichnisse"
install -d -m 0750 -o wgops -g wgops "$STATE_DIR"
install -d -m 0700 -o wgops -g wgops "$STATE_DIR/capabilities"
install -d -m 0700 -o root  -g root  "$STATE_DIR/capability-snapshots"
install -d -m 0750 -o cockpit-agent -g cockpit-agent-client "$AGENT_DIR"
install -d -m 0700 -o cockpit-agent -g cockpit-agent-client "$AGENT_DIR/sessions"
install -d -m 0750 -o cockpit-executor -g cockpit-executor-client "$EXEC_DIR"
install -d -m 0700 -o root -g root "$ENV_DIR"
install -d -m 0755 /usr/local/lib/wireguard-ops-cockpit
chmod 0750 "$STATE_DIR" "$AGENT_DIR" "$EXEC_DIR"
chmod 0700 "$AGENT_DIR/sessions"
chown wgops:wgops "$STATE_DIR"
chown cockpit-agent:cockpit-agent-client "$AGENT_DIR" "$AGENT_DIR/sessions"
chown cockpit-executor:cockpit-executor-client "$EXEC_DIR"

# ---------------------------------------------------------------------------
# 5) Repo auf Pin-Stand bauen
# ---------------------------------------------------------------------------
log "5) Repository + Build (Commit $REPO_COMMIT)"
# Vorher-Stand für den Selbst-Update-State festhalten (vor dem Umstellen; leer bei Erstinstallation)
# >>> self-update-prev
SELF_UPDATE_PREV=""
if [ -d "$COCKPIT_DIR/.git" ]; then
  SELF_UPDATE_PREV="$(git -C "$COCKPIT_DIR" rev-parse HEAD 2>/dev/null || true)"
  printf '%s' "$SELF_UPDATE_PREV" | grep -Eq '^[a-f0-9]{40}$' || SELF_UPDATE_PREV=""
else
  git clone --quiet "$REPO_URL" "$COCKPIT_DIR"
fi
# <<< self-update-prev
if [ -n "$(git -C "$COCKPIT_DIR" status --porcelain)" ]; then
  die "Repo $COCKPIT_DIR hat lokale Änderungen — bitte melden, nichts überschreiben."
fi
git -C "$COCKPIT_DIR" fetch --quiet origin
git -C "$COCKPIT_DIR" -c advice.detachedHead=false checkout --quiet --detach "$REPO_COMMIT"
export PATH="$NODE_DIR/bin:$PATH"
(cd "$COCKPIT_DIR" && npm ci --no-audit --no-fund) \
  || die "npm ci fehlgeschlagen (bei better-sqlite3-Kompilierfehlern: build-essential nachinstallieren)."
(cd "$COCKPIT_DIR" && npm run build) || die "Build fehlgeschlagen."
[ -f "$COCKPIT_DIR/apps/api/dist/index.js" ] || die "API-Build fehlt."
[ -f "$COCKPIT_DIR/apps/web/dist/index.html" ] || die "Web-Build fehlt."

# ---------------------------------------------------------------------------
# 6) Secrets + Environment-Dateien (Secrets bleiben auf der Kiste)
# ---------------------------------------------------------------------------
log "6) Secrets und /etc/wireguard-ops-cockpit"
umask 077
GEN_FILE="$SECRETS_DIR/generated.env"
if [ ! -f "$GEN_FILE" ]; then
  {
    echo "ENVELOPE_SECRET=$(openssl rand -hex 32)"
    echo "BROKER_SECRET=$(openssl rand -hex 32)"
    echo "TERMINAL_SECRET=$(openssl rand -hex 32)"
    echo "ADMIN_PW=$(openssl rand -base64 18 | tr -d '/+=' | cut -c1-24)"
  } > "$GEN_FILE"
  chmod 600 "$GEN_FILE"
fi
# shellcheck disable=SC1090
. "$GEN_FILE"

# DeepSeek-Key: aus Umgebung oder /root/cockpit-deploy/deepseek.env
if [ -z "${DEEPSEEK_API_KEY:-}" ] && [ -f "$SECRETS_DIR/deepseek.env" ]; then
  # shellcheck disable=SC1090
  . "$SECRETS_DIR/deepseek.env"
fi
[ -n "${DEEPSEEK_API_KEY:-}" ] || die "DEEPSEEK_API_KEY fehlt. Erwartet: $SECRETS_DIR/deepseek.env (kommt vom VPS)."

if [ ! -f "$COCKPIT_DIR/.env" ]; then
  cat > "$COCKPIT_DIR/.env" <<EOF
COCKPIT_ADMIN_USERNAME=admin
COCKPIT_ADMIN_PASSWORD=$ADMIN_PW
COCKPIT_API_HOST=127.0.0.1
COCKPIT_API_PORT=3001
COCKPIT_DB_PATH=$STATE_DIR/cockpit.sqlite
COCKPIT_SESSION_TTL_HOURS=12
COCKPIT_COOKIE_SECURE=false
COCKPIT_TMUX_MODE=auto
COCKPIT_PLANNER_RUNTIME=opencode
COCKPIT_OPENCODE_EXECUTABLE=opencode
COCKPIT_OPENCODE_MODEL=deepseek/deepseek-v4-pro
COCKPIT_SAFETY_OPENCODE_MODEL=deepseek/deepseek-v4-pro
COCKPIT_REQUIRE_MODEL_DIVERSITY=false
COCKPIT_APPROVAL_TTL_MINUTES=30
COCKPIT_MAX_FAILED_CHANGES_PER_HOUR=3
COCKPIT_TTYD_BASE_URL=/terminal
COCKPIT_TERMINAL_SIGNING_SECRET=$TERMINAL_SECRET
COCKPIT_BIND_IP=$WG_BIND_IP
COCKPIT_WEB_PORT=$WEB_PORT
VITE_API_BASE=/api
EOF
  chmod 600 "$COCKPIT_DIR/.env"
fi

[ -f "$ENV_DIR/api.env" ] || cat > "$ENV_DIR/api.env" <<EOF
COCKPIT_EXECUTION_ENVELOPE_SECRET=$ENVELOPE_SECRET
COCKPIT_EXECUTOR_BROKER_SECRET=$BROKER_SECRET
COCKPIT_AGENT_BROKER_SOCKET=/run/cockpit-agent/agent.sock
COCKPIT_EXECUTOR_BROKER_SOCKET=/run/cockpit-executor/executor.sock
EOF

[ -f "$ENV_DIR/agent.env" ] || cat > "$ENV_DIR/agent.env" <<EOF
DEEPSEEK_API_KEY=$DEEPSEEK_API_KEY
COCKPIT_OPENCODE_MODEL=deepseek/deepseek-v4-pro
COCKPIT_SAFETY_OPENCODE_MODEL=deepseek/deepseek-v4-pro
EOF

[ -f "$ENV_DIR/executor.env" ] || cat > "$ENV_DIR/executor.env" <<EOF
COCKPIT_EXECUTOR_BROKER_SECRET=$BROKER_SECRET
EOF

[ -f "$ENV_DIR/admin-recovery.env" ] || cat > "$ENV_DIR/admin-recovery.env" <<EOF
COCKPIT_ADMIN_USERNAME=admin
COCKPIT_ADMIN_PASSWORD=$ADMIN_PW
EOF

chmod 600 "$ENV_DIR"/*.env
chown root:root "$ENV_DIR"/*.env
umask 022   # ab hier wieder normale Rechte für Build-/Web-Dateien

# ---------------------------------------------------------------------------
# 7) systemd-Units (4 Dienste + API-Drop-in)
# ---------------------------------------------------------------------------
log "7) systemd-Units installieren"
install -m 644 "$COCKPIT_DIR/deploy/systemd/wireguard-ops-cockpit-api.service"      /etc/systemd/system/
install -m 644 "$COCKPIT_DIR/deploy/systemd/wireguard-ops-cockpit-ttyd.service"     /etc/systemd/system/
install -m 644 "$COCKPIT_DIR/deploy/systemd/wireguard-ops-cockpit-agent.service"    /etc/systemd/system/
install -m 644 "$COCKPIT_DIR/deploy/systemd/wireguard-ops-cockpit-executor.service" /etc/systemd/system/
install -d -m 755 /etc/systemd/system/wireguard-ops-cockpit-api.service.d
install -m 644 "$COCKPIT_DIR/deploy/systemd/wireguard-ops-cockpit-api-brokers.conf" \
  /etc/systemd/system/wireguard-ops-cockpit-api.service.d/brokers.conf
cat > /etc/systemd/system/wireguard-ops-cockpit-api.service.d/api-keys.conf <<'EOF'
[Service]
EnvironmentFile=/etc/wireguard-ops-cockpit/api.env
EOF

# ---------------------------------------------------------------------------
# 8) Helper (root-eigen, gepinnte Pfade) + sudoers
# ---------------------------------------------------------------------------
log "8) Helper + sudoers"
install -m 755 -o root -g root "$COCKPIT_DIR/deploy/helpers/cockpit-service-action" \
  /usr/local/sbin/cockpit-service-action
# Allowlist der Kiste anpassen: nginx statt apache2 (Rest unverändert lassen!)
sed -i 's/apache2|wireguard-ops-cockpit-ttyd/nginx|wireguard-ops-cockpit-ttyd/' /usr/local/sbin/cockpit-service-action
grep -q 'nginx|wireguard-ops-cockpit-ttyd' /usr/local/sbin/cockpit-service-action \
  || die "Allowlist-Anpassung cockpit-service-action fehlgeschlagen."

# Typed-Disk-Helfer (mdadm auf dem IMSM-Container /dev/md127; disk.manage)
[ -f "$COCKPIT_DIR/deploy/helpers/cockpit-disk-action" ] \
  || die "deploy/helpers/cockpit-disk-action fehlt im Checkout ($REPO_COMMIT) — Skript mit REPO_COMMIT=<merge-sha> erneut ausführen."
install -m 755 -o root -g root "$COCKPIT_DIR/deploy/helpers/cockpit-disk-action" \
  /usr/local/sbin/cockpit-disk-action
command -v mdadm >/dev/null 2>&1 \
  || echo "HINWEIS: mdadm fehlt — cockpit-disk-action kann erst nach 'apt-get install -y mdadm' arbeiten."

install -m 755 -o root -g root "$COCKPIT_DIR/deploy/helpers/cockpit-capability-action" \
  /usr/local/lib/wireguard-ops-cockpit/cockpit-capability-action.mjs
install -m 755 -o root -g root "$COCKPIT_DIR/deploy/helpers/cockpit-exact-file-replace" \
  /usr/local/sbin/cockpit-exact-file-replace
install -m 755 -o root -g root "$COCKPIT_DIR/deploy/recovery/cockpit-break-glass" \
  /usr/local/sbin/cockpit-break-glass

# Selbst-Update-Baustein (Modul; Vertrag + Install-Zeilen: doc/setup/self-update.md)
[ -f "$COCKPIT_DIR/deploy/helpers/cockpit-self-update-action" ] \
  || die "deploy/helpers/cockpit-self-update-action fehlt im Checkout ($REPO_COMMIT) — Skript mit REPO_COMMIT=<merge-sha> erneut ausführen."
install -d -m 0700 -o root -g root "$STATE_DIR/self-update"
install -d -m 0750 -o root -g root /var/log/wireguard-ops-cockpit-self-update
install -m 755 -o root -g root "$COCKPIT_DIR/deploy/helpers/cockpit-self-update-action" \
  /usr/local/sbin/cockpit-self-update-action
install -m 755 -o root -g root "$COCKPIT_DIR/deploy/helpers/cockpit-self-update-run" \
  /usr/local/lib/wireguard-ops-cockpit/cockpit-self-update-run
install -m 644 "$COCKPIT_DIR/deploy/systemd/wireguard-ops-cockpit-self-update@.service" \
  /etc/systemd/system/wireguard-ops-cockpit-self-update@.service
# Sicherheitsnetz des Selbst-Updates (Kopie vor dem Update, Rückfall bei Fehler)
# und dieses Skript selbst — der Runner ruft genau diese installierte Kopie.
# Neues Inode (install in temp + mv): ein laufender bash liest sein altes Skript
# weiter, auch wenn er sich gerade selbst ersetzt.
for f in deploy/helpers/cockpit-self-update-snapshot deploy/lab0/homeserver-cockpit-deploy.sh; do
  [ -f "$COCKPIT_DIR/$f" ] \
    || die "$f fehlt im Checkout ($REPO_COMMIT) — Skript mit REPO_COMMIT=<merge-sha> erneut ausführen."
  tgt="/usr/local/lib/wireguard-ops-cockpit/$(basename "$f")"
  install -m 755 -o root -g root "$COCKPIT_DIR/$f" "$tgt.new-$$"
  mv -f "$tgt.new-$$" "$tgt"
done

# Die eine Tür (doc/setup/host-run.md), wie auf dem VPS (vps-cockpit-deploy.sh, Tabelle):
# Root-Helfer, Backup-Riegel daneben und die Unit, die Läufe nach einem Neustart
# fortsetzt. Der Riegel importiert die Grenzen-Datei aus dem Aufräum-Block unten —
# beide liegen nach diesem Schritt im selben Verzeichnis (Claude, 02.10.2026).
[ -f "$COCKPIT_DIR/deploy/helpers/cockpit-host-run" ] \
  || die "deploy/helpers/cockpit-host-run fehlt im Checkout ($REPO_COMMIT) — Skript mit REPO_COMMIT=<merge-sha> erneut ausführen."
install -m 755 -o root -g root "$COCKPIT_DIR/deploy/helpers/cockpit-host-run" \
  /usr/local/lib/wireguard-ops-cockpit/cockpit-host-run.mjs
install -m 644 -o root -g root "$COCKPIT_DIR/deploy/helpers/cockpit-backup-guard.mjs" \
  /usr/local/lib/wireguard-ops-cockpit/cockpit-backup-guard.mjs
install -m 644 "$COCKPIT_DIR/deploy/systemd/wireguard-ops-cockpit-host-run-resume.service" \
  /etc/systemd/system/wireguard-ops-cockpit-host-run-resume.service

# Aufräum-Dienst des borg-Repos (Vertrag + Grenzen: doc/setup/borg-retention.md).
# Läuft als borg (Besitzer des Repos); die Passphrase legt Jochen/Claude einmalig
# als /etc/cockpit-borg-retention/passphrase (root, 0600) ab — nicht dieses Skript.
[ -f "$COCKPIT_DIR/deploy/helpers/cockpit-borg-retention.mjs" ] \
  || die "deploy/helpers/cockpit-borg-retention.mjs fehlt im Checkout ($REPO_COMMIT) — Skript mit REPO_COMMIT=<merge-sha> erneut ausführen."
id borg >/dev/null 2>&1 || die "Benutzer borg fehlt — der Aufräum-Dienst läuft als Besitzer des Repos."
install -m 755 -o root -g root "$COCKPIT_DIR/deploy/helpers/cockpit-borg-retention" \
  /usr/local/sbin/cockpit-borg-retention
install -m 755 -o root -g root "$COCKPIT_DIR/deploy/helpers/cockpit-borg-retention.mjs" \
  /usr/local/lib/wireguard-ops-cockpit/cockpit-borg-retention.mjs
install -m 644 -o root -g root "$COCKPIT_DIR/deploy/helpers/cockpit-borg-retention-rules.mjs" \
  /usr/local/lib/wireguard-ops-cockpit/cockpit-borg-retention-rules.mjs
install -m 644 "$COCKPIT_DIR/deploy/systemd/cockpit-borg-retention.service" \
  /etc/systemd/system/cockpit-borg-retention.service
install -m 644 "$COCKPIT_DIR/deploy/systemd/cockpit-borg-retention.timer" \
  /etc/systemd/system/cockpit-borg-retention.timer
install -d -m 0755 -o root -g root /etc/cockpit-borg-retention
[ -f /etc/cockpit-borg-retention/passphrase ] \
  || echo "HINWEIS: /etc/cockpit-borg-retention/passphrase fehlt — der Aufräum-Dienst startet erst, wenn sie (root, 0600) abgelegt ist."

visudo -cf "$COCKPIT_DIR/deploy/sudoers/cockpit-executor" >/dev/null \
  || die "sudoers-Vorlage ungültig — nichts installiert, nichts aktiv."
install -m 440 -o root -g root "$COCKPIT_DIR/deploy/sudoers/cockpit-executor" /etc/sudoers.d/cockpit-executor
visudo -c >/dev/null || { rm -f /etc/sudoers.d/cockpit-executor; die "Gesamtprüfung sudoers fehlgeschlagen — Datei wieder entfernt."; }

# ---------------------------------------------------------------------------
# 9) Agent-Runtime: OpenCode + Konfiguration
# ---------------------------------------------------------------------------
log "9) OpenCode installieren (Agent-Runtime, Version $OPENCODE_VERSION)"
umask 022   # npm-globale Dateien müssen für cockpit-agent lesbar sein (sonst EACCES)
npm install -g --silent "opencode-ai@$OPENCODE_VERSION"
test -x "$NODE_DIR/bin/opencode" || die "opencode-Binary nicht gefunden ($NODE_DIR/bin/opencode)."
chmod -R a+rX "$NODE_DIR/lib/node_modules/opencode-ai" 2>/dev/null || true
runuser -u cockpit-agent -- test -x "$NODE_DIR/bin/opencode" \
  || die "opencode ist für cockpit-agent nicht ausführbar — Rechte prüfen."
timeout 60 runuser -u cockpit-agent -- env HOME="$AGENT_DIR" "$NODE_DIR/bin/opencode" --version >/dev/null 2>&1 \
  || die "opencode --version schlägt als cockpit-agent fehl (runuser-Test)."
ln -sfn "$NODE_DIR/bin/opencode" /usr/local/bin/opencode
install -d -m 0750 -o cockpit-agent -g cockpit-agent-client "$AGENT_DIR/.config/opencode"
install -m 600 -o cockpit-agent -g cockpit-agent-client \
  "$COCKPIT_DIR/deploy/config/opencode-agent.jsonc" "$AGENT_DIR/.config/opencode/opencode.jsonc"

# ---------------------------------------------------------------------------
# 10) Web-Frontend über nginx (nur WG-IP; Port/TLS aus Ist-Zustand, Re-Run-sicher)
# ---------------------------------------------------------------------------
log "10) Web (nginx, Bindung $WG_BIND_IP:$WEB_PORT, TLS: $WEB_TLS)"
install -d -m 0755 "$WEBROOT"
cp -a "$COCKPIT_DIR/apps/web/dist/." "$WEBROOT/"
chown -R root:root "$WEBROOT"

# Site nur bei echter Änderung schreiben; Vorgänger-Version wird automatisch
# gesichert. Port/TLS/Zertifikatspfade stammen aus dem Ist-Zustand (Block 0b) —
# der v3-Fehler (TLS-Site → 8080/HTTP überschrieben) kann so nicht wiederkehren.
site_install

ln -sfn ../sites-available/wireguard-ops-cockpit /etc/nginx/sites-enabled/wireguard-ops-cockpit
if [ "$NGINX_PREEXISTED" = "no" ]; then
  rm -f /etc/nginx/sites-enabled/default   # frische Installation: Beispielseite raus
else
  echo "HINWEIS: nginx war vorher installiert — default-Site bleibt unangetastet."
fi

# nginx erst starten, wenn wg0 da ist; bei Start-Race automatisch neu versuchen.
install -d -m 755 /etc/systemd/system/nginx.service.d
cat > /etc/systemd/system/nginx.service.d/wait-wg0.conf <<'EOF'
[Unit]
Wants=sys-subsystem-net-devices-wg0.device wg-quick@wg0.service
After=sys-subsystem-net-devices-wg0.device wg-quick@wg0.service

[Service]
Restart=on-failure
RestartSec=5
EOF

nginx -t >/dev/null || die "nginx-Konfiguration ungültig — die laufende Konfiguration bleibt aktiv; Rückweg: Backup .bak-* neben $SITE_FILE. Bitte $SITE_FILE prüfen."

# Firewall: nur falls ufw aktiv — Zugriff aus dem WG-Netz erlauben
if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active"; then
  ufw allow in on wg0 proto tcp from 10.0.0.0/24 to "$WG_BIND_IP" port "$WEB_PORT" comment 'cockpit web (wg)' >/dev/null || true
fi

# ---------------------------------------------------------------------------
# 11) Starten
# ---------------------------------------------------------------------------
log "11) Dienste starten"
systemctl daemon-reload
systemctl enable nginx >/dev/null 2>&1 || true   # Boot-Autostart; Start/Reload entscheidet der Block darunter
if systemctl is-active --quiet nginx; then
  # Re-Run-Falle (Befund 25.09.): 'enable --now' startet einen LAUFENDEN nginx
  # nicht neu — ohne Reload bliebe die alte In-Memory-Config aktiv, obwohl die
  # Datei auf der Platte bereits ersetzt wurde.
  systemctl reload nginx || die "nginx-Reload fehlgeschlagen — journalctl -u nginx. Der laufende nginx behält seine bisherige Konfiguration."
  echo "nginx: Konfiguration neu geladen ($SITE_FILE ist jetzt aktiv)."
else
  systemctl start nginx
  echo "nginx: gestartet."
fi
systemctl enable --now wireguard-ops-cockpit-api wireguard-ops-cockpit-ttyd \
  wireguard-ops-cockpit-agent wireguard-ops-cockpit-executor
# Aufräum-Dienst: nur der Timer läuft dauerhaft; der Lauf selbst ist ein oneshot.
systemctl enable --now cockpit-borg-retention.timer
# Tür: Fortsetzen nach einem Neustart-Schritt (nur enable, wie auf dem VPS).
systemctl enable --quiet wireguard-ops-cockpit-host-run-resume.service
# Re-Run-Falle (Befund 25.09., Review t_57244697/I2): 'enable --now' startet einen
# LAUFENDEN Dienst nicht neu — nach einem Re-Run liefen API + beide Broker weiter mit
# dem alten In-Memory-Code (die SMART-/Self-Update-Strecke braucht den neuen Stand).
# Daher hier der explizite Zyklus der vier Cockpit-Dienste; im Selbst-Update
# (COCKPIT_RESTART_MODE=defer) wird er übersprungen — den Neustart übernimmt dort
# die geplante Aktivierung des Selbst-Update-Runners.
# >>> dienste-zyklus
case "${COCKPIT_RESTART_MODE:-}" in
  defer)
    echo "COCKPIT_RESTART_MODE=defer — Dienste-Zyklus übersprungen (Aktivierung übernimmt der Selbst-Update-Runner)."
    ;;
  *)
    systemctl restart wireguard-ops-cockpit-api wireguard-ops-cockpit-agent \
      wireguard-ops-cockpit-executor wireguard-ops-cockpit-ttyd \
      || die "Cockpit-Dienste-Neustart fehlgeschlagen — journalctl -u wireguard-ops-cockpit-<dienst> prüfen."
    echo "Cockpit-Dienste neu gestartet (neuer Stand aktiv)."
    ;;
esac
# <<< dienste-zyklus

# ---------------------------------------------------------------------------
# 12) Verifikation (Abnahme)
# ---------------------------------------------------------------------------
log "12) Verifikation"
sleep 3
for svc in api ttyd agent executor; do
  systemctl is-active --quiet "wireguard-ops-cockpit-$svc" \
    || die "wireguard-ops-cockpit-$svc nicht aktiv — journalctl -u wireguard-ops-cockpit-$svc"
done
echo "Dienste: alle 4 aktiv."

[ -S /run/cockpit-agent/agent.sock ]     || die "agent.sock fehlt."
[ -S /run/cockpit-executor/executor.sock ] || die "executor.sock fehlt."
echo "Broker-Sockets: vorhanden."

curl -fsS --max-time 10 http://127.0.0.1:3001/api/health | grep -q '"ok":true' \
  || die "API-Health nicht ok."
echo "API: http://127.0.0.1:3001/api/health = ok."

ttyd_code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 http://127.0.0.1:7681/terminal/ || true)
[ "$ttyd_code" = "200" ] || die "ttyd antwortet nicht (HTTP $ttyd_code)."
echo "ttyd: HTTP 200 auf 127.0.0.1:7681/terminal/."

if ip -brief a 2>/dev/null | grep -qw "$WG_BIND_IP"; then
  # Verifikation IMMER gegen den effektiv konfigurierten Port/Modus der Site
  # (Befund 25.09.: Check auf Fremdport 8080 traf dort code-server → HTTP 302).
  WEB_URL="$(site_url)"
  web_curl=()
  if [ "$WEB_TLS" = "yes" ]; then web_curl=(-k); fi   # -k: Selbst-Check auf der Kiste; Trust-Prüfung ist Client-Aufgabe
  web_code=$(curl "${web_curl[@]}" -s -o /dev/null -w '%{http_code}' --max-time 10 "$WEB_URL/" || true)
  [ "$web_code" = "200" ] || die "Web antwortet nicht auf $WEB_URL/ (HTTP $web_code) — ss -ltnp | grep ':${WEB_PORT}'; journalctl -u nginx"
  echo "Web: HTTP 200 auf $WEB_URL/."
  curl "${web_curl[@]}" -s --max-time 10 "$WEB_URL/api/health" | grep -q '"ok":true' \
    || die "API-Health über nginx ($WEB_URL/api/health) nicht ok — Proxy-Kette prüfen."
  echo "Web→API: $WEB_URL/api/health = ok."
else
  echo "HINWEIS: $WG_BIND_IP ist derzeit nicht lokal aktiv (WireGuard noch nicht oben?) — Web-Check übersprungen."
fi

# ---------------------------------------------------------------------------
# 12b) Selbst-Update-State verbuchen (Vertrag: doc/setup/self-update.md)
#      Das Skript schreibt den deployten Stand inkl. web_url; der Selbst-Update-
#      Runner liest und pflegt dieselbe Datei und prüft damit seinen Web-Check.
#      Geschrieben wird erst nach erfolgreicher Verifikation: deployed_commit =
#      neuer HEAD, previous_commit = Stand vor diesem Lauf (leer bei Erstlauf).
#      Im defer-Lauf ist genau das die Buchung, die der Runner erwartet.
# ---------------------------------------------------------------------------
# >>> self-update-state
if [ -d "$STATE_DIR/self-update" ]; then
  deployed_sha="$(git -C "$COCKPIT_DIR" rev-parse HEAD 2>/dev/null || true)"
  if ! printf '%s' "$deployed_sha" | grep -Eq '^[a-f0-9]{40}$'; then
    die "Selbst-Update-State: HEAD von $COCKPIT_DIR ist kein voller Commit ('$deployed_sha') — nicht verbucht."
  fi
  if [ -n "${SELF_UPDATE_PREV:-}" ]; then prev_txt="${SELF_UPDATE_PREV:0:7}"; else prev_txt="keiner"; fi
  web_url="$(site_url)"
  state_file="$STATE_DIR/self-update/state.json"
  state_tmp="$STATE_DIR/self-update/state.json.tmp-$$"
  {
    printf '{"version": 1, "deployed_commit": "%s", ' "$deployed_sha"
    if [ -n "${SELF_UPDATE_PREV:-}" ]; then
      printf '"previous_commit": "%s", ' "$SELF_UPDATE_PREV"
    else
      printf '"previous_commit": null, '
    fi
    printf '"web_url": "%s", ' "$web_url"
    printf '"updated_at": "%s", ' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    printf '"updated_by": "deploy-script"}\n'
  } > "$state_tmp"
  chmod 0640 "$state_tmp"
  chown root:root "$state_tmp"
  mv -f "$state_tmp" "$state_file"
  echo "Selbst-Update-State verbucht ($state_file): deployed_commit ${deployed_sha:0:7}, previous $prev_txt, web_url $web_url."
else
  echo "HINWEIS: $STATE_DIR/self-update fehlt — Selbst-Update-State nicht verbucht."
fi
# <<< self-update-state

log "Fertig"
cat <<EOF
Ergebnis:
  - Cockpit läuft: API + ttyd (nur localhost), Agent-Broker, Executor-Broker,
    nginx-Web: $(site_url)/  (Port/TLS: ${WEB_PORT_QUELLE})
  - Site-Konfiguration: $SITE_FILE — an den Ist-Zustand angepasst bzw. unverändert
    übernommen; ersetzt wird nur mit Backup (…bak-<zeitstempel>).
  - Admin-Zugangsdaten: /etc/wireguard-ops-cockpit/admin-recovery.env (root, 0600) — NICHT ausgeben, sicher übergeben
  - Secrets: /etc/wireguard-ops-cockpit/*.env + /opt/wireguard-ops-cockpit/.env (root, 0600)
  - Disk-Helfer: /usr/local/sbin/cockpit-disk-action (status|remove|add für /dev/md127);
    Nutzung über Cockpit-Runbook mit allowedCapabilities ["disk.manage"].
    Smoke-Test (root): /usr/local/sbin/cockpit-disk-action status
  - Selbst-Update-Baustein: /usr/local/sbin/cockpit-self-update-action <voll-sha>|status
    (typisierter Job; One-Shot-Unit wireguard-ops-cockpit-self-update@<sha>.service
    führt dieses Skript mit COCKPIT_RESTART_MODE=defer aus). Vertrag: doc/setup/self-update.md
  - Repo-Stand: gepinnt (${REPO_COMMIT:0:7}). Update: Cockpit-Job mit der Planzeile
    /usr/local/sbin/cockpit-self-update-action <voll-sha> (Kopie vorher, Rückfall
    bei Fehler) — oder dieses Skript erneut mit REPO_COMMIT=<neuer-sha> ausführen;
  - Aufräum-Dienst: cockpit-borg-retention.timer (täglich, Vorgabe 06:00; prune +
    compact als borg). Einstellung, Läufe, Bestand und Status im Cockpit
    ("Backup retention"); Vertrag: doc/setup/borg-retention.md.
    Einmalig: Passphrase nach /etc/cockpit-borg-retention/passphrase (root, 0600).
    opencode-Update über OPENCODE_VERSION=<x.y.z>.

Nächster Test (vom VPS aus, sobald WG steht):
  curl -k $(site_url)/api/health
  Browser: $(site_url)  (Login admin / Passwort aus admin-recovery.env)

Rückbau (nur bei Bedarf, als root):
  systemctl disable --now wireguard-ops-cockpit-api wireguard-ops-cockpit-ttyd wireguard-ops-cockpit-agent wireguard-ops-cockpit-executor
  # Tür (doc/setup/host-run.md):
  #   systemctl disable wireguard-ops-cockpit-host-run-resume.service
  #   rm -f /usr/local/lib/wireguard-ops-cockpit/cockpit-host-run.mjs /usr/local/lib/wireguard-ops-cockpit/cockpit-backup-guard.mjs \
  #         /etc/systemd/system/wireguard-ops-cockpit-host-run-resume.service
  # Aufräum-Dienst (nur mit Jochens Freigabe abschalten — doc/setup/borg-retention.md):
  #   systemctl disable --now cockpit-borg-retention.timer
  #   rm -f /usr/local/sbin/cockpit-borg-retention /usr/local/lib/wireguard-ops-cockpit/cockpit-borg-retention*.mjs \
  #         /etc/systemd/system/cockpit-borg-retention.{service,timer}
  #   rm -rf /etc/systemd/system/cockpit-borg-retention.timer.d
  #   Einstellung/Passphrase/Zustand bleiben (/etc/cockpit-borg-retention, /var/lib/cockpit-borg-retention).
  rm -f /etc/systemd/system/wireguard-ops-cockpit-*.service
  rm -rf /etc/systemd/system/wireguard-ops-cockpit-api.service.d
  rm -f /etc/sudoers.d/cockpit-executor /usr/local/sbin/cockpit-service-action \
        /usr/local/sbin/cockpit-disk-action /usr/local/sbin/cockpit-exact-file-replace \
        /usr/local/sbin/cockpit-break-glass \
        /usr/local/sbin/cockpit-self-update-action \
        /usr/local/lib/wireguard-ops-cockpit/cockpit-capability-action.mjs \
        /usr/local/lib/wireguard-ops-cockpit/cockpit-self-update-run \
        /usr/local/lib/wireguard-ops-cockpit/cockpit-self-update-snapshot \
        /usr/local/lib/wireguard-ops-cockpit/homeserver-cockpit-deploy.sh \
        /etc/systemd/system/wireguard-ops-cockpit-self-update@.service
  rm -rf /var/lib/wireguard-ops-cockpit-self-update-snapshots   # Update-Kopien (Rückweg)
  rm -rf /etc/wireguard-ops-cockpit /opt/wireguard-ops-cockpit /var/www/wireguard-ops-cockpit
  rm -f /etc/nginx/sites-enabled/wireguard-ops-cockpit /etc/nginx/sites-available/wireguard-ops-cockpit
  rm -f /etc/nginx/sites-available/wireguard-ops-cockpit.bak-*   # Site-Backups aus Deploy-Läufen
  rm -f /etc/systemd/system/nginx.service.d/wait-wg0.conf
  rm -rf /var/log/wireguard-ops-cockpit-self-update   # Selbst-Update-Logs
  systemctl daemon-reload && systemctl restart nginx
  # Falls entfernt: default-Site zurückholen: ln -s ../sites-available/default /etc/nginx/sites-enabled/default
  # Falls gesetzt: ufw delete allow in on wg0 proto tcp from 10.0.0.0/24 to $WG_BIND_IP port $WEB_PORT
  # Daten (nur auf Wunsch): rm -rf /var/lib/wireguard-ops-cockpit /var/lib/wireguard-ops-agent /var/lib/wireguard-ops-executor
  # Benutzer (nur auf Wunsch): userdel -r wgops; userdel -r cockpit-agent; userdel -r cockpit-executor
  # Node/OpenCode (nur auf Wunsch, falls sonst ungenutzt):
  #   npm uninstall -g opencode-ai; rm -f /usr/local/bin/opencode
  #   rm -rf /opt/node-v20.19.1-linux-x64 /root/cockpit-deploy
  #   # /usr/bin/node-Symlink nur entfernen, wenn er von diesem Deploy stammt
EOF
