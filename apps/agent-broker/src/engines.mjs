// Antriebe des Agenten-Brokers. Standard ist die Claude-CLI über das Abo
// (eigenes langlebiges Token, eigener Konfig-Ordner). Codex ist als zweiter
// Antrieb vorbereitet und erst nutzbar, wenn er ausdrücklich zugeschaltet ist.
// DeepSeek über opencode gibt es nur noch per ausdrücklichem Schalter und dann
// mit sichtbarem Etikett. Es gibt keinen stillen Rückfall: ist der gewählte
// Antrieb nicht verfügbar, endet der Lauf mit "nicht_verfuegbar".
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";

export const ROLES = ["planner", "research", "runner", "safety", "verifier"];
export const MODEL_ALIASES = new Set(["opus", "sonnet", "haiku", "fable"]);
const PREFLIGHT_TIMEOUT_MS = 15000;

// Rechte je Rolle. Die Sperre ist allein `--tools` (verfügbare Werkzeuge) plus
// `--disallowedTools`; `--allowedTools` erteilt nur die Erlaubnis ohne Rückfrage
// und sperrt nichts. Der runner bekommt die Teilmenge dessen, was die
// opencode-`build`-Rolle heute hat (Shell, Lesen, Schreiben, Suchen) — ohne
// Netzwerkzeuge, ohne Unteragenten.
export const ROLE_TOOLS = {
  safety: [],
  verifier: [],
  planner: ["Read", "Grep", "Glob"],
  research: ["Read", "Grep", "Glob"],
  runner: ["Bash", "Read", "Edit", "Write", "Grep", "Glob"],
};
// Zweite Sperre: alles, was eine Rolle nie haben darf, ausdrücklich verboten.
const NEVER = ["Agent", "Task", "WebFetch", "WebSearch", "NotebookEdit", "Skill", "SlashCommand", "KillShell", "BashOutput"];
const MUTATING = ["Bash", "Edit", "Write", "MultiEdit"];

export function readEngineConfig(env = process.env) {
  const credentials = env.CREDENTIALS_DIRECTORY ? path.join(env.CREDENTIALS_DIRECTORY, "claude-oauth-token") : null;
  return {
    engine: (env.COCKPIT_AGENT_ENGINE || "claude").trim(),
    runsRoot: env.COCKPIT_AGENT_RUNS_ROOT || "/var/lib/wireguard-ops-agent/runs",
    claude: {
      executable: env.COCKPIT_CLAUDE_EXECUTABLE || "claude",
      configDir: env.COCKPIT_CLAUDE_CONFIG_DIR || "/var/lib/wireguard-ops-agent/claude-config",
      tokenFile: env.COCKPIT_CLAUDE_TOKEN_FILE || credentials || "/etc/wireguard-ops-agent/claude-oauth-token",
      reviewModel: (env.COCKPIT_CLAUDE_REVIEW_MODEL || "opus").trim(),
      workModel: (env.COCKPIT_CLAUDE_WORK_MODEL || "sonnet").trim(),
      // Pfade, die keine Rolle mit Read/Grep/Glob anfassen darf (Token, Anmeldung, Läufe, Broker-Umgebung).
      // /proc: the CLI's own environ carries the token.
      deniedPaths: (env.COCKPIT_CLAUDE_DENIED_PATHS || "/etc/wireguard-ops-cockpit:/proc").split(":").filter(Boolean),
    },
    codex: {
      enabled: env.COCKPIT_CODEX_ENABLED === "1",
      executable: env.COCKPIT_CODEX_EXECUTABLE || "codex",
      home: env.COCKPIT_CODEX_HOME || "/var/lib/wireguard-ops-agent/codex-home",
    },
    opencode: {
      executable: env.COCKPIT_OPENCODE_EXECUTABLE || "opencode",
      plannerModel: env.COCKPIT_OPENCODE_MODEL || "",
      safetyModel: env.COCKPIT_SAFETY_OPENCODE_MODEL || env.COCKPIT_OPENCODE_MODEL || "",
      config: env.COCKPIT_OPENCODE_CONFIG || "/var/lib/wireguard-ops-agent/.config/opencode/opencode.jsonc",
      deepseekKey: env.DEEPSEEK_API_KEY,
    },
    home: env.HOME,
    path: env.PATH,
  };
}

export function claudeModelFor(role, claude) {
  return role === "safety" || role === "verifier" ? claude.reviewModel : claude.workModel;
}

