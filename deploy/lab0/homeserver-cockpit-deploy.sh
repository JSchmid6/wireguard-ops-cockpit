#!/usr/bin/env bash
# =============================================================================
# Home-Server Cockpit — Deploy-Skript (wireguard-ops-cockpit)
# -----------------------------------------------------------------------------
# Ziel:   Agent-Cockpit auf dem Home-Server (10.0.0.5) für Fernadministration
# Autor:  James (Hermes VPS) — Kanban t_6a58ebc7
# Stand:  2026-09-25   (Pin: Repo-Commit 59dc679 — Merge #7; Node v22.23.4)
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
#         nur lesende Pläne (überholt am 16.10.2026, siehe dort).
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
#         Die Kopie deckt nur das Cockpit ab, keine Host-Änderungen. Bootstrap-Kopie
#         (NC /Documents, vpsdrop) = diese Datei; abweichen darf nur der Pin-Default.
#         16.10.2026 (Kanban t_f92a44f9): die allgemeine Tür öffnet auf Lab0 auch für
#         verändernde Läufe (Jochens Abnahme: Neustart android-adb/-emulator per
#         host.run). Netz je Instanzrolle (doc/setup/host-run.md): das Skript legt die
#         Rolle lab0 root-eigen nach /etc/wireguard-ops-cockpit/instance-role.env und
#         installiert cockpit-host-snapshot (lokale Kopie von /etc, Paketstand,
#         Unit-Zuständen vor jedem verändernden Lauf; Ablage
#         /var/lib/wireguard-ops-cockpit-host-snapshots). borg-Frische und
#         Hoster-Snapshot gibt es nur auf dem VPS. Fehlt Rolle oder Snapshot oder
#         scheitert er, läuft kein Schritt (preflight_failed). Ausrollen per
#         self.update: der erste Lauf führt noch das alte installierte Skript aus und
#         installiert erst dieses; Rolle + Helfer kommen mit dem nächsten self.update.
#         08.11.2026 (Kanban t_88f1e802): Instanzrolle als Parameter — COCKPIT_ROLE=lab0
#         (Vorgabe, Lab0 unverändert) oder box (Proxmox-Host „Narrow Box“, 10.0.0.6).
#         Die Rolle kommt beim ersten Lauf aus COCKPIT_ROLE, danach aus der installierten
#         instance-role.env; ein Wechsel per Deploy wird verweigert (das Netz der Tür hängt
#         an ihr). box: kein IMSM-Disk-Helfer, kein borg-Aufräumdienst; Web per TLS auf
#         10.0.0.6:8180 mit dem box-Zertifikat der internen CA (/etc/pve/local/pveproxy-ssl.*,
#         vom Erststart gelegt); Netz = Host-Snapshot + Proxmox-Snapshot jedes Gastes;
#         James' Bearer: Konto hermes-automation, Label hermes-tresor, Hash aus
#         /etc/box-bootstrap/cockpit-token.sha256 (cockpit-automation-token-seed).
#         09.11.2026 (Kanban t_88f1e802): Debian trixie hat kein Paket ttyd (alle sechs
#         Türläufe der Box brachen in Schritt 1 ab). Ohne apt-Kandidaten installiert das
#         Skript das statische Release-Binary ttyd 1.7.7 (sha256 gepinnt) nach
#         /usr/local/bin/ttyd; die Unit ruft ttyd ohne Pfad auf. Abgleich der übrigen
#         Pakete gegen trixie main: alle vorhanden.
#         13.11.2026 (Kanban t_cb81637b): Runner unter eigener Identität — Nutzer
#         cockpit-runner (Gruppe cockpit-runner-client, kein sudo), Home
#         /var/lib/wireguard-ops-runner, Unit wireguard-ops-cockpit-runner, Socket
#         /run/cockpit-runner/runner.sock; wgops kommt in die Gruppe. Paket ripgrep, weil
#         opencode seinen Cache jetzt je Lauf neu anlegt.
#
# Aufruf (als root AUF DER KISTE):
#   bash homeserver-cockpit-deploy.sh                   # Lab0 bzw. die installierte Rolle
#   COCKPIT_ROLE=box bash homeserver-cockpit-deploy.sh  # Erstinstallation auf der Box
#   WEB_PORT=8180 bash homeserver-cockpit-deploy.sh   # nur bei gewolltem Portwechsel
#
# Voraussetzungen (Das Skript prüft sie und bricht klar benannt ab):
#   - Debian/Ubuntu-artiges Linux, x86_64 (sonst: stoppen + melden)
#   - Internet: apt-Mirror, github.com, registry.npmjs.org, nodejs.org
#   - /root/cockpit-deploy/deepseek.env mit DEEPSEEK_API_KEY=... (kommt vom VPS;
#     auf der Box legt es box-stage2.sh aus einem nur für die Box entschlüsselbaren Block ab)
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
# Claude Code für Planer/Research über das Abo (Karte t_936d9b0f); aktiv erst mit
# COCKPIT_PLAN_ENGINE=claude und CLAUDE_CODE_OAUTH_TOKEN in agent.env.
CLAUDE_CODE_VERSION="${CLAUDE_CODE_VERSION:-2.1.311}"   # dist-tag stable am 13.11.2026
NODE_DIR="/opt/node-v22.23.4-linux-x64"
NODE_SHA256="1805bcd35e6815559bd2eb97db438d3fdb0eb3a5e6a977b7c1badca76337e9ce"
COCKPIT_DIR="/opt/wireguard-ops-cockpit"
ENV_DIR="/etc/wireguard-ops-cockpit"
STATE_DIR="/var/lib/wireguard-ops-cockpit"
AGENT_DIR="/var/lib/wireguard-ops-agent"
# The runner (opencode build) under its own identity, home and socket (Kanban t_cb81637b).
RUNNER_DIR="/var/lib/wireguard-ops-runner"
EXEC_DIR="/var/lib/wireguard-ops-executor"
WEBROOT="/var/www/wireguard-ops-cockpit"
SECRETS_DIR="/root/cockpit-deploy"
WG_BIND_IP="${WG_BIND_IP:-}"   # Vorgabe je Rolle, siehe Preflight
NODE_PKG_URL="https://nodejs.org/dist/v22.23.4/node-v22.23.4-linux-x64.tar.xz"
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

