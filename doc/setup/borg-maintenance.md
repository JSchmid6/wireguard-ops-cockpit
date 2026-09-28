# Borg-Betrieb — Zustand ansehen und Wartung bestellen

Dieses Modul macht den Backup-Betrieb von der Ad-hoc-Shell zu einer Sache der
Cockpit-Policy: der Zustand ist lesbar, ein Repo-Check und ein Repair laufen als
typisierte Aktion mit Audit und Freigabe.

## Vertrag

| Aktion | Form im Plan | Wirkung | Freigabe |
| --- | --- | --- | --- |
| `borg.status` | `/usr/local/sbin/cockpit-borg-action status` | lesend: borgmatic-Timer, letzte Läufe (Journal), laufende Wartungs-Unit, jüngste Archive, Repo-Kennzahlen, Statusdatei der Kiste. Läuft in einer eigenen transienten Unit (`--wait --pipe --collect`) | autonom (keine) |
| `borg.check` | `/usr/local/sbin/cockpit-borg-action check` | startet `borgmatic --verbosity 1 check --force` in der Unit `cockpit-borg-check-<stamp>` und kehrt sofort zurück | autonom (keine) |
| `borg.repair` | `/usr/local/sbin/cockpit-borg-action repair` | startet `borgmatic --verbosity 1 check --repair --force` in der Unit `cockpit-borg-repair-<stamp>`; kann beschädigte Archive entfernen (siehe unten) | **Operator** (`blocked_user_approval`) |

Alles andere (`restore`, `delete`, zusätzliche Argumente, ein Pfad ausserhalb
`/usr/local/sbin/`) ist kein `borg.manage`, sondern `shell.exception` — es läuft
durch keinen automatischen Job.

Die Fähigkeit heisst `borg.manage` und liegt in der Allowlist des Aufrufers: ein
Change-Job muss `allowedCapabilities: ["borg.manage"]` mitbringen, sonst endet der
Plan als `blocked_user_approval` (Capability-Eskalation).

## Warum jedes Verb in einer eigenen systemd-Unit läuft

Der Executor (`wireguard-ops-cockpit-executor.service`), über den die typisierten
Aktionen laufen, ist absichtlich streng sandboxed (`RestrictAddressFamilies=AF_UNIX`,
`ProtectHome=read-only`, `PrivateTmp=yes`, `ProtectSystem=…`). In dieser Sandbox
geht der Borg-Betrieb nicht:

* kein SSH zur Kiste — `borgmatic list/info/check` scheitern am Socket,
* kein Schreibzugriff auf `/root/.cache/borg` und `/root/.config/borg` — borg kann
  seinen Cache nicht führen,
* und ein dort „abgesetzter“ Lauf (`setsid`) bliebe im cgroup des Executors: ein
  Neustart des Dienstes (z. B. beim Selbst-Update) beendet einen stundenlangen
  Check mitten im Lauf.

Darum startet der Helfer jedes der drei Verben über `systemd-run` als eigene
transiente Unit — ausserhalb der Sandbox, im eigenen cgroup, mit eigenem Journal:

* `status`: `systemd-run --wait --pipe --collect`. Die Ausgabe kommt durch
  `--pipe` durch, der Rückgabecode des Laufs durch `--wait` — `rc=2` („Repo nicht
  erreichbar“) bleibt also erhalten.
* `check`/`repair`: `systemd-run --collect --unit=cockpit-borg-<verb>-<stamp>` **ohne**
  `--wait`. Der Aufruf kehrt nach dem Start zurück (der Executor ist eine
  Anfrage/Antwort-Strecke und darf nicht Stunden warten), die Unit läuft weiter.
  `Type=exec` lässt einen Startfehler noch im Aufruf auffallen (rc=69),
  `RuntimeMaxSec=86400` beendet einen hängenden Lauf nach 24 h,
  `Nice=10` und `IOSchedulingClass=idle` halten den stundenlangen Lauf aus dem Weg
  von Nextcloud und GitLab: er bekommt CPU und Platte nur, wenn sonst niemand
  will. `status` bekommt das **nicht** — es ist eine kurze Abfrage. (Beides wirkt
  auf diesem Host; die Platte der Kiste wird vom entfernten `borg`-Prozess
  belastet und sieht davon nichts.)