function denyRules(paths) {
  // Absolute Pfade schreibt Claude Code als `//pfad`.
  return paths.flatMap((entry) => {
    const abs = `/${path.resolve(entry)}/**`;
    return [`Read(${abs})`, `Grep(${abs})`, `Glob(${abs})`];
  });
}

// Kommandozeile der Claude-CLI je Rolle. Der Prompt kommt über stdin, der
// Rollenkontext (AGENTS.md + Architektur + Rolle) über --append-system-prompt:
// die CLI liest AGENTS.md im Arbeitsordner nicht von selbst.
export function claudeArgs(role, { model, context, deniedPaths = [] }) {
  if (!ROLES.includes(role)) throw new Error("invalid agent role");
  if (!MODEL_ALIASES.has(model)) throw new Error(`model must be an alias (${[...MODEL_ALIASES].join(", ")})`);
  const tools = ROLE_TOOLS[role];
  const forbidden = [...NEVER, ...(tools.includes("Bash") ? [] : MUTATING)];
  const args = [
    "-p",
    "--output-format", "stream-json",
    "--verbose",
    "--model", model,
    "--tools", tools.join(","),
    "--disallowedTools", ...forbidden, ...(tools.length ? denyRules(deniedPaths) : []),
    "--setting-sources", "",
    "--strict-mcp-config",
    "--safe-mode",
    "--disable-slash-commands",
    "--no-session-persistence",
    "--permission-mode", "dontAsk",
  ];
  if (tools.length) args.push("--allowedTools", tools.join(","));
  args.push("--append-system-prompt", context);
  return args;
}

function execText(executable, args, env, timeout = PREFLIGHT_TIMEOUT_MS) {
  return new Promise((resolve) => {
    execFile(executable, args, { env, timeout, maxBuffer: 1_000_000 }, (error, stdout, stderr) => {
      resolve({ error, stdout: String(stdout || ""), stderr: String(stderr || "") });
    });
  });
}

function readToken(tokenFile) {
  let stat;
  try { stat = fs.statSync(tokenFile); } catch { return { error: `Token-Datei fehlt (${tokenFile})` }; }
  if (!stat.isFile()) return { error: "Token-Pfad ist keine Datei" };
  if ((stat.mode & 0o077) !== 0) return { error: "Token-Datei ist für Gruppe/andere lesbar (verlangt 0600/0400)" };
  let token;
  try { token = fs.readFileSync(tokenFile, "utf8").trim(); } catch (error) { return { error: `Token-Datei nicht lesbar (${error.code || "Fehler"})` }; }
  if (!token || /\s/.test(token)) return { error: "Token-Datei ist leer oder ungültig" };
  return { token };
}

function recordVersion(runsRoot, name, version) {
  // Jeder Versionswechsel wird protokolliert (Abschnitt 8): ein stiller Bruch
  // lässt sich so einer Version zuordnen.
  const stateFile = path.join(runsRoot, `${name}-version.json`);
  let last = null;
  try { last = JSON.parse(fs.readFileSync(stateFile, "utf8")).version; } catch { /* erste Messung */ }
  if (last === version) return false;
  fs.mkdirSync(runsRoot, { recursive: true, mode: 0o700 });
  fs.writeFileSync(stateFile, `${JSON.stringify({ version, seit: new Date().toISOString() })}\n`, { mode: 0o600 });
  fs.appendFileSync(path.join(runsRoot, "cli-versionen.jsonl"), `${JSON.stringify({ zeit: new Date().toISOString(), antrieb: name, vorher: last, jetzt: version })}\n`, { mode: 0o600 });
  return true;
}

