# Autonomie durch garantierten Rückbau

Entwurf, 18.08.2026. Betrifft `cockpit-capability-action.mjs`,
`capability-manifest.ts`, `evaluatePlanPolicy`.

## Das Problem

Der Agent darf heute Manifeste mit freien `argv` schreiben — das ist echte
Autonomie. Sie endet aber an der Schreibgrenze: `writablePaths` muss eine
existierende reguläre Datei unter 10 MB sein. Alles andere — ein
Verzeichnisbaum, eine Datenbank, ein Docker-Volume — braucht eine
Operator-Freigabe.

Die Folge, gemessen am WordPress-Update vom 18.08.: Safety-Urteil `passed`,
Risikozone `green`, trotzdem blockiert, weil das Manifest selbst `data_loss`
deklarierte. Für jede Routineänderung ein Klick — und damit ist „der Agent
administriert den Host, ohne dass ich ständig klicken muss" stillschweigend
nicht mehr wahr.

Der naheliegende Ausweg ist ein geprüfter Helfer je Klasse. Genau so ist
`cockpit-wordpress-update` entstanden, und er funktioniert. Aber die dritte,
vierte, fünfte Klasse ergibt einen Flickenteppich: der Rückbau steckt jedes
Mal woanders, jedes Skript muss einzeln geprüft werden, und in zwei Jahren
weiß niemand mehr, welches davon seine Zusage wirklich einhält.

## Die Bedingung, die Autonomie trägt

Was den WordPress-Helfer autonomiefähig machte, war nicht das Skript, sondern
eine erfüllte Bedingung:

> **Vor dem Eingriff existiert ein verifizierter Zustand, der ohne weitere
> Entscheidung vollständig zurückgespielt werden kann.**

Ist sie erfüllt, ist der schlimmste Ausgang „es war umsonst", nicht „es ist
kaputt". Ist sie nicht erfüllt, hilft keine Freigabe-Ergonomie: dann *muss*
ein Mensch hinsehen.

Das Cockpit erfüllt bereits die schwierigere Hälfte dieser Bedingung, und
zwar erzwungen statt zugesichert:

```
--property=TemporaryFileSystem=/:ro
--property=BindPaths=<jeder writablePath>
```

Ein Schritt kann **nur** schreiben, was ausdrücklich schreibbar eingehängt
wurde. Das ist keine Regel, an die sich der Agent halten soll — das ist ein
Dateisystem, in dem alles andere nur-lesbar ist. Der Rückbau muss also genau
die deklarierten Pfade abdecken, sonst nichts.

Die heutige Beschränkung auf Einzeldateien ist deshalb kein Sicherheitsentwurf.
Sie ist die Grenze von `copyFileSync`.

## Vorschlag: Snapshot-Anbieter

Das Manifest deklariert, **was** gesichert werden muss; der Executor weiß,
**wie**.

```jsonc
{
  "version": "cockpit-capability/v2",
  "name": "wordpress-update",
  "scopes": [
    { "kind": "tree",  "path": "/var/www/html",   "maxBytes": 2000000000 },
    { "kind": "mysql", "database": "wordpress" }
  ],
  "steps": [ /* freie argv wie bisher */ ],
  "verify": { "argv": ["/usr/local/bin/wp", "--path=/var/www/html", "core", "verify-checksums"] }
}
```

Anbieter, jeder mit *sichern → prüfen → zurückspielen*:

| `kind`   | sichert | prüft | spielt zurück |
|---|---|---|---|
| `file`   | `copyFileSync` (heute) | SHA256 | Datei überschreiben |
| `tree`   | `tar -czf` | `tar -tzf` + SHA256 | in Zwischenverzeichnis entpacken, dann tauschen |
| `mysql`  | `mysqldump --add-drop-table` | nicht leer, `-- Dump completed` | `mysql <` |
| `volume` | `docker run --rm -v vol:/v -v snap:/s tar` | `tar -tzf` | Volume leeren, entpacken |

`tree` und `volume` brauchen eine Größenobergrenze und eine Prüfung des freien
Platzes **vor** dem Sichern — ein Snapshot, der mitten im `tar` am vollen
Dateisystem scheitert, ist schlimmer als keiner.

