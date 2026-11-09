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

   „Läuft“ heisst für jede dieser Units: Zustand `active`, **`activating`**,
   `deactivating` oder `reloading`. Der Helfer liest dafür den Zustandstext von
   `systemctl is-active <unit>`, nicht dessen Rückgabecode: `borgmatic.service` ist
   `Type=oneshot` und steht während des **ganzen** Backups auf `activating` —
   und `systemctl is-active --quiet` gibt dafür rc=3, dieselbe Zahl wie für
   `inactive`. Nur nach dem Rückgabecode hielte der Helfer ein laufendes Backup
   für beendet und startete einen `check` mitten hinein (Befund W1). Die
   Wartungs-Units (`Type=exec`) stehen nur bis zum Start auf `activating`, beim
   Stoppen aber auf `deactivating`, während borg noch die Repo-Sperre hält — sie
   gehen deshalb über dieselbe Regel. Der Ablehnungsgrund nennt den Zustand,
   z. B. `Backup läuft (activating)`.
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
`activating`, und `status` zeigt den Wartenden als belegtes Repo. Dasselbe gilt
für die kurzen Repo-Abfragen der Anzeige: `status` hält die Sperre für
`list`/`info` ein paar Sekunden, ein genau dann startendes Backup wartet so lange.

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
   (`borg.repair` ⇒ `blocked_user_approval`): die Plan-Policy liest die
   typisierte Zeile mit demselben Parser wie die Ausführung (`requestsBorgRepair`
   über `typedPlanScript`) — aber über den **ganzen** Plan, also auch in einem
   zweiten Code-Block oder einem anderen Fence, und unabhängig davon, ob der Plan
   ein Capability-Manifest mitbringt. Den zweiten Riegel hält der Executor: er
   führt einen `repair` nur aus, wenn die Freigabe an genau diesen Job gebunden ist.
4. Nach dem Lauf `status`: Fortschritt und Ergebnis stehen im Journal der Unit;
   das nächste nächtliche `create` schreibt den neuen Stand. Die übrigen Archive
   bleiben unangetastet.

Was `repair` **nicht** tut: den Repo-Schlüssel anfassen, Konfiguration ändern, den
Timer abschalten oder Backups löschen, die noch lesbar sind.

## status: bei belegtem Repo oder belegter Sperre wird nicht abgefragt

Während Backup oder Wartung hält borg die Repo-Sperre. `borgmatic list/info`
scheiterten dann und das Repo sähe „nicht erreichbar“ aus (rc=2), obwohl es nur
belegt ist. `status` fragt darum **gar nicht** ab, sondern meldet
`repo: belegt (Backup|check|repair läuft, <Zustand>)` mit rc=0 — belegt nach
derselben Regel wie Riegel 1, also auch bei `activating` (das oneshot-Backup
während seines ganzen Laufs) und `deactivating`. `rc=2` („Repo nicht
erreichbar“) heisst weiterhin genau das.

Läuft nichts, nimmt `status` für seine Abfragen selbst die Sperre
`/run/lock/cockpit-borg.lock` — **einmal** um `list` und `info`, frei gleich nach
`info`. Die Anzeige misst alle 10 Minuten, solange jemand sie offen hat; ohne die
Sperre könnte der nächtliche Timer genau dann starten und `create` an der
Repo-Sperre von borg scheitern (borg wartet von selbst nur 1 s). Mit ihr wartet
das Backup über das Drop-in die paar Sekunden ab.

* Ist die Sperre nach 60 s nicht frei, fragt `status` nicht ab und meldet
  `repo: belegt (Sperre /run/lock/cockpit-borg.lock nach 60 s nicht frei)`,
  `repo_erreichbar: belegt (nicht abgefragt)`, rc=0.
* Ist die Sperre gar nicht nehmbar (`flock` fehlt oder scheitert), endet `status`
  mit rc=67 — ohne Sperre wird nicht abgefragt.
* Das Warten läuft gegen das Zeitbudget der status-Unit (`RuntimeMaxSec=200`) und
  bleibt gedeckelt: 60 s Warten, danach nur der kurze Belegt-Ausgang.
* Umgekehrt weist `check`/`repair` (Riegel 1) mit rc=3 ab, solange eine
  status-Abfrage die Sperre hält. Das Fenster ist Sekunden kurz und gewollt: beide
  teilen dieselbe Sperre.

## Dateien

| Pfad (Host) | Quelle | Zweck |
| --- | --- | --- |
| `/usr/local/sbin/cockpit-borg-action` | `deploy/helpers/cockpit-borg-action` | der einzige sudo-exponierte Einstieg; gepinnte Grammatik `status\|check\|repair` (dazu `db-access …` und `sources …`, nur aus einem Lauf der allgemeinen Tür) |
| `/etc/borgmatic/cockpit-sources.patterns` (+ `.vor-<Zeit>`) | `sources connect` legt sie an, `sources add` ergänzt | zusätzliche Backup-Quellen als `R <pfad>`-Zeilen, 0644 root, kein Geheimnis; `config.yaml` nennt sie per `patterns_from` |
| `/etc/borgmatic/mysqldump.cnf` (+ `.vor-<Zeit>`) | heute `db-access adopt` (Zwischenweg B), Ziel `db-access ensure` (Weg A, Karte t_58a51884) | Anmeldung des mysqldump-Hooks, 0600 root: heute das Nextcloud-Konto `nextDB` — an das NC-Passwort gekoppelt, gedumpt wird nur `nextcloud`, **nicht** `wordpress`; Ziel `cockpit_backup@localhost`. Die `.vor-`Dateien sind der Rückweg |
| `/etc/sudoers.d/cockpit-executor` | `deploy/sudoers/cockpit-executor` | Zeile `cockpit-executor ALL=(root) NOPASSWD: /usr/local/sbin/cockpit-borg-action *` |
| `/var/lib/wireguard-ops-cockpit/borg/last.unit`, `last.kind` | Laufzeit | zuletzt gestartete Wartungs-Unit und ihre Art, 0750 root — nur für die Anzeige; **der Laufzustand kommt aus systemd** (`systemctl is-active <unit>`) |
| `/run/lock/cockpit-borg.lock` | Laufzeit | Sperre gegen zwei gleichzeitige Läufe auf demselben Repo: `check`/`repair` halten sie für die Dauer des Laufs, die Repo-Abfragen von `status` kurz (ist sie nach 60 s nicht frei, meldet `status` „belegt“ mit rc=0); das nächtliche Backup wartet auf sie |
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
* Keine freien Argumente, keine Pfade (einzige Ausnahme: `sources add <pfad>` mit fester Wurzel-Liste, unten), kein `borg`-Rohkommando, kein `--repair`
  ohne vorherige Freigabe. Die internen Payload-Verben (`--payload <verb>`) laufen
  nur aus der eigenen Unit: sie verlangen `COCKPIT_BORG_ACTION_IN_UNIT`, das die
  Unit selbst setzt — und `sudo` lässt ohne SETENV keine Umgebung durch.
