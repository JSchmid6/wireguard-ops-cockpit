# Die allgemeine Tür: Host-Lauf mit Schloss und Türsteher

Stand 30.09.2026. Betrifft `apps/api/src/host-run.ts`, `deploy/helpers/cockpit-host-run`,
`deploy/systemd/wireguard-ops-cockpit-host-run-resume.service`, den Executor-Broker
(`host.run`, `host.status`) und den Planer-Vertrag.

## Warum

Bisher war das Cockpit ein Sandkasten, der fast nichts durfte: schreibbar waren nur exakte
einzelne Dateien, und ein Namensmuster wie `*.save` im gebundenen Baum schickte den Lauf zur
Freigabe. Daneben wuchs eine Reihe von Sondertüren (WordPress, Platten, Nextcloud, DinD,
exact-file). Am 30.09.2026 scheiterte daran die Paketpflege: `/etc/apt` enthält
`sources.list.save` und `trusted.gpg~`, der Prüf-Agent gab grün, der Runner verlangte trotzdem
Jochen.

Jochen: „Baust du ein Haus und nagelst die Tür zu. Gegen Verbrecher ist das gut, aber als Haus
nutzlos. Und keiner baut ein Haus mit Türen für Sofa reinbringen, Einkauf reinbringen und Jochen
heimkommen.“ Dazu: „Schloss und evtl. Türsteher.“

Die Tür ist deshalb allgemein: ein Plan trägt Shell-Schritte, und diese laufen als root auf dem
Host. Gesichert wird davor (Schloss, Türsteher) und darunter (Netz), nicht durch einen
Sandkasten.

## Der Weg eines Laufs

```
Planer ──► Plan mit einem ```host-run-Manifest (cockpit-host-run/v1)
        ──► Türsteher: isolierter Safety-Reviewer liest die konkreten Schritte
              (deterministische Treffer gehen als Fokus mit)
        ──► pass: API signiert den Envelope (HMAC, manifestHash, Ablauf, host.run)
            Befund mit Beleg: Jochen entscheidet (blocked_user_approval)
            Prüfung unvollständig: Stopp, kein Freigabe-Angebot (blocked_prerequisite)
        ──► Executor-Broker host.run ──► sudo cockpit-host-run.mjs start
              prüft das Schloss, legt /var/lib/wireguard-ops-cockpit/host-runs/<job>/ an,
              startet die Unit cockpit-host-run-<job> und kehrt sofort zurück
        ──► Unit: Netz je Instanzrolle (VPS: borg jünger als 24 h? Snapshot beim Hoster.
              Lab0: lokaler Host-Snapshot). Schritte. Prüfschritte.
        ──► API folgt mit host.status, danach unabhängige Verifikation wie bisher