## Die Umkehrung: `contained` wird abgeleitet, nicht behauptet

Heute deklariert der Planer sein Risiko, und `capabilityNeedsOperatorApproval`
glaubt ihm. Das ist die schwächste Stelle des Entwurfs: Ein gekaperter Planer
schreibt `contained` genauso leicht wie ein ehrlicher.

Künftig berechnet der Executor es:

```
autonom  ⟺  jeder writablePath ist von genau einem Scope abgedeckt
        ∧  jeder Scope hat einen Anbieter, der sichern UND zurückspielen kann
        ∧  jeder Snapshot wurde nach dem Anlegen verifiziert
        ∧  kein Schritt ist in stepNeedsApproval
        ∧  network ≠ host
```

Fällt eine Bedingung, ist es eine Operator-Freigabe — nicht weil jemand
`data_loss` geschrieben hat, sondern weil der Rückbau nicht garantiert werden
kann. Das Manifest darf sein Risiko weiterhin deklarieren; es zählt dann als
*zusätzliche* Beschränkung, nie als Erlaubnis.

Damit verschwindet auch die Umgehungsmöglichkeit: Ein Manifest, das
`contained` behauptet, ohne Scopes zu deklarieren, bekommt keine Autonomie,
sondern eine Freigabepflicht.

## Ablauf

```
1  Scopes prüfen      Pfade auflösen, Größe, freier Platz, keine
                      verbotenen Wurzeln, keine Überschneidung
2  Snapshot           je Anbieter sichern
3  Snapshot prüfen    lesbar, nicht leer, Prüfsummen  ← hier abbrechen ist billig
4  Falle scharf       erst jetzt; vorher gibt es kein Rückspielziel
5  Schritte           im Sandkasten, wie bisher
6  Verifizieren       manifest.verify; fehlt es, gilt Exit-Code 0
7a Erfolg             Snapshot behalten (Aufbewahrung, s.u.), Ergebnis melden
7b Fehlschlag         zurückspielen, erneut verifizieren, als
                      "rolled_back" melden — nicht als Erfolg
7c Rückbau scheitert  lautester möglicher Fehler, Snapshot-Pfad in die
                      Meldung, Job als "needs_operator" markieren
```

Schritt 7c ist der Fall, den man nicht wegprogrammieren kann. Er muss
unübersehbar sein.

## Was draußen bleibt — und warum das die Regel ist, keine Ausnahme

**Paketverwaltung.** `apt upgrade` erfüllt die Bedingung nicht: `postinst`-
Skripte migrieren Konfigurationen, starten Dienste neu, ändern Schemata. Ein
Downgrade von `libc6` ist kein Rückbau, sondern ein zweiter Eingriff. Es gibt
keinen ehrlichen `pkg`-Anbieter, also keine Autonomie — nach derselben Regel,
die WordPress autonom macht. Das ist kein Sonderfall im Flickenteppich,
sondern die Regel, die korrekt greift.

Dasselbe gilt für Identität (`useradd`, `visudo`), Netzwerk (`iptables`, `wg`)
und alles, was den Sandkasten verlässt. Die harte Grenzliste in
`evaluatePlanPolicy` bleibt genau dafür — sie ist die Verfassungsschicht unter
allem, und ein Regex lässt sich nicht überreden.

**Nextclouds vorhandene Rollback-Bausteine** (`nextcloud-rollback-restore.sh`
prüft Archiveinträge gegen eine Positivliste) werden zu Anbietern, statt ein
weiteres Skript zu bleiben.

## Aufbewahrung

Snapshots sind Sicherungen. Sie brauchen dieselbe Disziplin wie das
Mail-Archiv: Aufbewahrungsfrist, Platzprüfung vorher, und eine Obergrenze pro
Job. Vorschlag: die letzten N je Capability-Namen, dazu eine Altersgrenze,
aufgeräumt im selben Lauf. Ohne das füllt der Mechanismus, der Sicherheit
schaffen soll, die Platte — was auf diesem Host schon einmal passiert ist.

## Der Snapshot unter dem Dateisystem: Contabo