# Instanzrolle (doc/setup/host-run.md, „Netz je Instanzrolle“): beim ersten Lauf aus
# COCKPIT_ROLE (Vorgabe lab0), danach aus der installierten Datei. Ein Wechsel per Deploy
# wird verweigert — die Rolle bestimmt das Netz jedes späteren Laufs der Tür.
# Der markierte Block wird vom Test (host-run-helper.test.ts) 1:1 ausgeführt.
# >>> rollen-logik
INSTALLED_ROLE=""
if [ -f "$ENV_DIR/instance-role.env" ]; then
  INSTALLED_ROLE="$(sed -n 's/^COCKPIT_INSTANCE_ROLE=//p' "$ENV_DIR/instance-role.env" | head -n1)"
fi
COCKPIT_ROLE="${COCKPIT_ROLE:-${INSTALLED_ROLE:-lab0}}"
case "$COCKPIT_ROLE" in
  lab0) WG_BIND_IP="${WG_BIND_IP:-10.0.0.5}" ;;
  box)  WG_BIND_IP="${WG_BIND_IP:-10.0.0.6}" ;;
  *) die "Unbekannte Rolle '$COCKPIT_ROLE' — erwartet lab0 oder box." ;;
esac
if [ -n "$INSTALLED_ROLE" ] && [ "$INSTALLED_ROLE" != "$COCKPIT_ROLE" ]; then
  die "Installierte Rolle ist '$INSTALLED_ROLE', verlangt '$COCKPIT_ROLE' — ein Rollenwechsel geht nicht per Deploy. Nichts geändert."
fi
echo "Rolle: $COCKPIT_ROLE (WireGuard-IP $WG_BIND_IP)"
# <<< rollen-logik
if [ "$COCKPIT_ROLE" = "box" ]; then
  command -v pveversion >/dev/null 2>&1 || die "Rolle box erwartet einen Proxmox-VE-Host (pveversion fehlt)."
fi

if [ -r /etc/os-release ]; then . /etc/os-release; fi
case "${ID:-}${ID_LIKE:-}" in
  *debian*|*ubuntu*) log "OS: ${PRETTY_NAME:-unbekannt} — OK" ;;
  *) die "Debian/Ubuntu-artiges Linux erwartet (gefunden: ${PRETTY_NAME:-unbekannt}). Stoppen und Rückmeldung an Jochen — Plan ggf. anpassen." ;;
esac

free_kb=$(df -Pk /opt | awk 'NR==2{print $4}')
[ "$free_kb" -ge 5000000 ] || die "Weniger als 5 GB frei unter /opt (${free_kb} KB). Erst Platz schaffen."