```

Den Block erkennt `parseHostRunManifest` an ```` ```host-run ```` oder ```` ```json ```` mit der
Version. Steckt der Planer das Manifest in einen ```` ```bash ````/```` ```sh ````-Block (Lab0-Job
4553505c, 18.10.2026), gilt es ebenfalls — aber nur, wenn das Skript des Plans (`typedPlanScript`,
der erste bash/sh-Block) als Ganzes ein JSON-Objekt mit `cockpit-host-run/v1` ist. Shell-Code wird
nie zum Manifest, auch nicht, wenn er den Manifest-Text enthält (`echo '{…}'`, Heredoc, JSON plus
weitere Zeilen); er bleibt auf dem Runbook-Weg.

## 1. Schloss

Nur ein Envelope der Cockpit-API öffnet (`hermes-execution-envelope/v1`, HMAC-SHA256 mit
`COCKPIT_EXECUTION_ENVELOPE_SECRET` aus `/etc/wireguard-ops-cockpit/api.env`). Der Helfer prüft
selbst, zeitkonstant:

- die Signatur,
- die Ablaufzeit (nur beim Start; ein Lauf, der rechtzeitig begann, darf nach einem Neustart
  weitermachen),
- `manifestHash` = SHA-256 genau des Manifests, das ausgeführt wird,
- die Capability `host.run`,
- `gatePassed` (der Türsteher hat genau diesen Plan bestanden) oder `operatorApproved` (Jochen
  hat genau diesen Job freigegeben). Die API signiert auch für blockierte Jobs einen Envelope
  (er wartet auf die Freigabe); der öffnet die Tür nicht,
- die Job-Kennung.

Läuft die Frist eines wartenden Jobs ab, bevor Jochen entscheidet, kann James sie mit
`POST /api/hermes/jobs/:id/reactivate` neu aufziehen: derselbe Envelope-Inhalt, neue Frist,
nie `operatorApproved` — das Schloss öffnet danach genauso wenig wie vorher. Höchstens 3× und
nie über 72 h seit Anlage; Details in `doc/setup/wartet-auf-dich.md`.

Wer bestellt hat, steht als `actorId` im Envelope, im Laufzustand (`state.json`), in der ersten
Protokollzeile und im Audit (`hermes.host_run.started`). Der Envelope bindet außerdem Intent,
Plan, Türsteher-Urteil und Policy (wie bei den anderen Türen).

sudoers erlaubt dem Executor genau zwei Formen:
`node …/cockpit-host-run.mjs start` und `node …/cockpit-host-run.mjs status *`.
Das innere Verb `--payload` läuft nur in der eigenen Unit (sie setzt
`COCKPIT_HOST_RUN_IN_UNIT`; sudo setzt die Umgebung zurück) und prüft das gespeicherte Schloss
erneut.

## 2. Türsteher

`apps/api/src/host-run.ts`. Der isolierte Safety-Reviewer (Agent-Broker, Rolle `safety`) bekommt:

- alle Schritte und Prüfschritte, jede Zeile mit Kennung (`S2:L3`, `C1:L1`), dazu Name, Zweck,
  `mutates`, erklärtes Risiko und den Rückweg,
- die deterministische Einstufung als **Fokus**: geschützte Pfade und Namen (dieselbe Liste wie
  im Capability-Sandkasten, z. B. `*.save`, `~`, `shadow`, `keys`), die Risikoklassen
  `exposure`/`data_loss`/`identity_or_secret`, gefährliche Programme (rm -rf, mkfs, dd, Firewall,
  Benutzer, sudoers), Abflüsse (curl/wget mit Daten, scp, rsync, ssh, nc, git push, docker push,
  Mail), Geheimnis-Orte, Verschleierung, Persistenz, Eingriffe in Backup und Cockpit selbst, eine
  „nur lesend“-Behauptung, die nach Änderung aussieht.

Kein Treffer stoppt selbst. Die Entscheidung:

| Ergebnis | Folge |
|---|---|
| `VERDICT: pass` | Der Lauf startet. |
| `VERDICT: flag` mit mindestens einem **belegten** Befund | Jochen entscheidet (`blocked_user_approval`), mit Befund, Pfad und zitiertem Code. |
| Befund ohne Beleg | wird verworfen (und im Protokoll genannt). Bleibt keiner übrig: Stopp als unvollständige Prüfung. |
| Prüfmaterial passt nicht ins Budget (90 000 Bytes), Reviewer antwortet nicht, Antwort unlesbar | Stopp: „Prüfung unvollständig“ (`blocked_prerequisite`). Das ist kein Freigabe-Angebot; der Plan wird neu eingereicht. |

Ein Befund gilt als belegt, wenn `WHERE` eine vorhandene Zeile nennt, das Zitat in `CODE`
wörtlich auf dieser Zeile (bei mehreren Zeilen: im selben Schritt) steht und `PATH` einen
konkreten Missbrauchs- oder Schadenspfad beschreibt. Material wird nie gekürzt und nie
geschwärzt: ein Schritt, der abgeschnitten oder geschwärzt wäre, liefe ungesehen (ein
vorgetäuschter Schlüsselblock könnte sonst einen Befehl vor dem Reviewer verstecken). Enthält eine
Skriptzeile Text, der wie ein Geheimnis aussieht, geht sie deshalb wörtlich an den Reviewer und
steht als Fokus `literal-secret` in der Liste; ein wörtliches Geheimnis im Plan ist nach dem Prompt
ein X1-Befund. Ein harmloser Name, der nur so aussieht (`task-runner-…` trifft das `sk-`-Muster),
stoppt so nichts.

Es gibt keine Freigabe als Regel, auch nicht für „geschützte Pfade“ — mit zwei ausdrücklichen
Ausnahmen, dem Backup-Riegel (2a) und dem Risiko-Riegel (2b). Die harten Grenzen der
Plan-Policy (`evaluatePlanPolicy`) und der borg-Repair-Riegel gelten weiter für die anderen
Türen; ein Host-Lauf geht nicht durch sie, sondern durch den Türsteher. Dessen Anweisung macht
einen borg-Repair und das Löschen oder Zurückspielen eines Maschinen-Snapshots ausdrücklich zu
einem X4-Befund: die Entscheidung bleibt bei Jochen, jetzt über den Türsteher statt über eine
Regel.

Der Prompt (`HOST_RUN_REVIEW_INSTRUCTIONS`) ist bei Abflüssen am schärfsten (siehe 6): das Lesen
der Cockpit-Geheimnisse, der Zugangsdaten des Agenten, privater Schlüssel, borg-Schlüssel oder
Datenbank-Passwörter ist dort immer ein Befund, egal wohin die Ausgabe geht. Routine bleibt
Routine: Paket-Updates aus den eingetragenen Quellen, Docker-Pulls, Kernel mit Neustart,
GitLab-Stufen, Dienst-Neustarts.

## 2a. Backup-Riegel: Backups löschen nur mit Freigabe

Jochen, 30.09.2026: „Ein Admin muss auch die Backups löschen können. Aber halt mit Freigabe.“
Geschärft am 10.10.2026: „Ich bin eh der Meinung, dass Updates nicht freigegeben werden
müssten.“ Das ist die eine Ausnahme von „keine Freigabe als Regel“, und sie gilt **nur für echtes
Löschen**: ein Lauf, der Sicherungen löscht, ihre Aufbewahrung ändert oder sie abschaltet,
startet nur mit `operatorApproved`, **auch wenn der Türsteher `pass` sagt**. Alles andere —
auch was der Riegel nicht lesen kann — entscheidet der Türsteher mit Belegpflicht. Append-only
gibt es nicht; nach der Freigabe kann Jochen alles davon tun.

Die Erkennung ist deterministisch und hat genau eine Quelle:
`deploy/helpers/cockpit-backup-guard.mjs` (installiert neben dem Helfer als
`/usr/local/lib/wireguard-ops-cockpit/cockpit-backup-guard.mjs`, Version
`cockpit-backup-guard/v4`). Sie liefert zwei Listen:

- `backupGuardHits` — der Riegel (Art `backup`). Drei Stellen fragen ihn:
  1. die Policy der API (`hostRunPolicy`): ein Treffer macht aus `pass` ein
     `blocked_user_approval` (bei einem belegten Befund kommen die Treffer dazu; eine
     unvollständige Prüfung bleibt `blocked_prerequisite`). Der Envelope trägt dann kein
     `gatePassed`;
  2. `runHostRun` in der API vor dem Aufruf des Executors;
  3. der Root-Helfer selbst (`verifyRequest`), beim Start und bei jeder Fortsetzung nach einem
     Neustart: ohne `operatorApproved` Abbruch mit Code 77, bevor irgendetwas angelegt wird.
- `backupGuardFocus` — Hinweise für den Türsteher (Art `mention` oder `uncertain`). Sie halten
  den Lauf **nicht** an. Der Türsteher sieht sie als Fokus `backup-focus:*`, die Riegel-Treffer
  als `backup-approval:*`; seine Anweisung (X4) verlangt weiterhin, jeden Löschbefehl und jede
  Verschleierung eines Löschbefehls als belegten Befund zu melden.

Gelesen wird jede Zeile, die läuft: alle Schritte und Prüfschritte, dazu die Skripte, die der
Lauf per Heredoc schreibt und ausführt (und `ExecStart=`-Zeilen von Units, die er schreibt),
Inline-Code (`python -c`, `perl -e`) und der Befehl hinter `ssh <host> …`. Quotes und
Backslashes zählen nicht (`b"o"rg` ist `borg`), bekannte Variablen werden eingesetzt, Globs und
`{a,b}` gegen die geschützten Pfade geprüft, relative Pfade gegen `/` (das cwd des Helfers) und
jedes `cd`-Ziel aufgelöst. Kommentare zählen nicht.

**Riegel (`backup`, Freigabe nötig):**

- `borg`/`borgmatic` `delete`, `prune`, `compact`, `recreate`, `break-lock`, eine
  Schlüsseländerung (`key change-passphrase|import|migrate-to-repokey …`), `check --repair`,
  `borgmatic borg …`, ein `borgmatic`-Lauf mit anderer Konfiguration (`-c`) oder `--override`,
  `cockpit-borg-action` außer `status|check` — auch als Text in `sh -c '…'`, in einem Skript,
  das der Lauf schreibt, in einer Cron-Zeile oder in `echo/printf`;
- jede Änderung der Aufbewahrung: `keep_*`/`--keep-*`, `keepDaily|Weekly|Monthly`,
  `backup_keep_time` (GitLab), außerhalb eines reinen Lesebefehls;
- Schreiben in die Konfiguration: `/etc/borgmatic`, `/etc/borgmatic.d`, `/root/.config/borg`
  (Schlüssel), `/root/.borgmatic`, die borgmatic-Units samt `timers.target.wants`-Link,
  `/usr/bin/borg*`, `cockpit-borg-action`, den Aufräum-Dienst (unten), die Drop-in- und
  Generator-Verzeichnisse, über die systemd die Units still abschalten könnte
  (`cockpit-.service.d`, `service.d`, `system-generators`, `system.attached` …), jede Datei mit
  dem Namen einer dieser Units;
- Löschen, Verschieben, Überschreiben in Backup-Zielen — borg-Repo (`/media/RAID/backup_VServer`),
  `/var/backups`, `/var/opt/gitlab/backups`: `rm`, `rmdir`, `mv`, `shred`, `unlink`,
  `find … -delete` (oder `-exec rm`), `rsync --delete` ins Ziel, `git clean|rm`, `truncate`,
  `dd of=`, `chattr`; bei Löschbefehlen auch über einen Vorfahren (`rm -rf /var`,
  `cd /etc && rm -rf *`, `rm -rf /media`);
- auf Lab0 (`ssh borg@10.0.0.5 …`, `ssh lab0 …`, auch `-o HostName=10.0.0.5`): jeder Löschbefehl
  (`rm`, `mv`, `find -delete`, `zfs destroy` …), auch nach einem Trenner in Quotes
  (`ssh lab0 'true; rm -rf …'`); jeder Befehl dort, den der Riegel nicht lesen kann (fremdes
  Skript, `eval`, Dekodieren, `$CMD`, verschachteltes `ssh`); `ssh` nach Lab0 mit Text aus einer
  Pipe oder Datei (`… | ssh lab0 bash`, `ssh lab0 sh < plan.sh`) — ein Heredoc wird gelesen wie
  ein Schritt; und jeder Riegel-Treffer im Befehl hinter einem beliebigen `ssh <host>`;
- Lesen der Zugangsdaten und des Repo-Inhalts (seit 13.10.2026, `cockpit-backup-guard/v4`):
  `/etc/borgmatic`, `/etc/borgmatic.d`, `/root/.config/borg` (Schlüssel), `/root/.borgmatic`,
  `/etc/cockpit-borg-retention` (Passphrase des Aufräum-Dienstes) und `/media/RAID/backup_VServer`
  — mit jedem Befehl außer Metadaten (`ls`, `stat`, `du`, `df`, `test`, Prüfsummen …): `cat`,
  `grep`, `cp`, `ln -s`, `base64`, `find -exec`, `docker -v`, Eingabe-Umleitung (`< f`, `$(< f)`),
  `scp`/`rsync`/`sshfs` von `lab0:` — auch über Globs, Variablen, `sudo`, `bash -c`; ganze Bäume
  über einen Vorfahren (`grep -r … /etc`, `cp -a /etc`, `tar c /root`, `sshfs lab0:/media`);
  `borg mount|extract|export-tar`, `borgmatic mount|extract|export-tar|restore`;
- Abschalten: `systemctl` mit einem Verb, das eine Unit nicht laufen lässt (`stop`, `disable`,
  `mask`, `kill`, `edit`, `revert`, `set-property`, `freeze` …) an `borgmatic.timer|.service`,
  `cockpit-borg-retention.*` oder `timers.target` (auch per Glob wie `*.timer`), `service …
  stop`, `systemctl isolate|rescue|emergency`, `init`/`telinit`, die borg-Pakete entfernen
  (`apt-get remove|purge|autoremove`, `dpkg -r|-P`), die crontab aus der Ausgabe eines
  Backup-Befehls neu schreiben (`crontab -l | grep -v borgmatic | crontab -`);
- einen Maschinen-Snapshot löschen: `cockpit-vps-snapshot delete`, `DELETE …/snapshots/…`. Die
  Rotation des Werkzeugs selbst (`create` räumt den ältesten cockpit-eigenen Snapshot, Jochen
  28.09.2026) bleibt frei.

**Hinweis für den Türsteher (hält nicht an):**

- `mention` — ein Befehl nennt oder berührt die Backups, ohne zu löschen: eine neue Sicherung
  nach `/var/backups` legen (`cp`, `install`, `mkdir`), `docker run -v /var/backups:/b`,
  `systemctl restart borgmatic.timer`, `apt-mark hold borgbackup`, ein Schreiben in einen Baum,
  der die Backups enthält;
- `uncertain` — der Text, der läuft, ist nicht der Text im Plan: `ssh`/`scp`/`rsync` zu einem
  anderen Rechner, `eval`, Dekodieren, `$'\x..'`, Code aus einer Pipe, `alias`, `PATH`/
  `BASH_ENV`/`LD_PRELOAD`/`BORG_*`, ein Skript, das der Lauf nicht selbst schreibt, ein
  Befehlsname oder Ziel aus einem unbekannten Wert (`$CMD`, `rm -rf "$X"`, `xargs`), Inline-Code
  mit Prozessen oder Dateizugriffen.

**Frei** (weder Riegel noch Hinweis) bleiben die Routine und das Lesen: `systemctl start
borgmatic.service`, ein nacktes `borgmatic` (konfigurierte Aufbewahrung),
`borg list|info|check|create|diff`, `borgmatic list|info|check|create`,
`cockpit-borg-action status|check`, `systemctl status|is-active|show|list-timers …`,
`journalctl -u borgmatic`, lesende docker-Befehle (`ps`, `images`, `inspect`, `logs`, `stats`,
`version`, `info`, `compose ps|config|logs`), Paket-Updates — auch wenn `borgbackup` oder
`borgmatic` darunter sind —, `gitlab-backup create`, Lesebefehle (`ls`, `cat`, `grep`, `test`;
nicht auf Zugangsdaten und Repo-Inhalt, siehe oben) und `curl` ohne Upload an die Statusdatei auf
Lab0. Auf Lab0 bleibt sichtbare Routine per `ssh` frei (Jochen, 13.10.2026: „ein umkehrbarer
Routineschritt braucht kein Ja“): `systemctl start|stop|restart` an Units außerhalb der
Sicherung (`android-adb.service`, `android-emulator.service`, die Cockpit-Units), Status,
`journalctl`, Metadaten des Repos (`df`, `du`, `ls`), Paket-Updates. Der Türsteher sieht `ssh`
nach Lab0 weiter als Hinweis.

**Aufräum-Dienst auf Lab0** (`doc/setup/borg-retention.md`): frei ist seine Routine —
`/usr/local/sbin/cockpit-borg-retention status|run`, `set <d> <w> <m> <HH:MM>` innerhalb der festen
Grenzen (`deploy/helpers/cockpit-borg-retention-rules.mjs`, dieselbe Datei wie in API und Helfer)
und `systemctl start cockpit-borg-retention.service`. Der Riegel greift bei `set` unter der
Untergrenze oder mit `--freigabe`, `freigeben` (Fortsetzen nach einer Anomalie), jeder anderen
Form des Helfers, `systemctl stop|disable|mask|edit` an seinem Timer oder seiner Unit, und jedem
Schreiben in `/etc/cockpit-borg-retention`, `/var/lib/cockpit-borg-retention`, seine Units samt
`.d`-Verzeichnissen und seinen Code.

Was jetzt ohne Klick läuft, das vorher einen brauchte (Sicherheitsannahme, 10.10.2026): Text,
den der Riegel nicht lesen kann (Verschleierung, unbekannte Ziele, fremde Skripte, `ssh` zu einem
unbekannten Rechner), und Befehle, die die Backups nur nennen oder neue Sicherungen anlegen. Ein
Löschbefehl, der sich so versteckt, ist dann nur noch durch den Türsteher gesperrt: seine
Anweisung macht ihn zum X4-Befund mit Beleg, und ein belegter Befund geht an Jochen. Eine
Plan-Erzeugung, die den Türsteher täuscht UND den Löschbefehl vor dem Riegel versteckt, wäre der
verbleibende Weg; die Abwägung hat Jochen getroffen (eine Tür, keine Klick-Freigaben).
Ausnahme seit 13.10.2026: auf Lab0, dem Rechner mit dem Repo, ist unlesbarer Text hinter `ssh`
ein Riegel-Treffer (siehe oben) — dort ist jeder Befehl schon nah an den Sicherungen, und die
sichtbare Routine (Dienst-Neustart, Status, Logs) bleibt trotzdem frei.

Ehrliche Grenze: Programme, die schon auf dem Host liegen und über ihren Namen oder aus den
System-Verzeichnissen (`/usr`, `/opt/gitlab`) aufgerufen werden, nimmt der Riegel für das, was ihr
Name sagt; ihren Inhalt sieht er nicht. Ein Interpreter-Programm ohne Löschwort und ohne
geschützten Pfad wird nicht weiter zerlegt. Dort bleibt der Türsteher (X4) die Sicherung.

Tests: `apps/api/test/backup-guard.test.ts` (Korpus frei / Riegel / nur Hinweis, die echten Pläne
vom 10.10.2026 aus `fixtures/host-run-plans-2026-10-10.json`, Policy),
`host-run-helper.test.ts` (Helfer beim Start und nach dem Neustart, Snapshot-Name ≤ 30 Zeichen),
`host-run-flow.test.ts` (API: `pass` plus `borg delete` wartet auf Jochen, läuft nach der
Freigabe).

## 2b. Risiko-Riegel: erklärtes Risiko nur mit Freigabe

Vorfall 23.10.2026 (Job `d7df65dc`, neuer öffentlicher Vhost `office.wejos.de`): das Manifest
trug `"risk": ["exposure"]`, der Intent verlangte ausdrücklich Jochens Freigabe, der Türsteher
schrieb „Operator approval is the governing gate“ und sagte `pass` — und der Lauf startete ohne
Jochen. Ursache: `hostRunPolicy` las `manifest.risk` gar nicht; die erklärte Risikoklasse war
nur Fokus für den Türsteher (`declared-risk:*`), und `pass` hieß `ready`. Beim
Capability-Manifest dagegen erzwingt dieselbe Klasse seit jeher die Freigabe
(`capabilityNeedsOperatorApproval`).

Seitdem gilt: erklärt das Manifest eine Risikoklasse außer `contained` — `exposure`,
`data_loss` oder `identity_or_secret` —, startet der Lauf nur mit `operatorApproved`, **auch wenn
der Türsteher `pass` sagt**. Die Regel ist „alles außer `contained`“, damit es keine zweite Liste
gibt, die auseinanderlaufen kann. Drei Stellen fragen sie, wie beim Backup-Riegel:

1. `hostRunPolicy` (`hostRunRisksNeedingApproval`): aus `pass` wird `blocked_user_approval`
   (Zone rot, Beleg `declared risk: <klasse>`); bei einem belegten Befund kommt der Grund dazu;
   eine unvollständige Prüfung bleibt `blocked_prerequisite`. Der Envelope trägt kein `gatePassed`.
2. `runHostRun` in der API vor dem Aufruf des Executors.
3. der Root-Helfer (`verifyRequest`), beim Start und bei jeder Fortsetzung: ohne
   `operatorApproved` Abbruch mit Code 77. Ein Manifest ohne `risk`-Liste ist ungültig (64).

Unbekannte Klassen schließen zu: ein `risk`-Eintrag außerhalb der vier Klassen (`"network"`,
`"Exposure"`) oder ein `risk`, das keine Liste ist, macht das Manifest ungültig, statt still
zu `contained` zu werden. Fehlt `risk` ganz, setzt die API `["contained"]` (Planer-Vertrag).

Grenze: der Riegel greift auf das **erklärte** Risiko. Erklärt der Planer `contained`, obwohl
ein Schritt etwas öffnet, bleibt das ein Türsteher-Befund X3 „Exposure“ (Fokus `network`).

Tests: `host-run.test.ts` (Policy je Klasse, mit Befund, unvollständig), `host-run-helper.test.ts`
(Helfer 77 ohne / 0 mit Freigabe, `risk` fehlt → 64), `host-run-flow.test.ts` (API: `pass` plus
`exposure` wartet auf Jochen, läuft nach der Freigabe mit `operatorApproved`).

## 3. Tür

`deploy/helpers/cockpit-host-run` (installiert als
`/usr/local/lib/wireguard-ops-cockpit/cockpit-host-run.mjs`, gepinnte Node 20):

- eigene transiente Unit `cockpit-host-run-<job>` (`systemd-run --collect`, ohne Warten):
  außerhalb der Executor-Sandbox, übersteht einen Neustart des Executors,
  `RuntimeMaxSec` aus den Zeitlimits der Schritte plus Reserve — außer der Lauf ändert
  (`mutates`) oder hat einen unterbrechungssicheren Schritt (3a), dann `RuntimeMaxSec=infinity`
  (auch das Aufräumen nach einem Fehler darf nie abgeschnitten werden),
- jeder Schritt: `bash -eo pipefail -c <run>` als root, `DEBIAN_FRONTEND=noninteractive`,
  eigenes Zeitlimit (Standard 1800 s, höchstens 10 800 s; ein abbrechbarer Schritt, der es reißt,
  wird beendet und ist gescheitert, auch mit Exit 0 — ein unterbrechungssicherer nie, 3a), der
  erste Fehler beendet den Lauf,
- danach die Prüfschritte (Pflicht, jeder muss scheitern können),
- volle Ausgabe in `/var/lib/wireguard-ops-cockpit/host-runs/<job>/output.log` (0600) und ins
  Journal der Unit, ohne Steuerzeichen, **zeilenweise geschwärzt**: Token-Muster, `password=`/`token=`/`secret=`-
  Zuweisungen, Authorization-Kopfzeilen, private Schlüsselblöcke und die wörtlichen Werte aus
  `api.env`, `executor.env` und `contabo.env`,
- ein Lauf zur Zeit (Prüfen, Anlegen und Unit-Start unter einer atomaren Sperre).

  Ein zweiter Start wird vor dem ersten Schritt abgewiesen (Exit 75, „another host run is
  active: <job>“ bzw. „… is starting“). Die API nimmt das nicht als Fehllauf (Karte t_9c04b4de):
  Sie nimmt die Startmarken (`executionStartedAt`, `hostRunRequestedAt`) zurück, stellt den Job
  auf die Phase `waiting_for_host` (`output.hostRunQueue`: seit wann, wie oft abgewiesen, letzte
  Absage; Audit `hermes.host_run.queued`) und fragt alle 15 s erneut. Der Job startet, sobald der
  Platz frei ist. Die Freigabefrist gilt nur bis zum Klick (Vorfall 24.10.2026, Job a6ffb1fb):
  Wartet der Job in der Reihe, erneuert die API vor dem nächsten Startversuch die Frist seines
  Envelopes (`extendQueuedExecutionEnvelope`: gleicher Inhalt, also Plan-, Manifest- und
  Policy-Hash, `gatePassed`/`operatorApproved` unverändert, nur `issuedAt`/`expiresAt` neu, neu
  signiert; Audit `hermes.host_run.envelope_extended`, Zähler `hostRunQueue.extensions`). Er
  wartet höchstens 24 Stunden ab der ersten Abweisung (`hostRunQueue.notAfter`); keine neue Frist
  reicht darüber hinaus. Findet er bis dahin keinen Platz, endet er als `blocked_runner_busy`: Auf dem
  Host lief nichts, der Job ist wiederholbar und zählt nicht zum Circuit Breaker. Beim Warten darf
  James ihn zurückziehen, solange er nicht freigegeben ist. Ein freigegebener Job wartet bis zum
  Start oder bis zur Obergrenze; zurückziehen kann ihn James nicht. Ein API-Neustart plant ihn neu, wie einen Job in der Prüfung.
  Stirbt die API genau während eines Startversuchs (nur `hostRunRequestedAt` gesetzt), fragt sie
  nach dem Neustart `status <job>`. Kennt der Helfer den Lauf auch fünf Minuten nach der Anfrage
  nicht („no host run <job>“, die Startsperre ist dann verfallen), lief nichts: Die Marken fallen
  weg (Audit `hermes.host_run.not_started`), der Job wird wie ein wartender neu geplant oder ohne
  Breaker-Zählung beendet. Jede andere Antwort heißt weiter: dem Lauf folgen.

`status <job>` liefert Zustand, einen Protokollauszug (`logTail`, höchstens 30 000 Zeichen) und
`log` mit Pfad und Länge des ganzen Protokolls. Der Auszug behält jede `== `-Zeile (Schritt,
Prüfung, Netz, Ergebnis) und von jedem Abschnitt Kopf und Ende: kleine Abschnitte ganz, große
teilen sich den Rest; jeder Schnitt ist markiert. Bis 22.10.2026 war es nur das Ende, und ein langer
apt-Schritt schob die frühen Schritte aus dem Ergebnis (Job a45f57b1). Die API nennt den Pfad
in den NOTES des Ergebnisses (`full log on the host: …`), aber nur, wenn er im Laufverzeichnis
des Helfers liegt. Endet eine Unit ohne Ergebnis (Zeitlimit, Absturz), meldet `status` den Lauf
als gescheitert.

## 3a. Unterbrechungssichere Schritte: nie mittendrin abbrechen

Vorgabe Jochen, 11.10.2026: „Das mit den Zeitlimits ist brandgefährlich.“ Anlass: Job
`e9b7faf1` (Stufe A) — die Tür hat `apt-get upgrade` am Zeitlimit des Schritts per SIGKILL
beendet; 148 Pakete blieben „unpacked but not configured“ (u. a. openssh-server, apache2, php),
sshd lief nicht mehr.

- **Erkennung** (`deploy/helpers/cockpit-state-steps.mjs`, eine Quelle für API und Helfer,
  installiert neben dem Helfer): Paketverwaltung (apt, apt-get, aptitude, dpkg,
  unattended-upgrade, snap, do-release-upgrade, nala, pkcon, aptdcon, ubuntu-drivers), GitLab (gitlab-ctl, gitlab-rake, gitlab-backup),
  Migrationen (occ, `db:migrate`, mysql_upgrade/mariadb-upgrade, pg_upgrade…), `docker compose`/
  `docker-compose` (auch mit Optionen dazwischen, `docker --context x compose`), die Update-Helfer des Cockpits, Umschalten (`umschalt…`, switchover, cutover)
  und Platten/Boot (mkfs, parted, mdadm, update-grub, update-initramfs …). Gelesen wird der rohe
  Text von Name und Skript — ein Fehltreffer kostet nur Warten.
- **Wer unterbrechungssicher ist** (fail safe): ein erkannter Schritt; ein Schritt, den der
  Planer mit `"uninterruptible": true` kennzeichnet; und jeder Schritt eines ändernden Laufs
  (`mutates`), den der Planer nicht ausdrücklich mit `"uninterruptible": false` als abbrechbar
  kennzeichnet. Die Erkennung schlägt die Kennzeichnung: ein apt-Schritt bleibt
  unterbrechungssicher, auch mit `false`. Abbrechbar bleibt in einem ändernden Lauf nur, was der
  Planer ausdrücklich mit `false` kennzeichnet und die Erkennung nicht trifft — ruft ein solcher
  Schritt verdeckt Paketbefehle auf (eigenes Skript), sieht die Erkennung das nicht; also `false`
  nur für Schritte, die nichts installieren.
  Prüfschritte sind abbrechbar, außer die Erkennung trifft.
- **Am Zeitlimit**: kein Signal. Der Helfer schreibt „runs longer than planned … it is not
  ended — waiting“ ins Protokoll und `attention` (`level: "overrun"`) in den Laufzustand.
- **Harte Obergrenze** 6 h (oder das Zeitlimit, wenn größer): wieder kein Signal, sondern
  `attention.level: "operator"` und „OPERATOR: … still runs after … h“ im Protokoll. Der Lauf
  wartet weiter, bis bash selbst endet.
- **Hintergrundprozesse**: endet bash, hält aber ein mit `&` gestarteter Prozess die Ausgabe
  offen, liest der Helfer noch 10 s und macht dann ohne Abbruch weiter; der Prozess verliert
  dabei seine Ausgabe (schreibt er weiter, endet er an SIGPIPE) und endet spätestens mit der
  Lauf-Unit. Paketbefehle also nie mit `&` in den Hintergrund schicken. Bei einem abbrechbaren
  Schritt, den der Helfer am Zeitlimit beendet hat, gilt dieselbe Gnadenfrist für ein Kind in
  eigener Session (`setsid`, `ssh -f`), das das Signal überlebt — der Lauf hängt nicht.
- **API**: Solange der Helfer den Lauf als aktiv meldet, gibt die API ihn nie auf (jede solche
  Antwort schiebt ihre Frist). `attention` landet am Job (`output.hostRunAttention`), als Audit
  `hermes.host_run.attention` (einmal je Stufe) und in `GET /api/inbox` unter `attention` —
  James holt es dort ab und meldet es Jochen.
- **Aufräumen nach einem Fehler** (nur in einem ändernden Lauf, `mutates: true`): scheitert ein
  Paketschritt — oder irgendein Schritt, nach dem `dpkg --audit` halb installierte Pakete
  meldet —, räumt der Helfer vor dem Ende selbst auf (unterbrechungssicher, Ergebnis in `state.repair` und im Protokoll):
  1. sshd zuerst: läuft weder `ssh` noch `sshd`, wird er gestartet;
  2. `dpkg --configure -a --force-confdef --force-confold` (noninteractive);
  3. `apt-get -f install -y` mit denselben conffile-Optionen;
  4. sshd noch einmal und ob er lauscht (`ss -ltnp`);
  5. apache2, php*-fpm, mariadb, docker und die drei Cockpit-Dienste: ist einer aktiviert, aber
     nicht aktiv, wird er gestartet; was danach noch steht, nennt das Protokoll.
  Läuft Schritt 2 oder 3 länger als geplant (1 h), gilt dieselbe Meldung wie bei einem Schritt:
  `attention` „repair (…) runs longer than planned“, an der harten Obergrenze `operator` — kein
  Signal.
- **Lesender Lauf** (`mutates: false`): kein Aufräumen, auch nicht nach einem gescheiterten
  Paketschritt (`apt list --upgradable | grep -q …`, `apt-get -s upgrade`) — davor lagen weder
  borg-Prüfung noch Snapshot. Kein `dpkg --configure`, kein `apt-get -f install`, kein
  `systemctl start`. Der Helfer ruft nur `dpkg --audit` (liest), schreibt das Ergebnis nach
  `state.packageAudit` und meldet halb installierte Pakete im Protokoll („OPERATOR: read-only
  run: dpkg --audit reports unfinished packages …“) und als `attention` (`level: "operator"`).
- **Operator-Handgriff bei einem hängenden ändernden Lauf**: der Helfer beendet einen
  unterbrechungssicheren Schritt nie selbst. Hängt er nachweislich (Protokoll, `ps`), beendet
  der Operator den Lauf von Hand: `systemctl stop cockpit-host-run-<jobId>` — das beendet die
  ganze Unit (`KillMode=control-group`), also auch apt/dpkg darin; danach `dpkg --audit` und bei
  Bedarf `dpkg --configure -a` von Hand. `status` meldet den Lauf dann als gescheitert.
- **Robustheit des Helfers**: Schreibfehler im Protokoll oder im Laufzustand (z. B. volle Platte)
  beenden den Helfer nicht – auch das Aufräumen läuft dann –, und ein unerwarteter Fehler beendet ihn nicht, solange ein unterbrechungssicherer
  Schritt läuft — sonst endete die Unit (`KillMode=control-group`) und systemd beendete apt/dpkg
  mit.
- **Die anderen Wege**: Die Deploy-Unit des Selbst-Updates hat `TimeoutStartSec=infinity`, die
  `einspielen`-Unit von `dienste.update` (docker compose) kein `RuntimeMaxSec` mehr. Die
  Runner-Rolle des Agent-Brokers (der sie nach ihrem Budget mit SIGTERM→SIGKILL beendet) läuft
  ohnehin als `cockpit-agent` ohne root, sudo und Docker-Socket; die API gibt ihr zusätzlich
  keinen Plan, dessen Text (nicht nur der erste Skriptblock) einen Zustandsschritt nennt — der
  gehört durch die Tür.

## 4. Netz darunter

Vor jedem Lauf mit `mutates: true` (Standard; nur ein ausdrücklich lesender Plan setzt `false`,
und das prüft der Türsteher) spannt der Helfer das Netz seiner Instanz.

### Netz je Instanzrolle (16.10.2026)

Es bleibt **eine** Tür, ein Helfer und ein Envelope; nur das Netz hängt an der Rolle der Instanz.
Die Rolle steht in `/etc/wireguard-ops-cockpit/instance-role.env` (`COCKPIT_INSTANCE_ROLE=vps|lab0`,
root, 0600). Diese Datei legt **nur das Deploy** ab — `vps-cockpit-deploy.sh` aus
`deploy/vps/instance-role.env` (Tabelle, mit Rückfall), `homeserver-cockpit-deploy.sh` aus
`deploy/lab0/instance-role.env`. Plan, Manifest, Envelope und Umgebung des Aufrufers tragen keine
Rolle (sudo setzt die Umgebung zurück; der Helfer liest nur diese Datei). Fail closed: fehlt die
Datei, gehört sie nicht root, ist sie für Gruppe/andere schreibbar, steht keine, eine unbekannte
oder mehr als eine Rolle darin, scheitert der Lauf mit `preflight_failed`, kein Schritt läuft.

Dieselbe Datei sagt dem **Türsteher**, auf welchem Host er steht: Die API-Unit liest sie als
optionales `EnvironmentFile=-` (systemd liest als root, die API sieht nur `COCKPIT_INSTANCE_ROLE`).
Mit Rolle `lab0` beginnt seine Anweisung mit Lab0 (Backup-Ziel, borg-Repository = Familiendaten,
X1/X4), sonst — `vps`, fehlende oder unbekannte Rolle — mit dem strengsten Text, dem
Produktionshost. Der Rest des Vertrags (X1–X6, Antwortformat) ist auf beiden Hosts gleich. Grund:
Auf Lab0 hielt der Türsteher einen Lab0-Plan für einen Widerspruch zum Produktionshost (X5) und
stoppte jeden verändernden Lauf. Die Rolle ändert nur den Text, nie Schloss, Netz oder Riegel.

**vps** (unverändert):

1. `cockpit-borg-action status`: das letzte borg-Backup muss erfolgreich und jünger als 24 h
   sein. `last_run_end` ist die jüngste „Finished borgmatic…“-Zeile, die systemd nur beim
   erfolgreichen Ende der oneshot-Unit schreibt; `last_run_result` muss zusätzlich `success`
   sein, damit auch ein späterer gescheiterter Lauf stoppt.
2. `cockpit-vps-snapshot create cockpit-run-<job> --wait 900`: Maschinen-Snapshot beim Hoster;
   ist das Kontingent voll, rotiert das Werkzeug den ältesten cockpit-eigenen Snapshot.

**lab0**: Lab0 ist das borg-**Ziel**, kein borg-Client, und hat keinen Hoster — borg-Frische und
Maschinen-Snapshot passen dort nicht (Lauf 98a12e31 vom 16.10.2026 scheiterte genau daran:
„borg status failed (exit null)“, die VPS-Werkzeuge fehlen auf Lab0). Stattdessen:

1. `cockpit-host-snapshot create cockpit-run-<job>`
   (`/usr/local/lib/wireguard-ops-cockpit/cockpit-host-snapshot`, Muster wie
   `cockpit-self-update-snapshot`): lokale Kopie dessen, was ein Verwaltungslauf ändert —
   ganz `/etc` (damit Units und Drop-ins unter `/etc/systemd`), die Paketauswahl mit Versionen
   (`dpkg-query`) und welche Units eingeschaltet und aktiv waren (`systemctl list-unit-files`,
   `list-units --all`). Ablage `/var/lib/wireguard-ops-cockpit-host-snapshots/<name>/` (0700,
   Dateien 0600 — `/etc` enthält Geheimnisse), das `/etc`-Archiv wird gleich nach dem Schreiben
   zurückgelesen, das Manifest (`complete: true`) entsteht zuletzt; ein halber Snapshot bleibt
   nicht liegen. Die fünf jüngsten bleiben, rotiert wird nur die eigene Namensform; zu wenig
   Platz (< 256 MB) verweigert.
2. Keine borg-Prüfung: das Backup, das auf Lab0 liegt, sichert den VPS, nicht Lab0.
3. **Datensperre** (Jochen, 17.10.2026 — G5 für die Rolle lab0): die Lauf-Unit hängt die Datenpfade
   `/media` (mit dem borg-Repo `/media/RAID/backup_VServer/borg`), `/home`, `/mnt` und `/srv`
   schreibgeschützt ein (`systemd-run --property=ReadOnlyPaths=-<pfad>`, fehlende Pfade entfallen).
   Vor dem ersten Schritt prüft der Lauf in `/proc/self/mountinfo`, wohin jeder Pfad wirklich
   auflöst (Mount-Baum über Mount- und Parent-ID; der vom rbind verdeckte Original-Mount
   `/media/RAID` zählt nicht): jeder vorhandene Datenpfad ist ein eigener ro-Mount, jeder
   Mountpunkt darunter löst auf einen ro-Mount auf, kein autofs darunter (dessen echter Mount käme
   erst beim Zugriff, beschreibbar). Sonst `preflight_failed`, kein Schritt. Nach einem Neustart
   prüft die neue Unit dasselbe, wenn der Systemstart durch ist, vor dem nächsten Schritt; sonst
   endet der Lauf `failed`.

Ehrliche Grenze von lab0: der Host-Snapshot ist kein Maschinen-Snapshot. Er deckt Konfiguration,
Paketstand und Unit-Zustände, keine Daten und keinen Paketinhalt (ein Downgrade braucht die alte
Version aus dem Archiv). Die Daten schützt statt eines Rückwegs die Datensperre: ein Lauf schreibt
dort nicht. Sie fängt Versehen, nicht Absicht — root kann über eine andere Unit (`systemd-run`, ein
Dienst, den der Plan startet oder ändert), ein `mount -o remount`, `nsenter` oder einen Pfad außerhalb
der vier doch an Daten; solche Wege sind Sache des Türstehers (X4). Ein Mount, den der Host erst
nach der Prüfung einhängt (Hotplug, ein spätes `nofail`), erscheint in der Lauf-Unit beschreibbar. `/var/lib` bleibt beschreibbar
(dpkg, systemd), ist also nicht gesperrt. Dienste, die ein Lauf nur startet oder stoppt (etwa
`android-emulator`), laufen in ihrer eigenen Unit und sind von der Sperre nicht betroffen.

Scheitert ein Teil des Netzes, läuft kein Schritt (`preflight_failed`). Scheitert später ein Schritt
oder eine Prüfung, nennt das Protokoll die Snapshot-Kennung (`machine snapshot …` bzw.
`host snapshot …`); zurückgespielt wird nur mit Jochens Freigabe — beim Maschinen-Snapshot ein
Revert (nimmt alles seit dem Snapshot mit), beim Host-Snapshot gezielt einzelne Dateien
(`tar -xzf <ablage>/<name>/etc.tar.gz -C / etc/<pfad>`) bzw. Paket-/Unit-Stand nach den Listen.

Ausrollen: Rolle und Lab0-Werkzeug installiert das jeweils **neue** Deploy-Skript. self.update ruft
aber das **installierte** Skript auf; der erste self.update auf einen Stand mit diesem Netz läuft
also noch mit dem alten Skript, das nur das neue Skript (und den neuen Helfer) installiert. Deshalb
liegt das Netz in zwei Commits: der erste bringt Deploy-Skripte, Rolle und Werkzeug (der Helfer
bleibt alt), der zweite den Helfer, die Texte für Türsteher und Update-Review und diese Doku. Reihenfolge je Instanz: self.update auf den ersten
Commit, dann self.update auf den Merge — so fehlt die Rolle nie, wenn der neue Helfer sie verlangt.
Ein self.update direkt auf den Merge hinterlässt den neuen Helfer ohne Rolle: verändernde Läufe
scheitern dann sicher (`no instance role`), bis ein weiterer self.update das neue Skript laufen lässt.

Ausrollen der Datensperre (17.10.2026) folgt demselben Muster: auf Lab0 zuerst self.update auf den
Commit mit der Sperre (das alte Skript installiert neues Skript und neuen Helfer; bis zum nächsten
Schritt scheitern verändernde Läufe sicher an der fehlenden Rolle), dann self.update auf den Merge
(das neue Skript legt die Rolle). Das erste Update prüft noch das alte Update-Review mit dem G5 von
vor dem 16.10.; sein Befund geht einmal an Jochen. Auf dem VPS (schon auf dem ersten Commit von
#52, Rolle liegt) genügt ein self.update auf den Merge.

Das Cockpit selbst kommt auf Lab0 weiterhin über das typisierte Selbst-Update mit eigener Kopie und
Rückfall (`doc/setup/self-update.md`, „Lab0: snapshot and rollback“), nicht durch diese Tür.

Der Plan braucht Prüfschritte und einen Rückweg (`rollback`, Pflichtfeld). Ein Neustart ist ein
gewöhnlicher Schritt (`{"name":"reboot","reboot":true}`, höchstens drei): der Lauf schreibt
vorher, wo er weitermacht, `wireguard-ops-cockpit-host-run-resume.service` startet die
Fortsetzung beim Hochfahren (Phase `resuming`, nach erneuter Prüfung des Schlosses, ohne zweiten
Snapshot; `status` hält eine Fortsetzung zwei Minuten lang nicht für gescheitert, solange ihre Unit
noch startet), und die
API — die mit dem Host neu gestartet ist — nimmt den Job aus seinem Datensatz wieder auf, folgt
dem Lauf über `host.status` und meldet danach das Ergebnis samt Verifikation.

## 5. Sondertüren

Die vorhandenen Sondertüren (Capability-Sandkasten mit WordPress-, Nextcloud-, DinD-,
exact-file- und Snapshot-Helfern, typisierte Platten-, borg- und Update-Wege) bleiben unverändert.
Neue entstehen keine: Paket-Updates, Docker, Kernel mit Neustart und GitLab in Stufen sind
gewöhnliche Runbooks durch diese Tür. Der Planer-Vertrag (`hostRunPlannerContract`) macht die
Tür zum Standard für Host-Arbeit; ein Capability-Manifest nimmt er nur, wenn ein typisierter
Helfer die Aufgabe genau abdeckt. Ein Plan mit beiden Manifesten wird abgelehnt.

Schreibt der Operator das Manifest selbst in den Intent (genau ein ```` ```host-run ````-Block),
gilt dieses Manifest — nicht die Abschrift des Planers (`intentHostRunManifest`). Anlass: Jobs
611ad26d (10.10.2026) und 83434c34 (13.10.2026) scheiterten an „host-run manifest is not valid
JSON“, weil der Planer lange, stark escapte Manifeste nicht fehlerfrei auf eine Zeile abschrieb.
Die Abschrift wird nur noch verglichen und als Evidenz vermerkt (`planner copy: identical |
differs | absent | invalid (…)`). Zwei Blöcke oder ein ungültiger Block im Intent beenden den Job
vor dem Planer mit dem Grund; einen Rückfall auf die Planer-Abschrift gibt es nicht. Türsteher,
Schloss, Snapshot und Abbruch-Sicherheit prüfen und fahren genau das Intent-Manifest. Nur der
vertrauenswürdige Intent zählt, nie die Evidenz. Die Grenzen gelten weiter (u. a. höchstens 16
Checks — das Kernel-Manifest vom 13.10. hatte 17 und wäre auch mit fehlerfreier Abschrift
gestoppt worden).

