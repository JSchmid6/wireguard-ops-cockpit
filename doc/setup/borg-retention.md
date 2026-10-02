# Backup-Aufbewahrung — der Aufräum-Dienst auf Lab0

Jochen, 02.10.2026: „Wir brauchen die Möglichkeit, das über das Cockpit konfigurierbar
zu machen. Das wird auch nicht jedes Mal neu angefordert. Wir deployen fürs Aufräumen
einen Dienst, und der kann in bestimmten Bereichen eingestellt werden.“

Ausgangslage: Der borg-Schlüssel des VPS ist auf Lab0 seit 02.10. append-only
(`borg serve --append-only` in `authorized_keys` des Nutzers `borg`), und borgmatic auf
dem VPS macht nur noch `create` und `check`. Gelöscht wird damit nur noch auf Lab0, durch
diesen Dienst, lokal auf dem Repo-Pfad `/media/RAID/backup_VServer/borg` (borg 1.4), nie
über `borg serve`.

## Was der Dienst tut

`cockpit-borg-retention.timer` startet täglich (Vorgabe 06:00, nach dem nächtlichen Backup
des VPS) `cockpit-borg-retention.service`. Der Lauf (`cockpit-borg-retention.mjs --im-dienst`,
als `borg`, dem Besitzer des Repos):

1. liest die Einstellung (`/etc/cockpit-borg-retention/aufbewahrung.json`, sonst die
   Vorgabe) und prüft sie gegen die festen Grenzen; außerhalb löscht er nichts,
2. prüft, dass das Repo ihm gehört (neue Segmente eines root-Laufs könnte der VPS nicht
   mehr schreiben),
3. listet den Bestand (`borg list --json`) und vergleicht ihn mit seinem letzten Lauf,
4. `borg prune --list --glob-archives 'vmd61162-*' --keep-daily D --keep-weekly W
   [--keep-monthly M]`: nur die Serie des nächtlichen VPS-Backups; Handarchive mit
   anderem Namen fasst er nie an,
5. merkt sich sofort, was prune selbst entfernt hat (Vergleichsstand = Bestand vor prune
   ohne die von prune genannten Archive),
6. listet erneut und prüft, dass nur fehlt, was prune selbst genannt hat; danach gilt der
   neue Bestand als Vergleichsstand,
7. `borg compact --lock-wait 1`, danach noch einmal `borg list` (fehlt jetzt etwas, hält er
   an) und `borg info --json` für die Repo-Größe.

list und prune warten bis zu einer Stunde auf die Repo-Sperre (`--lock-wait 3600`): läuft
das Backup noch, wartet der Dienst, statt zu scheitern. `compact` wartet nicht: hält jemand
die Sperre zwischen der letzten Prüfung und compact (etwa ein Löschversuch vom VPS), wird an
diesem Tag nicht kompaktiert (`compactSkipped`), statt nach dem Warten eine ungeprüfte
Löschung endgültig zu machen. Passiert das zwei Läufe in Folge (etwa eine verwaiste Sperre),
endet der Lauf als Fehler. Der Lauf hat `Nice=10` und
`IOSchedulingClass=idle`.

Die Passphrase liest der Dienst aus `/etc/cockpit-borg-retention/passphrase` (root, 0600).
systemd reicht sie per `LoadCredential=passphrase:…` nur dieser Unit herein; borg holt sie
selbst über `BORG_PASSCOMMAND=cat $CREDENTIALS_DIRECTORY/passphrase`. Sie steht in keiner
Umgebung, keinem Argument und keinem Protokoll. **Die Datei legen Claude oder Jochen
einmalig ab; das gehört nicht zum Deploy.** Fehlt sie, startet der Lauf nicht (Unit
`failed`, im Cockpit „passphrase file: missing“).

## Fremde Löschungen werden nie endgültig

borg im append-only-Modus löscht nicht sofort: ein `borg delete`/`prune` über den
VPS-Schlüssel merkt die Archive nur vor. Endgültig weg sind sie erst nach einem `compact`
mit vollem Zugriff — also durch diesen Dienst. Deshalb vergleicht er vor dem Kompaktieren:

- **vor prune:** Archive des letzten Laufs, die jetzt fehlen,
- **nach prune:** Archive, die verschwunden sind, ohne dass prune sie genannt hat
  (gleichzeitig vorgemerkt).

Verglichen wird über die **Archiv-id**, nicht nur den Namen: ein `recreate` oder `rename`
behält vielleicht den Namen, aber nicht die id.

Fehlt etwas, das der Dienst nicht selbst entfernt hat: kein compact (und bei Befund vor
prune auch kein prune), Status **„angehalten“**, die Anomalie nennt **alle** fehlenden Archive
gegenüber dem Vergleichsstand, Rückgabewert 3 (die Unit steht auf
`failed`). Gemeldet wird über das **Cockpit**: das Panel „Backup retention“ zeigt den Status
rot, die fehlenden Archive und den Zeitpunkt; dazu `systemctl --failed` auf Lab0. Jeder
weitere Timer-Lauf bleibt angehalten und fasst das Repo nicht an.

Weiter geht es nur mit **Jochens Freigabe** (`freigeben <anomalie-id>`, im Cockpit „Approve
and resume“). Sie gilt genau für die Archive, die er gesehen hat (die id der Anomalie ist ein
Hash ihrer Archiv-ids). Fehlt nach der Freigabe noch ein weiteres Archiv, hält der Dienst
erneut an; die neue Anomalie nennt dann den ganzen Verlust (auch die schon freigegebenen
Archive), ihre Freigabe deckt alles. Nach der Freigabe startet der Lauf sofort und kompaktiert — dann sind die
freigegebenen Archive endgültig weg.

Der **erste Lauf** hat keinen Vergleichsstand: er prunt, merkt sich den Bestand und
kompaktiert erst beim nächsten Lauf. Das schützt nicht vor Löschungen, die schon vor dem
ersten Lauf vorgemerkt waren (siehe Ehrliche Grenzen) — es lässt Jochen nur einen Tag, den
Bestand im Cockpit anzusehen.

## Feste Grenzen

Die Grenzen stehen in `deploy/helpers/cockpit-borg-retention-rules.mjs`; API, Helfer,
Dienstlauf und Backup-Riegel lesen dieselbe Datei.

| Feld | Boden (nie darunter) | Untergrenze (darunter nur mit Freigabe) | Obergrenze (nie darüber) | Vorgabe |
| --- | --- | --- | --- | --- |
| `keep_daily` | 1 | 3 | 30 | 3 |
| `keep_weekly` | 0 | 2 | 12 | 2 |
| `keep_monthly` | 0 | 0 | 24 | 0 |
| Uhrzeit | — | — | 04:00–22:00 | 06:00 |

Mehr behalten geht immer bis zur Obergrenze. Die Vorgabe entspricht der bisherigen
Aufbewahrung des VPS (`keep_daily 3`, `keep_weekly 2`).

## Was frei ist und was Jochens Freigabe braucht

| Vorgang | Weg | Freigabe |
| --- | --- | --- |
| Dienstlauf (Timer, „Run now“, `cockpit-borg-retention run`, `systemctl start cockpit-borg-retention.service`) | Routine | keine |
| Einstellung innerhalb der Grenzen | Cockpit `PUT /api/borg/retention`, Helfer `set D W M HH:MM` | keine, Audit `borg.retention.changed` |
| prune und compact nach der eingestellten Regel | nur durch den Dienstlauf | keine |
| Einstellung unter der Untergrenze | Cockpit mit Bestätigung und Grund, Helfer `set … --freigabe` | **Jochen**, Audit `borg.retention.changed_with_approval` |
| Fortsetzen nach einer Anomalie | Cockpit „Approve and resume“, Helfer `freigeben <id>` | **Jochen**, Audit `borg.retention.resumed` |
| über der Obergrenze, unter dem Boden, Uhrzeit außerhalb | — | nie |
| `borg delete`, `recreate`, prune mit eigenen Werten, compact von Hand | host-run | **Jochen** (Backup-Riegel) |
| Dienst abschalten oder umgehen (Timer stoppen/abschalten/maskieren, Units, Einstellung, Zustand oder Code ändern) | host-run | **Jochen** (Backup-Riegel) |