# Altlasten, die der Agent-Broker verweigert (assertNoPlantedConfig, dieselben Namen;
# ein Test vergleicht die Listen und diesen Block mit dem VPS-Deploy): von der
# Session-Wurzel bis / und im globalen Konfigordner, je Broker-Home (Planrollen und
# Runner, Karte t_2a2d8e5b). Liegt eine davon da, stoppt der Broker JEDE seiner
# Rollen, auch Planer und Türsteher bzw. den Runner — das Cockpit könnte sich
# weder reparieren noch zurückrollen. Geprüft, bevor irgendetwas installiert wird:
# der laufende Stand bleibt, root verschiebt die genannten Pfade (nicht löschen) und
# deployt erneut.
# >>> planted-config-preflight
readonly PLANTED_PROJECT_NAMES=(opencode.json opencode.jsonc .opencode AGENTS.md CLAUDE.md CONTEXT.md .claude .agents .git .gitconfig .npmrc)
readonly PLANTED_GLOBAL_NAMES=(opencode.json config.json config AGENTS.md agent agents command commands mode modes plugin plugins tool tools skill skills)
planted_config_preflight() { # planted_config_preflight <host root> <agent home>
  local root="$1" home="$2" dir name found=()
  dir="$home/sessions"
  while :; do
    for name in "${PLANTED_PROJECT_NAMES[@]}"; do
      if [ -e "$root${dir%/}/$name" ] || [ -L "$root${dir%/}/$name" ]; then found+=("${dir%/}/$name"); fi
    done
    [ "$dir" = / ] && break
    dir="$(dirname -- "$dir")"
  done
  for name in "${PLANTED_GLOBAL_NAMES[@]}"; do
    if [ -e "$root$home/.config/opencode/$name" ] || [ -L "$root$home/.config/opencode/$name" ]; then found+=("$home/.config/opencode/$name"); fi
  done
  if [ -e "$root$home/.config/git" ] || [ -L "$root$home/.config/git" ]; then found+=("$home/.config/git"); fi
  [ "${#found[@]}" -eq 0 ] && return 0
  printf 'opencode would load %s into every role\n' "${found[@]}"
  return 1
}
# <<< planted-config-preflight
planted_report=""
for planted_home in "$AGENT_DIR" "$RUNNER_DIR"; do
  planted_part="$(planted_config_preflight "" "$planted_home")" || planted_report+="$planted_part"$'\n'
done
if [ -n "$planted_report" ]; then
  # Beide Homes teilen die Ebenen ab /var/lib: jeden Pfad einmal nennen.
  printf '%s' "$planted_report" | awk '!seen[$0]++' >&2
  die "Agent- oder Runner-Broker würden mit diesen Altlasten jede Rolle verweigern. Als root beiseite schieben, dann erneut deployen. Nichts geändert."
fi

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

# Rolle box: das Web läuft per TLS mit dem box-Zertifikat der internen CA, das der
# Erststart für pveproxy abgelegt hat (/etc/pve/local, pmxcfs). nginx bekommt eine eigene
# Kopie (root, 0600) — /etc/pve hängt am Proxmox-Cluster-Dienst und ist beim Start von
# nginx nicht sicher da. Ersetzt nur bei Abweichung; der Erststart erneuert beide nie.
if [ "$COCKPIT_ROLE" = "box" ]; then
  for f in /etc/pve/local/pveproxy-ssl.pem /etc/pve/local/pveproxy-ssl.key; do
    [ -r "$f" ] || die "Rolle box: $f fehlt — der Erststart hat das box-Zertifikat nicht gelegt. Nichts geändert."
  done
  install -d -m 0700 -o root -g root "$(dirname "$TLS_CERT_FALLBACK")"
  cmp -s /etc/pve/local/pveproxy-ssl.pem "$TLS_CERT_FALLBACK" \
    || install -m 0644 -o root -g root /etc/pve/local/pveproxy-ssl.pem "$TLS_CERT_FALLBACK"
  cmp -s /etc/pve/local/pveproxy-ssl.key "$TLS_KEY_FALLBACK" \
    || install -m 0600 -o root -g root /etc/pve/local/pveproxy-ssl.key "$TLS_KEY_FALLBACK"
fi

site_detect
site_resolve
# Neuanlage auf der Box: TLS auf 8180 wie Lab0 (das Plugin spricht nur https://10.0.0.6:8180).
if [ "$COCKPIT_ROLE" = "box" ] && [ "$SITE_EXISTS" = "no" ]; then
  if [ "$WEB_PORT_EXPLICIT" = "no" ]; then WEB_PORT=8180; fi
  WEB_TLS="yes"; WEB_CERT="$TLS_CERT_FALLBACK"; WEB_KEY="$TLS_KEY_FALLBACK"
  WEB_PORT_QUELLE="Rolle box, Neuanlage (${WEB_PORT}, TLS)"