## 6. Ehrliche Grenze

Den Schlüssel zur Tür — die Zugangsdaten für die Cockpit-API, mit denen James Läufe bestellt —
kann heute jeder Unteragent in James' Container lesen (siehe t_1b05a93f: gleiche uid für Gateway
und Agenten). Wer ihn hat, kann einen Plan einreichen. Das Schloss verhindert nur, dass ein
anderer als die API selbst einen Lauf freigibt; es verhindert nicht, dass ein manipulierter
Besteller einen bösen Plan vorlegt.

Der Schlüssel gehört in den Tresor, nicht in eine Datei: Die Hermes-Seite holt den Token künftig
per `tresor.geheimnis`, rotiert ihn und entfernt die Klartextdateien (t_e308b9f9). Die Tür setzt
keinen Ablageort voraus — sie sieht nur den Bearer-Token am Endpunkt. Solange Agenten und Gateway
dieselbe uid teilen, kann ein Unteragent aber auch einen Token aus dem Tresor abgreifen, den das
Gateway gerade benutzt; der Tresor verkleinert die Angriffsfläche, er ersetzt den Türsteher nicht.

Deshalb ist der **Türsteher die eigentliche Sicherung**. Das Netz darunter macht Schäden auf dem
Host rückgängig (Snapshot, borg), aber **keine Abflüsse nach außen**: ein Geheimnis oder
Familiendaten, die den Host verlassen haben, holt kein Snapshot zurück. Deshalb ist der
Reviewer-Prompt dort am schärfsten, und deshalb gilt das Lesen der Cockpit-eigenen Geheimnisse
(Envelope-Secret, Hoster-Zugang) immer als Befund — wer sie hat, braucht weder Tür noch
Türsteher.