* Kein Runtime-Sudo: die Zeile steht in der versionierten, vom Deploy geprüften
  sudoers-Datei; die API kann sich keine Rechte bauen.
* Kein tmux-Runbook für borg: Runbook-Sitzungen laufen als `wgops`, der
  Repo-Schlüssel gehört root. Der lesende Weg ist die typisierte Aktion, nicht
  eine Shell-Sitzung.

## DB-Zugang des Backups (`db-access`, 28.10.2026)

Der mysqldump-Hook der borgmatic-Konfiguration
(`mysqldump --defaults-extra-file=/etc/borgmatic/mysqldump.cnf --single-transaction --quick --all-databases`)
meldete sich bis zum 26.10.2026 mit dem **Nextcloud-Konto** an. Nach dessen Passwort-Rotation
(Karte t_bc2b0db1) scheiterte jedes Backup mit 1045, zwei Nächte lang. **Entscheidung (Jochen,
28.10.2026, Karte t_30c9ea52):** Ziel ist ein eigenes Konto, entkoppelt von Nextcloud-
und WordPress-Passwörtern. **Ist-Stand:** das ist noch nicht umgesetzt — live läuft Zwischenweg B
(`adopt`, Nextcloud-Konto, nur DB `nextcloud`, WordPress nicht im Dump; siehe Befund unten), bis
Weg A (Karte t_58a51884) da ist.

| Form | Wirkung |
| --- | --- |
| `cockpit-borg-action db-access status` | lesend: Besitz/Modus der Datei, Konto (`user=`-Zeile), ob die Anmeldung geht (Fehlerzeile der Datenbank), Zahl der Sicherungen. Kein Wert. |
| `cockpit-borg-action db-access check` | rc=0, wenn das Konto der Datei sich anmeldet und `mysqldump --all-databases --no-data` durchläuft (wie der Hook, nur das Schema) |
| `cockpit-borg-action db-access ensure` | legt `cockpit_backup@localhost` an (oder setzt ihm ein neues Passwort), entzieht alles und gibt genau `SELECT, SHOW VIEW, TRIGGER, LOCK TABLES, SHOW DATABASES` auf `*.*` (der Hook dumpt alle Datenbanken, ohne `--events`, darum kein EVENT), prüft das neue Konto mit einer Arbeitsdatei, sichert die alte Datei als `mysqldump.cnf.vor-<UTC-Zeit>` (0600) und tauscht dann (0600 root). Übrige Zeilen der alten Datei außer `user`/`password` bleiben. |
| `cockpit-borg-action db-access adopt` | **Zwischenweg B** (Jochen 28.10.2026): schreibt das aktuelle Nextcloud-DB-Konto aus `config.php` (gelesen als `www-data`, wie bei `ensure`) in die Datei; an der Datenbank ändert sich nichts. Prüft die neue Anmeldung und den Schema-Dump mit einer Arbeitsdatei, sichert die alte Datei als `.vor-<UTC-Zeit>` und tauscht (0600 root). Für den Fall, dass `ensure` kein Konto anlegen kann (siehe unten). |
| `cockpit-borg-action db-access restore` | spielt die jüngste `.vor-`Datei zurück. Gehört sie schon dem Backup-Konto (Stand vor einer Rotation), setzt `restore` das Konto zuerst auf ihren Hash — dafür braucht es wieder die Verwaltungs-Anmeldung (unten, X1). Gehört sie dem alten Nextcloud-Konto (Stand vor dem ersten `ensure`), bleibt `cockpit_backup` bestehen, ohne Wirkung. |

Grenzen:

* **Nur aus einem Lauf der allgemeinen Tür:** der Aufruf muss in der cgroup einer Lauf-Unit
  `cockpit-host-run-<job>.service` stehen. Der Executor kommt per sudo an den Helfer, aber nicht in
  diese cgroup — `db-access` ist für ihn mit rc=64 zu. Damit bleibt `borg.manage` bei
  `status|check|repair`.
* **Kein Wert verlässt die Shell:** das Zufallspasswort (40 Zeichen `[A-Za-z0-9]` aus
  `/dev/urandom`) und die Verwaltungs-Anmeldung gehen nur über `printf` (bash-builtin) in eine
  Pipe bzw. ein `/dev/fd` — nie in argv, Umgebung, Protokoll oder Ausgabe. Das Protokoll der Tür
  schwärzt zusätzlich jede `password=`-Zuweisung.
* **Die Verwaltungs-Anmeldung** ist das Nextcloud-DB-Konto aus `config.php`: auf
  diesem Host sind root (Socket und `debian.cnf`) und `mysql@localhost` passwortgeschützt
  (Inventar-Jobs 697b46d0, be3a0f57), ein anderes Konto mit `CREATE USER` gibt es nicht. Gelesen
  wird die Datei als `www-data` (`runuser`), weil sie www-data-beschreibbar war — root führt ihren
  Code nie aus. Das ist Lesen eines Geheimnisses (X1): der Lauf nennt es im Intent, und der Befund
  geht an Jochen. Nach einem `ensure` braucht das Backup das Nextcloud-Passwort nie wieder (nach `adopt` schon — siehe Befund unten); eine spätere
  Rotation des Backup-Passworts ist ein weiteres `ensure`, ein `restore` nach einer Rotation setzt
  den Hash zurück — beide wieder mit dieser Anmeldung und damit wieder X1 im Intent.