// Liest stream-json: das init-Ereignis belegt Modell und tatsächlich geladene
// Werkzeuge, das result-Ereignis trägt die Antwort. Weicht die
// Werkzeugliste von der Rolle ab, wird der Lauf sofort abgebrochen.
export function claudeStreamReader(expectedTools) {
  const state = { tools: null, model: null, result: null, mcp: null };
  const expected = [...expectedTools].sort().join(",");
  return {
    state,
    onLine(line) {
      let event;
      try { event = JSON.parse(line); } catch { return null; }
      if (event?.type === "system" && event.subtype === "init") {
        state.tools = Array.isArray(event.tools) ? event.tools : null;
        state.model = typeof event.model === "string" ? event.model : null;
        state.mcp = Array.isArray(event.mcp_servers) ? event.mcp_servers : null;
        const actual = (state.tools || []).slice().sort().join(",");
        if (state.tools === null || actual !== expected) return { status: "fehler", grund: `Werkzeugliste weicht von der Rolle ab (erwartet [${expected}], geladen [${actual}])` };
        if (state.mcp && state.mcp.length > 0) return { status: "fehler", grund: "fremde MCP-Server geladen" };
      }
      if (event?.type === "result") state.result = event;
      return null;
    },
    finish({ exitCode, stderr }) {
      const result = state.result;
      const base = { tools: state.tools, model: state.model };
      if (!result) return { ...base, status: "fehler", grund: `kein Ergebnis-Ereignis (Exit ${exitCode})${stderr ? `: ${stderr.trim().slice(-300)}` : ""}` };
      if (state.tools === null) return { ...base, status: "fehler", grund: `kein init-Ereignis mit Werkzeugliste (Exit ${exitCode}); die Rolle ist nicht belegt` };
      const text = typeof result.result === "string" ? result.result : "";
      if (result.is_error || result.subtype !== "success") {
        const auth = /not logged in|\/login|invalid api key|oauth|authenticat|401/i.test(text);
        return { ...base, status: auth ? "nicht_verfuegbar" : "fehler", grund: `${auth ? "Anmeldung ungültig" : "Fehler-Ergebnis"}: ${text.slice(0, 300) || result.subtype}` };
      }
      if (exitCode !== 0) return { ...base, status: "fehler", grund: `Exit ${exitCode}` };
      if (!text.trim()) return { ...base, status: "fehler", grund: "leere Antwort" };
      return { ...base, status: "erfolg", grund: null, output: text };
    },
  };
}

// Vorabprüfung der Claude-CLI: Modell-Alias, Token-Datei, Binary + Version,
// Anmeldung. Liefert { ok:false, grund } oder den startbereiten Antrieb.
export async function prepareClaude(role, prompt, context, config) {
  const { claude } = config;
  const model = claudeModelFor(role, claude);
  if (!MODEL_ALIASES.has(model)) return { ok: false, grund: `Modell muss ein Alias sein (${[...MODEL_ALIASES].join(", ")}), nicht "${model}"` };
  const token = readToken(claude.tokenFile);
  if (token.error) return { ok: false, grund: token.error };
  try { fs.mkdirSync(claude.configDir, { recursive: true, mode: 0o700 }); } catch (error) { return { ok: false, grund: `Konfig-Ordner nicht anlegbar (${error.code || "Fehler"})` }; }
  const env = {
    HOME: config.home,
    PATH: config.path,
    CLAUDE_CONFIG_DIR: claude.configDir,
    CLAUDE_CODE_OAUTH_TOKEN: token.token,
    // Keine Selbst-Aktualisierung, keine Telemetrie: die Version ändert nur der Betreiber.
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    DISABLE_AUTOUPDATER: "1",
  };
  const version = await execText(claude.executable, ["--version"], env);
  if (version.error) return { ok: false, grund: version.error.code === "ENOENT" ? `Claude-CLI nicht gefunden (${claude.executable})` : `Claude-CLI antwortet nicht (--version: ${version.error.code || version.error.message})` };
  const match = version.stdout.match(/(\d+\.\d+\.\d+)/);
  if (!match) return { ok: false, grund: "Claude-CLI-Version nicht lesbar" };
  const auth = await execText(claude.executable, ["auth", "status"], env);
  let status = null;
  try { status = JSON.parse(auth.stdout); } catch { /* unten */ }
  if (!status || status.loggedIn !== true) return { ok: false, grund: "Claude-Anmeldung fehlt (auth status: nicht angemeldet)", cliVersion: match[1] };
  let cliVersionNew = false;
  try { cliVersionNew = recordVersion(config.runsRoot, "claude", match[1]); } catch { /* Protokoll ist Beiwerk */ }
  const reader = claudeStreamReader(ROLE_TOOLS[role]);
  return {
    ok: true,
    engine: {
      name: "claude", model, label: null, cliVersion: match[1], cliVersionNew,
      executable: claude.executable,
      args: claudeArgs(role, { model, context, deniedPaths: [path.dirname(claude.tokenFile), claude.configDir, config.runsRoot, ...claude.deniedPaths] }),
      env, stdin: prompt,
      onLine: reader.onLine, finish: reader.finish,
    },
  };
}

