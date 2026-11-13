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
- Zustand je Lauf: `HOME`, `CLAUDE_CONFIG_DIR`, `XDG_*_HOME` und `TMPDIR` liegen unter
  `<workspace>/.run-state/` und gehen mit dem Arbeitsordner. Das Home der Identität bleibt
  schreibgeschützt und bekommt kein `.claude`.
- Das Kind bekommt nur `PATH`, den Claude-Login und diese Pfade, **nicht** `DEEPSEEK_API_KEY`.
- `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1`: Claude hält seinen Login aus der Shell, die das Modell
  bedient (braucht `bubblewrap`). Startet Claude so nicht, fällt der Lauf auf opencode zurück
  (NOTBETRIEB mit Grund) — ein stilles Abschalten gibt es nicht.
- Ergebnis: der Text aus `result`, das Modell aus `modelUsage` (z. B. `claude-sonnet-5-5`).

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