fi
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
# ttyd (09.11.2026, Kanban t_88f1e802): Debian trixie (Box) hat kein ttyd-Paket — weder
# main noch backports. Ohne apt-Kandidaten kommt das statische Release-Binary von
# github.com/tsl0922/ttyd, Version und sha256 fest gepinnt, nach /usr/local/bin/ttyd.
# Die Unit ruft ttyd ohne Pfad auf (systemd sucht /usr/local/bin vor /usr/bin).
# Der markierte Block wird vom Test (deploy-ttyd.test.ts) 1:1 ausgeführt.
# >>> ttyd-logik
TTYD_VERSION="1.7.7"
TTYD_SHA256="8a217c968aba172e0dbf3f34447218dc015bc4d5e59bf51db2f2cd12b7be4f55"   # SHA256SUMS des Releases, x86_64
TTYD_URL="https://github.com/tsl0922/ttyd/releases/download/${TTYD_VERSION}/ttyd.x86_64"
TTYD_LOCAL="${TTYD_LOCAL:-/usr/local/bin/ttyd}"

# yes, wenn apt ein Paket ttyd installieren kann (Ubuntu universe: VPS, Lab0).
ttyd_apt_candidate() {
  local cand
  cand="$(apt-cache policy ttyd 2>/dev/null | awk '/Candidate:/{print $2; exit}')"
  if [ -n "$cand" ] && [ "$cand" != "(none)" ]; then echo yes; else echo no; fi
}

# Holt das gepinnte Binary; Hash-Abweichung bricht ab, bevor etwas installiert ist.
ttyd_install_binary() {
  local tmp
  if [ -x "$TTYD_LOCAL" ] && echo "$TTYD_SHA256  $TTYD_LOCAL" | sha256sum -c - >/dev/null 2>&1; then
    echo "ttyd: $TTYD_LOCAL ($TTYD_VERSION) schon vorhanden."
    return 0
  fi
  tmp="$(mktemp)"
  curl -fsSL --max-time 120 -o "$tmp" "$TTYD_URL" || { rm -f "$tmp"; die "ttyd-Download fehlgeschlagen ($TTYD_URL)."; }
  echo "$TTYD_SHA256  $tmp" | sha256sum -c - >/dev/null 2>&1 \
    || { rm -f "$tmp"; die "ttyd-Prüfsumme stimmt nicht ($TTYD_URL) — abgebrochen, nichts installiert."; }
  install -D -m 0755 -o root -g root "$tmp" "$TTYD_LOCAL"
  rm -f "$tmp"
  echo "ttyd: Release-Binary $TTYD_VERSION nach $TTYD_LOCAL (sha256 geprüft)."
}

# ttyd vorhanden: auf dem PATH (Paket) oder als Release-Binary unter $TTYD_LOCAL. Der
# Self-Update-Lauf startet das Skript mit PATH=/usr/sbin:/usr/bin:/sbin:/bin, also ohne
# /usr/local/bin (13.11.2026, Kanban t_68b5bdf8) — die Prüfung darf sich nicht auf den PATH verlassen.
ttyd_present() {
  command -v ttyd >/dev/null 2>&1 || [ -x "$TTYD_LOCAL" ]
}

# ripgrep: opencode keeps its cache per run (Kanban t_cb81637b); without rg on the PATH its
# grep/glob tools would download ripgrep from GitHub into that empty cache on every run.
# bubblewrap: Claude Code hält damit seinen Login aus der Shell der Rolle (CLAUDE_CODE_SUBPROCESS_ENV_SCRUB).
APT_PACKAGES=(ca-certificates curl git tmux nginx openssl python3 sudo ripgrep bubblewrap)
TTYD_FROM_APT="$(ttyd_apt_candidate)"
if [ "$TTYD_FROM_APT" = "yes" ]; then APT_PACKAGES+=(ttyd); fi
# <<< ttyd-logik
apt-get install -y -qq --no-install-recommends "${APT_PACKAGES[@]}" \
  || die "Paketinstallation fehlgeschlagen (${APT_PACKAGES[*]}; Universe aktiv?)."
if [ "$TTYD_FROM_APT" = "yes" ]; then
  # Ein früher gelegtes Release-Binary würde das Paket verdecken — nur unser eigenes entfernen.
  if [ -f "$TTYD_LOCAL" ] && echo "$TTYD_SHA256  $TTYD_LOCAL" | sha256sum -c - >/dev/null 2>&1; then
    rm -f "$TTYD_LOCAL"; echo "ttyd: Paket da — Release-Binary $TTYD_LOCAL entfernt."
  fi
else
  echo "ttyd: kein apt-Paket (z. B. Debian trixie) — gepinntes Release-Binary."
  ttyd_install_binary
fi
ttyd_present || die "ttyd fehlt nach der Installation."
if [ "$NGINX_PREEXISTED" = "no" ]; then
  systemctl disable --now nginx >/dev/null 2>&1 || true   # frisch installiert: erst nach Konfiguration aktivieren
fi

