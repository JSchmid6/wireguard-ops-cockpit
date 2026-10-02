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
        ──► Unit: borg jünger als 24 h? Snapshot beim Hoster. Schritte. Prüfschritte.
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

Vor jedem Lauf mit `mutates: true` (Standard; nur ein ausdrücklich lesender Plan setzt `false`,
und das prüft der Türsteher):

1. `cockpit-borg-action status`: das letzte borg-Backup muss erfolgreich und jünger als 24 h
   sein. `last_run_end` ist die jüngste „Finished borgmatic…“-Zeile, die systemd nur beim
   erfolgreichen Ende der oneshot-Unit schreibt; `last_run_result` muss zusätzlich `success`
   sein, damit auch ein späterer gescheiterter Lauf stoppt.
2. `cockpit-vps-snapshot create cockpit-run-<job> --wait 900`: Maschinen-Snapshot beim Hoster;
   ist das Kontingent voll, rotiert das Werkzeug den ältesten cockpit-eigenen Snapshot.

Scheitert eines davon, läuft kein Schritt (`preflight_failed`). Scheitert später ein Schritt oder
eine Prüfung, nennt das Protokoll die Snapshot-Kennung; zurückgespielt wird er nur mit Jochens
Freigabe (ein Revert nimmt alles seit dem Snapshot mit).

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
- `mutates: false` spart Snapshot und Backup-Prüfung. Stimmt die Behauptung nicht, ist das ein
  X5-Befund des Türstehers — einen deterministischen Riegel dafür gibt es bewusst nicht.
- Kommt ein angeforderter Neustart nicht (gleiche Boot-Kennung 30 Minuten nach der Anforderung),
  gilt der Lauf als gescheitert, und die Tür ist wieder frei. Kommt der Host gar nicht zurück,
  gibt die API nach ihrer Frist (Zeitbudget plus eine Stunde je Neustart) auf.

## Tests

- `apps/api/test/host-run-helper.test.ts`: der echte Helfer mit Stubs für systemd-run,
  systemctl, borg und Snapshot — Schloss (Signatur, Ablauf, Drift, Capability), Netz (borg zu
  alt/gescheitert, Snapshot scheitert, lesender Lauf), Tür (Fehler, Zeitlimit, Prüfschritte,
  Schwärzung, Neustart mit Fortsetzung, ein Lauf zur Zeit).
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
- `test/vps-cockpit-deploy.test.sh`: Helfer und Resume-Unit in der Deploy-Tabelle, Unit aktiviert.