* **Die Datenbank bekommt nur den Hash:** `ensure` rechnet den `mysql_native_password`-Hash im
  Helfer und setzt ihn per `IDENTIFIED BY PASSWORD '<hash>'`; der Klartext steht nur in der Datei.
  Scheitert eine Rotation nach dem `ALTER USER`, bekommt das Konto den alten Hash zurück — die
  alte Datei bleibt gültig (fail closed).
* **Repo-Sperre:** `ensure`, `adopt` und `restore` halten `/run/lock/cockpit-borg.lock` bis zum Ende; der
  Drop-in `cockpit-borg-lock.conf` lässt den Nachtlauf darauf warten, er fällt also nie zwischen
  `ALTER USER` und den Tausch der Datei. Belegt (Prüfung läuft) → rc=3, nichts verändert.
* **Prüf-Haken nur in einer Kopie:** Unter `/usr/local/sbin/cockpit-borg-action` gelten immer die
  festen Pfade (Datei, `config.php`, `/proc/self/cgroup`) und das feste Konto; die
  `COCKPIT_BORG_ACTION_DB_*`-Variablen wirken nur in einer Testkopie des Helfers. `xtrace` ist
  im Helfer abgeschaltet.
* **TRIGGER ist kein reines Leserecht (bewusste Abweichung):** MariaDB kennt kein lesendes
  Trigger-Recht; `SHOW TRIGGERS` — und damit ein vollständiger Dump mit Triggern — braucht
  `TRIGGER`, das auch `CREATE/DROP TRIGGER` erlaubt. Jochens Auftrag (28.10.2026) nennt TRIGGER
  ausdrücklich in der Rechte-Liste. Das Restrisiko: wer die 0600-root-Datei liest, könnte Trigger
  anlegen; root erreicht über `config.php` ohnehin ein vollberechtigtes Konto. Die Alternative
  (`--skip-triggers` im Hook, Dump ohne Trigger) wäre eine eigene Entscheidung.
* Fail closed: Backup läuft gerade oder Sperre belegt (rc=3), Nextcloud-Konto fehlt/ist nicht lokal (rc=67), Konto
  anlegen scheitert, die übernommene Anmeldung (`adopt`) geht nicht oder das neue Konto liest nicht alle Datenbanken (rc=1) — die Datei bleibt dann
  unverändert, ein in diesem Aufruf neu angelegtes Konto wird wieder entfernt.
* **Befund 28.10.2026 (Diagnose-Job 1c231c24):** das Nextcloud-Konto `nextDB` hat nur
  `ALL PRIVILEGES ON nextcloud.*` — kein `CREATE USER`, `mysql.user` nicht lesbar. `ensure` scheitert
  darum hier (Job a0545b06, nichts verändert). **Entscheidung (Jochen, 28.10.2026):** bis ein anderer
  einmaliger Verwaltungsweg da ist (Weg A: MariaDB-Start mit `--init-file`, eigene Karte), nimmt das
  Backup per `adopt` wieder das aktuelle Nextcloud-Konto. Folgen, bewusst hingenommen: das Backup
  bleibt an das Nextcloud-Passwort gekoppelt (jede Rotation braucht wieder `adopt`), und der Hook
  dumpt mit diesem Konto nur die Datenbank `nextcloud` — **nicht** `wordpress` (das war schon vor dem
  26.10. so). `adopt` ist Lesen desselben Geheimnisses wie bei `ensure` (X1 im Intent).
* Ohne Rückweg darf genau dieser Lauf trotzdem starten (Ausnahme `backup-repair`,
  `doc/setup/host-run.md`): `db-access ensure` (oder `adopt`), danach `systemctl start borgmatic.service`,
  Prüfungen `db-access check` und `! systemctl is-failed --quiet borgmatic.service`, Rückweg
  `db-access restore`.

## Backup-Quellen ergänzen (`sources`, 02.11.2026)

**Entscheidung (Jochen, 31.10.2026, Karte t_2b394537):** „Wie sollen wir ein System sicher
betreiben, wenn das Backup nicht gepflegt werden darf?“ — James darf das Backup **ergänzen**,
ohne Jochens Klick; **schwächen** (Quellen entfernen, Aufbewahrung, delete/prune, Passphrase,
Repo) bleibt beim Backup-Riegel und damit bei Jochen.

**Ist-Stand vor dieser Fähigkeit (02.11.2026, belegt ohne config.yaml):** die Quellen stehen in
der Kommandozeile jedes Archivs (`borgmatic info --last 1`, Zeile `Command line:`), das ist
lesend und frei. Archiv `vmd61162-2026-11-02T00:47:26` sichert `/etc /home/hermes/.hermes
/opt/collabora /opt/frigate/config /opt/gitlab /opt/nextcloud /opt/nextcloud-appapi
/opt/nextcloud-hpb /opt/wireguard-ops-cockpit /root/.borgmatic /tmp/backup_dumps
/var/lib/docker/volumes/nc_app_email_archive_data/_data /var/www/html /var/www/nextcloud` —
`/opt/stacks` (wejos-wp) und `/var/lib/docker/volumes/forgejo-data` fehlen. Für diese Frage also
`server_einblick was=host pruefung=borg` statt einer Abfrage der Konfiguration.

**Weg:** zusätzliche Quellen stehen nicht in `config.yaml` (die hält Zugangsdaten und wird nie
gelesen), sondern in einer eigenen Musterdatei ohne Geheimnisse,
`/etc/borgmatic/cockpit-sources.patterns` (0644 root), eine Zeile `R <pfad>` je Quelle.
`config.yaml` nennt sie einmal per `patterns_from`; borgmatic 1.8 reicht das als
`--patterns-from` an `borg create`, und borg nimmt die R-Zeilen („root path“) zu den
`source_directories` hinzu. Kein `!include`, kein zweites borgmatic-Konfig unter
`/etc/borgmatic.d` (das wäre ein zweiter Lauf mit eigenem Repo und eigener Passphrase).