„Freigabe“ heißt im Cockpit: eine **Admin-Sitzung** (Jochen) mit `approval: { confirmed:
true, reason: "…" }` (Grund mindestens 10 Zeichen). Ein Automation-Token (James) kann nicht
freigeben, auch nicht sich selbst (403, Audit `borg.retention.approval_refused`); eine
Anfrage unter der Untergrenze ohne Freigabe endet mit 409 (`needsApproval`, Audit
`borg.retention.approval_needed`).

**Backup-Riegel** (`deploy/helpers/cockpit-backup-guard.mjs`, `doc/setup/host-run.md` 2a):
frei sind nur `/usr/local/sbin/cockpit-borg-retention status|run`, `set D W M HH:MM` innerhalb
der Grenzen und `systemctl start cockpit-borg-retention.service`. Alles andere, was den Dienst
oder seine Dateien berührt, ist ein Treffer und wartet auf Jochen — auch Drop-ins, die systemd
ohne „borg“ im Namen auf seine Units anwendet (`cockpit-.service.d`, `cockpit-.timer.d`,
`service.d`, `timer.d` in `/etc`, `/run` und `/usr/lib/systemd/system`), systemd-Generatoren
(`system-generators`, `/run/systemd/generator*`) und `system.attached`. Der Helfer über
`node …mjs` statt über seinen sbin-Namen ist ebenfalls ein Treffer.

Die Prüf-Haken des Helfers (`BORG_RETENTION_*`, nur für die Tests) wirken nur außerhalb des
installierten Orts: die Kopie unter `/usr/local/lib/wireguard-ops-cockpit/` liest sie nie,
auch wenn ein Drop-in oder die Umgebung des systemd-Managers sie setzt.

## Schnittstellen

Helfer (`/usr/local/sbin/cockpit-borg-retention`, sudo nur für den Executor):

| Form | Wirkung | Rückgabe |
| --- | --- | --- |
| `status` | Datenblock `== DATEN (cockpit-borg-retention/v1) ==` + eine JSON-Zeile: Einstellung, Grenzen, Timer, Status, Anomalie, letzte 10 Läufe, Bestand (letzter Lauf), Platz (`statfs` des Repos), Repo-Größe | 0 |
| `run` | `systemctl start --no-block cockpit-borg-retention.service` | 0 / 69 |
| `set D W M HH:MM [--freigabe]` | Einstellung schreiben, Timer-Drop-in `cockpit-borg-retention.timer.d/uhrzeit.conf`, Zeile in `einstellungen.jsonl`, `daemon-reload`, `try-restart` des Timers | 0 / 65 außerhalb / 77 unter der Untergrenze ohne `--freigabe` / 69 gespeichert, aber Reload gescheitert |
| `freigeben <id>` | Freigabe für genau diese Anomalie, startet den Lauf | 0 / 3 nicht angehalten oder Lauf aktiv / 77 andere Anomalie |
| `--im-dienst` | der Lauf; nur aus der Unit (`COCKPIT_BORG_RETENTION_IN_UNIT`, nie als root) | 0 / 1 borg-Fehler / 3 angehalten / 65, 77 Einstellung ungültig / 78 Einrichtung fehlt |

Executor-Aktionen (`apps/executor-broker`): `borg.retention.status` und `.run` (Ziel `state`),
`.set` und `.set-approved` (Ziel `D-W-M-HH:MM`), `.resume` (Ziel: 16-hex-Anomalie-id).