Weitere bekannte Grenzen:

- Der Türsteher ist ein Sprachmodell. Er kann einen verschleierten Abfluss übersehen; die
  Fokusliste und die Pflicht zum Zitat verringern das, schließen es nicht aus.
- Die Schwärzung arbeitet zeilenweise auf bekannten Mustern und den bekannten Cockpit-Werten.
  Ein Geheimnis in unbekannter Form kann im Protokoll landen. Das Protokoll bleibt root-eigen
  (0600), aber ein Auszug daraus (bis 30 000 Zeichen) steht im Job-Ergebnis, und das kann der Besteller
  über `GET /api/hermes/jobs/:jobId` lesen — also genau der Agent, der manipuliert sein könnte.
  Eine Ausgabe ist damit auch ein Weg nach draußen; der Reviewer-Prompt behandelt das Lesen und
  Ausgeben von Geheimnissen deshalb als Befund, egal wohin die Ausgabe geht.
- Ein privater Schlüsselblock ohne END-Zeile wird höchstens 200 Zeilen lang geschwärzt, damit er
  nicht den Rest des Protokolls verschluckt.
- `mutates: false` spart Snapshot und Backup-Prüfung. Stimmt die Behauptung nicht, ist das ein
  X5-Befund des Türstehers — einen deterministischen Riegel dafür gibt es bewusst nicht.
