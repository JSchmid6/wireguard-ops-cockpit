# Borg-Betrieb — Zustand ansehen und Wartung bestellen

Dieses Modul macht den Backup-Betrieb von der Ad-hoc-Shell zu einer Sache der
Cockpit-Policy: der Zustand ist lesbar, ein Repo-Check und ein Repair laufen als
typisierte Aktion mit Audit und Freigabe.

## Vertrag

| Aktion | Form im Plan | Wirkung | Freigabe |
| --- | --- | --- | --- |
| `borg.status` | `/usr/local/sbin/cockpit-borg-action status` | lesend: borgmatic-Timer, letzte Läufe (Journal), laufende Wartungs-Unit, jüngste Archive, Repo-Kennzahlen, Statusdatei der Kiste. Läuft in einer eigenen transienten Unit (`--wait --pipe --collect`) | autonom (keine) |
| `borg.check` | `/usr/local/sbin/cockpit-borg-action check` | startet `borgmatic --verbosity 1 check --force` in der Unit `cockpit-borg-check-<stamp>-<pid>` und kehrt sofort zurück | autonom (keine) |
| `borg.repair` | `/usr/local/sbin/cockpit-borg-action repair` | startet `borgmatic --verbosity 1 check --repair --force` in der Unit `cockpit-borg-repair-<stamp>-<pid>`; kann beschädigte Archive entfernen (siehe unten) | **Operator** (`blocked_user_approval`) |

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
* `check`/`repair`: `systemd-run --collect --unit=cockpit-borg-<verb>-<stamp>-<pid>` **ohne**
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
| `/etc/borgmatic/mysqldump.cnf` (+ `.vor-<Zeit>`) | heute `db-access adopt` (Zwischenweg B), Ziel `db-access bootstrap` (Weg A, Karte t_58a51884), danach Rotation per `ensure` | Anmeldung des mysqldump-Hooks, 0600 root: heute das Nextcloud-Konto `nextDB` — an das NC-Passwort gekoppelt, gedumpt wird nur `nextcloud`, **nicht** `wordpress`; Ziel `cockpit_backup@localhost`. Die `.vor-`Dateien sind der Rückweg |
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
Weg A (Karte t_58a51884, `db-access bootstrap`) einmal gelaufen ist.

| Form | Wirkung |
| --- | --- |
| `cockpit-borg-action db-access status` | lesend: Besitz/Modus der Datei, Konto (`user=`-Zeile), ob die Anmeldung geht (Fehlerzeile der Datenbank), Zahl der Sicherungen. Kein Wert. |
| `cockpit-borg-action db-access check` | rc=0, wenn das Konto der Datei sich anmeldet und `mysqldump --all-databases --no-data` durchläuft (wie der Hook, nur das Schema) |
| `cockpit-borg-action db-access ensure` | legt `cockpit_backup@localhost` an (oder setzt ihm ein neues Passwort), entzieht alles und gibt genau `SELECT, SHOW VIEW, TRIGGER, LOCK TABLES, SHOW DATABASES` auf `*.*` (der Hook dumpt alle Datenbanken, ohne `--events`, darum kein EVENT), prüft das neue Konto mit einer Arbeitsdatei, sichert die alte Datei als `mysqldump.cnf.vor-<UTC-Zeit>` (0600) und tauscht dann (0600 root). Übrige Zeilen der alten Datei außer `user`/`password` bleiben. |
| `cockpit-borg-action db-access adopt` | **Zwischenweg B** (Jochen 28.10.2026): schreibt das aktuelle Nextcloud-DB-Konto aus `config.php` (gelesen als `www-data`, wie bei `ensure`) in die Datei; an der Datenbank ändert sich nichts. Prüft die neue Anmeldung und den Schema-Dump mit einer Arbeitsdatei, sichert die alte Datei als `.vor-<UTC-Zeit>` und tauscht (0600 root). Für den Fall, dass `ensure` kein Konto anlegen kann (siehe unten). |
| `cockpit-borg-action db-access bootstrap` | **Weg A** (Jochen 28.10.2026): startet `mariadb.service` **einmal** mit `--init-file` neu (siehe „Weg A“ unten): die Datei legt `cockpit_backup@localhost` mit dem Hash und den Rechten von `ensure` an und gibt `root@localhost` zusätzlich `unix_socket` (das bisherige Verfahren von root bleibt als Alternative). Danach prüft es das neue Konto mit einer Arbeitsdatei, sichert die alte Datei als `.vor-<UTC-Zeit>` und tauscht (0600 root). Ist die Datei schon auf `cockpit_backup` und gültig: nichts verändert, kein Neustart. Kurzer DB-Ausfall (Nextcloud, WordPress). |
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
* **Die Verwaltungs-Anmeldung** ist root per Socket, sobald `bootstrap` gelaufen ist (ohne
  Geheimnis); vorher und als Rückfall das Nextcloud-DB-Konto aus `config.php`: auf
  diesem Host sind root (Socket und `debian.cnf`) und `mysql@localhost` passwortgeschützt
  (Inventar-Jobs 697b46d0, be3a0f57), ein anderes Konto mit `CREATE USER` gibt es nicht. Gelesen
  wird die Datei als `www-data` (`runuser`), weil sie www-data-beschreibbar war — root führt ihren
  Code nie aus. Das ist Lesen eines Geheimnisses (X1): der Lauf nennt es im Intent, und der Befund
  geht an Jochen. Nach einem `ensure` braucht das Backup das Nextcloud-Passwort nie wieder (nach `adopt` schon — siehe Befund unten); eine spätere
  Rotation des Backup-Passworts ist ein weiteres `ensure`, ein `restore` nach einer Rotation setzt
  den Hash zurück — vor `bootstrap` beide wieder mit dieser Anmeldung und damit wieder X1 im Intent,
  nach `bootstrap` über root per Socket ohne X1. `adopt` liest `config.php` immer (es schreibt genau
  dieses Konto in die Datei).