# Netz Richtung github + npm prüfen
curl -fsS --max-time 15 -o /dev/null "https://github.com/JSchmid6/wireguard-ops-cockpit" \
  || die "github.com nicht erreichbar. Fallback (Offline-Transfer über den VPS) nötig — stoppen und melden."
curl -fsS --max-time 15 -o /dev/null "https://registry.npmjs.org/" \
  || die "registry.npmjs.org nicht erreichbar. Stoppen und melden."

# ---------------------------------------------------------------------------
# 2) Node-Runtime v22.23.4 (gepinnt, Prüfsumme verifiziert)
# ---------------------------------------------------------------------------
log "2) Node $NODE_DIR sicherstellen"
if [ ! -x "$NODE_DIR/bin/node" ]; then
  tarball="$SECRETS_DIR/node-v22.23.4-linux-x64.tar.xz"
  if [ ! -f "$tarball" ]; then
    curl -fL --max-time 300 -o "$tarball" "$NODE_PKG_URL" || die "Node-Tarball-Download fehlgeschlagen."
  fi
  echo "$NODE_SHA256  $tarball" | sha256sum -c - >/dev/null || die "Node-Tarball-Prüfsumme stimmt nicht — abgebrochen."
  tar -xJf "$tarball" -C /opt
else
  echo "Node bereits vorhanden."
fi
[ -x "$NODE_DIR/bin/node" ] || die "Node-Installation unvollständig."
"$NODE_DIR/bin/node" --version | grep -q "v22.23.4" || die "Falsche Node-Version aktiv."

# /usr/bin/node für Helper-Shebang (#!/usr/bin/node) — 22.23.4, falls nichts vorhanden
if [ ! -e /usr/bin/node ]; then ln -s "$NODE_DIR/bin/node" /usr/bin/node; fi

# ---------------------------------------------------------------------------
# 3) Service-User und Gruppen (angelehnt an VPS-Referenz)
# ---------------------------------------------------------------------------
log "3) Benutzer/Gruppen"
getent group wgops >/dev/null || groupadd --system wgops
id -u wgops >/dev/null 2>&1 || useradd --system -m -d "$STATE_DIR" -s /bin/bash -g wgops wgops

getent group cockpit-agent-client >/dev/null || groupadd --system cockpit-agent-client
id -u cockpit-agent >/dev/null 2>&1 || useradd --system -m -d "$AGENT_DIR" -s /usr/sbin/nologin -g cockpit-agent-client cockpit-agent

# Eigene Identität für den Runner: kein Mitglied von cockpit-agent-client, kein sudo.
getent group cockpit-runner-client >/dev/null || groupadd --system cockpit-runner-client
id -u cockpit-runner >/dev/null 2>&1 || useradd --system -m -d "$RUNNER_DIR" -s /usr/sbin/nologin -g cockpit-runner-client cockpit-runner

getent group cockpit-executor-client >/dev/null || groupadd --system cockpit-executor-client
id -u cockpit-executor >/dev/null 2>&1 || useradd --system -m -d "$EXEC_DIR" -s /usr/sbin/nologin -g cockpit-executor-client cockpit-executor

usermod -aG cockpit-agent-client wgops
usermod -aG cockpit-runner-client wgops
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
install -d -m 0750 -o cockpit-runner -g cockpit-runner-client "$RUNNER_DIR"
install -d -m 0700 -o cockpit-runner -g cockpit-runner-client "$RUNNER_DIR/sessions"
install -d -m 0750 -o cockpit-executor -g cockpit-executor-client "$EXEC_DIR"
install -d -m 0700 -o root -g root "$ENV_DIR"
install -d -m 0755 /usr/local/lib/wireguard-ops-cockpit
chmod 0750 "$STATE_DIR" "$AGENT_DIR" "$RUNNER_DIR" "$EXEC_DIR"
chmod 0700 "$AGENT_DIR/sessions" "$RUNNER_DIR/sessions"
chown wgops:wgops "$STATE_DIR"
chown cockpit-agent:cockpit-agent-client "$AGENT_DIR" "$AGENT_DIR/sessions"
chown cockpit-runner:cockpit-runner-client "$RUNNER_DIR" "$RUNNER_DIR/sessions"
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
# 7) systemd-Units (5 Dienste + API-Drop-in)
# ---------------------------------------------------------------------------
log "7) systemd-Units installieren"
install -m 644 "$COCKPIT_DIR/deploy/systemd/wireguard-ops-cockpit-api.service"      /etc/systemd/system/
install -m 644 "$COCKPIT_DIR/deploy/systemd/wireguard-ops-cockpit-ttyd.service"     /etc/systemd/system/
install -m 644 "$COCKPIT_DIR/deploy/systemd/wireguard-ops-cockpit-agent.service"    /etc/systemd/system/
install -m 644 "$COCKPIT_DIR/deploy/systemd/wireguard-ops-cockpit-runner.service"   /etc/systemd/system/
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