Der Laufzustand ist damit systemd-Zustand, nicht eine PID-Datei:
`systemctl is-active <unit>`, `systemctl status <unit>`, `journalctl -u <unit>`.
`status` zeigt die laufende Unit mit ihrem Journal und nach dem Lauf die zuletzt
gestartete Unit; `--collect` räumt jede Unit nach ihrem Ende ab.

## check und repair: drei Riegel

1. **Kein zweiter Lauf (rc=3).** Abgelehnt wird, wenn eine borg-Wartungs-Unit aktiv
   ist, `borgmatic.service` läuft (nächtliches Backup) oder die Sperrdatei
   `/run/lock/cockpit-borg.lock` belegt ist. Der gestartete Lauf hält die Sperre
   selbst, solange er dauert; systemd räumt sie mit der Unit ab.
2. **Frist bis zum Timer (rc=3).** `check`/`repair` starten nicht, wenn der nächste
   `borgmatic.timer`-Lauf in weniger als 8 h ansteht. Die Zeit kommt aus
   `systemctl list-timers borgmatic.timer --output=json`: dort steht `next` in
   Mikrosekunden **seit der Epoche** — keine Wanduhr, also auch keine Zeitzonen-
   oder Sommerzeitrechnung im Helfer. (`systemctl show … NextElapseUSecRealtime`
   formatiert in Ortszeit; wer das als UTC liest, liegt im Sommer zwei und im
   Winter eine Stunde daneben.) Der Host läuft in CEST, der Timer mit
   `OnCalendar=daily` und `RandomizedDelaySec=3h`. Grund: ein Check über ~3,5 TB
   läuft Stunden; ein Start kurz vor dem Timer liesse das nächtliche Backup in die
   Repo-Sperre laufen (genau das passierte am 22.09.2026). Ist der Timer nicht
   aktiv, gibt es nichts zu kollidieren (der Helfer sagt es im Klartext); steht
   kein nächster Lauf fest (`next` ist `null`, leere Liste), ist die Ausgabe
   unbrauchbar oder fehlt `systemctl`, wird **nicht** gestartet (fail closed).
3. **`--force`.** borgmatic überspringt Checks, die innerhalb der konfigurierten
   Frequenz liegen („Skipping archives check due to configured frequency“) — ohne
   `--force` wäre `check` ein No-op, der wie ein grüner Check aussieht. `check`
   läuft darum mit `--force`.

`repair` setzt zusätzlich `BORG_CHECK_I_KNOW_WHAT_I_AM_DOING=YES` (borg fragt sonst
interaktiv „Type 'YES'…“ und der Lauf stirbt headless).

## Das nächtliche Backup wartet auf die Sperre

Die 8-h-Frist (Riegel 2) ist nur so gut wie die Schätzung, wie lange ein Check
über ~4,7 TB dauert. Gemessen ist das nicht. Darum gibt es einen zweiten,
unabhängigen Riegel **auf der Seite des Backups**:

`/etc/systemd/system/borgmatic.service.d/cockpit-borg-lock.conf`

```
[Service]
ExecStartPre=/usr/bin/flock /run/lock/cockpit-borg.lock /bin/true
```

`flock` ohne `-n` blockiert, bis die Repo-Sperre frei ist, und läuft danach
`/bin/true` (rc=0). Ein `check`/`repair`, das die Frist passiert hat und dann
länger dauert als gedacht, lässt das nächtliche `create` also **warten** statt
scheitern. `borgmatic.service` ist `Type=oneshot` und hat damit keinen
Start-Timeout — Warten kostet hier nichts; die Unit steht solange auf
`activating`, und `status` zeigt den Wartenden als belegtes Repo.

Eigenschaften des Riegels:

* Er beschleunigt nichts und ändert nichts an borgmatic — er hält nur den Start
  auf. Die Sperre selbst hält weiterhin der Wartungslauf, solange er dauert.
