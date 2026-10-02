# Die allgemeine Tür: Host-Lauf mit Schloss und Türsteher

Stand 30.09.2026, Netz je Kiste seit 02.10.2026. Betrifft `apps/api/src/host-run.ts`,
`deploy/helpers/cockpit-host-run`, `deploy/helpers/cockpit-host-run-net.mjs`,
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
        ──► Unit: Netz der Kiste (VPS: borg jünger als 24 h, Snapshot beim Hoster;
              Lab0: RAID, Platz, Aufräum-Dienst, Systemsicherung). Schritte. Prüfschritte.
        ──► API folgt mit host.status, danach unabhängige Verifikation wie bisher
```

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

Es gibt keine Freigabe als Regel, auch nicht für „geschützte Pfade“ — mit einer ausdrücklichen
Ausnahme, dem Backup-Riegel (2a). Die harten Grenzen der
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
Das ist die eine Ausnahme von „keine Freigabe als Regel“. Ein Lauf, der Backups löscht oder
ihre Aufbewahrung verkürzt, startet nur mit `operatorApproved`, **auch wenn der Türsteher
`pass` sagt**. Append-only gibt es nicht; nach der Freigabe kann Jochen alles davon tun.

Die Erkennung ist deterministisch und hat genau eine Quelle:
`deploy/helpers/cockpit-backup-guard.mjs` (installiert neben dem Helfer als
`/usr/local/lib/wireguard-ops-cockpit/cockpit-backup-guard.mjs`). Drei Stellen fragen sie:

1. die Policy der API (`hostRunPolicy`): ein Treffer macht aus `pass` ein `blocked_user_approval`
   (bei einem belegten Befund kommen die Treffer dazu; eine unvollständige Prüfung bleibt
   `blocked_prerequisite`). Der Envelope trägt dann kein `gatePassed`;
2. `runHostRun` in der API vor dem Aufruf des Executors;
3. der Root-Helfer selbst (`verifyRequest`), beim Start und bei jeder Fortsetzung nach einem
   Neustart: ohne `operatorApproved` Abbruch mit Code 77, bevor irgendetwas angelegt wird.

Der Türsteher sieht die Treffer als Fokus `backup-approval:*` und soll sie trotzdem als X4
melden.

Gelesen wird jede Zeile, die läuft: alle Schritte und Prüfschritte, dazu die Skripte, die der
Lauf per Heredoc schreibt und ausführt (und `ExecStart=`-Zeilen von Units, die er schreibt).
Quotes und Backslashes zählen nicht (`b"o"rg` ist `borg`), bekannte Variablen werden eingesetzt,
Globs und `{a,b}` gegen die geschützten Pfade geprüft, relative Pfade gegen `/` (das cwd des
Helfers) und jedes `cd`-Ziel aufgelöst.

**Freigabe nötig (`backup`)** — ein Befehl berührt die Backups und ist keine freie Form:

- `borg`/`borgmatic` `delete`, `prune`, `compact`, `recreate`, `--override`, eine andere
  Konfiguration (`-c`), `check --repair`, `cockpit-borg-action repair`,
- Schreiben, Löschen, Verschieben in `/etc/borgmatic`, `/etc/borgmatic.d`, `/root/.config/borg`,
  `/root/.cache/borg`, `/root/.ssh`, den borgmatic-Units, `/usr/bin/borg*` — auch über einen
  Vorfahren bei Befehlen, die ganze Bäume treffen (`rm -rf /etc/b*`, `cd /etc && rm -rf *`,
  `docker run -v /:/host`, `git clean -fdx /etc`, `rm -rf /media` als Vorfahr des Repo-Pfads),
- jede Zeile, die den Repo-Pfad (`/media/RAID`, `backup_VServer`), Lab0 (`10.0.0.5`, `lab0`)
  oder `timers.target` nennt und nicht nur liest,
- `systemctl stop|disable|mask|edit …` an `borgmatic.timer`/`.service` (auch per Glob wie
  `*.timer`), `systemctl isolate|rescue|emergency` und `init`/`telinit` (halten alle Timer an),
  Paket entfernen, Cron-Eintrag herausfiltern (die Ausgabe eines Backup-Befehls
  fließt in einen schreibenden Befehl).

**Freigabe nötig (`uncertain`)** — der Text, der läuft, ist nicht der Text im Plan:

- `ssh`/`scp`/`sftp`/`sshfs`/`rsync` zu einem anderen Rechner (ob es Lab0 ist, sagt der Text
  nicht: `~/.ssh/config`-Aliase),
- `eval`, Dekodieren (`base64 -d`, `xxd -r`, `openssl enc -d`), `$'\x..'`, Code aus einer Pipe
  (`… | bash`), `alias`, `hash -p`, `env -S`, Namensreferenzen, `PATH`/`BASH_ENV`/`LD_PRELOAD`/
  `BORG_*`,
- ein Skript, das der Lauf nicht selbst per Heredoc schreibt (`bash /root/x.sh`, `./install.sh`),
- ein Befehlsname oder ein Ziel aus einem Wert, der nicht im Plan steht (`$CMD`,
  `rm -rf $(cat liste)`, `xargs rm`), `cd` an einen Ort, den der Plan nicht nennt,
- Inline-Code (`python -c`, `perl -e`, awk mit `system`), der Prozesse startet, Dateien anfasst
  oder Code zur Laufzeit baut.

**Frei** bleiben die Routine und das Lesen: `systemctl start borgmatic.service`, ein nacktes
`borgmatic` (konfigurierte Aufbewahrung), `borg list|info|check|create|diff`,
`borgmatic list|info|check|create`, `cockpit-borg-action status|check`,
`systemctl status|show|list-timers …`, `journalctl -u borgmatic`, Lesebefehle wie `ls`, `cat`,
`grep`, `test`, und `curl` ohne Upload an die Statusdatei auf Lab0. Werte aus `date`, `uname`,
`seq`, `mktemp` und gewöhnliche Paketpflege lösen nichts aus.

**Aufräum-Dienst auf Lab0** (`doc/setup/borg-retention.md`): frei ist seine Routine —
`/usr/local/sbin/cockpit-borg-retention status|run`, `set <d> <w> <m> <HH:MM>` innerhalb der festen
Grenzen (`deploy/helpers/cockpit-borg-retention-rules.mjs`, dieselbe Datei wie in API und Helfer)
und `systemctl start cockpit-borg-retention.service`. Freigabe braucht: `set` unter der Untergrenze
oder mit `--freigabe`, `freigeben` (Fortsetzen nach einer Anomalie), jede andere Form des Helfers,
`systemctl stop|disable|mask|edit` an seinem Timer oder seiner Unit, und jedes Schreiben in
`/etc/cockpit-borg-retention`, `/var/lib/cockpit-borg-retention`, seine Units samt `.d`-Verzeichnissen,
die Drop-ins, die systemd ohne „borg“ im Namen auf sie anwendet (`cockpit-.service.d`,
`cockpit-.timer.d`, `service.d`, `timer.d` in `/etc`, `/run`, `/usr/lib/systemd/system`), und seinen Code. Der Riegel heißt seitdem `cockpit-backup-guard/v2`.

Ehrliche Grenze: Programme, die schon auf dem Host liegen und über ihren Namen oder aus den
System-Verzeichnissen (`/usr`, `/opt/gitlab`) aufgerufen werden, nimmt der Riegel für das, was ihr
Name sagt; ihren Inhalt sieht er nicht. Ein Interpreter-Programm ohne die genannten Primitive
wird nicht weiter zerlegt. Dort bleibt der Türsteher (X4) die Sicherung. Der Riegel irrt lieber
zur Freigabe hin: im Zweifel fragt er Jochen.

Tests: `apps/api/test/backup-guard.test.ts` (Korpus frei/gesperrt, Policy),
`host-run-helper.test.ts` (Helfer beim Start und nach dem Neustart), `host-run-flow.test.ts`
(API: `pass` plus `borg delete` wartet auf Jochen, läuft nach der Freigabe).

## 3. Tür

`deploy/helpers/cockpit-host-run` (installiert als
`/usr/local/lib/wireguard-ops-cockpit/cockpit-host-run.mjs`, gepinnte Node 20):

- eigene transiente Unit `cockpit-host-run-<job>` (`systemd-run --collect`, ohne Warten):
  außerhalb der Executor-Sandbox, übersteht einen Neustart des Executors,
  `RuntimeMaxSec` aus den Zeitlimits der Schritte plus Reserve,
- jeder Schritt: `bash -eo pipefail -c <run>` als root, `DEBIAN_FRONTEND=noninteractive`,
  eigenes Zeitlimit (Standard 1800 s, höchstens 10 800 s; wer es reißt, ist gescheitert, auch mit
  Exit 0), der erste Fehler beendet den Lauf,
- danach die Prüfschritte (Pflicht, jeder muss scheitern können),
- volle Ausgabe in `/var/lib/wireguard-ops-cockpit/host-runs/<job>/output.log` (0600) und ins
  Journal der Unit, ohne Steuerzeichen, **zeilenweise geschwärzt**: Token-Muster, `password=`/`token=`/`secret=`-
  Zuweisungen, Authorization-Kopfzeilen, private Schlüsselblöcke und die wörtlichen Werte aus
  `api.env`, `executor.env` und `contabo.env`,
- ein Lauf zur Zeit (Prüfen, Anlegen und Unit-Start unter einer atomaren Sperre).

`status <job>` liefert Zustand und Protokollende. Endet eine Unit ohne Ergebnis (Zeitlimit,
Absturz), meldet `status` den Lauf als gescheitert.

## 4. Netz darunter

Welches Netz unter der Tür liegt, stellt jede Kiste in einer root-eigenen Datei ein:
`/etc/wireguard-ops-cockpit/host-run-net.json` (root, 0644). Umgebungsvariablen gibt es dafür
nicht: sudo setzt sie zurück, und die Lauf-Unit bekommt nur `COCKPIT_HOST_RUN_IN_UNIT`. Form
und Grenzen prüft `deploy/helpers/cockpit-host-run-net.mjs` (installiert neben dem Helfer); die
Datei nennt nur Werte, nie Befehle. Der Helfer liest sie vor jedem Lauf mit `mutates: true`
(Standard; nur ein ausdrücklich lesender Plan setzt `false`, und das prüft der Türsteher) und
noch einmal unmittelbar vor jedem Neustart-Schritt:

- **Datei fehlt:** Netz des VPS (`hoster-snapshot`), wie vor dieser Einstellung.
- **Datei gehört nicht root, ist für Gruppe oder andere schreibbar, kein reguläres File, oder
  ihr Inhalt ist ungültig** (unbekanntes Feld, Wert außerhalb der Grenzen): kein verändernder
  Lauf (`preflight_failed`); lesende Läufe gehen weiter.

Die API liest dieselbe Datei beim Start, nur um dem Türsteher, dem Planer und Jochen ehrlich zu
sagen, was darunter liegt (Prompt, Planer-Vertrag, Begründung der Entscheidung, Ergebnis) und um
ihre Frist um die Dauer der Systemsicherung zu verlängern. Sie entscheidet damit nichts; nach
einer Änderung der Datei die API neu starten. Die Datei muss deshalb für die API (`wgops`)
lesbar sein (0644 in einem Verzeichnis mit 0755); kann sie sie nicht lesen, sagt sie das im
Prompt und rechnet mit der längsten erlaubten Sicherung (6 h).

Beispiele: `deploy/config/host-run-net.vps.json` und `deploy/config/host-run-net.lab0.json`.

### VPS: `hoster-snapshot`

1. `cockpit-borg-action status`: das letzte borg-Backup muss erfolgreich und jünger als 24 h
   sein. `last_run_end` ist die jüngste „Finished borgmatic…“-Zeile, die systemd nur beim
   erfolgreichen Ende der oneshot-Unit schreibt; `last_run_result` muss zusätzlich `success`
   sein, damit auch ein späterer gescheiterter Lauf stoppt.
2. `cockpit-vps-snapshot create cockpit-run-<job> --wait 900`: Maschinen-Snapshot beim Hoster;
   ist das Kontingent voll, rotiert das Werkzeug den ältesten cockpit-eigenen Snapshot.

### Lab0: `system-backup`

Lab0 ist eine physische Kiste: kein Hoster, kein Snapshot, keine Konsole aus der Ferne. Die
Root-Platte ist LVM (`ubuntu-vg`, 465 GB, 0 GB frei), das RAID unter `/media/RAID` hält die
VPS-Backups (02.10.2026: 5,5 T, 4,7 T belegt, 777 G frei, 87 %).

**Entscheidung Jochen (02.10.2026):** Das Netz ist eine Systemsicherung aufs RAID mit **borg**
(Platz ist knapp, viele Versionen kommen dazu: borg dedupliziert und komprimiert).
Zurückgeholt wird im Notfall **vor Ort mit einem Rescue-System**. LVM-Umbau und eine Extra-SSD
entfallen als zu aufwändig.

Vor jedem verändernden Lauf, in dieser Reihenfolge (fehlt etwas, läuft kein Schritt,
`preflight_failed`):

1. **RAID gesund:** `/proc/mdstat` nennt das Array (`raidDevice`; auf Lab0 das IMSM-Volume
   `md126` im Container `md127`) `active`, und alle Glieder sind da (`[4/4] [UUUU]`; ein `_`
   oder `[4/3]` stoppt).
2. **Sicherungsplatte eingehängt:** `mount` steht in `/proc/self/mountinfo` und liegt auf einem
   anderen Gerät als `/`. Ohne diese Prüfung schriebe eine Sicherung bei nicht eingehängtem RAID
   die Root-Platte voll.
3. **Quellen vorhanden** (`sources`, Vorschlag `/`, `/boot`, `/boot/efi`).
4. **Standalone-borg da:** `/usr/local/lib/wireguard-ops-cockpit/borg-standalone` ist eine
   reguläre Datei, gehört root, ist für Gruppe und andere nicht schreibbar und meldet sich mit
   `--version` als `borg 1.4.x` (die Standalone-Binary schreibt `borg.exe 1.4.x`). Mit genau
   dieser Binary sichert der Helfer, und eine Kopie legt er neben das Repo. Dazu die Vorlage der
   Notfall-Anleitung neben dem Helfer (`cockpit-systemsicherung-NOTFALL.txt`).
5. **Sicherungsordner gehört der Tür:** `target` fehlt, ist leer, oder ist ein Verzeichnis, das
   root gehört und das Kennzeichen `.cockpit-systemsicherung` trägt. Einen fremden, nicht leeren
   Ordner (etwa `backup_VServer` oder Claudes Sicherung vom 02.10.) übernimmt der Helfer **nie**.
6. **Aufräum-Dienst ohne Anomalie** (`retentionService: true`): `cockpit-borg-retention status`
   darf weder `angehalten` noch eine Anomalie melden. Eine Anomalie heißt: jemand hat
   VPS-Backups auf dem RAID gelöscht; dann entscheidet Jochen zuerst
   (`doc/setup/borg-retention.md`), bevor an der Kiste gebaut wird.
7. **Platz:** frei auf der Sicherungsplatte muss mindestens sein, was die Quellen belegen
   (ungünstiger Fall: eine volle erste Sicherung ohne Kompression und Deduplizierung; die
   Ausschlüsse sind darin nicht abgezogen), plus `reserveGB`, die danach frei bleiben — damit eine
   Systemsicherung nie die VPS-Backups verdrängt.

Dann die Sicherung:

8. **Ordner und Repo:** `target` wird root-eigen mit **0700** angelegt bzw. auf 0700 gesetzt (die
   Sicherung enthält `/etc` und SSH-Schlüssel). Das Repo ist `<target>/repo`, beim ersten Mal
   `borg init --encryption=none` — **unverschlüsselt**, damit das Rescue-System keine Passphrase
   braucht. Ein eigenes Repo je Kiste; die VPS-Backups liegen in einem anderen.
9. **Notfall-Bausatz neben dem Repo**, bei jeder Sicherung erneuert: `<target>/borg` (Kopie der
   Standalone-Binary, 0700), `<target>/NOTFALL.txt` (Vorlage
   `deploy/lab0/cockpit-systemsicherung-NOTFALL.txt` mit den Pfaden dieser Kiste: Rescue-Stick
   booten, IMSM-RAID mit `mdadm --assemble --scan` einbinden, Root formatieren — mit der alten
   UUID — und einhängen, `borg extract`, fstab und Bootloader prüfen bzw. `grub-install`) und
   `<target>/PLATTEN.txt` (`lsblk` mit UUIDs und `/proc/mdstat` zum Zeitpunkt der Sicherung).
10. **Archiv:** `borg create --one-file-system --numeric-ids --exclude-caches --compression
    zstd,3` der Quellen nach `<target>/repo::vorlauf-<Zeit>-<job>`, `--lock-wait 600`, Zeitlimit
    `timeoutSeconds` (danach SIGTERM, damit borg seine Sperre freigibt, eine Minute später
    SIGKILL). `-x` hält das RAID, `/proc`, `/sys`, `/run` draußen. Ausschlüsse (`exclude`,
    borg-Muster; Vorschlag nach der Entscheidung): `/swap.img`, `/tmp/*`, `/var/tmp/*`,
    `/var/cache/*`, `/root/.cache/*`, `/home/*/.cache/*`, der Nextcloud-Sync-Ordner
    `/home/jochen/Nextcloud`, `/opt/android-workbench` (Android-SDK und Emulator-Abbilder) und
    die Docker-Abbilder (`/var/lib/docker/overlay2`, `image`, `buildkit`, dazu der Abbild-Speicher
    von containerd). **Docker-Volumes (`/var/lib/docker/volumes`) bleiben drin.** borg-Ende 0 oder
    1 (Warnung, etwa eine Datei änderte sich beim Lesen) gilt als Erfolg, ab 2 als Fehler.
11. **Aufbewahrung, streng begrenzt:** `borg prune --glob-archives 'vorlauf-*'
    --keep-last=<keepPreRun>` und danach `borg compact` — nur in `<target>/repo`, nur die
    eigene Reihe. Die Wochen-Reihe `woche-*` und jedes andere Archiv bleiben unberührt; `borg
    delete` ruft der Helfer nie auf. Scheitert prune oder compact, ist das neue Archiv trotzdem
    vollständig: der Lauf geht weiter, Protokoll und Laufzustand (`upkeepError`) sagen es.

Die Grenzen stehen in der root-eigenen Datei, nicht im Code: `keepPreRun` (Vorgabe 5, erlaubt
1–20) und `keepWeekly` (Vorgabe 4, erlaubt 1–12). Ändern wie beim Aufräum-Dienst: innerhalb der
Grenzen frei, die Form prüft der Helfer vor jeder Sicherung (ein Wert außerhalb oder ein
unbekanntes Feld — auch das alte `keep` — stoppt jeden verändernden Lauf).

Die Sicherung läuft einmal je Lauf, nicht nach einem Neustart. `systemBackup.path` im
Laufzustand ist `<repo>::<archiv>`; es steht im Protokoll und im Ergebnis, und scheitert später
ein Schritt, nennt das Protokoll das Archiv als Rückweg. Zurückgeholt wird nur mit Jochens
Freigabe und **vor Ort** nach `NOTFALL.txt`.

#### Wöchentlich per Timer

Damit es überhaupt eine Systemsicherung gibt, auch wenn lange kein verändernder Lauf kommt:
`cockpit-systemsicherung.timer` (sonntags 03:30, `Persistent=true`) startet
`cockpit-systemsicherung.service`, und der ruft `cockpit-host-run.mjs weekly-backup` auf (nur in
dieser Unit, `COCKPIT_SYSTEM_BACKUP_IN_UNIT=1`; sudoers erlaubt das Verb nicht). Dieselben
Prüfungen 1–7, dasselbe Repo, eigene Reihe `woche-<Zeit>` mit eigener Aufbewahrung
(`keepWeekly`). Läuft gerade ein Host-Lauf (auch einer, der auf seinen Neustart wartet), sichert
der Timer nicht (Ende 75); bei einer anderen Kiste als `system-backup` endet er mit 78, bei
einer gescheiterten Prüfung oder Sicherung mit 70, bei gescheitertem prune/compact mit 1 — jedes
Mal steht die Unit auf `failed`, sichtbar in `systemctl --failed`. Units:
`deploy/systemd/cockpit-systemsicherung.service` und `.timer`.

**Gleichzeitig:** Die Wochen-Sicherung prüft unter der Start-Sperre der Tür, dass kein Lauf
aktiv ist; solange ihre Unit aktiv ist, startet kein Host-Lauf (`start` endet mit 75, „the
weekly system backup is running“ — den Lauf später neu bestellen). Dazu sperrt borg das Repo
(`--lock-wait 600`).

**Ehrliche Grenze:** Der Helfer prüft den Sicherungsordner (root, kein Symlink, unter `mount`,
Kennzeichen) und vor jedem weiteren Schreiben und vor prune noch einmal, dass es derselbe Ordner
ist (Gerät und Inode). Ein Tausch genau zwischen zwei Prüfungen bleibt möglich, wenn ein
Nicht-root-Nutzer in `mount` schreiben darf; dann landen höchstens die Notfall-Dateien oder ein
neues Repo im fremden Ordner. Fremde Archive prunt er auch dann nicht: prune nennt nur die
eigenen Präfixe, und das VPS-Repo ist verschlüsselt (ohne Passphrase bricht borg ab). Vor dem
Ausrollen `ls -ld /media/RAID` ansehen.

**Abwägung (so entschieden):**

| | borg-Archiv aufs RAID (gewählt) | rsync-Kopie aufs RAID | LVM-Snapshot (Umbau) |
| --- | --- | --- | --- |
| Platz | dedupliziert und komprimiert; viele Versionen kosten wenig | jede Version kostet geänderte Dateien ganz | in `ubuntu-vg` ist kein Platz |
| Liegt auf | anderer Platte (RAID) | anderer Platte (RAID) | derselben Platte |
| Konsistenz | Dateien eines laufenden Systems; Datenbanken nicht absturzsicher | ebenso | Zeitpunkt-genau |
| Zurück | Rescue-System vor Ort, `borg extract` mit der Binary neben dem Repo | Rescue-System, rsync zurück | `lvconvert --merge` — nach einem kaputten Upgrade auch nur vor Ort |
| Umbau | keiner | keiner | Root-LV offline verkleinern |

### Neustart: wer hilft, wenn die Kiste nicht hochkommt

`reboot` (beide Netze, optional):

- `mustBeEnabled`: Gruppen von Units, von denen je mindestens eine `enabled` sein muss
  (`systemctl is-enabled`), Vorschlag für Lab0 `[["wg-quick@wg0.service"], ["ssh.service",
  "ssh.socket"]]` (Ubuntu startet SSH seit 22.10 oft über `ssh.socket`). Geprüft wird vor dem
  Lauf, wenn der Plan einen Neustart enthält (`preflight_failed`, kein Schritt läuft), und
  **noch einmal unmittelbar vor jedem Neustart-Schritt**: ein Release-Upgrade kann eine Unit
  ersetzen oder abschalten. Fehlt dann eine, startet die Tür nicht neu, der Lauf endet als
  `failed` und nennt die Systemsicherung als Rückweg.
- `onSite: true`: Die Tür sagt es deutlich — im Prompt des Türstehers, im Planer-Vertrag, in der
  Begründung der Entscheidung, die Jochen sieht („The plan reboots a physical host: if it does
  not come back, only someone on site can help.“), und im Protokoll vor dem Neustart.

Ehrlich: `enabled` heißt nur, dass systemd die Unit beim Hochfahren startet. Ob sie dann läuft
(Konfiguration kaputt, Kernel bootet nicht, Platte fehlt), prüft die Tür vorher nicht. Kommt
Lab0 nicht hoch, meldet die Tür den Lauf nach ihrer Frist als gescheitert — helfen kann nur
jemand an der Kiste.

### Allgemein

Scheitert eine Prüfung des Netzes, läuft kein Schritt (`preflight_failed`). Scheitert später ein
Schritt oder eine Prüfung, nennt das Protokoll den Rückweg (Snapshot-Kennung oder borg-Archiv
der Systemsicherung); zurückgespielt wird nur mit Jochens Freigabe (ein Revert nimmt alles seit dem
Snapshot bzw. der Sicherung mit).

Der Plan braucht Prüfschritte und einen Rückweg (`rollback`, Pflichtfeld). Ein Neustart ist ein
gewöhnlicher Schritt (`{"name":"reboot","reboot":true}`, höchstens drei): der Lauf schreibt
vorher, wo er weitermacht, `wireguard-ops-cockpit-host-run-resume.service` startet die
Fortsetzung beim Hochfahren (Phase `resuming`, nach erneuter Prüfung des Schlosses, ohne zweiten
Snapshot und ohne zweite Sicherung; `status` hält eine Fortsetzung zwei Minuten lang nicht für
gescheitert, solange ihre Unit noch startet), und die
API — die mit dem Host neu gestartet ist — nimmt den Job aus seinem Datensatz wieder auf, folgt
dem Lauf über `host.status` und meldet danach das Ergebnis samt Verifikation.

### Ausrollen auf Lab0

Lab0 rollt über sein eigenes Deploy-Skript aus (`homeserver-cockpit-deploy.sh` unter
`/root/cockpit-deploy`, liegt nicht in diesem Repo; siehe `doc/setup/borg-retention.md`). Dazu
gehören diese Zeilen in Schritt 8 — **ohne das Modul startet der Helfer gar nicht mehr**, auch
nicht für lesende Läufe; ohne die Vorlage der Notfall-Anleitung stoppt jeder verändernde Lauf:

```bash
install -m 644 -o root -g root "$COCKPIT_DIR/deploy/helpers/cockpit-host-run-net.mjs" /usr/local/lib/wireguard-ops-cockpit/cockpit-host-run-net.mjs
install -m 644 -o root -g root "$COCKPIT_DIR/deploy/lab0/cockpit-systemsicherung-NOTFALL.txt" /usr/local/lib/wireguard-ops-cockpit/cockpit-systemsicherung-NOTFALL.txt
install -m 644 -o root -g root "$COCKPIT_DIR/deploy/systemd/cockpit-systemsicherung.service" /etc/systemd/system/cockpit-systemsicherung.service
install -m 644 -o root -g root "$COCKPIT_DIR/deploy/systemd/cockpit-systemsicherung.timer" /etc/systemd/system/cockpit-systemsicherung.timer
systemctl daemon-reload
systemctl enable --now cockpit-systemsicherung.timer
```

Die Einstellungsdatei installiert das Skript **nur, wenn sie fehlt** — sonst überschriebe jedes
Deploy die von Hand angepassten Werte (`keepPreRun`, `keepWeekly`, Ausschlüsse):

```bash
[ -e /etc/wireguard-ops-cockpit/host-run-net.json ] || install -m 644 -o root -g root "$COCKPIT_DIR/deploy/config/host-run-net.lab0.json" /etc/wireguard-ops-cockpit/host-run-net.json
```

**Standalone-borg einmal von Hand** (nicht im Repo, kein Download im Deploy): die Version wie
`borg --version` auf Lab0 (1.4.x) aus den Releases von borgbackup
(`https://github.com/borgbackup/borg/releases`, Datei `borg-linux-glibc231-x86_64` samt
`borg-linux-glibc231-x86_64.asc`; glibc 2.31 läuft auch auf älteren Rescue-Systemen), Signatur
mit `gpg --verify` gegen den Release-Schlüssel von borgbackup prüfen, dann:

```bash
install -m 755 -o root -g root borg-linux-glibc231-x86_64 /usr/local/lib/wireguard-ops-cockpit/borg-standalone
/usr/local/lib/wireguard-ops-cockpit/borg-standalone --version   # borg.exe 1.4.x
```

Vor dem ersten Lauf auf Lab0 von Hand prüfen und die Datei anpassen (diese Werte hat die Karte
nicht auf Lab0 verifiziert): `cat /proc/mdstat` (Name des Volumes; Lab0-Status vom 02.10.2026
18:05 zeigt `md126 : active raid10 … [4/4] [UUUU]` — IMSM-Nummern können sich nach einem
Neustart ändern, dann stoppt die Tür mit „RAID … is not in /proc/mdstat“),
`findmnt /media/RAID`, `findmnt /boot /boot/efi` (gibt es beide?), `ls /swap.img`,
`systemctl is-enabled wg-quick@wg0.service ssh.service ssh.socket` (Name der WireGuard-Unit),
`ls -d /opt/android-workbench /var/lib/docker/overlay2 /var/lib/containerd` (wo die Abbilder
wirklich liegen), `df -h / /media/RAID`, `ls -ld /media/RAID/lab0-systemsicherung` (muss fehlen
oder leer sein).

**Erste Sicherung und Messung:** Die erste Sicherung ist voll und kann Stunden dauern
(`timeoutSeconds`, Vorschlag 4 h). Sie lässt sich ohne Host-Lauf anstoßen:
`systemctl start cockpit-systemsicherung.service` (läuft im Vordergrund bis zum Ende;
`journalctl -u cockpit-systemsicherung.service` zeigt die borg-Statistik). Die Größe danach:
`BORG_UNKNOWN_UNENCRYPTED_REPO_ACCESS_IS_OK=yes /usr/local/lib/wireguard-ops-cockpit/borg-standalone
info /media/RAID/lab0-systemsicherung/repo` (Original, komprimiert, dedupliziert) und
`du -sh /media/RAID/lab0-systemsicherung`. Erst danach das Release-Upgrade bestellen.

Die Sicherung von Claude vom 02.10. (`/media/RAID/lab0-systemsicherung-20261002`, /etc und
Paketliste) liegt außerhalb von `target` und bleibt unberührt.

Der VPS braucht keine Datei und keinen Timer; `deploy/vps/vps-cockpit-deploy.sh` installiert nur
das Modul.

## 5. Sondertüren

Die vorhandenen Sondertüren (Capability-Sandkasten mit WordPress-, Nextcloud-, DinD-,
exact-file- und Snapshot-Helfern, typisierte Platten-, borg- und Update-Wege) bleiben unverändert.
Neue entstehen keine: Paket-Updates, Docker, Kernel mit Neustart und GitLab in Stufen sind
gewöhnliche Runbooks durch diese Tür. Der Planer-Vertrag (`hostRunPlannerContract`) macht die
Tür zum Standard für Host-Arbeit; ein Capability-Manifest nimmt er nur, wenn ein typisierter
Helfer die Aufgabe genau abdeckt. Ein Plan mit beiden Manifesten wird abgelehnt.

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
  (0600), aber sein Ende (bis 30 000 Zeichen) steht im Job-Ergebnis, und das kann der Besteller
  über `GET /api/hermes/jobs/:jobId` lesen — also genau der Agent, der manipuliert sein könnte.
  Eine Ausgabe ist damit auch ein Weg nach draußen; der Reviewer-Prompt behandelt das Lesen und
  Ausgeben von Geheimnissen deshalb als Befund, egal wohin die Ausgabe geht.
- Ein privater Schlüsselblock ohne END-Zeile wird höchstens 200 Zeilen lang geschwärzt, damit er
  nicht den Rest des Protokolls verschluckt.
- `mutates: false` spart das ganze Netz (Snapshot und Backup-Prüfung bzw. Systemsicherung). Stimmt die Behauptung nicht, ist das ein
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

## Tests

- `apps/api/test/host-run-helper.test.ts`: der echte Helfer mit Stubs für systemd-run,
  systemctl, borg und Snapshot — Schloss (Signatur, Ablauf, Drift, Capability), Netz (borg zu
  alt/gescheitert, Snapshot scheitert, lesender Lauf), Tür (Fehler, Zeitlimit, Prüfschritte,
  Schwärzung, Neustart mit Fortsetzung, ein Lauf zur Zeit).
- `apps/api/test/host-run-helper.test.ts`, Block „net of a physical box“: Lab0-Netz mit Stubs
  für borg (führt Archivnamen je Repo und prunt nach `--glob-archives`/`--keep-last` wie borg),
  lsblk, `/proc/mdstat`, mountinfo und den Aufräum-Dienst — borg-Archiv statt borg-Status und
  Snapshot mit genau diesen borg-Aufrufen (`init --encryption=none`, `create` mit `-x` und den
  Ausschlüssen, `prune` nur der eigenen Reihe, `compact`), Ordner 0700 mit Binary, NOTFALL.txt
  und PLATTEN.txt; Rotation: nur die eigene Reihe, fremde Archive (`vmd61162-…`) und die andere
  Reihe bleiben; Wochen-Sicherung über `weekly-backup` mit eigener Reihe und Aufbewahrung, nicht
  außerhalb ihrer Unit, nicht auf dem VPS-Netz, nicht während eines Host-Laufs; die
  mitgelieferten Timer-Units; Stopp bei degradiertem RAID, nicht eingehängter Platte, Platte auf
  `/`, angehaltenem Dienst, zu wenig Platz, fehlender Quelle, fehlender/falscher/fremd
  schreibbarer borg-Binary, fehlender Notfall-Vorlage, fremdem Zielordner, altem `keep`,
  ungültiger oder fremd schreibbarer Datei, borg-Fehler; borg-Warnung (1) gilt, gescheitertes
  prune lässt den Lauf weiter; Neustart mit Hinweis „vor Ort“, kein Start ohne WireGuard, kein
  Neustart, wenn ein Schritt SSH abschaltet.
- `apps/api/test/host-run-net.test.ts`: Form und Grenzen der Einstellung, die mitgelieferten
  Dateien, was Türsteher, Planer und Jochen auf Lab0 lesen.
- `apps/api/test/host-run.test.ts`: Manifest, Fokus (der `/etc/apt`-Fall stoppt nicht mehr),
  Prompt, Belegprüfung, Entscheidung, Ergebnis.
- `apps/api/test/host-run-flow.test.ts`: der Weg durch die API mit Brokern als Fakes — `pass`
  startet trotz `*.save`-Pfad und borg-Repair-Zeile (kein Regel-Stopp), ein belegter Befund geht
  an Jochen (`gatePassed` fehlt) und nach der Freigabe läuft genau dieser Plan (`operatorApproved`,
  gleicher Hash), ein Befund ohne Beleg stoppt ohne Freigabe-Angebot, zwei Manifeste werden
  abgelehnt.
- `apps/api/test/host-run-resume.test.ts`: API-Neustart während eines Laufs (Broker als Fakes),
  auch wenn die API zwischen Start und Startmarke starb (`hostRunRequestedAt`).
- `apps/executor-broker/test/index.test.mjs`: `host.run`/`host.status`.
- `test/vps-cockpit-deploy.test.sh`: Helfer und Resume-Unit in der Deploy-Tabelle, Unit aktiviert
  (der VPS bekommt den Wochen-Timer der Systemsicherung nicht).
