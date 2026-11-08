# Instanz box: Erstinstallation ohne Konsole (Karte t_88f1e802, 08.11.2026)

Die Narrow Box (CSL i3-N305, Proxmox VE 9 auf Debian trixie, WireGuard 10.0.0.6) ersetzt den
Home-Assistant-Raspberry und den UniFi-Controller. Ihr Root-Weg für James ist — wie auf Lab0 — ein
eigenes Cockpit mit der allgemeinen Tür (`doc/setup/host-run.md`), kein SSH.

## Ablauf

1. **Auto-Install-Stick** (außerhalb dieses Repos, Hermes `out/umzug-narrow-box/iso`): Proxmox ohne
   Eingriff, Erststart legt WireGuard, die interne CA, das box-Zertifikat
   (`/etc/pve/local/pveproxy-ssl.{pem,key}`, SAN `box`, `10.0.0.6`), den Proxmox-Token `james@pve!box`,
   `/etc/box-bootstrap/cockpit-token.sha256` und die **Einmal-Tür** `box-bootstrap.timer` an.
2. **Einmal-Tür**: holt alle 10 Minuten `http://10.0.0.1:8899/box-stage2.sh` und `.sig` (vpsdrop des
   VPS), prüft die Signatur (`ssh-keygen -Y verify`, Namespace `box-stage2`, Schlüssel nur in Hermes),
   führt die Datei als root aus und schließt sich nach Erfolg, nach 6 Fehlläufen oder 14 Tagen nach dem
   Erststart. Protokoll `/var/log/box-stage2.log`.
3. **stage2** (`deploy/box/box-stage2.sh.in`, ausgefüllt und signiert): legt den Planner-Schlüssel ab,
   holt `deploy/lab0/homeserver-cockpit-deploy.sh` am gepinnten Merge-Commit, prüft dessen sha256 gegen
   den Wert in der signierten Datei und führt es mit `COCKPIT_ROLE=box` aus.
4. **Deploy mit Rolle box** (dasselbe Skript wie Lab0, Rolle als Parameter): kein IMSM-Disk-Helfer,
   kein borg-Aufräumdienst; `instance-role.env` aus `deploy/box/`; Web per TLS auf `10.0.0.6:8180` mit
   einer Kopie des box-Zertifikats unter `/etc/nginx/ssl/` (nginx startet unabhängig von pmxcfs);
   danach James' Bearer (unten). Spätere Stände kommen per `self.update` — das installierte Skript liest
   die Rolle aus der installierten `instance-role.env`; ein Rollenwechsel per Deploy wird verweigert.

## Entscheidung: der Planner-Schlüssel (DEEPSEEK_API_KEY)

Das vpsdrop ist für jeden WireGuard-Peer lesbar, also nie Klartext dort. Gewählt: der Schlüssel steht in
stage2 als **CMS-Block, verschlüsselt für das box-Zertifikat** (`openssl cms -encrypt -binary -aes-256-gcm
-recip box.crt`; `-binary`, sonst kommt die Zeile mit CRLF zurück; EC-Schlüssel → ECDH-Schlüsselvereinbarung). Entschlüsseln kann nur, wer den privaten
Schlüssel des box-Zertifikats hat: die Box selbst (vom Erststart abgelegt) und die interne CA-Ablage in
Hermes, aus der er stammt — kein anderer Peer. Die Signatur von stage2 deckt den Block mit ab (niemand
kann ihn unbemerkt tauschen). Verworfen:

- Schlüssel per Cockpit-Lauf nachreichen: das Cockpit der Box braucht den Planner, um überhaupt einen
  Lauf zu planen — Henne und Ei.
- Schlüssel ins ISO: das ISO liegt in Nextcloud und auf einem USB-Stick, lebt länger als nötig und
  müsste bei jeder Rotation neu gebaut werden.
- Eigene Abholstelle mit Token: mehr bewegliche Teile für denselben Schutz, den die Verschlüsselung an
  das vorhandene Zertifikat schon gibt.

Rotation: neuen Schlüssel per `host.run` auf der Box (Cockpit) in `/etc/wireguard-ops-cockpit/agent.env`
schreiben; stage2 läuft nur einmal.

## James' Bearer

Der Token (`cpt_<hex>`) entsteht in Hermes (Tresor-Eintrag `cockpit-token-box`, mit `hermes` geteilt).
Auf die Box kommt nur `sha256(<hex>)` (`/etc/box-bootstrap/cockpit-token.sha256`, kein Geheimnis).
`deploy/helpers/cockpit-automation-token-seed` legt das Konto `hermes-automation` (Rolle `automation`,
kein Passwort-Login) an und trägt den Hash unter dem Label `hermes-tresor` mit den Routen aus
`deploy/config/automation-scopes.json` ein — gemessen am 08.11.2026 auf VPS und Lab0 (identisch: jede
Route mit dem Token aufgerufen, 403 „not authorized for this endpoint“ = nicht im Scope). Steht schon ein
`hermes-tresor`-Token, bleibt er. Danach ist die Hash-Datei verbraucht (`….sha256.used`): Das Deploy ruft
den Helfer nur, solange die unverbrauchte Datei da ist — ein später per Löschen der Zeile widerrufener
Token kommt mit keinem weiteren Deploy oder self.update zurück. Ein Konto gleichen Namens mit anderer Rolle
bricht ab, ohne etwas zu ändern (die Datei bleibt dann unverbraucht). Rotation:
`plugins/cockpit/schluessel.py --instanz box` (Hermes), ersetzt nur den Hash, über die Tür der Box.

## Nachweis

`/var/log/box-stage2.log` (über das Cockpit lesbar) und `cockpit_einblick instanz=box was=sitzungen` →
HTTP 200 (Hermes-Plugin `cockpit`, TLS nur gegen die interne CA).
