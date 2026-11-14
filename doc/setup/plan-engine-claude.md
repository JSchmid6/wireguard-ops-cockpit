# Planer und Research auf Claude (Abo), DeepSeek nur als NOTBETRIEB

Entscheidung Jochen, 13.11.2026 (Karte t_936d9b0f, Vorlage t_8053933a Variante D): Planer und
Research laufen mit Claude Sonnet über das Claude-Abo. Safety, Verifier und Runner bleiben auf
opencode (DeepSeek). Fällt Claude aus, springt opencode mit dem bisherigen Planer-Modell ein, und
der Job trägt **NOTBETRIEB**.

## Schalter (je Host)

| Zeile | Bedeutung |
|---|---|
| `COCKPIT_PLAN_ENGINE=claude` | Planer und Research über `claude -p`; fehlt die Zeile, bleibt alles auf opencode |
| `COCKPIT_CLAUDE_MODEL=sonnet` | Modell-Alias oder voller Name; Vorgabe `sonnet` |
| `CLAUDE_CODE_OAUTH_TOKEN=…` | **in `claude.env`**, nicht in `agent.env`: Langzeit-Login aus `claude setup-token` (ein Jahr gültig). Nur die Agent-Unit lädt `claude.env` (`EnvironmentFile=-…`); die Runner-Unit, die `agent.env` auch lädt, bekommt ihn nie |
| `COCKPIT_CLAUDE_ENV_SCRUB=0` | nur als bewusste Ausnahme: schaltet das Abschotten des Logins vor der Shell ab (siehe unten) |
| `COCKPIT_OPENCODE_MODEL` | bleibt: Modell des Rückfalls (und des Runners) |

`COCKPIT_PLAN_ENGINE`, `COCKPIT_CLAUDE_MODEL` und `COCKPIT_CLAUDE_ENV_SCRUB` stehen in `agent.env`, beide Dateien `root:root 0600`. Der Broker liest die Schalter je Lauf (`apps/agent-broker/src/index.mjs`, `claudeSettings`). Die
Modellwahl bleibt Host-Konfiguration (AGENTS.md, „Models“); das Repo kennt nur die Vorgabe.

## Wie der Broker Claude startet

`claude -p --safe-mode --strict-mcp-config --no-session-persistence --model <m> --tools
Bash,Read,Grep,Glob,WebFetch,WebSearch --allowedTools <dieselben> --append-system-prompt-file
<workspace>/AGENTS.md --output-format json`, der Prompt auf stdin.

- `--safe-mode`: kein CLAUDE.md, keine Skills, Plugins, Hooks, MCP-Server, eigenen Agenten oder
  Befehle — das Gegenstück zu opencodes `--pure` plus `assertNoPlantedConfig`. Die Rollen-Anweisung
  kommt aus der root-kontrollierten `AGENTS.md` des Arbeitsordners als Schluss des Systemprompts.
- Werkzeuge wie opencodes `plan`: lesen, suchen, Shell, Web; kein Edit/Write. Die Grenze bleibt die
  Unit (AGENTS.md, „plan denies only the edit tool“).
- Zustand je Lauf: `HOME`, `CLAUDE_CONFIG_DIR` und `XDG_*_HOME` liegen unter
  `<workspace>/.run-state/` und gehen mit dem Arbeitsordner. Das Home der Identität bleibt
  schreibgeschützt und bekommt kein `.claude`.
- `TMPDIR` ist ein eigenes, kurzes Verzeichnis je Lauf: `/tmp/cockpit-claude-XXXXXX` (mkdtemp,
  0700), entfernt am Ende des Claude-Laufs, also zusammen mit dem Arbeitsordner (Karte
  t_8b92ed2f). Grund: Claudes Sandbox bindet zwei Unix-Sockets
  `<TMPDIR>/claude-http-<16 hex>.sock` und `claude-socks-…` (socat, Claude Code 2.1.311), und
  `sun_path` fasst 107 Zeichen. Unter dem Arbeitsordner
  (`/var/lib/wireguard-ops-agent/sessions/agent-<uuid>-research-XXXXXX/.run-state/tmp`) wurden es
  ~145, socat konnte nicht binden, und jeder Lauf endete mit „Sandbox is required but failed to
  initialize: Failed to create bridge sockets after 5 attempts“ (Messläufe 14.11.2026 auf VPS,
  Lab0 und Box) — das Bash-Werkzeug fehlte, Research war blind. Jetzt sind es 61 Zeichen.
  `/tmp` ist in der Agent-Unit privat (`PrivateTmp=true`) und wird bei jedem Neustart der Unit
  geleert; was ein abgebrochener Lauf liegen lässt, verschwindet spätestens dort. Ein kürzerer
  Arbeitsordnername wurde verworfen: Wurzel, Request-ID (bis 64 Zeichen) und Rolle lassen unter
  `/var/lib/…` keine verlässliche Reserve, und der Name trägt die Zuordnung Lauf ↔ Job. Würde der
  Socketpfad dennoch zu lang (`createClaudeTmpdir` prüft es), startet Claude nicht, und der Lauf
  fällt mit Grund auf opencode zurück (NOTBETRIEB). Ehrliche Grenze wie beim Arbeitsordner: `/tmp`
  der Unit teilen alle Rollen der Identität `cockpit-agent`; 0700 schützt nur vor anderen Nutzern.