- Kommt ein angeforderter Neustart nicht (gleiche Boot-Kennung 30 Minuten nach der Anforderung),
  gilt der Lauf als gescheitert, und die Tür ist wieder frei. Kommt der Host gar nicht zurück,
  gibt die API nach ihrer Frist (Zeitbudget plus eine Stunde je Neustart) auf.

## Prüfung von Änderungen an der Tür

Änderungen an der Tür selbst gehen wie jeder Cockpit-Code durch die Prüfung vor dem
Selbstupdate (`doc/setup/self-update.md`, Abschnitt „The guarantees and the one door“). Deren
Garantien bilden seit 02.10.2026 dieses Modell ab: dass `host.run` Plantext als root ohne
Sandkasten ausführt und der Türsteher ohne Jochen freigibt, ist gewollt und kein Befund. Ein
Befund ist ein Weg am Schloss (G2), am Türsteher (G9), am Backup-Riegel (G10) oder am Netz (G5)
vorbei. Der Runner markiert die Dateien der Tür als Fokus `host-door`.
Wer an der Tür ändert, liest vorher `doc/setup/self-update.md` „Before you change this door“ und
schreibt `G-Garantien berührt: …` in die PR-Beschreibung; ohne diese Zeile ist die CI rot
(`.github/workflows/pr-guarantees.yml`).

