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
5. **`cockpit-wordpress-update` danach.** Er wird überflüssig — oder bleibt
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