* **Die Datenbank bekommt nur den Hash:** `ensure` rechnet den `mysql_native_password`-Hash im
  Helfer und setzt ihn per `IDENTIFIED BY PASSWORD '<hash>'`; der Klartext steht nur in der Datei.
  Scheitert eine Rotation nach dem `ALTER USER`, bekommt das Konto den alten Hash zurück — die
  alte Datei bleibt gültig (fail closed).
* **Repo-Sperre:** `ensure`, `adopt`, `restore` und `bootstrap` halten `/run/lock/cockpit-borg.lock` bis zum Ende; der
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
* **Weg A (`bootstrap`, Karte t_58a51884, Werkstatt-Probe 13.11.2026 mit MariaDB 10.11.14 wie
  der Host):** kein Konto darf hier Konten anlegen, also bekommt die Datenbank die nötigen Sätze
  einmal beim Start. Ablauf: Arbeitsdatei mit neuem Konto (Klartext nur dort), Verzeichnis
  `/run/cockpit-db-init.XXXXXX` (root:mysql 0750) mit `init.sql` (root:mysql 0640, nur der Hash),
  `systemctl set-environment MYSQLD_OPTS=--init-file=…` (die Unit liest `$MYSQLD_OPTS` im
  ExecStart), `systemctl restart mariadb.service`, sofort danach `unset-environment` und die Datei
  löschen, dann Anmeldung und Schema-Dump des neuen Kontos prüfen und die Optionsdatei tauschen.
  Belegt in der Probe:
  * **root:root 0600 geht nicht:** mariadbd läuft als `mysql` und bricht den Start mit „Can't
    create/write to file … Permission denied / Aborting“ ab — darum Gruppe `mysql`, 0640.
  * **Ein SQL-Fehler in der Datei hält den Start nicht auf:** mariadbd führt die Sätze bis zum
    Fehler aus und startet. Maßgeblich ist deshalb allein die Prüfung des neuen Kontos danach.
  * **Ein Neustart reicht:** `init_file` wird nur beim Start gelesen; `@@init_file` zeigt bis zum
    nächsten Start auf die gelöschte Datei, ohne Wirkung. (Der Auftrag rechnete mit zweien.)
  * **root:** `ALTER USER root@localhost IDENTIFIED VIA unix_socket OR <bisheriges Verfahren> USING
    <bisheriger Hash>` (vorbereitete Anweisung in der Datei, gelesen aus `mysql.global_priv`) — nur,
    wenn root genau ein Verfahren hat (`auth_or` fehlt oder ist `[{}]`; so speichert MariaDB auch
    ein einzelnes `IDENTIFIED VIA … USING`) und es `mysql_native_password`/`ed25519` mit Hash ist.
    Sonst (anderes Plugin, schon Alternativen, root fehlt) `DO 0`: root verliert nie etwas, und die
    Verwaltung bleibt beim Nextcloud-Konto (Probe: alle vier Fälle). Der OS-Nutzer root
    kommt per Socket hinein, wer root mit Passwort nutzt, weiter wie bisher; andere OS-Nutzer
    bekommen per Socket 1698. Nebenwirkung, gewollt: `/etc/mysql/debian-start` (ExecStartPost)
    scheitert seit langem an root (1045, „Upgrade failed“) und läuft ab diesem Start wieder, samt
    `mariadb-upgrade`, falls die Systemtabellen hinter der Version stehen.
  * **Fail closed:** Backup läuft oder Sperre belegt (rc=3); Datenbank läuft nicht, `MYSQLD_OPTS`
    schon im Manager, in einem Drop-in oder einem `EnvironmentFile` gesetzt (oder dieses nicht lesbar):
    rc=67, nichts überschrieben; lässt sich `MYSQLD_OPTS` nach dem Start nicht zurücknehmen, kein
    Rückweg-Neustart (er scheiterte an der gelöschten Datei), rc=1 mit dem Handgriff
    `systemctl unset-environment MYSQLD_OPTS`; kommt die Datenbank
    mit der Datei nicht hoch, startet `bootstrap` sie sofort normal (ohne Datei) neu und meldet rc=1;
    wirkt die Datei nicht, rc=1 — in allen Fällen bleibt `mysqldump.cnf` unverändert, und Datei und
    `MYSQLD_OPTS` sind weg (auch bei Abbruch, `trap EXIT`).
  * **Rückweg:** `db-access restore` (Datei auf `nextDB`, Stand Zwischenweg B). root zurück auf nur
    Passwort: `ALTER USER root@localhost IDENTIFIED VIA mysql_native_password USING '<Hash aus SHOW
    CREATE USER>'` per `mysql -u root` (Socket); `cockpit_backup` stört ohne Datei nicht.
  * Danach nimmt die Verwaltungs-Anmeldung zuerst root per Socket — `ensure` (Rotation) und
    `restore` lesen `config.php` dann nicht mehr (kein X1 mehr).
  * Kein Teil der Ausnahme `backup-repair`: `bootstrap` startet die Datenbank neu und braucht den
    normalen Rückweg (Backup höchstens 30 h alt) und den Maschinen-Snapshot.
