# Wartet auf dich — die Startseite des Cockpits

Stand 02.10.2026 (t_432807ea). Gilt für das VPS- und das Lab0-Cockpit (gleicher Code).

Nach dem Login zeigt das Cockpit zuerst eine einzige Liste: alles, was Jochen entscheiden muss.
Terminals, Sitzungen, Runbooks, Zeitpläne, Borg-Zustand, Aufbewahrung und Audits liegen
eingeklappt hinter dem Knopf **Mehr**. Die Seite ist für das Handy gebaut: eine Spalte,
Knöpfe über die volle Breite und mindestens 52 px hoch, Befunde zum Aufklappen.

## Was dort erscheint

| Karte | Quelle | Freigeben | Ablehnen |
|---|---|---|---|
| Änderung von James | `hermes-change`-Job in `blocked_user_approval` (Türsteher-Befund, Update-Prüfer-Stopp, Plan-Policy) | `POST /api/hermes/jobs/:id/approval` | derselbe Weg mit `rejected` |
| Backup-Riegel | derselbe Job, wenn der Riegel (`cockpit-backup-guard.mjs`) angeschlagen hat — also auch ein `cockpit-borg-retention set` unter der Untergrenze, den James bestellt | wie oben | wie oben |
| Freigabe | offener Eintrag in `approvals` (Runbook- und Agentenpläne) | `POST /api/approvals/:id/decision` | derselbe Weg mit `rejected` |
| Aufräum-Dienst | Lab0-Dienst `angehalten` nach einer Anomalie (Archive fehlen, die er nicht selbst entfernt hat), solange er für genau diese Anomalie keine Freigabe trägt (nach `freigeben` bleibt er bis zum Ende seines Laufs `angehalten`) | `POST /api/borg/retention/resume` (Grund ≥ 10 Zeichen, wie bisher) | `POST /api/inbox/retention/:anomalyId/keep`: der Dienst bleibt angehalten, die Karte verschwindet, ein Audit hält den Grund fest |

Eine Einstellung unter der Untergrenze, die Jochen selbst im Bereich „Backup retention" setzt,
fragt dort direkt nach seiner Freigabe — sie wartet auf niemanden und erscheint deshalb nicht als
Karte.

Jede Karte zeigt:

- **die Absicht in einem Satz** (der erste Satz der vertrauenswürdigen Absicht des Jobs),
- **warum gestoppt wurde** (`policy.reason`),
- **die Befunde**: Titel, Garantie oder Klasse, Datei und Zeile (Update-Prüfer) bzw. Schritt und
  Zeile (Türsteher, `S3:L1`), Schwere; aufgeklappt die Begründung mit dem zitierten Code. Vom
  Türsteher nur die belegten Befunde — unbelegte verwirft er selbst, sie stoppen nichts.
- **die Frist** als Countdown bis zum Ablauf des Envelopes (`envelope.expiresAt`, Vorgabe
  `COCKPIT_APPROVAL_TTL_MINUTES=30`) bzw. der Freigabe,
- **Freigeben** und **Ablehnen**, beide erst mit einem Grund bedienbar.

**Der Grund ist Pflicht** — nicht nur in der Oberfläche: `POST /api/hermes/jobs/:id/approval` und
`POST /api/approvals/:id/decision` antworten ohne nicht-leeren `reason` mit 400.

Nichts offen: groß **„Nichts wartet auf dich"**, darunter eine Zeile mit dem letzten Lauf, dem Alter
des letzten Backups (aus `borg.status`, ohne neue Messung zu erzwingen) und dem freien Platz auf `/`.

## Abgelaufene Frist: „Neu bestellen lassen"

Ein abgelaufener Envelope ist nicht mehr freigebbar (das prüft der Server ohnehin). Die Karte sagt
das deutlich und bietet statt Freigeben **Neu bestellen lassen**:

`POST /api/inbox/jobs/:id/reorder` (nur Jochens Sitzung, nie ein Automation-Token; nur wenn der
Envelope wirklich abgelaufen ist) schließt den alten Job endgültig (`blocked_policy`, mit
`output.reorder`), schreibt das Audit `hermes.change.reorder_requested` und listet den Wunsch
24 Stunden lang in `GET /api/inbox` unter `reorders` (Job-Id, Absicht, Notiz). James bestellt
dieselbe Absicht neu; die neue Bestellung wird frisch geplant, geprüft und signiert. Eine alte
Freigabe wird nie wiederverwendet. `reorders` zeigt einem Automation-Token nur Jobs seines eigenen
Kontos — die Absicht eines anderen Kontos wird nie zu James' Bestellung.

Kommt eine Freigabe knapp zu spät (letzte Sekunden des Countdowns, Handyuhr geht nach), schließt
die Freigabe-Route den Job wie bisher mit „execution envelope expired". Die Karte bleibt dann
stehen und bietet „Neu bestellen lassen"; die Route nimmt auch einen so geschlossenen Job an
(einmal).

Eine abgelaufene **Plan-Freigabe** aus `approvals` (Runbook- oder Agentenplan aus der
Oberfläche, nicht von James) lässt sich nicht neu bestellen: Die Karte sagt, den Lauf unter
„Mehr" neu zu planen, und erlaubt nur noch Ablehnen.