Die Wurzel liegt auf blankem ext4 (`/dev/sda2`), ohne LVM, btrfs oder ZFS —
lokal gibt es keine Schicht, die einen Systemzustand einfrieren könnte. Das war
der Grund, Paketverwaltung als nicht autonomisierbar einzustufen.

Der Hoster liefert sie aber:

```
POST   /v1/compute/instances/{id}/snapshots               anlegen
GET    /v1/compute/instances/{id}/snapshots               auflisten
POST   /v1/compute/instances/{id}/snapshots/{sid}/revert  zurückrollen
DELETE /v1/compute/instances/{id}/snapshots/{sid}         löschen
```

OAuth-2-Bearer, Zugangsdaten aus dem Kundenpanel. Der Snapshot liegt auf
Blockebene, also **unterhalb** von ext4 — er erfasst damit genau das, was ein
Dateikopier-Rückbau prinzipiell nicht erfassen kann: `postinst`-Skripte,
Dienstmigrationen, Schemaänderungen. Als Anbieter `vps:contabo` wären
Systemupdates damit ehrlich autonomisierbar.

Er ist aber von anderer Art als die übrigen, und das muss der Entwurf abbilden:

| | Reichweite | Rückbau | Kollateral |
|---|---|---|---|
| `file`/`tree`/`mysql` | deklarierte Pfade | Sekunden, im laufenden System | keiner |
| `vps:contabo` | **die ganze Maschine** | Neustart, Minuten | **alles seit dem Snapshot** |

Ein Revert um 14:00 auf den Stand von 13:00 nimmt auch die Mails mit, die das
Archiv inzwischen geholt hat, GitLab-Commits, Nextcloud-Uploads. Chirurgisch
ist das nicht; es ist eine Zeitmaschine für den Host.

**Deshalb asymmetrisch:**

* **Snapshot anlegen** darf der Executor autonom. Der Wert liegt darin, dass vor
  einem Systemupdate ein garantierter Rückweg *existiert*.
* **Revert nur mit Operator-Freigabe.** Ein Rückbau mit Kollateralschaden ist
  eine Abwägung, keine Rechnung.

Zwei Randbedingungen aus Contabos Dokumentation: Snapshots werden nach 30 Tagen
gelöscht, und ein Revert entfernt automatisch alle neueren Snapshots. Ein
Automatismus, der häufig Snapshots anlegt, baut die Historie also ständig um —
Aufbewahrung gehört hier genauso geplant wie bei den lokalen Anbietern.

**Und der API-Token ist ein Generalschlüssel.** Wer ihn hat, kann die Maschine
zurückrollen. Für einen Agenten auf einem externen Modell wäre das die
mächtigste Fähigkeit im System. Er gehört behandelt wie `~/.hermes/credentials`:
harte Grenze in `evaluatePlanPolicy`, nie in einem Manifest, nie im
Agentenkontext. Der Executor liest ihn aus seiner eigenen Umgebung.

## MCP: Schema statt Prosa — aber nicht als Gesprächsmuster

`capabilityPlannerContract()` ist heute ein Prosablock von ~1700 Token, mit
einer Einzelzeile von 1132 Zeichen. Er beschreibt für jeden Helfer die exakten
Argumente, `runAsUser`, Netzwerkmodus, erlaubte Pfade. Der Executor prüft
dieselben Regeln noch einmal, an 33 `fail()`-Stellen — die Mehrzahl davon
Formfehler, nicht Sachfehler.

Das sind **zwei getrennte Wahrheiten über dieselbe Sache**. Driften sie
auseinander, merkt es niemand, und der Planer erfährt seinen Formfehler erst
nach Planung und Freigabe, ganz am Ende.

MCP behebt genau das: Aus dem Absatz wird ein Schema, ein falsch geformtes
Argument existiert gar nicht erst. Was es **nicht** behebt — und was man nicht
verwechseln darf:

| Schicht | heute | mit MCP |
|---|---|---|
| Beschreibung | Prosa | Tool-Schema, maschinenlesbar |
| Formprüfung | 33 × `fail()` im Executor | Protokoll lehnt vorab ab |
| Ausführungsgrenze | `TemporaryFileSystem=/:ro` | unverändert |
| Rückbau | Executor-Snapshot | unverändert |
| Erlaubnis | Policy + Safety-Urteil | unverändert |