# Typed-Disk-Helfer (mdadm auf dem IMSM-Container /dev/md127; disk.manage) — nur Lab0
if [ "$COCKPIT_ROLE" = "lab0" ]; then
  [ -f "$COCKPIT_DIR/deploy/helpers/cockpit-disk-action" ] \
    || die "deploy/helpers/cockpit-disk-action fehlt im Checkout ($REPO_COMMIT) — Skript mit REPO_COMMIT=<merge-sha> erneut ausführen."
  install -m 755 -o root -g root "$COCKPIT_DIR/deploy/helpers/cockpit-disk-action" \
    /usr/local/sbin/cockpit-disk-action
  command -v mdadm >/dev/null 2>&1 \
    || echo "HINWEIS: mdadm fehlt — cockpit-disk-action kann erst nach 'apt-get install -y mdadm' arbeiten."
fi

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
# Root-Helfer und die Unit, die Läufe nach einem Neustart fortsetzt.
[ -f "$COCKPIT_DIR/deploy/helpers/cockpit-host-run" ] \
  || die "deploy/helpers/cockpit-host-run fehlt im Checkout ($REPO_COMMIT) — Skript mit REPO_COMMIT=<merge-sha> erneut ausführen."
install -m 755 -o root -g root "$COCKPIT_DIR/deploy/helpers/cockpit-host-run" \
  /usr/local/lib/wireguard-ops-cockpit/cockpit-host-run.mjs
# Die festen Grenzen des Aufräum-Dienstes (cockpit-borg-retention.mjs importiert sie).
install -m 644 -o root -g root "$COCKPIT_DIR/deploy/helpers/cockpit-borg-retention-rules.mjs" \
  /usr/local/lib/wireguard-ops-cockpit/cockpit-borg-retention-rules.mjs
# Zustandsschritte nie mittendrin abbrechen: die eine Erkennung, die der Helfer
# importiert (fehlte bis 16.10.2026 → ERR_MODULE_NOT_FOUND im Root-Helfer).
install -m 644 -o root -g root "$COCKPIT_DIR/deploy/helpers/cockpit-state-steps.mjs" \
  /usr/local/lib/wireguard-ops-cockpit/cockpit-state-steps.mjs
install -m 644 "$COCKPIT_DIR/deploy/systemd/wireguard-ops-cockpit-host-run-resume.service" \
  /etc/systemd/system/wireguard-ops-cockpit-host-run-resume.service
# Netz der Tür auf Lab0 (doc/setup/host-run.md, „Netz je Instanzrolle“, 16.10.2026):
# Rolle lab0 aus dieser root-eigenen Datei, Sicherung = lokaler Host-Snapshot
# (Konfiguration, Paketstand, Unit-Zustände) statt borg-Frische + Hoster-Snapshot.
# Ohne Rolle oder Snapshot-Helfer scheitert jeder verändernde Lauf im Preflight.
# Rolle box: dieselbe Datei aus deploy/box/ (Netz: Host-Snapshot + Proxmox-Snapshot je Gast).
for f in deploy/helpers/cockpit-host-snapshot "deploy/$COCKPIT_ROLE/instance-role.env"; do
  [ -f "$COCKPIT_DIR/$f" ] \
    || die "$f fehlt im Checkout ($REPO_COMMIT) — Skript mit REPO_COMMIT=<merge-sha> erneut ausführen."
done
install -m 644 -o root -g root "$COCKPIT_DIR/deploy/helpers/cockpit-host-snapshot" \
  /usr/local/lib/wireguard-ops-cockpit/cockpit-host-snapshot
install -d -m 0700 -o root -g root /var/lib/wireguard-ops-cockpit-host-snapshots
install -m 600 -o root -g root "$COCKPIT_DIR/deploy/$COCKPIT_ROLE/instance-role.env" "$ENV_DIR/instance-role.env"

if [ "$COCKPIT_ROLE" = "lab0" ]; then
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
install -m 644 "$COCKPIT_DIR/deploy/systemd/cockpit-borg-retention.service" \
  /etc/systemd/system/cockpit-borg-retention.service
install -m 644 "$COCKPIT_DIR/deploy/systemd/cockpit-borg-retention.timer" \
  /etc/systemd/system/cockpit-borg-retention.timer
install -d -m 0755 -o root -g root /etc/cockpit-borg-retention
[ -f /etc/cockpit-borg-retention/passphrase ] \
  || echo "HINWEIS: /etc/cockpit-borg-retention/passphrase fehlt — der Aufräum-Dienst startet erst, wenn sie (root, 0600) abgelegt ist."