- bwrap braucht unter Ubuntus userns-Härtung das AppArmor-Profil `bwrap-userns-restrict`
  (Abschnitt „bwrap und AppArmor“ unten).
- Das Kind bekommt nur `PATH`, den Claude-Login und diese Pfade, **nicht** `DEEPSEEK_API_KEY`.
- `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1`: Claude hält seinen Login aus der Shell, die das Modell
  bedient (braucht `bubblewrap`). Startet Claude so nicht, fällt der Lauf auf opencode zurück
  (NOTBETRIEB mit Grund) — ein stilles Abschalten gibt es nicht.
- Ergebnis: der Text aus `result`, das Modell aus `modelUsage` (z. B. `claude-sonnet-5-5`).

## bwrap und AppArmor (Karte t_79e9f6d6)

Ubuntu setzt `kernel.apparmor_restrict_unprivileged_userns=1`: Ein Programm ohne eigenes Profil,
das einen User-Namespace anlegt, landet im Profil `unprivileged_userns` und verliert darin jede
Capability. bwrap kann dann seine `uid_map` nicht schreiben, und Claudes Sandbox bricht mit
„bwrap: setting up uid map: Permission denied“ ab. Beleg VPS, Kernel-Audit 14.11.2026:
`apparmor="DENIED" … profile="unprivileged_userns" name="proc/<pid>/uid_map" comm="bwrap"` und
`DENIED capable … capname="setpcap"`. Ubuntu ab 25.04 bringt dafür im Paket `apparmor` das Profil
`/etc/apparmor.d/bwrap-userns-restrict` mit (Lab0, dpkg: `apparmor`). Ubuntu 24.04 (VPS) hat es
nicht, auch nicht unter `extra-profiles` (geprüft am Paket `4.0.1really4.0.1-0ubuntu0.24.04.9`).

**Weg:** Genau dieses Profil, bytegleich aus `apparmor_4.1.0~beta5-0ubuntu14.2` (Ubuntu 25.04),
liegt als `deploy/apparmor/bwrap-userns-restrict` im Repo (sha256 `634d3d34…f0e`, `abi <abi/4.0>`).
Der Parser von 24.04 übersetzt es. Es enthält zwei Profile: `bwrap` (für `/usr/bin/bwrap`) darf
User-Namespaces anlegen und hat darin Capabilities. Alles, was bwrap startet, läuft gestapelt unter
`&bwrap//&unpriv_bwrap`, und `unpriv_bwrap` hat `audit deny capability`. Die Kinder, also auch die
Shell des Modells, bekommen im Namespace keine Capabilities. Die Härtung bleibt für alle anderen
Programme an, der sysctl bleibt 1.

- VPS: Das Profil ist ein Eintrag der Tabelle in `deploy/vps/vps-cockpit-deploy.sh`. Das Deploy lädt es
  mit `apparmor_parser -r`. Beim Rückfall entlädt es das Profil wieder (`-R`), wenn die Datei vorher
  fehlte, sonst lädt es die alten Bytes neu. Gehört der Pfad einem Paket (nach einem Release-Upgrade),
  bleibt die Datei unberührt. Erstmals ausgerollt per host-run, Job `17877b84` (14.11.2026). Eine
  Probe als `nobody` (`bwrap --unshare-user … id -u` → `65534`) lief danach durch.
- Lab0/box: `homeserver-cockpit-deploy.sh` (Schritt 9b) legt die Repo-Kopie nur hin, wenn die Härtung
  aktiv ist UND die Datei fehlt. Lab0 hat sie aus dem Paket, die box (Debian) hat die Härtung nicht.
  Dort ändert sich nichts.
- Rückweg von Hand: `apparmor_parser -R /etc/apparmor.d/bwrap-userns-restrict`, dann die Datei löschen.

**Verworfen:** `kernel.apparmor_restrict_unprivileged_userns=0` würde die Härtung für jedes Programm
abschalten. Ein eigenes Profil für `claude` oder die Agent-Unit mit `userns` bzw. `flags=(unconfined)`
würde dem ganzen Claude-Prozessbaum Capabilities im Namespace geben, nicht nur bwrap. Und es wäre
ein Profil, das niemand außer uns pflegt.

**Ehrliche Grenze:** Das Profil `bwrap` selbst ist weit gefasst (`allow capability`, Dateien,
mount, Netz). Die Grenze ist das Stapeln auf `unpriv_bwrap` für alles, was bwrap ausführt. Jeder Nutzer
des Hosts kann nun über bwrap einen User-Namespace anlegen, wie auf einem Ubuntu ab 25.04 auch.