* Ohne Rückweg darf genau dieser Lauf trotzdem starten (Ausnahme `backup-repair`,
  `doc/setup/host-run.md`): `db-access ensure` (oder `adopt`), danach `systemctl start borgmatic.service`,
  Prüfungen `db-access check` und `! systemctl is-failed --quiet borgmatic.service`, Rückweg
  `db-access restore`.

## Backup-Quellen ergänzen (`sources`, 02.11.2026)

**Entscheidung (Jochen, 31.10.2026, Karte t_2b394537):** „Wie sollen wir ein System sicher
betreiben, wenn das Backup nicht gepflegt werden darf?“ — James darf das Backup **ergänzen**,
ohne Jochens Klick; **schwächen** (Quellen entfernen, Aufbewahrung, delete/prune, Passphrase,
Repo) bleibt bei Jochen (X4-Befund des Türstehers).

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

| Form | Wirkung | Freigabe |
| --- | --- | --- |
| `cockpit-borg-action sources status` | lesend: angeschlossen ja/nein (nur ein Treffer-Test auf `config.yaml`, kein Inhalt), die R-Zeilen, Zahl der Sicherungen | frei |
| `cockpit-borg-action sources add <pfad>` | hängt genau eine R-Zeile an. Pfad: absolut, nur `[A-Za-z0-9._@+-]` je Ebene, kein `.`/`..`, kein Symlink (`realpath` = Pfad), existierendes Verzeichnis, mindestens eine Ebene unter `/opt/stacks`, `/srv` oder `/var/lib/docker/volumes`. Schon drin oder unter einer vorhandenen Quelle → nichts verändert, rc=0. **Größengrenze (H2):** die Quelle zusammen mit allen schon eingetragenen Cockpit-Quellen (`du -sbc`, über Mountpunkte hinweg, rc von `du` ≠ 0 heißt nicht messbar) darf höchstens ¼ des freien Platzes auf `/media/RAID` der Kiste belegen (Spalte Avail der Zeile `DF` in der Statusdatei, wie in `status`; deren `DATE` höchstens 24 h alt); darüber, oder wenn Größe oder Platz nicht lesbar sind, nichts verändert, rc=1, Meldung „Braucht Jochen“ mit dem Weg `add-large`. Alte Datei als `.vor-<UTC-Zeit>`, neue per `mv`, dann `borgmatic config validate`; ungültig → alte Datei zurück, rc=1. Nennt die Größe (`du -sh`), wirkt ab dem nächsten Backup-Lauf | **frei** |
| `cockpit-borg-action sources add-large <pfad>` | wie `add`, nur ohne Größengrenze (Ausgabe `größenprüfung: übersprungen`) — für eine Quelle, die Jochen trotz Größe will | Jochen |
| `cockpit-borg-action sources connect` | einmalig: `config.yaml` bekommt am Ende den Block `patterns_from: [<musterdatei>]` (alte Datei als `config.yaml.vor-<Zeit>`, 0600), legt die leere Musterdatei an, `borgmatic config validate`; ungültig → alte `config.yaml` zurück. Nennt `config.yaml` schon ein eigenes `patterns_from`, verändert es nichts (rc=1, dann von Hand) | Jochen |
| `cockpit-borg-action sources disconnect` | nimmt genau diesen Block wieder heraus — nur, wenn `config.yaml` seit dem Anschluss sonst unverändert ist (Vergleich mit der `.vor`-Datei plus Block), sonst rc=1 und nichts verändert | Jochen |
| `cockpit-borg-action sources restore` | die jüngste `.vor`-Musterdatei zurück, also Quellen weg | Jochen |