fi   # Ende Aufräum-Dienst (nur lab0: das borg-Ziel)

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
timeout 60 runuser -u cockpit-runner -- env HOME="$RUNNER_DIR" "$NODE_DIR/bin/opencode" --version >/dev/null 2>&1 \
  || die "opencode --version schlägt als cockpit-runner fehl (runuser-Test)."
ln -sfn "$NODE_DIR/bin/opencode" /usr/local/bin/opencode
# Claude Code: Planer und Research laufen damit, sobald agent.env es einschaltet
# (apps/agent-broker/src/index.mjs claudeSettings); ohne Schalter liegt es nur da.
log "9b) Claude Code installieren (Planer/Research, Version $CLAUDE_CODE_VERSION)"
# Kein Abbruch: ohne Schalter braucht niemand Claude, und ein fehlgeschlagener
# Download darf kein Deploy/Self-Update anhalten. Ist der Schalter an, läuft der
# Broker dann sichtbar im NOTBETRIEB (doc/setup/plan-engine-claude.md).
if npm install -g --silent "@anthropic-ai/claude-code@$CLAUDE_CODE_VERSION" && test -x "$NODE_DIR/bin/claude"; then
  chmod -R a+rX "$NODE_DIR/lib/node_modules/@anthropic-ai" 2>/dev/null || true
  # Nichts in sein Home schreiben: ein ~/.claude dort hielte jede Rolle an (assertNoPlantedConfig).
  CLAUDE_HELP="$(timeout 60 runuser -u cockpit-agent -- env HOME=/nonexistent CLAUDE_CONFIG_DIR=/nonexistent/claude DISABLE_AUTOUPDATER=1 "$NODE_DIR/bin/claude" --help 2>/dev/null || true)"
  case "$CLAUDE_HELP" in *--safe-mode*) ;; *) echo "HINWEIS: claude als cockpit-agent nicht lauffähig oder ohne --safe-mode — Planer/Research bleiben im NOTBETRIEB." ;; esac
else
  echo "HINWEIS: Claude Code $CLAUDE_CODE_VERSION nicht installiert — Planer/Research bleiben bei COCKPIT_PLAN_ENGINE=claude im NOTBETRIEB."
fi
# BEGIN agent-opencode-config (test/cockpit-agent-unit-e2e-inner.sh runs exactly these lines)
# The config of every agent role belongs to root; the agent identity, which also
# runs the runner with build tools, only reads it. The unit keeps the home
# read-only on top (wireguard-ops-cockpit-agent.service). opencode writes
# .gitignore into its config directory on every start unless it exists and
# fails on a read-only one, so the deploy places it.
install -d -m 0750 -o root -g cockpit-agent-client "$AGENT_DIR/.config" "$AGENT_DIR/.config/opencode"
install -m 640 -o root -g cockpit-agent-client \
  "$COCKPIT_DIR/deploy/config/opencode-agent.jsonc" "$AGENT_DIR/.config/opencode/opencode.jsonc"
install -m 640 -o root -g cockpit-agent-client \
  "$COCKPIT_DIR/deploy/config/opencode-config-dir.gitignore" "$AGENT_DIR/.config/opencode/.gitignore"
# END agent-opencode-config
# BEGIN runner-opencode-config
# The runner's own config, the same file, root-owned in its own home: the runner
# reads it, and its unit keeps that home read-only as well.
install -d -m 0750 -o root -g cockpit-runner-client "$RUNNER_DIR/.config" "$RUNNER_DIR/.config/opencode"
install -m 640 -o root -g cockpit-runner-client \
  "$COCKPIT_DIR/deploy/config/opencode-agent.jsonc" "$RUNNER_DIR/.config/opencode/opencode.jsonc"
install -m 640 -o root -g cockpit-runner-client \
  "$COCKPIT_DIR/deploy/config/opencode-config-dir.gitignore" "$RUNNER_DIR/.config/opencode/.gitignore"
# END runner-opencode-config

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
  wireguard-ops-cockpit-agent wireguard-ops-cockpit-runner wireguard-ops-cockpit-executor