// Codex (vorbereitet, abgeschaltet). Sandbox nach Rechten: nur der runner
// schreibt im Arbeitsordner, alle anderen read-only; nie danger-full-access.
// Codex kennt keine Rolle ganz ohne Werkzeuge — read-only ist die engste Stufe.
export function codexArgs(role, { workspace, finalFile }) {
  if (!ROLES.includes(role)) throw new Error("invalid agent role");
  return [
    "exec", "--json", "--skip-git-repo-check", "--ephemeral", "--ignore-user-config", "--ignore-rules",
    "--sandbox", role === "runner" ? "workspace-write" : "read-only",
    "--cd", workspace, "--output-last-message", finalFile, "-",
  ];
}

export async function prepareCodex(role, prompt, context, config, { workspace, runDir }) {
  const { codex } = config;
  if (!codex.enabled) return { ok: false, grund: "Codex ist nicht zugeschaltet (COCKPIT_CODEX_ENABLED=1 fehlt)" };
  const env = { HOME: config.home, PATH: config.path, CODEX_HOME: codex.home };
  const version = await execText(codex.executable, ["--version"], env);
  if (version.error) return { ok: false, grund: `Codex-CLI nicht verfügbar (${version.error.code || version.error.message})` };
  const match = version.stdout.match(/(\d+\.\d+\.\d+)/);
  if (!match) return { ok: false, grund: "Codex-CLI-Version nicht lesbar" };
  const login = await execText(codex.executable, ["login", "status"], env);
  if (login.error) return { ok: false, grund: "Codex-Anmeldung fehlt (login status)" };
  const finalFile = path.join(runDir, "final.txt");
  return {
    ok: true,
    engine: {
      name: "codex", model: null, label: "Codex-CLI (zweiter Antrieb, nicht Claude)", cliVersion: match[1], cliVersionNew: recordVersion(config.runsRoot, "codex", match[1]),
      executable: codex.executable, args: codexArgs(role, { workspace, finalFile }), env, stdin: `${context}\n\n${prompt}`,
      onLine: () => null,
      finish({ exitCode }) {
        let output = "";
        try { output = fs.readFileSync(finalFile, "utf8"); } catch { /* unten */ }
        if (exitCode !== 0) return { status: "fehler", grund: `Exit ${exitCode}` };
        if (!output.trim()) return { status: "fehler", grund: "leere Antwort" };
        return { status: "erfolg", grund: null, output };
      },
    },
  };
}

// DeepSeek über opencode: nur per ausdrücklichem Schalter COCKPIT_AGENT_ENGINE=opencode.
export function opencodeArgs(role, prompt, { plannerModel, safetyModel }) {
  const model = role === "planner" || role === "research" || role === "runner" ? plannerModel : safetyModel;
  const agent = role === "runner" ? "build" : "plan";
  return { model, args: ["run", "--auto", "--pure", "--agent", agent, ...(model ? ["--model", model] : []), "--print-logs", prompt] };
}

export async function prepareOpencode(role, prompt, context, config) {
  const { opencode } = config;
  const { model, args } = opencodeArgs(role, prompt, opencode);
  let output = "";
  return {
    ok: true,
    engine: {
      name: "opencode", model: model || null, cliVersion: null, cliVersionNew: false,
      label: `DeepSeek/opencode per Schalter COCKPIT_AGENT_ENGINE=opencode (nicht Claude${model ? `, ${model}` : ""})`,
      executable: opencode.executable, args,
      env: { HOME: config.home, PATH: config.path, DEEPSEEK_API_KEY: opencode.deepseekKey, OPENCODE_CONFIG: opencode.config, NODE_ENV: "production" },
      stdin: "",
      onLine(line) { if (output.length < 2_000_000) output += `${line}\n`; return null; },
      finish({ exitCode, stderr }) {
        if (exitCode !== 0) return { status: "fehler", grund: `Exit ${exitCode}: ${stderr.trim().slice(-300)}` };
        return { status: "erfolg", grund: null, output };
      },
    },
  };
}

export async function prepareEngine(role, prompt, context, config, dirs) {
  if (config.engine === "claude") return await prepareClaude(role, prompt, context, config);
  if (config.engine === "codex") return await prepareCodex(role, prompt, context, config, dirs);
  if (config.engine === "opencode") return await prepareOpencode(role, prompt, context, config);
  return { ok: false, grund: `unbekannter Antrieb "${config.engine}"` };
}