API (`apps/api/src/borg-retention.ts`, Routen in `app.ts`):
`GET /api/borg/retention`, `PUT /api/borg/retention`, `POST /api/borg/retention/run`,
`POST /api/borg/retention/resume`. Die Antwort des Helfers wird Feld für Feld gegen ihre
Form geprüft; was nicht passt, fällt weg, Notizen laufen durch `sanitizeReason` (keine
Pfade, Adressen oder Zugangsdaten).

Dateien auf Lab0:

| Pfad | Besitzer | Inhalt |
| --- | --- | --- |
| `/usr/local/sbin/cockpit-borg-retention` | root 755 | sudo-Einstieg (startet den gepinnten Node-Lauf) |
| `/usr/local/lib/wireguard-ops-cockpit/cockpit-borg-retention{,-rules}.mjs` | root 755/644 | Helfer und Grenzen |
| `/etc/systemd/system/cockpit-borg-retention.{service,timer}` | root 644 | Units |
| `/etc/systemd/system/cockpit-borg-retention.timer.d/uhrzeit.conf` | root 644 | Uhrzeit aus dem Cockpit |
| `/etc/cockpit-borg-retention/aufbewahrung.json` | root 644 | Einstellung (ohne Datei gilt die Vorgabe) |
| `/etc/cockpit-borg-retention/passphrase` | root 600 | Passphrase (einmalig von Hand) |
| `/var/lib/cockpit-borg-retention/zustand.json`, `laeufe.jsonl`, `borg/` | borg (StateDirectory) | Status, Vergleichsstand, Läufe (letzte 100), borg-Cache und -Sicherheitsdaten |
| `/var/lib/cockpit-borg-retention/einstellungen.jsonl` | root 640 (im Verzeichnis des Diensts) | jede Änderung und Freigabe |

## Ausrollen

Lab0 rollt über die Tabelle von Schritt 8 seines Deploy-Skripts
`homeserver-cockpit-deploy.sh` aus (liegt nicht in diesem Repo, Quelle Nextcloud
`/Documents/homeserver-cockpit-deploy.sh`). Die Zeilen dafür:

```bash
install -m 755 -o root -g root "$COCKPIT_DIR/deploy/helpers/cockpit-borg-retention" /usr/local/sbin/cockpit-borg-retention
install -m 755 -o root -g root "$COCKPIT_DIR/deploy/helpers/cockpit-borg-retention.mjs" /usr/local/lib/wireguard-ops-cockpit/cockpit-borg-retention.mjs
install -m 644 -o root -g root "$COCKPIT_DIR/deploy/helpers/cockpit-borg-retention-rules.mjs" /usr/local/lib/wireguard-ops-cockpit/cockpit-borg-retention-rules.mjs
install -m 644 "$COCKPIT_DIR/deploy/systemd/cockpit-borg-retention.service" /etc/systemd/system/cockpit-borg-retention.service
install -m 644 "$COCKPIT_DIR/deploy/systemd/cockpit-borg-retention.timer" /etc/systemd/system/cockpit-borg-retention.timer
install -d -m 0755 -o root -g root /etc/cockpit-borg-retention
# Schritt 11, nach daemon-reload:
systemctl enable --now cockpit-borg-retention.timer
```

Die sudoers-Zeile kommt mit `deploy/sudoers/cockpit-executor`, das Schritt 8 ohnehin
installiert. Auf dem VPS läuft der Dienst nicht; dort installiert
`deploy/vps/vps-cockpit-deploy.sh` nur die Grenzen-Datei, weil der Backup-Riegel sie
importiert. Das Cockpit-Panel sagt auf einem Host ohne Dienst „not available on this host“.

Einmalig von Hand (nicht Teil des Deploys): die Passphrase ablegen, z. B.
`install -m 600 -o root -g root /dev/stdin /etc/cockpit-borg-retention/passphrase`, und mit
`/usr/local/sbin/cockpit-borg-retention status` prüfen (`installed.passphrase: "ok"`).

## Ehrliche Grenzen