# Aufräum-Dienst (nur lab0): nur der Timer läuft dauerhaft; der Lauf selbst ist ein oneshot.
if [ "$COCKPIT_ROLE" = "lab0" ]; then systemctl enable --now cockpit-borg-retention.timer; fi
# Tür: Fortsetzen nach einem Neustart-Schritt (nur enable, wie auf dem VPS).
systemctl enable --quiet wireguard-ops-cockpit-host-run-resume.service
# Re-Run-Falle (Befund 25.09., Review t_57244697/I2): 'enable --now' startet einen
# LAUFENDEN Dienst nicht neu — nach einem Re-Run liefen API + beide Broker weiter mit
# dem alten In-Memory-Code (die SMART-/Self-Update-Strecke braucht den neuen Stand).
# Daher hier der explizite Zyklus der fünf Cockpit-Dienste; im Selbst-Update
# (COCKPIT_RESTART_MODE=defer) wird er übersprungen — den Neustart übernimmt dort
# die geplante Aktivierung des Selbst-Update-Runners.
# >>> dienste-zyklus
case "${COCKPIT_RESTART_MODE:-}" in
  defer)
    echo "COCKPIT_RESTART_MODE=defer — Dienste-Zyklus übersprungen (Aktivierung übernimmt der Selbst-Update-Runner)."
    ;;
  *)
    systemctl restart wireguard-ops-cockpit-api wireguard-ops-cockpit-agent \
      wireguard-ops-cockpit-runner wireguard-ops-cockpit-executor wireguard-ops-cockpit-ttyd \
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
for svc in api ttyd agent runner executor; do
  systemctl is-active --quiet "wireguard-ops-cockpit-$svc" \
    || die "wireguard-ops-cockpit-$svc nicht aktiv — journalctl -u wireguard-ops-cockpit-$svc"
done
echo "Dienste: alle 5 aktiv."

[ -S /run/cockpit-agent/agent.sock ]     || die "agent.sock fehlt."
[ -S /run/cockpit-runner/runner.sock ]   || die "runner.sock fehlt."
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
# 12a) James' Bearer auf der Box (Rolle box): Konto hermes-automation, Label
#      hermes-tresor, Hash aus dem Erststart. Der Token selbst kommt nie auf den Host;
#      steht schon ein hermes-tresor-Token (Rotation), bleibt er (Helfer: kept). Danach ist
#      die Hash-Datei verbraucht (…sha256.used): ein später per Löschen widerrufener Token
#      kommt mit keinem weiteren Deploy/self.update zurück.
# ---------------------------------------------------------------------------
if [ "$COCKPIT_ROLE" = "box" ]; then
  TOKEN_HASH_FILE=/etc/box-bootstrap/cockpit-token.sha256
  if [ -f "$TOKEN_HASH_FILE" ]; then
    seeded="$(python3 "$COCKPIT_DIR/deploy/helpers/cockpit-automation-token-seed" "$STATE_DIR/cockpit.sqlite" \
      "$TOKEN_HASH_FILE" "$COCKPIT_DIR/deploy/config/automation-scopes.json")" \
      || die "Automation-Token konnte nicht eingetragen werden (cockpit-automation-token-seed, siehe stderr)."
    echo "Automation-Token: $seeded"
  elif [ -f "$TOKEN_HASH_FILE.used" ]; then
    echo "Automation-Token: Bootstrap-Hash schon verbraucht — nichts eingetragen."
  else
    echo "HINWEIS: $TOKEN_HASH_FILE fehlt — kein Automation-Token eingetragen."
  fi
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
  systemctl disable --now wireguard-ops-cockpit-api wireguard-ops-cockpit-ttyd wireguard-ops-cockpit-agent wireguard-ops-cockpit-runner wireguard-ops-cockpit-executor
  # Tür (doc/setup/host-run.md):
  #   systemctl disable wireguard-ops-cockpit-host-run-resume.service
  #   rm -f /usr/local/lib/wireguard-ops-cockpit/cockpit-host-run.mjs \
  #         /usr/local/lib/wireguard-ops-cockpit/cockpit-state-steps.mjs \
  #         /usr/local/lib/wireguard-ops-cockpit/cockpit-host-snapshot /etc/wireguard-ops-cockpit/instance-role.env \
  #         /etc/systemd/system/wireguard-ops-cockpit-host-run-resume.service
  #   rm -rf /var/lib/wireguard-ops-cockpit-host-snapshots   # Host-Snapshots der Tür (Rückweg, nur nach Prüfung)
  #   (cockpit-borg-retention-rules.mjs nimmt der Aufräum-Block unten mit.)
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
  # Benutzer (nur auf Wunsch): userdel -r wgops; userdel -r cockpit-agent; userdel -r cockpit-runner; userdel -r cockpit-executor
  # Node/OpenCode (nur auf Wunsch, falls sonst ungenutzt):
  #   npm uninstall -g opencode-ai; rm -f /usr/local/bin/opencode
  #   rm -f /usr/local/bin/ttyd   # nur das Release-Binary (Debian trixie); das apt-Paket bleibt
  #   rm -rf /opt/node-v22.23.4-linux-x64 /root/cockpit-deploy
  #   # /usr/bin/node-Symlink nur entfernen, wenn er von diesem Deploy stammt
EOF