## Freigabe-Matrix: wann Jochen gefragt wird (11.10.2026)

Grundsatz (Jochen, 11.10.2026): Cockpit-Änderungen landen nur bei ihm, wenn ein Prüfer die Hand
hebt. Der Normalfall ist Durchlaufen. Das gilt für beide Prüfungen: den Türsteher eines Host-Laufs
(Abschnitt 2, `hostRunPolicy`) und die Prüfung vor dem Selbstupdate und vor `dienste.update`
(`applyUpdateReviewPolicy`, `doc/setup/self-update.md`, „Decision“).

| Prüfergebnis | ohne Backup-Riegel / harten Blocker | mit Backup- oder Risiko-Riegel-Treffer (nur `host.run`) oder hartem Plan-Blocker |
|---|---|---|
| **PASS** — Freigabe auf vollständigem Material | läuft ohne Jochen (`ready`) | Jochen entscheidet (`blocked_user_approval`) |
| **FINDING** — mindestens ein echter Befund (Türsteher: mit Beleg; Selbstupdate: `GUARANTEE` nicht `UNVERIFIABLE`) | Jochen entscheidet, mit Befund und zitiertem Code (`blocked_user_approval`) | Jochen entscheidet, Befund und Riegel/Blocker zusammen (`blocked_user_approval`); ist der Plan schon `blocked_prerequisite`/`blocked_policy`, bleibt diese Sperre, und der Befund steht in `GET /api/inbox` unter `reviewFindings` |
| **INCOMPLETE** — Material fehlt oder zu groß, Prüfer antwortet nicht, Antwort unlesbar, nur `UNVERIFIABLE` bzw. Befunde ohne Beleg | Stopp ohne Freigabe-Angebot (`blocked_prerequisite`): technischer Fehler für James, keine Frage an Jochen | ebenso `blocked_prerequisite` — ungeprüft wird nie zur Freigabe angeboten (nur `blocked_policy` bleibt) |