* Er ist **kein** Ersatz für die Frist: der wartende Backup-Lauf hält die Sperre
  selbst noch nicht, ein überlanger Check kann das Backup also weit in den Morgen
  schieben.
* Er setzt `/usr/bin/flock` voraus (util-linux) — ohne `flock` scheitert der Start
  des Backups. systemd selbst hängt an util-linux, und der Helfer braucht `flock`
  ohnehin für dieselbe Sperre.
* Fremde Drop-ins in demselben Verzeichnis (z. B. `nach-gitlab-backup.conf`)
  bleiben unangetastet; `ExecStartPre`-Einträge mehrerer Drop-ins gelten
  nebeneinander.
* Installiert wird die Datei von `deploy/vps/vps-cockpit-deploy.sh` (Tabelle) —
  wie der Helfer, also auch über den Selbst-Update-Weg. Der Rückfall des Skripts
  nimmt genau diese Datei wieder weg (bzw. stellt den vorherigen Stand her).

## repair: erst nach einem Befund

`repair` ist **kein** Routinewerkzeug und keine Vorsichtsmassnahme. Mit `--repair`
entfernt borg Archive bzw. Segmente, die es nicht mehr lesen kann — die
betroffenen Archivzeitpunkte sind danach aus dem Repository **weg**, ihre Dateien
lassen sich nicht mehr wiederherstellen. Der Weg:

1. `check` bestellen (autonom). Das Journal nennt das auffällige Archiv:
   `journalctl -u cockpit-borg-check-<stamp>`.
2. Befund lesen — und entscheiden, ob die betroffenen Archivzeitpunkte entbehrlich
   sind. `status` zeigt danach die Unit und nach `check` den Befund im Journal.
3. Erst dann `repair` bestellen. Die API erzwingt dafür die Freigabe des Operators
   (`borg.repair` ⇒ `blocked_user_approval`).
4. Nach dem Lauf `status`: Fortschritt und Ergebnis stehen im Journal der Unit;
   das nächste nächtliche `create` schreibt den neuen Stand. Die übrigen Archive
   bleiben unangetastet.

Was `repair` **nicht** tut: den Repo-Schlüssel anfassen, Konfiguration ändern, den
Timer abschalten oder Backups löschen, die noch lesbar sind.

## status: bei belegtem Repo wird nicht abgefragt

Während Backup oder Wartung hält borg die Repo-Sperre. `borgmatic list/info`
scheiterten dann und das Repo sähe „nicht erreichbar“ aus (rc=2), obwohl es nur
belegt ist. `status` fragt darum **gar nicht** ab, sondern meldet
`repo: belegt (Backup|check|repair läuft)` mit rc=0. `rc=2` („Repo nicht
erreichbar“) heisst weiterhin genau das.

## Dateien

| Pfad (Host) | Quelle | Zweck |
| --- | --- | --- |
| `/usr/local/sbin/cockpit-borg-action` | `deploy/helpers/cockpit-borg-action` | der einzige sudo-exponierte Einstieg; gepinnte Grammatik `status\|check\|repair` |
| `/etc/sudoers.d/cockpit-executor` | `deploy/sudoers/cockpit-executor` | Zeile `cockpit-executor ALL=(root) NOPASSWD: /usr/local/sbin/cockpit-borg-action *` |
| `/var/lib/wireguard-ops-cockpit/borg/last.unit`, `last.kind` | Laufzeit | zuletzt gestartete Wartungs-Unit und ihre Art, 0750 root — nur für die Anzeige; **der Laufzustand kommt aus systemd** (`systemctl is-active <unit>`) |
| `/run/lock/cockpit-borg.lock` | Laufzeit | Sperre gegen zwei gleichzeitige Läufe auf demselben Repo |
| `/etc/systemd/system/borgmatic.service.d/cockpit-borg-lock.conf` | `deploy/systemd/borgmatic-cockpit-borg-lock.conf` | Drop-in: das nächtliche Backup wartet auf die Sperre, statt an ihr zu scheitern |
| Journal der Unit | systemd | Fortschritt und Ergebnis jedes Laufs (`journalctl -u cockpit-borg-<verb>-<stamp>`); ein eigenes Logverzeichnis gibt es nicht mehr |