## Hinweis an Jochen über James (Telegram)

**Gewählt: James holt, das Cockpit schickt nichts.** Das Cockpit bekommt keinen Telegram-Bot-Token
und keinen Webhook — es braucht damit kein neues Geheimnis und keine ausgehende Verbindung.

1. **James' eigene Jobs (der Hauptfall):** Endet ein Job in `blocked_user_approval`, liefert das
   Cockpit in der Job-Antwort (`GET /api/hermes/jobs/:id` und die fertige Antwort von
   `POST /api/hermes/runbook`) das Feld `operatorLink`, z. B.
   `https://<cockpit>/#karte-job-<id>`. James sieht diese Antwort ohnehin (`cockpit_auftrag`,
   `cockpit_einblick was=job`) und schickt den Link per Telegram an Jochen. Dafür ist **kein**
   neuer Scope und kein neuer Schlüssel nötig.
2. **Alles andere** (Freigaben aus `approvals`, Anomalie des Aufräum-Dienstes, `reorders`): James
   liest `GET /api/inbox` mit seinem bestehenden Automation-Token, sobald Jochen diesem Token den
   Scope `GET /api/inbox` gibt (bei der nächsten Rotation über `plugins/cockpit/schluessel.py`).
   Das ist eine Berechtigung, kein neues Geheimnis. Ein Automation-Token sieht dort nur die Jobs
   seines eigenen Kontos und kann weiterhin nichts freigeben.

Warum nicht das Cockpit selbst schicken lassen: Ein Bot-Token im Cockpit wäre ein neues Geheimnis
auf dem Host, und Telegram läuft bei James ohnehin schon. Home Assistant hätte dasselbe Problem
(Token). Der Weg über James nutzt nur, was schon da ist.

Die Basisadresse für den Link setzt `COCKPIT_WEB_URL` (kein Geheimnis, z. B.
`http://10.0.0.1:5173`). Ohne sie ist der Link relativ (`/#karte-job-<id>`).

Der Direktlink öffnet das Cockpit; nach dem Login springt die Seite zur Karte und hebt sie hervor.
Ist sie schon entschieden, steht dort „Die verlinkte Karte wartet nicht mehr".

**Noch offen auf James' Seite** (nicht Teil dieses Repos): im Skill `cockpit` den `operatorLink`
bei `blocked_user_approval` an Jochen weiterreichen; optional ein Cron, der `GET /api/inbox` liest
und für neue Karten bzw. `reorders` meldet.

## Korrektur am Freigabeweg

Bis zu diesem Stand suchte `POST /api/hermes/jobs/:id/approval` die Laufzeit-Sitzung mit der
Kennung des **freigebenden** Admins. James' Jobs liegen aber in Sitzungen seines
Automation-Kontos — eine Freigabe durch Jochen endete deshalb in `blocked_prerequisite`
(„executor runtime is unavailable"), ohne dass etwas lief. Jetzt sucht die Route die Sitzung des
Auftraggebers (`jobOwnerId`), an den auch der Envelope gebunden ist. Schloss, Türsteher und Riegel
bleiben unverändert: Der Envelope wird genauso geprüft wie vorher.

## API

| Route | Wer | Was |
|---|---|---|
| `GET /api/inbox` | Sitzung; Automation nur mit Scope | `cards`, `status` (`lastRuns`, `backup`, `disk`), `reorders`, `generatedAt` |
| `POST /api/inbox/jobs/:jobId/reorder` | Sitzung (nicht Automation) | abgelaufenen Job schließen, Neubestellung anmelden; Body `{ note? }` |
| `POST /api/inbox/retention/:anomalyId/keep` | Admin-Sitzung | Anomalie ablehnen = angehalten lassen; Body `{ reason }` |

## Tests

- `apps/api/test/inbox.test.ts` — Karten aus Job, Freigabe und Anomalie; Befunde (nur belegte);
  Frist und Sortierung; Sichtbarkeit je Rolle; `operatorLink`; Neubestellen nur abgelaufen und
  nicht per Token; Pflichtgrund.
- `apps/api/test/host-run-flow.test.ts` — James bestellt mit seinem Token, Jochen gibt als Admin
  frei, der Lauf startet in James' Sitzung (vorher: `blocked_prerequisite`).
- `apps/web/src/Inbox.test.tsx` — Countdown, Zustandszeile, Knöpfe erst mit Grund, Befunde
  ausklappbar, „Neu bestellen lassen", Anomalie, Fehleranzeige, Direktlink; Handyansicht über die
  tragenden CSS-Regeln (eine Spalte zuerst, Knöpfe ≥ 44 px, nichts breiter als 360 px) und die
  Lesereihenfolge der Karte. jsdom rechnet kein Layout; ein echter Blick auf dem Handy bleibt
  nötig.
- `apps/web/src/App.test.tsx` — Startseite zeigt „Wartet auf dich", der Rest ist hinter „Mehr"
  zu; Freigaben laufen über die Karte mit Grund.