| Form | Wirkung | Riegel |
| --- | --- | --- |
| `cockpit-borg-action sources status` | lesend: angeschlossen ja/nein (nur ein Treffer-Test auf `config.yaml`, kein Inhalt), die R-Zeilen, Zahl der Sicherungen | frei |
| `cockpit-borg-action sources add <pfad>` | hängt genau eine R-Zeile an. Pfad: absolut, nur `[A-Za-z0-9._@+-]` je Ebene, kein `.`/`..`, kein Symlink (`realpath` = Pfad), existierendes Verzeichnis, mindestens eine Ebene unter `/opt/stacks`, `/srv` oder `/var/lib/docker/volumes`. Schon drin oder unter einer vorhandenen Quelle → nichts verändert, rc=0. Alte Datei als `.vor-<UTC-Zeit>`, neue per `mv`, dann `borgmatic config validate`; ungültig → alte Datei zurück, rc=1. Nennt die Größe (`du -shx`), wirkt ab dem nächsten Backup-Lauf | **frei** |
| `cockpit-borg-action sources connect` | einmalig: `config.yaml` bekommt am Ende den Block `patterns_from: [<musterdatei>]` (alte Datei als `config.yaml.vor-<Zeit>`, 0600), legt die leere Musterdatei an, `borgmatic config validate`; ungültig → alte `config.yaml` zurück. Nennt `config.yaml` schon ein eigenes `patterns_from`, verändert es nichts (rc=1, dann von Hand) | Jochen |
| `cockpit-borg-action sources disconnect` | nimmt genau diesen Block wieder heraus — nur, wenn `config.yaml` seit dem Anschluss sonst unverändert ist (Vergleich mit der `.vor`-Datei plus Block), sonst rc=1 und nichts verändert | Jochen |
| `cockpit-borg-action sources restore` | die jüngste `.vor`-Musterdatei zurück, also Quellen weg | Jochen |

Ein Verb zum Entfernen einzelner Quellen gibt es nicht; das ist `restore` (Riegel) oder ein
Lauf, der die Musterdatei schreibt (Schreiben in `/etc/borgmatic` → Riegel).

Grenzen:

* **Nur aus einem Lauf der allgemeinen Tür** (cgroup `cockpit-host-run-<job>.service`), wie
  `db-access`; über den Executor rc=64. Der installierte Helfer nimmt immer die festen Pfade, die
  Prüf-Haken (`COCKPIT_BORG_ACTION_SOURCES_FILE`, `_SOURCES_ROOTS`, `_CONFIG`, `_LOCK`,
  `_CGROUP_FILE`) gelten nur in einer Testkopie.
* **Kein Geheimnis in der Ausgabe:** `config.yaml` wird nur per `grep -q` (angeschlossen?) und
  beim Anhängen/Vergleichen berührt, nie ausgegeben; die Ausgabe von `borgmatic config validate`
  wird verworfen (sie zitiert bei Schemafehlern Werte), nach aussen geht nur „gültig“.
* **Sperre:** jede Änderung nimmt `/run/lock/cockpit-borg.lock` und weist ab, solange das Backup
  (`borgmatic.service`, im installierten Helfer fest) läuft (rc=3) — eine Musterdatei wechselt nie mitten in einem `borg create`.
* **Wurzeln** stehen doppelt fest: im Helfer (`SOURCES_ROOTS_FIXED`) und im Riegel
  (`SOURCE_ROOTS` in `deploy/helpers/cockpit-backup-guard.mjs`, prüft den wörtlichen Pfad; ein Pfad
  aus einer Variablen ist für den Riegel unlesbar und geht an Jochen). `/etc`, `/opt/<dienst>`,
  `/var/www` sind schon ganze Quellen und darum keine Wurzeln.
* **Musterdatei nur als eigene, gewöhnliche Datei:** ist sie ein Symlink, ein Hardlink oder
  keine reguläre Datei, weisen `add` und `status` ab (rc=1) — sonst läse `add` etwa `config.yaml`
  und legte sie 0644 ab. `status` zählt außerdem „fremde Zeilen“ (alles außer Kommentaren und
  `R`-Zeilen, z. B. ein Ausschluss `! /srv`, der eine Quelle wieder ausschlösse).
* **Kein Kürzen bei Schreibfehlern:** jeder Schreibschritt von `add` wird geprüft, und vor dem
  Tausch muss die neue Datei die alte vollständig enthalten und genau eine `R`-Zeile mehr haben
  (volles Dateisystem → rc=1, nichts verändert).
