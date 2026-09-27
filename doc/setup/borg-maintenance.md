# Borg-Betrieb — Zustand ansehen und Wartung bestellen

Dieses Modul macht den Backup-Betrieb von der Ad-hoc-Shell zu einer Sache der
Cockpit-Policy: der Zustand ist lesbar, ein Repo-Check und ein Repair laufen als
typisierte Aktion mit Audit und Freigabe.

## Vertrag

| Aktion | Form im Plan | Wirkung | Freigabe |
| --- | --- | --- | --- |
| `borg.status` | `/usr/local/sbin/cockpit-borg-action status` | lesend: borgmatic-Timer, letzte Läufe (Journal), jüngste Archive, Repo-Kennzahlen, Statusdatei der Kiste | autonom (keine) |
| `borg.check` | `/usr/local/sbin/cockpit-borg-action check` | startet `borgmatic check` (lesend) abgesetzt und kehrt sofort zurück | autonom (keine) |
| `borg.repair` | `/usr/local/sbin/cockpit-borg-action repair` | startet `borgmatic check --repair --force` abgesetzt; kann beschädigte Archive entfernen | **Operator** (`blocked_user_approval`) |

Alles andere (`restore`, `delete`, zusätzliche Argumente, ein Pfad ausserhalb
`/usr/local/sbin/`) ist kein `borg.manage`, sondern `shell.exception` — es läuft
durch keinen automatischen Job.

Die Fähigkeit heisst `borg.manage` und liegt in der Allowlist des Aufrufers: ein
Change-Job muss `allowedCapabilities: ["borg.manage"]` mitbringen, sonst endet der
Plan als `blocked_user_approval` (Capability-Eskalation).

## Dateien

| Pfad (Host) | Quelle | Zweck |
| --- | --- | --- |
| `/usr/local/sbin/cockpit-borg-action` | `deploy/helpers/cockpit-borg-action` | der einzige sudo-exponierte Einstieg; gepinnte Grammatik `status\|check\|repair` |
| `/etc/sudoers.d/cockpit-executor` | `deploy/sudoers/cockpit-executor` | Zeile `cockpit-executor ALL=(root) NOPASSWD: /usr/local/sbin/cockpit-borg-action *` |
| `/var/lib/wireguard-ops-cockpit/borg/` | Laufzeit | `last.pid`, `last.kind`, `last.log` (Symlink auf das jüngste Log), 0750 root |
| `/var/log/wireguard-ops-cockpit-borg/<verb>-<stamp>.log` | Laufzeit | ein Log je abgesetztem Lauf, 0750 root |
| `/run/lock/cockpit-borg.lock` | Laufzeit | Sperre gegen zwei gleichzeitige Läufe auf demselben Repo |

Installiert wird der Helfer von `deploy/vps/vps-cockpit-deploy.sh` (Tabelle) — also
auch über den Selbst-Update-Weg des Cockpits, ohne Handgriff am Terminal.

## Warum `check`/`repair` abgesetzt laufen

Ein Repo-Check über ~3,5 TB läuft Stunden. Der typisierte Executor ist eine
Anfrage/Antwort-Strecke (der Broker wartet auf den Kindprozess), ein Helper, der
zwei Stunden im Slot hängt, wäre ein kaputter Executor. `check`/`repair` starten
darum über `setsid` eine eigene Sitzung, die die Sperre für die gesamte Dauer
hält, und kehren sofort mit PID und Logpfad zurück. Der Fortschritt ist über
`status` sichtbar (Sperrzustand, PID, Logschwanz).

`repair` setzt `BORG_CHECK_I_KNOW_WHAT_I_AM_DOING=YES` (borg fragt sonst
interaktiv „Type 'YES'…" und der Lauf stirbt headless).

Beide Verben brechen mit rc=3 ab, wenn `borgmatic.service` gerade läuft oder die
Sperre belegt ist. Grund: borgmatic benutzt denselben Repo-Lock; ein zweiter Lauf
beendet den nächtlichen Timer-Lauf mit „Failed to create/acquire the lock" (genau
das passierte am 22.09.2026).

## Grenzen (bewusst)

* Der Repo-Schlüssel bleibt ausschliesslich auf dem VPS. Der Helfer liest
  `/etc/borgmatic/config.yaml` **nie** — die Datei enthält Klartext-Zugangsdaten
  (mysqldump, borg). Es laufen nur borgmatic-Kommandos, die den Schlüssel selbst
  benutzen und nur ihre Zusammenfassung ausgeben.
* Keine freien Argumente, keine Pfade, kein `borg`-Rohkommando, kein `--repair`
  ohne vorherige Freigabe.
* Kein Runtime-Sudo: die Zeile steht in der versionierten, vom Deploy geprüften
  sudoers-Datei; die API kann sich keine Rechte bauen.
* Kein tmux-Runbook für borg: Runbook-Sitzungen laufen als `wgops`, der
  Repo-Schlüssel gehört root. Der lesende Weg ist die typisierte Aktion, nicht
  eine Shell-Sitzung.

## Zustand der Kiste (Baustein „Sichtbarkeit")

`status` beantwortet auch „was macht die Kiste?" ohne SSH:

* auf dem VPS: Array-Zustand und freier Platz aus der Statusdatei
  `http://10.0.0.5:8088/status.txt` (`MDSTAT`, `DF /media/RAID`), die der
  Dateidienst der Kiste ohnehin erzeugt;
* wenn `status` auf der Kiste selbst läuft (dort gibt es kein borgmatic, weil
  kein Schlüssel): Mount, Platz und das Repo-Verzeichnis — Existenz, mtime,
  Grösse, Anzahl Datensegmente und das jüngste Segment. Ein nicht erreichbares
  Repo meldet `status` mit rc=2 und `repo_erreichbar: nein`, damit der Job als
  Befund endet und nicht als „alles gut".