**Messhinweis (`id -un` „leer“, 14.11.2026) — behoben (Karte t_f7cc608e):** Weder bwrap noch die
Sandbox verschluckte die Ausgabe. Research-Antworten ohne `## `-Überschrift liefen durch den
Runner-Zweig von `extractCleanOutput` (`apps/api/src/app.ts`), der Zeilen unter 30 Zeichen mit
Kleinbuchstaben am Anfang verwarf (`cockpit-agent`, `rc=0`, `apparmor\t4.1…`). Seitdem bleibt eine
Research-Antwort wörtlich (`extractResearchAnswer`): Weg fallen nur opencodes Log-Rauschen
(`timestamp=`, `tee:`, `> build `, ANSI-Farben) und, was `filterSensitiveContent` schwärzt. Dasselbe
gilt für einen Plan ohne Zaun und ohne Überschrift (`extractPlannerText`); mit Zaun oder Überschrift
schneidet der Planer weiter dort. Messläufe brauchen keine Überschriften oder `od`/`base64` mehr.

## NOTBETRIEB

Scheitert Claude (nicht angemeldet, Token abgelaufen, Abo-Fenster voll, Netz, Start), läuft dieselbe
Anfrage mit opencode und dem Rest des Rollenbudgets, in einem **frischen** Arbeitsordner, der wieder
auf gepflanzte Konfiguration geprüft wird: was die Shell des Claude-Laufs hinterließ, erreicht opencode nicht.
Ohne JSON-Ergebnis (unbekannte Option, Sandbox-Start) steht stderr als Grund. Eine Zeitüberschreitung
von Claude fällt nicht zurück: Das Budget ist dann verbraucht, die Rolle scheitert wie bisher.

- Broker-Antwort: `engine: {name, model}`, im Rückfall zusätzlich `notbetrieb: true, reason`.
- Job: `output.agentEngine.<rolle>` (bleibt über alle späteren Updates) und bei Rückfall — auch wenn
  der Rückfall selbst scheitert — `output.notbetrieb = "NOTBETRIEB: planner ran on <modell> (opencode) because Claude failed: <grund>"`,
  gebildet aus dem jeweils letzten Motor je Rolle (ein Neuplanen über Claude löscht es).
- Das Cockpit hat keinen Telegram-Weg (AGENTS.md, „Wartet auf dich“): Hermes liest das Feld beim
  Job-Ergebnis (Plugin cockpit) und meldet es Jochen.

## Einrichten

1. Lab0/Box: Das Deploy installiert `@anthropic-ai/claude-code@$CLAUDE_CODE_VERSION` neben opencode
   und `bubblewrap` (Schritt 9b, auch beim Self-Update; scheitert es, nur ein HINWEIS, kein Abbruch).
   VPS: wie opencode per host.run. Die Agent-Unit mit `EnvironmentFile=-…/claude.env` kommt mit dem Deploy.
2. Jochen erzeugt einmal `claude setup-token` (Browser-Login mit seinem Konto); der Token liegt im
   Tresor, nie im Repo, in Logs oder im Manifest.
3. Je Host ein host.run, der den Token verschlüsselt mitbringt (CMS an das Host-Zertifikat, wie
   box-bootstrap.md „Der Planner-Schlüssel“), ihn als `claude.env` (0600) ablegt, in `agent.env`
   `COCKPIT_PLAN_ENGINE=claude` und `COCKPIT_CLAUDE_MODEL=sonnet` setzt, dann
   `wireguard-ops-cockpit-agent.service` neu startet. Das Schreiben in eine Datei mit Geheimnissen
   ist `identity_or_secret` und geht an Jochen.
4. Messlauf je Host: ein Research-Job; `output.agentEngine.research` muss
   `{name: "claude", model: "claude-sonnet-…"}` zeigen, ohne `notbetrieb`.

Rückweg: `COCKPIT_PLAN_ENGINE` aus `agent.env` nehmen und die Agent-Unit neu starten; `claude.env` löschen.

## Ehrliche Grenzen

- Der Login gilt für Jochens ganzes Abo, ein Jahr. Jede Rolle mit Shell **in der Agent-Unit**
  (Planer und Research über Claude, Safety, Verifier, Rückfall über opencode) läuft als
  `cockpit-agent` und kann ihn aus `/proc/<broker-pid>/environ` oder `/proc/<claude-pid>/environ`
  lesen; `ProtectProc=invisible` verbirgt nur fremde Nutzer. Der Scrub schützt nur die Umgebung der
  Kinder, nicht die des Elternprozesses. Gleiche Klasse wie `DEEPSEEK_API_KEY` heute. Die Runner-Unit
  (eigene Identität) erreicht ihn nicht. Bei Verdacht: Token im Abo widerrufen, neu erzeugen.
- Abo-Läufe zählen gegen Jochens 5-h-Fenster; ist es voll, läuft NOTBETRIEB (Kosten DeepSeek).
- Die API kennt den Schalter nicht: `/api/health` (`modelDiversity`) und der Breaker-Fingerabdruck
  rechnen weiter mit `COCKPIT_OPENCODE_MODEL`. Was wirklich lief, steht am Job.