Ein Verb zum Entfernen einzelner Quellen gibt es nicht; das ist `restore` (Jochen) oder ein
Lauf, der die Musterdatei schreibt (Schreiben in `/etc/borgmatic` → X4-Befund, Jochen).

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
* **Wurzeln** stehen im Helfer fest (`SOURCES_ROOTS_FIXED`); ein Pfad außerhalb weist er ab.
* **Musterdatei nur als eigene, gewöhnliche Datei:** ist sie ein Symlink, ein Hardlink oder
  keine reguläre Datei, weisen `add` und `status` ab (rc=1) — sonst läse `add` etwa `config.yaml`
  und legte sie 0644 ab. `status` zählt außerdem „fremde Zeilen“ (alles außer Kommentaren und
  `R`-Zeilen, z. B. ein Ausschluss `! /srv`, der eine Quelle wieder ausschlösse).
* **Kein Kürzen bei Schreibfehlern:** jeder Schreibschritt von `add` wird geprüft, und vor dem
  Tausch muss die neue Datei die alte vollständig enthalten und genau eine `R`-Zeile mehr haben
  (volles Dateisystem → rc=1, nichts verändert).
* **Kein Textmuster-Riegel mehr (13.11.2026, Karte t_abe2651b).** Bis dahin las zusätzlich der
  Backup-Riegel (`cockpit-backup-guard.mjs`) jede Plan-Zeile, die den Helfer nennt, mit immer
  feineren Shell-Regeln (neun Prüfrunden in PR #73, weitere in #78–#96). Er ist ausgebaut: Ob ein
  Lauf den Helfer über Umwege (`find -exec`, `xargs`, Interpreter, Pipe in eine Shell, `eval`)
  außerhalb seiner freien Formen aufruft, beurteilt der Türsteher am ganzen Plan (X4/X5). Frei
  bleiben `sources status` und `sources add <Verzeichnis>`; `add-large`, `connect`, `disconnect`,
  `restore` und `repair` sind nach seiner Anweisung Befunde für Jochen. Strukturell bleiben die
  festen Wurzeln, die Größengrenze von `add`, die cgroup-Prüfung (nur aus einem host-run) und die
  Sperre im Helfer selbst.
* Mehr Quellen heißen mehr Platz auf der Kiste (RAID, `DF` in `status`). **Größengrenze (Hinweis
  H2, 05.11.2026, gebaut 10.11.2026, Karte t_0ea98639):** eine große Quelle könnte das RAID auf
  Lab0 füllen, dann scheitern alle Nachtläufe. Darum misst `add` die neue Quelle **zusammen mit
  allen schon eingetragenen Cockpit-Quellen** in einem Aufruf `du -sbc` (scheinbare Größe, also
  eher zu groß; höchstens 120 s, länger heißt „nicht messbar“) und vergleicht die Summe mit dem
  freien Platz aus der Statusdatei der Kiste — dieselbe Zeile `DF … /media/RAID`, die `status`
  zeigt (genau eine Zeile, Avail wie von `df -h`: Komma oder Punkt, Einheiten K…E als Potenzen
  von 1024). Frei ist `add` bis **¼ des freien Platzes**. Nachbesserung nach der Zweitprüfung
  PR #83 (11.11.2026, Karte t_b6cbeb86):
  - **Über Mountpunkte (B1):** gemessen wird ohne `-x`. borgmatic geht standardmäßig über
    Mountpunkte (`one_file_system` ist per Default `false`), etwa in ein Docker-Volume mit
    nfs/cifs/bind unter `/var/lib/docker/volumes/<v>/_data`; `du -x` sähe davon nichts. Der Helfer
    hängt damit nicht von der Einstellung auf dem Host ab — steht sie auf `true`, zählt er nur zu
    viel. Ein hängender Netz-Mount läuft in den Timeout (`timeout -k 10`) und endet als „nicht
    messbar“. Gewählt statt „Mountpunkt unter der Quelle → abweisen“, weil es ohne eine zweite
    Quelle der Wahrheit (`/proc/self/mountinfo`) auskommt und ein harmloser Mount kein Fall für
    Jochen ist.
  - **Rückgabecode (B2):** endet `du` mit rc ≠ 0 (unlesbarer Unterordner, verschwundene Datei,
    E/A-Fehler), ist die Ausgabe nur eine Teilsumme — das gilt als „nicht messbar“, rc=1.
  - **Mehrere `add` vor dem nächsten Backup (B3):** der freie Platz sinkt erst, wenn ein Backup
    gelaufen ist und die Kiste ihre Statusdatei neu geschrieben hat; jedes `add` dazwischen sähe
    denselben Wert. Darum zählt die Summe alle schon eingetragenen R-Zeilen mit. Bewusst *alle*
    statt „nur die seit `DATE` hinzugekommenen“: ob eine Quelle schon im freien Platz steckt,
    hängt an drei Zeiten (Eintrag, Ende des nächsten Backups, `DATE` der Statusdatei), von denen
    der Helfer nur zwei sicher kennt — eine Quelle, die vor `DATE` eingetragen, aber erst danach
    gesichert wurde, fiele durch. Alle zu zählen ist zustandslos und zählt nie zu wenig, nur eine
    schon gesicherte Quelle doppelt. Die Folge: die Cockpit-Quellen zusammen bleiben frei unter ¼
    des freien Platzes; wer darüber will, ist ohnehin ein Fall für Jochen (`add-large`). Eine
    Quelle, die eine schon eingetragene enthält, zählt deren Dateien nur einmal (`du` zählt jede
    Datei über alle Argumente einmal).
  - **Alter der Statusdatei (H1):** ihr `DATE` muss genau einmal da, lesbar (`date -d`, mit
    Zeitzone) und höchstens 24 h alt sein (höchstens 10 min in der Zukunft) — sonst gilt der freie
    Platz als nicht lesbar, fail-closed. Ein stehender Dienst auf der Kiste liefert sonst einen
    alten Wert.
  Begründung des Faktors 4 statt einer festen Grenze in Byte: das erste Archiv der Quelle wächst
  das Repo um bis zu ihre Größe (Kompression und Deduplizierung machen es nur kleiner), jede
  Änderung an ihr bleibt bis zum Ende der Aufbewahrung (bis zu 30 Tagessicherungen) zusätzlich
  liegen, und der Rest gehört dem Wachstum der vorhandenen Quellen; ob 100 GB zu viel sind, hängt
  allein vom freien Platz ab (am 10.11.2026: 697G frei, 88 % belegt, also Grenze ≈ 174 GiB).
  Darüber, oder wenn Größe oder Platz nicht lesbar sind (Kiste nicht erreichbar, Zeile fehlt),
  verändert `add` nichts und endet mit rc=1 und „Braucht Jochen“ — fail-closed, nicht still
  weiter. Mit Jochens Freigabe geht dieselbe Quelle über `sources add-large <pfad>`; der Türsteher
  meldet sie als X4-Befund. Gemessen wird vor der Sperre (ein langes `du` hält kein
  Backup auf); die Abdeckung („schon drin“) gilt vorher und unter der Sperre noch einmal, eine
  schon gesicherte Quelle wird nicht gemessen. Der installierte Helfer fragt immer die feste
  Statusdatei `http://10.0.0.5:8088/status.txt`, nie den Prüf-Haken `COCKPIT_BORG_ACTION_KISTE_URL`.
  Grenze ehrlich: die Prüfung gilt für die Quellen beim Hinzufügen; wachsen sie danach, sieht das nur
  `status` (`DF`). Tests: `test/cockpit-borg-action.test.sh` (H2-Fälle groß/klein, nicht lesbar,
  `add-large`; B1 du ohne `-x` — mit echtem Bind-Mount, wo der Prüfstand mounten darf —, B2 du rc=1
  mit Teilsumme, B3 zweites `add` hintereinander über der Grenze, H1 `DATE` zu alt/fehlt/kaputt/Zukunft).

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