Installiert werden Helfer und Drop-in von `deploy/vps/vps-cockpit-deploy.sh`
(Tabelle) — also auch über den Selbst-Update-Weg des Cockpits, ohne Handgriff am
Terminal.

## Rückgabewerte

`0` ok · `2` Repo nicht erreichbar (nur `status`) · `3` es läuft schon eine Wartung
oder zu wenig Frist bis zum Timer · `64` Aufruffehler · `67` falscher Host
(`check`/`repair` auf einer Maschine ohne borgmatic) oder fehlende Umgebung ·
`69` die Unit konnte nicht starten.

## Grenzen (bewusst)

* Der Repo-Schlüssel bleibt ausschliesslich auf dem VPS. Der Helfer liest
  `/etc/borgmatic/config.yaml` **nie** — die Datei enthält Klartext-Zugangsdaten
  (mysqldump, borg). Es laufen nur borgmatic-Kommandos, die den Schlüssel selbst
  benutzen und nur ihre Zusammenfassung ausgeben.
* Keine freien Argumente, keine Pfade, kein `borg`-Rohkommando, kein `--repair`
  ohne vorherige Freigabe. Die internen Payload-Verben (`--payload <verb>`) laufen
  nur aus der eigenen Unit: sie verlangen `COCKPIT_BORG_ACTION_IN_UNIT`, das die
  Unit selbst setzt — und `sudo` lässt ohne SETENV keine Umgebung durch.
* Kein Runtime-Sudo: die Zeile steht in der versionierten, vom Deploy geprüften
  sudoers-Datei; die API kann sich keine Rechte bauen.
* Kein tmux-Runbook für borg: Runbook-Sitzungen laufen als `wgops`, der
  Repo-Schlüssel gehört root. Der lesende Weg ist die typisierte Aktion, nicht
  eine Shell-Sitzung.

## Zustand der Kiste (Baustein „Sichtbarkeit“)

`status` beantwortet auch „was macht die Kiste?“ ohne SSH:

* auf dem VPS: Array-Zustand und freier Platz aus der Statusdatei
  `http://10.0.0.5:8088/status.txt` (`MDSTAT`, `DF /media/RAID`), die der
  Dateidienst der Kiste ohnehin erzeugt;
* wenn `status` auf der Kiste selbst läuft (dort gibt es kein borgmatic, weil
  kein Schlüssel): Mount, Platz und das Repo-Verzeichnis — Existenz, mtime,
  Grösse, Anzahl Datensegmente und das jüngste Segment. Ein nicht erreichbares
  Repo meldet `status` mit rc=2 und `repo_erreichbar: nein`, damit der Job als
  Befund endet und nicht als „alles gut“.

## Den Zustand im Cockpit sehen

Der Zustand ist jetzt ein Feld der Cockpit-Anzeige, nicht mehr nur die Ausgabe
eines Auftrags. Read-only, mit Quelle und Zeitstempel je Wert:

| Route | Wirkung |
| --- | --- |
| `GET /api/borg/status` | liefert den letzten gemessenen Stand; ist er älter als 10 Minuten, stösst die Route im Hintergrund eine neue Messung an und antwortet trotzdem sofort |
| `POST /api/borg/status/refresh` | misst jetzt und wartet bis zu 25 s auf das Ergebnis |

Beide Routen verlangen eine Anmeldung (Operator-Sitzung oder ein Bearer-Token
mit genau diesem Scope). `borg.status` ist lesend — es gibt dafür **keine**
Freigabe und keinen Audit-Eintrag; `check`/`repair` bleiben der auditierte,
freigabepflichtige Weg über die Policy.

Angezeigt werden:

* **letzter borgmatic-Lauf** — Beginn und Ende (Zeitstempel aus
  `journalctl -u borgmatic`, ISO mit Zone), Ergebnis und Exit-Status aus
  `systemctl show borgmatic.service -p Result -p ExecMainStatus`,