MCP ersetzt die Beschreibungsschicht, nicht die Sicherheitsschicht.

**Der Fallstrick:** MCP ist von Haus aus ein Gesprächsmuster — Werkzeug rufen,
Ergebnis sehen, nächstes Werkzeug. Das würde die stärkste Eigenschaft des
Cockpits zerstören: dass ein *vollständiger* Plan geprüft, freigegeben und dann
als Ganzes ausgeführt wird. Zieht der Agent während des Laufs frei Werkzeuge,
gibt es nichts mehr, das ein Richter vorab lesen könnte.

**Zuschnitt:**

* **MCP für Entdeckung und Form.** Der Planer fragt, welche Fähigkeiten es gibt
  und wie ihre Parameter aussehen — Schema statt Absatz.
* **Das Manifest bleibt die Festlegung.** Ergebnis ist weiterhin ein
  vollständiges, prüfbares Dokument, kein Strom von Einzelaufrufen.
* **Nur lesende Werkzeuge direkt aufrufbar** (`status`, `check`, `list`). Alles
  Verändernde geht durch Plan → Prüfung → Freigabe oder abgeleitete Autonomie →
  Executor.
* **Eine Quelle für beides.** Das Schema erzeugt den Contract-Text *und* die
  Executor-Prüfung, statt sie getrennt zu pflegen.

Hermes' Läufe gehen über `opencode`, das MCP unterstützt — der Weg ist gangbar,
ohne die Agentenschicht auszutauschen.

## Was zuerst zu klären ist

1. **`tree` bei großen Bäumen.** 766 MB WordPress dauern ~90 s. Ein
   Nextcloud-`apps`-Baum ist größer. Ab welcher Größe ist ein Snapshot keine
   Routine mehr — und was passiert dann: Freigabe verlangen oder ablehnen?
2. **Nebenläufigkeit.** Zwei Jobs mit überlappendem Scope dürfen nicht
   gleichzeitig laufen. `resource_group` je Scope, nicht je Capability.
3. **`mysql` und Konsistenz.** `--single-transaction` reicht für InnoDB;
   MyISAM-Tabellen brauchen eine Sperre. Prüfen, was hier tatsächlich läuft.
4. **Migration.** `cockpit-capability/v1` bleibt gültig; v2 ergänzt `scopes`.
   Ein v1-Manifest mit `writablePaths` wird auf `file`-Scopes abgebildet,
   verhält sich also exakt wie heute.
5. **Contabo-Snapshot: Dauer und Wirkung.** Wie lange dauert `POST snapshots`
   auf einer 1,2-TB-Instanz, und ist die Instanz dabei benutzbar? Ein Anbieter,
   der den Host für Minuten anhält, ist für Routineläufe untauglich — das muss
   gemessen werden, bevor er eingeplant wird.
6. **Wechselwirkung mit borgmatic.** Ein VPS-Snapshot ist kein Ersatz für die
   Sicherung: 30 Tage Aufbewahrung, beim selben Hoster, und ein Revert löscht
   neuere Snapshots. Beides nebeneinander, mit klarer Rollenverteilung.
7. **`cockpit-wordpress-update` danach.** Er wird überflüssig — oder bleibt
   als Beleg, dass der Mechanismus dasselbe leistet. Erst ersetzen, wenn v2
   dieselbe Aufgabe nachweislich erfüllt, nicht vorher.

## Warum das kein Flickenteppich ist

| heute | danach |
|---|---|
| ein geprüfter Helfer je Klasse | ein Mechanismus, viele Manifeste |
| Rückbau im Skript versteckt | Rückbau im Executor, einmal geprüft |
| `contained` = Behauptung des Planers | `contained` = vom Executor abgeleitet |
| neue Klasse = neues Skript + Prüfung | neue Klasse = Manifest, sofort |

Der Agent gewinnt Autonomie genau dort, wo sie verantwortbar ist, und verliert
sie genau dort, wo sie es nicht ist — nach einem Kriterium, das der Executor
selbst nachrechnet, statt es zu glauben.
