#!/bin/bash
# Den Contabo-API-Zugang fuer das Cockpit hinterlegen — ohne dass er irgendwo
# mitgelesen wird: kein Echo, kein Verlauf, kein Chat.
#
# Vorher im Kundenpanel (my.contabo.com -> Account -> API):
#     Client ID und Client Secret ablesen,
#     API-Nutzer = die E-Mail des Kontos,
#     API-Passwort dort setzen (ist NICHT das Panel-Passwort).
#
# Die Datei liest nur root und, je Schritt lesend eingehaengt, der Helfer
# cockpit-vps-snapshot im Sandkasten des Executors. Wer sie hat, kann die
# Maschine zurueckrollen — deshalb ist /etc/wireguard-ops-cockpit im Cockpit
# eine harte Grenze und taucht in keinem Plan auf.
#
# Aufruf als root:   bash contabo-zugang-hinterlegen.sh
set -euo pipefail
ZIEL=/etc/wireguard-ops-cockpit/contabo.env
HELFER=/usr/local/lib/wireguard-ops-cockpit/cockpit-vps-snapshot
[[ $EUID -eq 0 ]] || { echo "Bitte als root." >&2; exit 1; }
read -rp  'Client ID: ' CID
read -rsp 'Client Secret (Eingabe bleibt unsichtbar): ' CSEC; echo
read -rp  'API-Nutzer (E-Mail des Kontos): ' CUSER
read -rsp 'API-Passwort (Eingabe bleibt unsichtbar): ' CPASS; echo
read -rp  'Instanz-ID (leer = ueber den Hostnamen suchen): ' CINST
CID="${CID//[[:space:]]/}"; CSEC="${CSEC//[[:space:]]/}"; CUSER="${CUSER//[[:space:]]/}"; CINST="${CINST//[[:space:]]/}"
[[ -n $CID && -n $CSEC && -n $CUSER && -n $CPASS ]] || { echo "Unvollstaendig — nichts geschrieben." >&2; exit 1; }
[[ -z $CINST || $CINST =~ ^[0-9]+$ ]] || { echo "Instanz-ID muss eine Zahl sein — nichts geschrieben." >&2; exit 1; }
install -d -m 700 -o root -g root "$(dirname "$ZIEL")"
umask 077
printf 'CONTABO_CLIENT_ID=%s\nCONTABO_CLIENT_SECRET=%s\nCONTABO_API_USER=%s\nCONTABO_API_PASSWORD=%s\nCONTABO_INSTANCE_ID=%s\n' \
  "$CID" "$CSEC" "$CUSER" "$CPASS" "$CINST" > "$ZIEL"
chown root:root "$ZIEL"; chmod 600 "$ZIEL"
unset CSEC CPASS
echo "Hinterlegt: $ZIEL ($(stat -c '%U %a' "$ZIEL")). Probe:"
/usr/bin/python3 "$HELFER" status | /usr/bin/python3 -c '
import json, sys
d = json.load(sys.stdin); i = d["instance"]
print(f"  Instanz {i[\"instanceId\"]} {i[\"name\"]} ({i[\"status\"]}, {i.get(\"productId\")}), {d[\"snapshotCount\"]} Snapshot(s) vorhanden")
for s in d["snapshots"]:
    print(f"  - {s[\"snapshotId\"]} {s[\"name\"]} angelegt {s[\"createdDate\"]} weg am {s[\"autoDeleteDate\"]}")
'