- **Schlüsselmodus:** Der Dienst geht von einem `repokey`-Repo aus (Schlüssel im Repo, nur
  die Passphrase fehlt). Ist es ein `keyfile`-Repo, braucht der Lauf zusätzlich die
  Schlüsseldatei in `/var/lib/cockpit-borg-retention/borg/config/keys/`. Das ist vor dem
  ersten Lauf zu prüfen (`borg info` mit der Passphrase); diese Karte hat das nicht verifiziert.
- **Vergleich nur ab dem Vergleichsstand:** Geschützt ist, was beim letzten Lauf im Repo war.
  Ein Archiv, das zwischen zwei Läufen entsteht und wieder vorgemerkt wird, fällt nicht auf.
  Vor dem ersten Lauf vorgemerkte Löschungen erkennt der Dienst nicht; der zweite Lauf macht
  sie endgültig. Wer das ausschließen will, sieht vor dem zweiten Lauf (am Tag nach dem
  Ausrollen) den Bestand im Cockpit gegen `borg list` vom VPS durch.
- **Fenster vor compact:** Zwischen der letzten Prüfung und dem Start von compact liegen
  Millisekunden ohne Repo-Sperre. compact wartet nicht auf die Sperre und es gibt eine Prüfung
  danach; eine Löschung, die genau in dieses Fenster fällt und vor compact fertig ist, wird
  trotzdem endgültig — der Dienst meldet sie dann (Status „angehalten“, Phase `after-compact`).
- **Prüf-Haken:** Dass die installierte Kopie die `BORG_RETENTION_*`-Haken nicht liest, hängt
  am Installationsort; die Tests laufen aus dem Repo und können den installierten Ort nicht
  nachstellen (dafür bräuchte es root).
- **Serie:** prune räumt nur Archive `vmd61162-*`. Ändert sich der Hostname des VPS, prunt
  der Dienst nichts mehr (die Läufe zeigen dann `pruned 0`, das RAID füllt sich). Das ist die
  sichere Richtung, will aber gesehen werden.
- **Freigabe in der API:** Ob eine Einstellung unter der Untergrenze oder ein Fortsetzen
  freigegeben ist, entscheidet die API (Admin-Sitzung). Der Helfer verlangt dafür nur die
  Form (`--freigabe`, die richtige Anomalie-id). Wie beim borg-Repair gilt: wer die
  Executor-Zugangsdaten hat, kann die API umgehen.
- **Freigabe-Fenster:** `freigeben` weist ab, solange der Lauf aktiv ist. Startet der Timer im
  Moment danach, kann der Lauf die Freigabe noch nicht sehen; er bleibt dann angehalten und
  schreibt den Zustand nicht um. Das ist die sichere Richtung: die Freigabe muss dann
  wiederholt werden.

## Tests

- `apps/api/test/borg-retention-rules.test.ts`: Grenzen (Vorgabe, Ober-/Untergrenze, Boden,
  Uhrzeitfenster, Zahlenformen), Bestandsvergleich über die id, prune-Liste, Verlust während prune.
- `apps/api/test/borg-retention-helper.test.ts`: der echte Helfer gegen einen borg- und einen
  systemctl-Stub. Erster Lauf ohne compact, Folgelauf mit compact, Passphrase nur als
  Credential-Befehl, Anomalie vor und nach prune, recreate, Freigabe nur für die gesehene
  Anomalie, keine Deckung späterer Verluste, Einstellung mit Drop-in und Protokoll,
  Untergrenze/Obergrenze/Boden/Uhrzeit, Status-Bericht, Läufe außerhalb der Unit.
- `apps/api/test/borg-retention-api.test.ts`: Routen, Freigabe nur aus Jochens Sitzung,
  Audit-Einträge, Bericht-Prüfung.
- `apps/api/test/backup-guard.test.ts`: Routine des Diensts frei, alle Freigabe-Formen gesperrt.
- `apps/executor-broker/test/index.test.mjs`: die fünf gepinnten Executor-Formen.
- `apps/web/src/RetentionPanel.test.tsx`: Anzeige, Speichern, Freigabe-Dialog, Anomalie.