- Ein echter Befund landet immer bei Jochen, ohne Ausnahme — auch wenn die Prüfung zusätzlich
  unvollständig war. Ist der Plan ohnehin schon `blocked_prerequisite` oder `blocked_policy`, wird
  daraus kein Freigabe-Angebot, denn eine Freigabe darf diese Sperren nie aufheben. Der Job
  speichert dann aber `output.updateReview.result: "finding"`, und `GET /api/inbox` listet ihn
  sieben Tage lang unter `reviewFindings` (Job-Id, Status, Absicht, Befunde ohne `UNVERIFIABLE`).
  James meldet ihn Jochen. Ein überarbeiteter Plan, dessen neue Prüfung durchgeht, lässt den
  Befund deshalb nicht verschwinden.
- PASS ist nie der Restfall: Nur `VERDICT: approve` auf vollständigem Material ist PASS. Ein
  Ergebnis ohne Prüferantwort (auch ohne Fehlermeldung) ist INCOMPLETE („the review produced no
  verdict“).
- INCOMPLETE ist nie ein Durchlass. James klärt die Ursache (Einsammeln reparieren, Lauf
  wiederholen) und reicht neu ein; kommt er nicht weiter, fragt er Jochen selbst.
- Harte Blocker, die unabhängig vom Prüfergebnis zu Jochen gehen: Backup-Riegel (Abschnitt 2a,
  nur `host.run`); Risiko-Riegel (Abschnitt 2b, erklärtes `exposure`/`data_loss`/
  `identity_or_secret`, nur `host.run`); für die typisierten Türen die Plan-Policy (`evaluatePlanPolicy`: geschützte
  Grenze, Risikozone rot, nicht autorisierte Capability, `shell.exception`, `borg.repair`).