* **Riegel über Umwege (Zweitprüfung PR #69):** `bash|sh|source|. /usr/local/sbin/cockpit-borg-action …`
  prüft der Riegel mit denselben Regeln wie den Helfer (das Befehlswort bleibt die Shell, ihre
  eigenen Hinweise bleiben; frei nur die exakte Form); ein Glob, der auf den Helfer passt (als
  Befehlswort oder Shell-Argument), und `cp|ln|install|rsync` des Helfers gehen an Jochen. Weil der Riegel den
  Helfer nur am Namen erkennt, schützt sich der Helfer zusätzlich selbst: in der echten cgroup
  eines Laufs der allgemeinen Tür laufen alle Verben außer `status`/`check` nur, wenn er genau als
  `/usr/local/sbin/cockpit-borg-action` aufgerufen wird und dort liegt — eine Kopie (`cat > …`),
  ein Link oder ein anderer Pfad endet mit rc=64. Offline nicht prüfbar (braucht die cgroup einer
  Lauf-Unit), die Bedingung steht vor der Grammatik.
* **Allgemeine Regel seit der Zweitprüfung t_f65aa80e (Karte t_5ce5f79f, 05.11.2026):** `find -exec {}`,
  `xargs -I{} {}`, `perl -e 'system(…)'` oder `python3 -c 'os.system(…)'` rufen genau den
  installierten Pfad auf — der Selbstschutz greift dort nicht, und der Riegel las das Verb nicht.
  Darum gilt jetzt: **nennt ein Befehl den Helfer und ist er weder die freie Direktform noch reines
  Lesen, ist er ein Treffer.** „Nennen“ heißt: der Name `cockpit-borg-action` (Wortgrenze, auch in
  Quotes), ein Glob, der auf `/usr/local/sbin/cockpit-borg-action` passt (`{}` zählt dabei wie `*`),
  oder ein find-Filter (`-name`, `-path`, `-regex`, auch `-i…`), der auf ihn passt, unter einem
  Startpfad, der ihn enthält. Frei bleiben nur: der Helfer als Befehlswort (oder die Shell-Form
  oben) mit `status|check|db-access …|sources status|sources add <wörtlicher Pfad>`, Lesebefehle
  (`ls`, `sha256sum`, `test`, `journalctl`, `systemctl status` …) und Textausgabe (`echo`,
  `printf`, `logger`). Fließt Text, der den Helfer nennt, in eine Shell, in eine Datei, die laufen
  kann (Cron, Skript), oder steht er in Code einer anderen Sprache (`python -c`, `perl -e`, `ruby`,
  `node`, `php`, ein Heredoc für `python3 -`), ist auch das ein Treffer — gleich mit welchem Verb.
  `xargs` und der Rest von `find` nach einem `\;` sind ein Treffer, wenn die Zeile den Helfer nennt
  (`ls …/cockpit-borg-action | xargs -I{} {} …`). Ein Platzhalter als Befehlswort ohne den Helfer in
  der Zeile (`find /opt/app -exec {} \;`, `xargs -I{} {}`) ist ein Hinweis für den Türsteher
  (`uncertain`), kein Treffer. **Nachtrag Zweitprüfung t_0b3f7290 (Karte t_fd6dfaa4, 09.11.2026):**
  Dieselbe Zeilenregel gilt für eine Shell, einen Interpreter, `source`/`.` oder `at|batch`, die
  Text aus einer Pipe ausführen (`ls …/cockpit-borg-action | sed 's/$/ sources disconnect/' | bash`,
  `find /usr/local/sbin -name 'cockpit-borg*' -printf '%p repair\n' | sh`,
  `command -v cockpit-borg-action | sed 's/$/ repair/' | sh`), und für eine Shell oder `source`
  mit einem Skript, das der Plan nicht zeigt (`bash <(echo '…/cockpit-borg-action repair')`):
  nennt die Zeile den Helfer, ist es ein Treffer, sonst bleibt es `uncertain`
  (`journalctl -u borgmatic | grep x | sh -c cat` bleibt frei). Der Wert von `xargs -I`, `-i` oder
  `--replace` zählt wie `{}`, also nennt `ls /usr/local/sbin | grep borg | xargs -I@ /usr/local/sbin/@
  repair` den Helfer per Glob (Hinweis H-a). Der Preis: auch `cockpit-borg-action status | python3 -c …`
  geht an Jochen — wer die Status-Ausgabe auswerten will, nimmt `grep`, `awk` oder `jq`.
  Ein Argument in Quotes, das über das Zeilenende reicht, neben dem Helfer ist ein Treffer (der Riegel liest jede Zeile für sich; Hinweis H1). Tests:
  `apps/api/test/backup-guard.test.ts` (die sechs Fälle der Zweitprüfung und Varianten).
  **Nachtrag Zweitprüfung t_5dd27194 (Karte t_3dce65e1, 09.11.2026):** (B1) Eine Gruppe hinter einer
  Pipe liest die Pipe: jeder Befehl in `( … )` oder `{ …; }` gilt als „liest aus der Pipe“
  (`echo '…/cockpit-borg-action repair' | (exec bash)`, `| { cd /; sh; }`). (B2) Endet eine Zeile
  außerhalb von Quotes auf `|`, `|&`, `&&` oder `||`, setzt Bash sie fort; der Riegel fügt sie wie
  die Backslash-Fortsetzung zu einer logischen Zeile zusammen (nicht, wenn die Zeile einen Heredoc
  öffnet). (B3/B4) Pipe-Ausgabe, deren Quelle den Helfer nennt (ohne der Helfer selbst zu sein), in
  eine Datei, die laufen kann (Umleitung oder `tee`; alles außer reinen Datendateien wie `.json`,
  `.txt`, `.log`), ist ein Treffer — `ls <helfer> | sed 's/$/ repair/' > /etc/cron.d/x`,
  `… | tee /tmp/r` vor `bash /tmp/r`. `<helfer> status | jq . > /tmp/s.json` bleibt frei. (B5) `eval`
  auf einer Zeile, die den Helfer nennt (auch in `$(…)`), ist ein Treffer wie `sh -c "$(…)"`.
  (H-1) Ein `grep`-Muster, das auf den Namen passt, nennt den Helfer, wenn dieselbe Zeile `ls`
  über `/usr/local/sbin` (bzw. den Helfer) oder `find` über einen Vorfahren listet
  (`cd /usr/local/sbin && ls | grep borg-action | sed 's/$/ repair/' | sh`); `grep -v` nicht.
  **Nachtrag Zweitprüfung t_605da75b (Karte t_6735af09, 09.11.2026): Zeilen-Allowlist statt
  Senken-Liste.** Die vierte Runde fand wieder neue Senken: `|&` galt nicht als Pipe (die Doku oben
  behauptete es), `if/while/until/for/case/select` als Pipe-Ziel, Schreiber wie `dd of=`,
  `cp|install /dev/stdin`, `sponge`, `crontab -`, `xargs … bash -c` (entgegen dem Satz oben),
  `awk '{system($0)}'`, GNU-`sed …/e`, `eval "$x"` eine Zeile nach `x="$(ls <helfer> | sed …)"`,
  `awk`/`sed -n`/`compgen -c` statt `grep` über dem Verzeichnis, `coproc bash` und
  `exec 3> >(bash)` — alle in echter Bash als wirksam belegt. Entscheidung: nicht die fünfte Liste,
  sondern eine Allowlist je logischer Zeile. **Nennt ein Befehl der Zeile den Helfer außerhalb seiner
  freien Formen** (Direkt- und Shell-Form urteilt der Riegel weiter nach Verben), **dürfen alle
  übrigen einfachen Befehle der Zeile** — auch in `$(…)`, `<(…)`, `>(…)`, Gruppen und
  `if/while/for/case` — **nur Filter oder Datensenken sein**: `grep`, `jq`, `head`, `tail`, `wc`,
  `sort` (ohne `-o`, `--compress-program`), `uniq`, `cut`, `tr`, `cat`, `awk` ohne `system()`,
  `| getline`, `print … >|` und ohne `-f`, `sed` ohne `e`, `w`, `-i`, `-f`, Lesebefehle (`ls`,
  `sha256sum`, `journalctl`, `systemctl status` …), `echo|printf|logger`, `read`, `test`, `cd`,
  `tee` und Umleitung nur in Datendateien (`.json`, `.txt`, `.log`, `/var/log/…`, `/dev/null`);
  Vorsätze nur `sudo`, `env`, `timeout`, `nice`, `ionice`, `command`. Alles andere — eine Shell, ein
  Interpreter, `eval`, `source`, `xargs`, `exec`, `coproc`, `crontab`, `at`, `dd`, `cp`, `install`,
  `sponge`, `ssh`, ein Befehlsname aus einer Variablen, eine Umleitung in einen Deskriptor (`>&3`) —
  ist ein Treffer, gleich welche Senke es ist. Listet ein Befehl das Verzeichnis des Helfers
  (`ls /usr/local/sbin` bzw. `-R` über einem Vorfahren, `find` über einem Vorfahren ohne fremden
  Namensfilter, `du -a`, `tree`, `compgen -c`, `locate`), gilt dieselbe Regel für die Befehle hinter
  ihm in der Pipe. Über Zeilen hinweg: eine Variable, deren Wert den Helfer nennt (`x="$(ls <helfer>)"`,
  `c='<helfer> repair'`, `read -r c < <(ls <helfer>)`, auch weitergereicht `y="$x repair"`), nennt
  ihn in jeder Zeile, in der sie vorkommt; frei bleibt der Wert der freien Direktform
  (`s=$(<helfer> status); echo "$s" | grep ok`). `|&` ist jetzt eine Pipe. Für die Allowlist zerlegt
  der Riegel die Zeile eigens mit Quotes und Ersetzungen, damit ein `sed`- oder `awk`-Programm in
  Quotes nicht an `;`, `(` oder `|` zerfällt. Frei bleiben `<helfer> status |& tee /tmp/borg.log`,
  `… status | tee -a /var/log/cockpit-borg.log`, `ls /usr/local/sbin | grep -v borg-action`. Der Preis:
  eine Zeile, die den Helfer nennt und daneben etwas Fremdes tut (`ls -l <helfer> && systemctl
  restart x`), geht an Jochen — wer beides will, schreibt zwei Zeilen. Tests: `apps/api/test/backup-guard.test.ts` (N1–N8).
  **Nachtrag Zweitprüfung t_20ae3cda (Karte t_d16c58d1, 09.11.2026): Plan-Umfang statt Zeile.** Die
  Zeilen-Allowlist urteilte über Namen und Syntax **einer** Zeile; die fünfte Runde fand Fluss über
  Zeilen, in echter Bash belegt: (A) ein Filter-Name, umgebunden in einer Vorzeile (`cat(){ sh; }`⏎
  `echo '<helfer> repair' | cat`, ebenso `function head {…}`, `alias tail=sh`, `hash -p /bin/sh cat`,
  eigenes `cat` plus `export PATH=…`, `echo(){ sh -c "$*"; }`); (C) Arithmetik, die `$(…)` mit der
  Pipe als Eingabe ausführt (`| echo "$(( $(sh) ))"`, `printf -v 'a[$(sh)]' x`,
  `test -v "a[\$($x repair)]"`) — der Riegel hatte `$((…))` durch `0` ersetzt, ohne hineinzusehen;
  (E) `sed` mit anderem Trenner (`s|$| repair|e`, `s,$, repair,e`, `s|$||w /etc/cron.d/x`); (F) eine
  „Datensenke“, die eine andere Zeile ausführt (`tail -f /tmp/p.txt | sh &`, `sh < /tmp/r.txt`,
  `bash -s < r.log`, `cat r.txt | sh`, `$(cat r.txt)`, `$(< r.txt)`, `while read -r l; do $l; done`,
  `xargs -a r.txt … sh -c`, `BASH_ENV=r.txt bash -c true`, ein FIFO `f.log`, ein Symlink
  `/tmp/r.txt → /etc/cron.d/x`); (G) Variablen ohne `$name` (`${!y}`, `declare -n r=x`, `export X=…`
  plus `printenv X`/`env`, `x=$(compgen -c | grep borg-action)`). Entscheidung: keine sechste
  Senken-Liste, sondern der Geltungsbereich wird **der ganze Plan**. Ein erster Durchgang über alle
  Schritte und Prüfschritte (samt ausgeführter Heredocs) stellt fest, ob der Plan den Helfer
  außerhalb seiner freien Formen nennt. Frei sind dabei nur die Direktform (bzw. Shell-Form) und
  `test`/`[`/`[[` auf ihn, denn sie geben keinen Text aus, der anderswo laufen könnte; alles andere
  macht seinen Namen zu Text (`echo`, `ls`, `stat`, `sha256sum`, ein Glob, ein find-Filter, ein
  `grep` über seinem Verzeichnis, das Listen dieses Verzeichnisses, eine Variable mit seinem Namen).
  Nennt der Plan ihn so, gilt im zweiten Durchgang für **jede** Zeile: jeder einfache Befehl ist
  Filter oder Datensenke (Liste oben; dazu `set` mit Optionen, `exit`/`return` mit Zahl, `compgen`
  ohne `-C`/`-F`, `locate`), und nichts bindet um — keine Funktionsdefinition, kein `alias`, `hash`,
  `enable`, keine Zuweisung an PATH, BASH_ENV, ENV, LD_* & Co. (außer dem Standard-PATH), kein
  `${!…}`, kein `declare -n`, kein `export` einer Variablen, deren Wert den Helfer nennt. Damit
  fallen F und A ohne eigene Regel: wer eine Datei, ein FIFO oder `tail -f` ausführt, braucht eine
  Shell, `xargs`, `less`, `ln`, `mkfifo` oder einen Befehlsnamen aus einem Wert — keiner davon ist ein
  Filter. Arithmetik: `$((…))`, `((…))` und Array-Indizes werden durchlaufen, jedes `$(…)`/`` `…` ``
  darin wird ein eigener Befehl (das allein reicht nicht: Bash rechnet auch den *Wert* eines Namens
  aus — siehe Nachtrag t_2e391eba); ein Index mit `$(…)` in einem Argument (`printf -v`, `read`,
  `test -v`, `declare`) ist kein Filter, ebenso `mapfile -C`. `sed` wird positiv gelesen statt per
  Regex auf `/`: Optionen nur `-n -E -r -s -u -z -l`, `-e`/`--expression`, `--posix`, `--debug`,
  `--sandbox`; Programme nur Adressen (Zahl, `$`, `/re/`, `\cREc`, `first~step`, Bereiche, `!`),
  `s` und `y` mit beliebigem Trenner, `s`-Flags nur `g p i I m M <Zahl>`, dazu `p P d D n N g G h H
  x l z = F q Q`, `: b t T`, `a i c`, `{ }`; alles andere (`e`, `w`, `W`, `r`, `R`, `v`, das e-/w-Flag,
  ein Programm aus einer Variablen oder `$(…)`) ist kein Filter. `awk` bleibt eine Wortprüfung,
  zusätzlich ohne `-E`, `-i`, `-l`, `--include`, `--load` und ohne indirekten Aufruf `@f(…)`.
  **Preis (gemessen, `/opt/data/out/t_d16c58d1/probe-preis.log`):** frei bleiben die Direktformen
  neben fremder Arbeit (`<helfer> status | jq .` plus `apt-get -y upgrade`, `sources add` plus
  `systemctl restart`, `db-access status` plus `a2dissite`), `test -x <helfer> && <helfer> status`
  neben `docker compose pull`, und Pläne, die nur lesen und filtern (`stat <helfer>` plus
  `docker compose ps`, `set -euo pipefail` plus `sha256sum <helfer> | tee /tmp/h.txt`). An Jochen geht
  neu ein Plan, der den Helfer als Text nennt **und** daneben etwas ändert: `sha256sum <helfer>` oder
  `ls -l <helfer>` plus `apt-get`/`systemctl restart`, `echo "<helfer>"` plus Arbeit,
  `h=<helfer>; $h status` plus Arbeit. Ausweg: den Pfad wörtlich schreiben, `test -x` statt `ls`,
  oder zwei Läufe (der Satz „schreibt zwei Zeilen“ im Nachtrag oben gilt damit nicht mehr). Tests:
  `apps/api/test/backup-guard.test.ts` (A1–G10 und die freien Fälle `t_d16c58d1: …`), Sonden
  `/opt/data/out/t_20ae3cda/sonden/probe-t20.mjs` (0 Abweichungen außer Z10, das schon auf main ein
  Treffer ist). Auch der in Bash ungültige Plan „`|` am Anfang der Folgezeile“ ist jetzt ein Treffer
  (er nennt den Helfer und hat ein `sh`); Bash würde ihn ohnehin nicht ausführen.
  Grenze, ehrlich: Ein Programm, das den Helfer weder nennt noch per Glob oder find-Filter trifft
  (Name aus Teilen zusammengesetzt, dekodiert, aus einer Datei gelesen), sieht der Riegel nicht;
  das bleibt Verschleierung und damit Sache des Türstehers (X4, `doc/setup/host-run.md` 2a).
  **Nachtrag Zweitprüfung t_f1b3ea8c (Karte t_2e391eba, 09.11.2026): Erweiterungen, die Bash als
  Code auswertet.** Die Plan-Allowlist urteilt über Befehlsnamen; Bash führt aber auch einen Wert
  aus, der in bestimmten Erweiterungen landet. In echter Bash belegt, Riegel frei und Türsteher-Fokus
  leer: (P) Prompt-Expansion `x='$(sh)'`⏎`echo '<helfer> repair' | echo "${x@P}"`, auch zerlegt
  (`x='$'`, `y='(sh)'`, `z=$x$y`, `${z@P}`); (PS4) `PS4='$(sh) '`⏎`set -x`⏎`… | cat` — der Satz
  „nichts bindet um“ stimmte damit nicht, PS4 fehlte in der Liste der Code-Variablen; (S) Arithmetik
  auf einem Namen, dessen Wert `a[$(sh)]` erst aus Teilen entsteht (`z=$x$y`, `printf -v z …`, `tr`)
  — „Arithmetik wird nach `$(…)` durchsucht“ galt nur für das wörtliche `$(…)`. Entscheidung: keine
  Senkenliste, sondern **eine Regel** im gekennzeichneten Plan: jede Erweiterung, die Bash als Code
  auswertet, ist kein Filter. Das sind `${…@P}`; die Zuweisung (auch `declare`, `export`, `read`,
  `printf -v`, `for`, `${v:=…}`) an PS0–PS4 und die übrigen Code-Variablen sowie an die
  Integer-Variablen RANDOM, SRANDOM, OPTIND, HISTCMD (Bash rechnet jeden Wert aus, belegt);
  `declare`/`local`/`typeset -i`; und Arithmetik, die nicht nur Zahlen (auch `0x1f`, `2#101`) und
  Operatoren enthält: `$((…))`, `((…))`, `$[…]`, `let`, `for ((…))`, `[[ … -eq|-ne|-lt|-le|-gt|-ge
  … ]]`, `[[ -v a[i] ]]`, `${s:off:len}` (auch `${@:n}`), ein Index `${a[i]}`, `${#a[i]}`, `a[i]=`,
  `b=([i]=…)` und als Name in `unset`, `test -v`, `read`, `printf -v`, `declare`/`local`. Ein Heredoc
  ohne Quotes am Begrenzer wird wie eine Zeile gelesen; `<<'EOF'` erweitert nichts und bleibt frei.
  Geprüft, was **nicht** rechnet (`sonden/bash-real-arith-ctx.sh`): `test`/`[` mit `-eq`, `printf
  %d`, `shift`/`exit`/`return`/`break` mit Wert, `read -t/-n/-u`, `ulimit`, `mapfile -n/-s/-O`,
  `${x@E}`/`@A`/`@Q`, SECONDS/LINENO und andere Sondervariablen — sie bleiben frei. Ein Index eines
  assoziativen Arrays rechnet nicht; der Riegel kennt den Typ nicht und zählt ihn trotzdem. Der
  Leser lässt Quotes stehen: `'$((x))'` in einem `awk`-Programm eines gekennzeichneten Plans ist ein
  Treffer zu viel. **Preis (gemessen):** gegen bdd3c56 unverändert 5/15 (`probe-preis`), gegen
  5c18e72 0/15 neu; frei bleiben im gekennzeichneten Plan `$((1 + 2))`, `[[ 3 -gt 2 ]]`, `[ "$n" -eq
  0 ]`, `${s:-x}`, `${s: -1}`, `${a[@]}`, `${PIPESTATUS[0]}`, `${x@Q}`, `set -x` ohne eigenes PS4;
  ein ungekennzeichneter Plan behält `for ((i=0; …))` und `${x@P}`. Sonden:
  `/opt/data/out/t_2e391eba/sonden/probe-r5.mjs` (65 Fälle) und `bash-real-r5.mjs` (48 von 51
  Treffer-Formen laufen in echter Bash; PS0, PS3 und `$((10#$z))` sind Treffer der Regel, ohne
  dass sie hier liefen). Tests: `apps/api/test/backup-guard.test.ts` (P, PS4, S).
* **Kommentar wie in Bash (09.11.2026, Zweitprüfung t_ba8ceb38, Karte t_8f78c1ac).** Der Riegel
  las `#` nach Leerraum, `;&|()` als Kommentarbeginn und sah den Rest der Zeile nicht — auch eine
  direkte `repair`-Zeile: `echo $(true)#; …/cockpit-borg-action repair` lief in echter Bash, der Riegel
  blieb frei (schon auf main). Bash beginnt einen Kommentar nur am Wortanfang. Jetzt liest **ein**
  Leser (`scanShell`, für Kommentar, Heredoc und offenen Quote) die Zeile: Kommentar nach Leerraum,
  `;&|(`, und nach dem `)` einer Gruppe `(…)` oder eines Befehls `((…))`; kein Kommentar ist `#`
  direkt nach dem `)` von `$(…)`, `$((…))`, `<(…)`, `>(…)`, nach `$[…]`, in `${…}`, in Arithmetik und
  in `` `…` `` (dort endet ein Kommentar am Backtick, belegt). Im Zweifel liest er zu viel: ein `)`,
  dessen `(` nicht in der Zeile steht (`x=$(⏎…⏎)#; …`), macht `#` nicht zum Kommentar, und danach
  öffnet die Zeile keinen Heredoc mehr; in `${…}` und `` `…` `` öffnet `<<` keinen Heredoc. Preis:
  `case x in x)# …` ist in Bash ein Kommentar, der Riegel liest den Rest (ein Treffer zu viel).
  Gemessen: alle Sonden der früheren Runden unverändert (`/opt/data/out/t_8f78c1ac/sonden-*`), die
  Fälle aus t_ba8ceb38 (`faelle*.mjs`) sind alle Treffer, wo Bash `repair` startet. Tests:
  `apps/api/test/backup-guard.test.ts` (t_8f78c1ac).
* **Offene Entscheidung (05.11.2026, Karte t_5ce5f79f): Freigabe-Markierung im Helfer.** Erwogen:
  die schwächenden Verben (`sources connect|disconnect|restore`, `repair`) laufen in einer
  host-run-cgroup nur, wenn `cockpit-host-run` für genau diesen Job eine root-eigene Markierung
  „operatorApproved“ aus dem geprüften Envelope abgelegt hat. Nicht gebaut: die Schritte eines Laufs
  laufen selbst als root und könnten die Markierung schreiben; gegen das Fälschen schützte wieder
  nur der Riegel am Pfad (oder der Türsteher bei Verschleierung) — der Gewinn ist kleiner, als er
  aussieht, und es ist eine Änderung an Schloss und Helfer zugleich (G2, G10). Entscheidet Jochen.
* Mehr Quellen heißen mehr Platz auf der Kiste (RAID, `DF` in `status`): `add` nennt die Größe,
  die Entscheidung bleibt „ergänzen ist frei“. **Offen (Hinweis H2, 05.11.2026):** `add` hat keine
  Größengrenze; eine große Quelle kann das RAID auf Lab0 füllen, dann scheitern alle Nachtläufe.
  Eine Grenze (fest oder gegen den freien Platz aus `status`) ist nicht gebaut.

Ablauf für eine neue Quelle (ohne Jochen, sobald angeschlossen): ein host-run mit dem Schritt
`/usr/local/sbin/cockpit-borg-action sources add <pfad>`, Prüfung `… sources status`, Rückweg
keiner nötig (ein Zusatz löscht nichts; Zurücknehmen wäre `restore` und damit Jochens Sache).
Beleg nach dem nächsten Nachtlauf: `borgmatic list --archive latest --path <pfad ohne /> | head`
(frei, lesend) bzw. die Kommandozeile `--patterns-from` in `borgmatic info --last 1`.

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
| `POST /api/borg/status/refresh` | misst jetzt und wartet bis zu 25 s auf das Ergebnis — höchstens eine Messung je 60 s seit dem letzten Messbeginn (auch eine gescheiterte zählt); innerhalb davon kommt sofort der letzte Stand zurück. Jede gestartete Messung schreibt genau eine Zeile ins API-Log (`borg-status: Messung gestartet (refresh\|ttl) <Zeit>`), ohne Pfade oder Adressen |

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