* **letzter Repo-Check** — Art (`check`/`repair`), Zustand, `rc`, Zeitpunkt und
  Unit, wenn das Cockpit einen Check gestartet hat; das Ergebnis kommt aus dem
  Journal der Unit (`Ende: <ISO> (rc=<n>)`), die Unit selbst ist mit `--collect`
  nach dem Lauf weg,
  * **Konsistenzprüfung des nächtlichen Laufs** — getrennt geführt und meist
  `skipped`: borgmatic fährt den Check nur nach seiner konfigurierten Frequenz.
  Ein übersprungener Check ist **kein** grüner Check; „ok" wird hier nur aus einem
  wirklich gelaufenen Check mit `rc=0`.

### Woher die Werte kommen (und was sie nicht enthalten)

Der Helfer endet mit einem maschinenlesbaren Block
`== DATEN (cockpit-borg-status/v1) ==`: ein Schlüssel je Zeile, als Wert nur
ISO-Zeit mit Zone, ganze Zahl, Einheitenname oder feste Aufzählung. Die API
(`apps/api/src/borg-status.ts`) liest **ausschliesslich** diesen Block und
verwirft jede Zeile, die nicht in das Muster passt; überlange Werte werden
verworfen, nicht abgeschnitten. Damit landen weder Pfade noch Zugangsdaten oder
etwas aus `/etc/borgmatic/config.yaml` in der Anzeige oder im Log — der Offline-Test
`test/cockpit-borg-action.test.sh` prüft genau das, und
`apps/api/test/borg-status.test.ts` prüft die Gegenseite (Fremdzeilen,
Pfad-Injektion, fehlender Block).

Fehlt der Helfer auf dem Host oder ist er älter als dieser Stand, sagt die
Anzeige `failed`/`unknown` samt Grund — sie erfindet keine Werte. Dasselbe gilt
für alle drei Werte einzeln, solange keine Quelle vorliegt.

**Der Grund wird geschwärzt.** Auf dem Fehlerpfad reicht der Executor-Broker die
rohe Helfer-Ausgabe durch (`error: [stderr, stdout].join("\n")`); darin stehen
Pfade, URLs und Adressen (`ssh://borg@…/media/…`, `/usr/local/sbin/…`,
`fe80::1`). Bevor etwas davon in die Anzeige kommt, ersetzt `sanitizeReason`
jedes Token mit einem Pfadtrenner, jede URL und jede Adresse (IPv4 und IPv6) —
eine Uhrzeit wie `02:56:06` bleibt dabei lesbar. Geprüft in
`apps/api/test/borg-status.test.ts`.

**Ein Befund ist kein Ausfall.** Endet der Helfer mit einem Befund-Exitcode
(z. B. `rc=2` „Repo nicht erreichbar"), steht der Datenblock trotzdem in dieser
Ausgabe. Die API übernimmt ihn dann: Timer, letzter Lauf und Check-Ergebnis sind
host-lokal gemessen und bleiben gültig, der Grund steht als
`Messung mit Befund: …` daneben. Ohne Block bleibt es bei `failed` ohne Werte —
und ein grüner Check entsteht aus einem Befund nie.

### Ausrollen und zurücknehmen

Das Ausrollen ist der normale Weg dieses Repos: Pin auf einen Commit ziehen, der
`cockpit-borg-action` **und** das systemd-Drop-in mitbringt
(`deploy/vps/vps-cockpit-deploy.sh` installiert beides), also ≥ `d5b6a0d` für den
Helfer und ≥ dem Commit dieses Abschnitts für den Datenblock. Ohne diesen Stand
gibt es den Block nicht, und die Anzeige bleibt bei `unknown` — sie zeigt dann
nichts Falsches, nur nichts.

Zurücknehmen heisst: den Pin wieder auf den alten Commit ziehen. Der Deploy
baut den alten Stand neu, stellt die installierten Dateien aus seinem Backup
wieder her und startet die laufenden Dienste **nicht** neu (siehe Rollback im
Deploy-Skript). Die Anzeige ist rein lesend, es gibt keine Daten und keinen
Zustand, der dabei verloren gehen könnte; ältere Helfer ohne Datenblock werden von
der API als „kein Block" erkannt.