- Die Sicherungskette vor einem verändernden Lauf (borg-Prüfung, Snapshot) hängt nicht an dieser
  Matrix und bleibt unverändert.

## Tests

- `apps/api/test/host-run-helper.test.ts`: der echte Helfer mit Stubs für systemd-run,
  systemctl, borg und Snapshot — Schloss (Signatur, Ablauf, Drift, Capability), Netz (borg zu
  alt/gescheitert, Snapshot scheitert, lesender Lauf; je Instanzrolle: vps unverändert, lab0 mit
  Host-Snapshot statt borg/Hoster — auch mit dem echten `cockpit-host-snapshot` —, Rolle fehlt,
  unbekannt, doppelt, schreibbar oder nur in der Umgebung → `preflight_failed`, Host-Snapshot
  scheitert oder fehlt → `preflight_failed`, nichts ausgeführt; lab0-Datensperre: ReadOnlyPaths an
  der Unit, schreibbarer Datenpfad oder Untermount, gestapelter rw-Mount, autofs auf oder unter
  einem Datenpfad bzw. fehlende Sperre → `preflight_failed`; verdeckter rbind-Original-Mount zählt nicht;
  nach dem Neustart erneut geprüft → `failed`), Tür (Fehler, Zeitlimit, Prüfschritte,
  Schwärzung, Neustart mit Fortsetzung, ein Lauf zur Zeit), unterbrechungssichere Schritte mit
  Attrappen für dpkg/apt-get/ss (langsamer apt überzieht ohne Abbruch, Meldung, harte Obergrenze
  mit Operator-Meldung, Erkennung schlägt `false`, Aufräumen sshd → dpkg → apt-get -f → Dienste;
  ein lesender Lauf räumt nach einem gescheiterten apt-Schritt nicht auf, meldet nur `dpkg --audit`).
- `apps/api/test/state-steps.test.ts`: die Erkennung und die Kennzeichnung im Manifest.
- `apps/api/test/host-run.test.ts`: Manifest, Fokus (der `/etc/apt`-Fall stoppt nicht mehr),
  Prompt, Belegprüfung, Entscheidung, Ergebnis.
- `apps/api/test/host-run-flow.test.ts`: der Weg durch die API mit Brokern als Fakes — `pass`
  startet trotz `*.save`-Pfad und borg-Repair-Zeile (kein Regel-Stopp), ein belegter Befund geht
  an Jochen (`gatePassed` fehlt) und nach der Freigabe läuft genau dieser Plan (`operatorApproved`,
  gleicher Hash), ein Befund ohne Beleg stoppt ohne Freigabe-Angebot, zwei Manifeste werden
  abgelehnt; Überziehung am Job, im Audit und in `GET /api/inbox`; kein Zustandsschritt an den
  Runner.
- `apps/api/test/host-run-resume.test.ts`: API-Neustart während eines Laufs (Broker als Fakes),
  auch wenn die API zwischen Start und Startmarke starb (`hostRunRequestedAt`).
- `apps/executor-broker/test/index.test.mjs`: `host.run`/`host.status`.
- `apps/api/test/host-snapshot.test.ts`: `cockpit-host-snapshot` selbst — vollständige, private
  Kopie (`/etc`-Archiv gelesen, Paket- und Unit-Listen, Manifest zuletzt), Rotation nur der eigenen
  Namensform, Name/Bestand/Platz verweigert, kein halber Snapshot bei einem Fehler.
- `test/vps-cockpit-deploy.test.sh`: Helfer, Resume-Unit und Instanzrolle in der Deploy-Tabelle
  (Rolle root 0600, Rückfall bytegenau), Unit aktiviert.
