// cockpit-backup-guard — Backups löschen nur mit Jochens Freigabe
// (doc/setup/host-run.md, Abschnitt „Backup-Riegel“).
//
// Vorgabe Jochen, 30.09.2026: „Ein Admin muss auch die Backups löschen können.
// Aber halt mit Freigabe.“ Diese Datei ist die eine Quelle der Erkennung: die
// API (apps/api/src/host-run.ts) fragt sie, bevor sie einen Envelope signiert,
// und der Root-Helfer (deploy/helpers/cockpit-host-run, installiert daneben
// als cockpit-backup-guard.mjs) fragt sie noch einmal, bevor er startet. Ein
// Treffer heißt: der Lauf startet nur mit operatorApproved, auch wenn der
// Türsteher grün gibt.
//
// Deterministisch, ohne Modell. Gelesen wird jede Zeile, die läuft (Schritte
// und Prüfschritte), samt der Skripte, die der Lauf per Heredoc schreibt.
//
//   backup     ein Befehl berührt die Backups und ist keine der freien
//              Leseformen: borg/borgmatic außer list/info/check/create, die
//              borgmatic-Konfiguration, borg-Schlüssel und -Cache, die Units
//              borgmatic.timer/.service, timers.target, den Repo-Pfad, Lab0
//              (10.0.0.5).
//   uncertain  der Text, der läuft, ist nicht der Text, der hier steht:
//              ssh zu einem anderen Rechner (ob es Lab0 ist, sagt der Text
//              nicht), eval/Dekodieren, Code aus einer Pipe, ein Skript, das
//              der Lauf nicht selbst schreibt, ein dynamischer Befehlsname,
//              ein Ziel aus einer Variable, deren Wert nicht im Plan steht.
//
// Frei bleibt die Routine: `systemctl start borgmatic.service`, ein nacktes
// `borgmatic` (mit der konfigurierten Aufbewahrung), Lesen und Prüfen.
//
// Ehrliche Grenze: Programme, die schon auf dem Host liegen und über ihren
// Namen aufgerufen werden, nimmt der Riegel für das, was ihr Name sagt; ihren
// Inhalt sieht er nicht. Deshalb liest der Türsteher weiterhin mit (X4).

export const BACKUP_GUARD_VERSION = "cockpit-backup-guard/v1";

// Was die Backups sind. TOKEN greift im normalisierten Text (ohne Quotes und
// Backslashes), also auch in b"o"rg und bo\rg.
const TOKEN = /borg|backup_vserver|\/media\/raid|\b10\.0\.0\.5\b|\blab0\b|timers\.target/i;
const PROTECTED = [
  "/etc/borgmatic", "/etc/borgmatic.d", "/root/.config/borg", "/root/.cache/borg", "/root/.borgmatic", "/root/.ssh",
  "/etc/systemd/system/borgmatic.timer", "/etc/systemd/system/borgmatic.service",
  "/lib/systemd/system/borgmatic.timer", "/lib/systemd/system/borgmatic.service",
  "/usr/lib/systemd/system/borgmatic.timer", "/usr/lib/systemd/system/borgmatic.service",
  "/usr/bin/borg", "/usr/bin/borgmatic", "/usr/local/sbin/cockpit-borg-action",
];
const UNITS = ["borgmatic.timer", "borgmatic.service", "timers.target"];
const ANCESTORS = [...new Set(PROTECTED.flatMap((item) => {
  const parts = item.split("/").slice(1, -1);
  return ["/", ...parts.map((_, index) => `/${parts.slice(0, index + 1).join("/")}`)];
}))];
const DEFAULT_CWD = "/"; // cockpit-host-run startet jeden Schritt mit cwd "/"

// Befehle, die einen ganzen Baum treffen: für sie zählt auch ein Vorfahr eines
// geschützten Pfads (rm -rf /etc, mv /root …, docker -v /:/host).
const BULK = new Set(["rm", "rmdir", "mv", "cp", "find", "cd", "pushd", "chroot", "mount", "umount", "rsync", "tar", "unzip", "docker", "podman", "systemd-nspawn", "nsenter", "chmod", "chown", "chgrp", "chattr", "setfacl", "shred"]);
const SHELLS = new Set(["sh", "bash", "dash", "zsh", "ksh", "ash", "mksh", "busybox"]);
const INTERPRETERS = /^(?:python[\d.]*|perl[\d.]*|ruby[\d.]*|node|nodejs|php[\d.]*|lua[\d.]*|tclsh|Rscript|pwsh)$/;
const REMOTE_SHELL = new Set(["ssh", "scp", "sftp", "sshfs", "autossh", "mosh", "sshpass", "rclone"]);
const READ_ONLY = new Set([
  "cat", "head", "tail", "less", "more", "grep", "egrep", "fgrep", "zgrep", "rg", "ls", "stat", "test", "[", "[[", "wc", "du", "df",
  "sha256sum", "sha1sum", "md5sum", "b2sum", "cksum", "file", "readlink", "realpath", "basename", "dirname", "diff", "cmp", "which",
  "whereis", "type", "true", "false", "pgrep", "pidof", "ps", "id", "date", "hostname", "uptime", "free", "lsblk", "findmnt", "getent",
  "jq", "cut", "tr", "column", "nl", "tac", "strings", "zcat", "xzcat", "bzcat", "echo", "printf", "dpkg-query", "apt-cache", "sleep",
  "nproc", "uname", "whoami", "lsof", "ss", "find", "journalctl", "systemctl", "dpkg", "apt", "apt-mark", "command", "curl", "wget",
  "borg", "borgmatic", "cockpit-borg-action", "sort", ":",
]);
const SYSTEMCTL_READ = new Set(["status", "is-active", "is-enabled", "is-failed", "show", "cat", "list-timers", "list-units", "list-unit-files", "list-dependencies", "help"]);
const ROUTINE_UNITS = new Set(["borgmatic", "borgmatic.service", "borgmatic.timer"]);
const BORG_READ = new Set(["list", "info", "check", "create", "diff", "version", "repo-list", "repo-info"]);
const BORGMATIC_ACTIONS = new Set(["list", "info", "rlist", "rinfo", "repo-list", "repo-info", "check", "create"]);
const BORGMATIC_FLAGS = new Set(["--stats", "--list", "--json", "--progress", "--files", "--force", "--no-color", "--version"]);
const BORGMATIC_VALUED = new Set(["-v", "--verbosity", "--syslog-verbosity", "--log-file-verbosity", "--monitoring-verbosity", "--last", "--first", "--archive", "--repository", "--only"]);
// Wertquellen, deren Ausgabe kein Ziel verstecken kann ($(date +%s), $(uname -r)).
const BENIGN_PRODUCERS = new Set(["date", "uname", "nproc", "id", "whoami", "arch", "hostname", "lsb_release", "seq"]);
// Umgebung, die bestimmt, welcher Code läuft.
const CODE_ENV = /^(?:PATH|BASH_ENV|ENV|LD_PRELOAD|LD_LIBRARY_PATH|LD_AUDIT|PYTHONPATH|PYTHONSTARTUP|PYTHONHOME|PERL5LIB|PERL5OPT|PERLLIB|RUBYOPT|RUBYLIB|NODE_OPTIONS|NODE_PATH|PROMPT_COMMAND|SHELLOPTS|BASHOPTS|GLOBIGNORE|BASH_FUNC_\w*|BORG_\w+|BORGMATIC_\w+)$/;
// Frei zu lesen (setzen nur Variablen).
const SOURCE_OK = new Set(["/etc/os-release", "/usr/lib/os-release", "/etc/lsb-release"]);
// Hier liegen installierte Programme; ein Pfad-Aufruf woandershin ist ein
// Skript, dessen Inhalt der Plan nicht zeigt.
const SYSTEM_PREFIXES = ["/usr/bin/", "/usr/sbin/", "/bin/", "/sbin/", "/usr/local/bin/", "/usr/local/sbin/", "/usr/lib/", "/usr/libexec/", "/usr/share/", "/opt/gitlab/bin/", "/opt/gitlab/embedded/bin/", "/snap/bin/"];

// Roh (vor dem Normalisieren): der ausgeführte Text ist nicht der gelesene.
const OBFUSCATION = [
  [/\beval\b/, "eval runs text that is built at run time"],
  [/\bbase(?:64|32)\b[^\n]*\s(?:-[a-zA-Z]*d\b|--decode\b)|\bxxd\b[^\n]*\s-r\b|\bopenssl\s+(?:enc|base64)\b[^\n]*\s-d\b|\buudecode\b|\bgpg\b[^\n]*\s(?:-d|--decrypt)\b/, "decoded text"],
  [/\$'[^']*\\[0-7xuUc]/, "$'…' escapes hide the real characters"],
  [/\b(?:sftp|scp|ssh):\/\//i, "a transfer to another machine: whether it is Lab0 is not decidable from the text"],
];
const INLINE_CODE = /(\b(?:python[\d.]*|perl[\d.]*|ruby[\d.]*|node|nodejs|php[\d.]*|lua[\d.]*|tclsh|Rscript|pwsh)\s+(?:-[\w-]+\s+)*-(?:c|e|E|r|-eval|-command|Command)\s+)('[^']*'|"(?:[^"\\]|\\.)*")/g;
const INLINE_INTERPRETER = /\b(?:python[\d.]*|perl[\d.]*|ruby[\d.]*|node|nodejs|php[\d.]*|lua[\d.]*|tclsh|Rscript|pwsh)\s+(?:-[\w-]+\s+)*-(?:c|e|E|r|-eval|-command|Command)\b/;
const CODE_PRIMITIVES = /\b(?:system|popen|exec[a-z]*|spawn[a-z]*|fork|subprocess|shutil|pathlib|open|unlink|rmtree|remove|rename|symlink|eval|compile|__import__|importlib|getattr|setattr|globals|chr|fromCharCode|atob|b64decode|decode|codecs|socket|paramiko|ctypes|pty|require|child_process|qx|glob|Buffer|os\s*\.\s*(?!path\b)\w+)\b|`/;
const AWK_PRIMITIVES = /\bsystem\s*\(|\|\s*getline|\|&|\bprint[^;}]*[>|]/;

const OPAQUE = "\u0001";
// Ein Trenner in Quotes (printf 'a;b', sh -c 'x; y'): er trennt weiter (sh -c
// führt ihn aus), aber was danach kommt, ist womöglich nur Text. Klammern
// bleiben, wie sie sind: "$(…)" ist auch in Quotes eine Ersetzung.
const IN_QUOTES = "\u0002";
const QUOTED_SEPARATOR = /[;&|\n]/;
const GLOB = /[*?[\]{}]/;

function clip(text, limit = 300) { return text.length > limit ? `${text.slice(0, limit)} …` : text; }

// ── Zeilen, Heredocs ───────────────────────────────────────────────────────

// Außerhalb von Quotes: wo ein Kommentar beginnt und welche Heredocs die Zeile
// öffnet. Ein "<<X" in Quotes oder in einem Kommentar öffnet keinen.
function scanUnquoted(line) {
  const heredocs = [];
  let quote = null;
  let commentAt = -1;
  let arithmetic = 0; // (( a << b )) und $[ … ] schieben Bits, sie öffnen keinen Heredoc
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (quote === "'") { if (char === "'") quote = null; continue; }
    if (char === "\\") { i += 1; continue; }
    if (quote === '"') { if (char === '"') quote = null; continue; }
    if (char === "'" || char === '"') { quote = char; continue; }
    if (char === "(" && line[i + 1] === "(" || char === "$" && line[i + 1] === "[") { arithmetic += 1; i += 1; continue; }
    if (arithmetic > 0 && (char === ")" && line[i + 1] === ")" || char === "]")) { arithmetic -= 1; if (char === ")") i += 1; continue; }
    if (char === "#" && (i === 0 || /[\s;&|()]/.test(line[i - 1]))) { commentAt = i; break; }
    if (arithmetic === 0 && char === "<" && line[i + 1] === "<" && line[i + 2] !== "<" && line[i - 1] !== "<") {
      const match = line.slice(i + 2).match(/^(-?)\s*(['"]?)\\?([A-Za-z_][\w.-]*)\2/);
      if (match) { heredocs.push({ strip: match[1] === "-", word: match[3] }); i += 1 + match[0].length; }
    }
  }
  return { heredocs, code: commentAt >= 0 ? line.slice(0, commentAt) : line };
}

// Logische Zeilen (Fortsetzungen verbunden) und Heredoc-Körper, jede mit der
// Kennung ihrer ersten physischen Zeile (S<n>:L<n> wie beim Türsteher).
function splitScript(prefix, text) {
  const physical = text.replace(/\r\n/g, "\n").split("\n");
  const lines = [];
  const heredocs = [];
  let index = 0;
  while (index < physical.length) {
    const id = `${prefix}:L${index + 1}`;
    let raw = physical[index];
    index += 1;
    while (/(^|[^\\])(\\\\)*\\$/.test(raw) && index < physical.length) { raw = raw.slice(0, -1) + physical[index]; index += 1; }
    const { heredocs: opened, code } = scanUnquoted(raw);
    const line = { id, raw, code, heredocs: [] };
    lines.push(line);
    for (const doc of opened) {
      const body = [];
      let closed = false;
      while (index < physical.length) {
        const bodyLine = physical[index];
        const bodyId = `${prefix}:L${index + 1}`;
        index += 1;
        if ((doc.strip ? bodyLine.replace(/^\t+/, "") : bodyLine) === doc.word) { closed = true; break; }
        body.push({ id: bodyId, raw: bodyLine });
      }
      const heredoc = { line, body, closed };
      line.heredocs.push(heredoc);
      heredocs.push(heredoc);
    }
  }
  return { lines, heredocs };
}

// ── Normalisieren, Ersetzen, Variablen ─────────────────────────────────────

// Quotes und Backslashes weg (b"o"rg → borg), $IFS ist ein Leerzeichen, ~ und
// $HOME sind /root (der Helfer setzt HOME=/root). Nach \ ist $ kein Wert, und
// in '…' für awk, sed und jq auch nicht (awk '{print $1}'). Sonst bleibt es
// stehen: sh -c '…' führt den Text als Shell aus.
const OWN_LANGUAGE = /(?:^|[;&|(\n])\s*(?:sudo\s+)?(?:\S*\/)?(?:[gm]?awk|sed|jq)\s[^;&|(\n]*$/;
function normalize(code) {
  let out = "";
  let quote = null;
  let literal = false;
  for (let i = 0; i < code.length; i += 1) {
    const char = code[i];
    if (quote === "'") { if (char === "'") quote = null; else if (!literal || char !== "$" && char !== "`") out += QUOTED_SEPARATOR.test(char) ? IN_QUOTES + char : char; continue; }
    if (char === "\\") { const next = code[i + 1] ?? ""; if (next !== "$" && next !== "`") out += next; i += 1; continue; }
    if (char === '"') { quote = quote === '"' ? null : '"'; continue; }
    if (char === "'" && quote === null) { quote = "'"; literal = OWN_LANGUAGE.test(code.slice(0, i)); continue; }
    out += quote && QUOTED_SEPARATOR.test(char) ? IN_QUOTES + char : char;
  }
  return out
    .replace(/\$\{IFS\}|\$IFS\b/g, " ")
    .replace(/\$\{HOME\}|\$HOME\b/g, "/root")
    .replace(/(^|[\s=:])~(?=\/|\s|$)/g, "$1/root");
}

// $(…), `…`, <(…), >(…) und $((…)) werden zu Platzhaltern; ihr Inhalt wird als
// eigene Zeile geprüft. Das Ergebnis ist OPAQUE, außer bei harmlosen Quellen.
function extractSubstitutions(text, inner) {
  let out = "";
  let i = 0;
  while (i < text.length) {
    if (text.startsWith("$((", i)) {
      const end = closing(text, i + 3, "(", ")", 2);
      out += "0"; i = end; continue;
    }
    const opener = text.startsWith("$(", i) ? 2 : (text[i] === "<" || text[i] === ">") && text[i + 1] === "(" ? 2 : 0;
    if (opener) {
      const end = closing(text, i + opener, "(", ")", 1);
      const body = text.slice(i + opener, end - 1);
      const nested = extractSubstitutions(body, inner);
      inner.push(nested);
      out += text[i] === "$" ? producerValue(nested) : OPAQUE;
      i = end; continue;
    }
    if (text[i] === "`") {
      const end = text.indexOf("`", i + 1);
      const body = end < 0 ? text.slice(i + 1) : text.slice(i + 1, end);
      const nested = extractSubstitutions(body, inner);
      inner.push(nested);
      out += producerValue(nested);
      i = end < 0 ? text.length : end + 1; continue;
    }
    out += text[i]; i += 1;
  }
  return out;
}

function closing(text, from, open, close, depth) {
  let level = depth;
  let i = from;
  while (i < text.length && level > 0) {
    if (text[i] === open) level += 1;
    else if (text[i] === close) level -= 1;
    i += 1;
  }
  return i;
}

// Was eine Befehlsersetzung liefert, soweit das feststeht.
function producerValue(body) {
  const words = body.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0 || /[;&|<>]/.test(body)) return OPAQUE;
  const name = baseName(words[0]);
  if (name === "mktemp") {
    const args = words.slice(1);
    if (args.some((arg) => arg.includes(OPAQUE) || arg.includes("$"))) return OPAQUE;
    const dirIndex = args.findIndex((arg) => arg === "-p" || arg === "--tmpdir");
    const inline = args.find((arg) => arg.startsWith("--tmpdir="));
    const template = args.filter((arg, index) => !arg.startsWith("-") && !(dirIndex >= 0 && index === dirIndex + 1)).find((arg) => arg.includes("/"));
    const dir = dirIndex >= 0 ? args[dirIndex + 1] : inline ? inline.slice("--tmpdir=".length) : "/tmp";
    return template || `${dir}/tmp.mktemp`;
  }
  if (BENIGN_PRODUCERS.has(name) && words.slice(1).every((arg) => /^[-+%\w:.=, ]*$/.test(arg))) return "0";
  if (name === "dpkg" && words.slice(1).join(" ") === "--print-architecture") return "0";
  return OPAQUE;
}

// Werte der Variablen eines Skripts, flussunabhängig: alle Werte, die ein Name
// irgendwo bekommt. Unbekannt, dynamisch oder von außen: OPAQUE.
function collectVariables(segmentsOf) {
  const raw = new Map();
  const opaque = new Set();
  const add = (name, value) => { if (!raw.has(name)) raw.set(name, new Set()); raw.get(name).add(value); };
  for (const { words } of segmentsOf) {
    let index = 0;
    while (index < words.length && /^(?:!|if|then|else|elif|do|while|until|time|\{|export|local|declare|typeset|readonly)$/.test(words[index])) {
      if (/^(?:declare|typeset|local|export|readonly)$/.test(words[index]) && words.slice(index + 1).some((word) => /^-\w*n/.test(word))) opaque.add("*");
      index += 1;
      while (index < words.length && /^-\w+$/.test(words[index])) index += 1;
    }
    for (; index < words.length; index += 1) {
      const match = words[index].match(/^([A-Za-z_]\w*)(\+?=)(.*)$/);
      if (!match) break;
      if (match[2] === "+=" || match[3].startsWith("(")) opaque.add(match[1]);
      else add(match[1], match[3]);
    }
    const head = words[index];
    if (head === "for" && /^[A-Za-z_]\w*$/.test(words[index + 1] || "") && words[index + 2] === "in") {
      const items = words.slice(index + 3);
      if (items.length === 0 || items.some((item) => item.includes(OPAQUE))) opaque.add(words[index + 1]);
      else for (const item of items) add(words[index + 1], item);
    } else if (head === "for" || head === "select") {
      if (words[index + 1]) opaque.add(words[index + 1]);
    } else if (head === "read" || head === "mapfile" || head === "readarray" || head === "getopts") {
      for (const word of words.slice(index + 1)) if (/^[A-Za-z_]\w*$/.test(word)) opaque.add(word);
    } else if (head === "printf" && words[index + 1] === "-v" && words[index + 2]) {
      opaque.add(words[index + 2]);
    }
  }
  const resolved = new Map();
  const resolving = new Set();
  const resolve = (name) => {
    if (resolved.has(name)) return resolved.get(name);
    if (opaque.has(name) || opaque.has("*") || !raw.has(name) || resolving.has(name)) return null;
    resolving.add(name);
    const values = [];
    for (const value of raw.get(name)) {
      const expanded = expandText(value, resolve, 16);
      if (!expanded) { resolving.delete(name); resolved.set(name, null); return null; }
      values.push(...expanded);
    }
    resolving.delete(name);
    const result = values.length > 16 || values.some((value) => value.includes(OPAQUE)) ? null : [...new Set(values)];
    resolved.set(name, result);
    return result;
  };
  return resolve;
}

// Setzt bekannte Variablen ein; mehrere Werte ergeben Varianten (höchstens
// limit). Unbekannte Variablen und ${…}-Operatoren werden OPAQUE.
function expandText(text, resolve, limit = 64) {
  let variants = [""];
  const pattern = /\$(?:\{([^}]*)\}|([A-Za-z_]\w*)|([0-9@*#?$!-]))/g;
  let last = 0;
  let match;
  const append = (piece) => { variants = variants.map((variant) => variant + piece); };
  while ((match = pattern.exec(text)) !== null) {
    append(text.slice(last, match.index));
    last = pattern.lastIndex;
    const special = match[3] ?? (match[1] !== undefined && /^[#?$!-]$/.test(match[1]) ? match[1] : null);
    if (special !== null && /^[#?$!-]$/.test(special)) { append("0"); continue; }
    const name = match[2] ?? (match[1] !== undefined && /^[A-Za-z_]\w*$/.test(match[1]) ? match[1] : null);
    const values = name ? resolve(name) : null;
    if (!values) { append(OPAQUE); continue; }
    if (values.length === 1) { append(values[0]); continue; }
    if (variants.length * values.length > limit) return null;
    variants = variants.flatMap((variant) => values.map((value) => variant + value));
  }
  append(text.slice(last));
  return variants;
}

// ── Segmente ───────────────────────────────────────────────────────────────

// Einfache Befehle einer Zeile, mit der Angabe, ob sie aus einer Pipe lesen.
function splitSegments(text) {
  const cleaned = text
    .replace(/\d*>&\d*-?/g, " ")
    .replace(/&>>?/g, ">")
    .replace(/>\|/g, ">");
  const segments = [];
  let current = "";
  let piped = false;
  let nextPiped = false;
  let quoted = false;
  let nextQuoted = false;
  const push = () => {
    if (current.trim()) segments.push({ text: current.trim(), piped, quoted });
    current = ""; piped = nextPiped; nextPiped = false; quoted = nextQuoted; nextQuoted = false;
  };
  for (let i = 0; i < cleaned.length; i += 1) {
    if (cleaned[i] === IN_QUOTES) { nextQuoted = true; continue; }
    const char = cleaned[i];
    if (char === "|" && cleaned[i + 1] === "|") { push(); piped = false; i += 1; continue; }
    if (char === "|" && cleaned[i + 1] === IN_QUOTES && cleaned[i + 2] === "|") { push(); piped = false; i += 2; continue; }
    if (char === "&" && cleaned[i + 1] === "&") { push(); piped = false; i += 1; continue; }
    if (char === "&" && cleaned[i + 1] === IN_QUOTES && cleaned[i + 2] === "&") { push(); piped = false; i += 2; continue; }
    if (char === "|") { nextPiped = true; push(); continue; }
    if (char === ";" || char === "&" || char === "(" || char === ")" || char === "\n") { push(); piped = false; continue; }
    current += char;
  }
  push();
  return segments;
}

function baseName(word) {
  const clean = word.replace(/^[({]+/, "");
  return clean.includes("/") ? clean.slice(clean.lastIndexOf("/") + 1) : clean;
}

const KEYWORDS = /^(?:!|if|then|else|elif|fi|do|done|while|until|time|\{|\}|case|esac|in|function)$/;

// Schlüsselwörter, Zuweisungen und Vorsätze (sudo, env, timeout, xargs, sh -c …)
// vor dem eigentlichen Befehl. strict: nur die harmlosen Vorsätze, die eine
// freie Leseform tragen darf.
function commandOf(words, strict) {
  const assignments = [];
  const prefixes = [];
  let i = 0;
  let ok = true;
  let problem = null;
  let fromStdin = false;
  const skipOptions = (valued = new Set(), allowed = null) => {
    while (i < words.length && words[i].startsWith("-") && words[i] !== "--") {
      if (allowed && !allowed.test(words[i])) ok = false;
      if (valued.has(words[i])) i += 1;
      i += 1;
    }
    if (words[i] === "--") i += 1;
  };
  for (;;) {
    while (i < words.length && KEYWORDS.test(words[i])) i += 1;
    if (/^(?:export|local|declare|typeset|readonly)$/.test(words[i] || "")) {
      i += 1;
      while (i < words.length && /^[-+]\w+$/.test(words[i])) { if (/^-\w*n/.test(words[i])) { ok = false; problem = "a name reference makes one variable stand for another"; } i += 1; }
      while (i < words.length && /^[A-Za-z_]\w*(?:\+?=|$)/.test(words[i])) { if (words[i].includes("=")) assignments.push(words[i]); i += 1; }
      continue;
    }
    while (i < words.length && /^[A-Za-z_]\w*\+?=/.test(words[i])) { assignments.push(words[i]); i += 1; }
    if (i >= words.length) break;
    const name = baseName(words[i]);
    if (name === "sudo" || name === "doas") {
      prefixes.push(name); i += 1;
      skipOptions(new Set(["-u", "-g", "-C", "-D", "-h", "-p", "-r", "-t", "-U", "-T"]), strict ? /^-n$/ : null);
      if (words[i - 1] === "-s" || words[i - 1] === "-i") fromStdin = true;
      continue;
    }
    if (name === "env") {
      prefixes.push(name); i += 1;
      if (words.slice(i).some((word) => word === "-S" || word.startsWith("--split-string"))) { ok = false; problem = "env -S splits a string into a command"; }
      skipOptions(new Set(["-u", "--unset", "-C", "--chdir"]), strict ? /^$/ : null);
      continue;
    }
    if (name === "timeout") { prefixes.push(name); i += 1; skipOptions(new Set(["-s", "-k", "--signal", "--kill-after"]), strict ? /^$/ : null); i += 1; continue; }
    if (name === "nice") { prefixes.push(name); i += 1; skipOptions(new Set(["-n"]), strict ? /^-(?:n|\d+)$/ : null); continue; }
    if (name === "ionice") { prefixes.push(name); i += 1; skipOptions(new Set(["-c", "-n"]), strict ? /^-(?:c|n)\d*$/ : null); continue; }
    if (name === "command" && words[i + 1] !== "-v" && words[i + 1] !== "-V") { prefixes.push(name); i += 1; continue; }
    if (strict) break;
    if (/^(?:exec|builtin|nohup|setsid|unbuffer|stdbuf|time|chrt|taskset|busybox|sshpass)$/.test(name)) {
      prefixes.push(name); i += 1;
      skipOptions(new Set(["-a", "-p", "-f", "-i", "-o", "-e"]));
      if ((name === "chrt" || name === "taskset") && i < words.length) i += 1;
      continue;
    }
    if (name === "flock") {
      prefixes.push(name); i += 1;
      skipOptions(new Set(["-w", "-E", "--timeout", "--conflict-exit-code"]));
      if (words[i - 1] === "-c" || words[i - 1] === "--command") continue;
      i += 1; // die Sperrdatei
      if (words[i] === "-c") i += 1;
      continue;
    }
    if (name === "systemd-run") {
      prefixes.push(name); i += 1;
      skipOptions(new Set(["-p", "--property", "-u", "--unit", "--uid", "--gid", "-E", "--setenv", "--description", "--slice", "-M", "--machine", "-H", "--host", "--working-directory", "--nice", "--on-active", "--on-boot", "--on-startup", "--on-unit-active", "--on-unit-inactive", "--on-calendar", "--timer-property", "--path-property", "--socket-property", "--service-type", "-s"]));
      continue;
    }
    if (name === "xargs") {
      prefixes.push(name); i += 1;
      skipOptions(new Set(["-I", "-d", "-n", "-P", "-L", "-s", "-E", "-a", "--arg-file", "--delimiter", "--max-args", "--max-procs"]));
      fromStdin = true;
      continue;
    }
    if (name === "watch") { prefixes.push(name); i += 1; skipOptions(new Set(["-n", "--interval", "-d"])); continue; }
    if (name === "chroot") { prefixes.push(name); i += 1; skipOptions(new Set(["--userspec", "--groups"])); i += 1; continue; }
    if (name === "runuser" || name === "su") {
      prefixes.push(name); i += 1;
      while (i < words.length && words[i] !== "-c" && words[i] !== "--command") i += 1;
      i += 1;
      continue;
    }
    if (SHELLS.has(name) && leadingOptions(words, i + 1).some((word) => /^-[a-zA-Z]*c[a-zA-Z]*$/.test(word))) {
      prefixes.push(name); i += 1;
      while (i < words.length && words[i].startsWith("-")) { const flag = words[i]; i += 1; if (/c/.test(flag)) break; }
      continue;
    }
    break;
  }
  return { assignments, prefixes, word: words[i], args: words.slice(i + 1), ok, problem, fromStdin };
}

function leadingOptions(words, from) {
  const options = [];
  for (let i = from; i < words.length && words[i].startsWith("-"); i += 1) options.push(words[i]);
  return options;
}

function redirectTargets(text) {
  const targets = [];
  const pattern = /(?:^|[^<>])>>?\s*([^\s;&|<>]+)/g;
  let match;
  while ((match = pattern.exec(text)) !== null) targets.push(match[1]);
  return targets.filter((target) => !/^\/dev\/(?:null|stdout|stderr|fd\/[12])$/.test(target));
}

// ── Pfade ──────────────────────────────────────────────────────────────────

function resolvePath(path, cwd) {
  const absolute = path.startsWith("/") ? path : `${cwd.replace(/\/$/, "")}/${path}`;
  const out = [];
  for (const part of absolute.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") out.pop(); else out.push(part);
  }
  return `/${out.join("/")}`;
}

function globRegex(glob) {
  let pattern = "";
  for (let i = 0; i < glob.length; i += 1) {
    const char = glob[i];
    if (char === "*") pattern += "[^/]*";
    else if (char === "?") pattern += "[^/]";
    else if (char === "[") { const end = glob.indexOf("]", i + 1); if (end < 0) pattern += "\\["; else { pattern += `[${glob.slice(i + 1, end).replace(/^!/, "^").replace(/\\/g, "\\\\")}]`; i = end; } }
    else if (char === "{") { const end = glob.indexOf("}", i + 1); if (end < 0) pattern += "\\{"; else { pattern += `(?:${glob.slice(i + 1, end).split(",").map((alt) => alt.replace(/[.+^$()|\\]/g, "\\$&").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]")).join("|")})`; i = end; } }
    else pattern += char.replace(/[.+^$()|\\\]}]/g, "\\$&");
  }
  try { return new RegExp(`^${pattern}$`, "i"); } catch { return /^.*$/; }
}

const within = (path, root) => path === root || path.startsWith(root === "/" ? "/" : `${root}/`);

// Berührt dieser (aufgelöste) Pfad die Backups? bulk: der Befehl trifft ganze
// Bäume, dann zählt auch ein Vorfahr.
function pathTouches(path, bulk) {
  if (GLOB.test(path)) {
    const regex = globRegex(path);
    if ([...PROTECTED, ...(bulk ? ANCESTORS : [])].some((item) => regex.test(item))) return true;
    const literal = path.slice(0, path.search(GLOB));
    const dir = literal.slice(0, literal.lastIndexOf("/")) || "/";
    return PROTECTED.some((item) => within(dir, item)) || (bulk && PROTECTED.some((item) => within(item, dir)));
  }
  return PROTECTED.some((item) => within(path, item) || (bulk && within(item, path)));
}

// Die Wörter eines Befehls, die Pfade sein können, aufgelöst gegen jedes cwd.
function pathWords(args, name) {
  const values = [];
  let skipFirst = name === "chmod" || name === "chown" || name === "chgrp";
  for (const arg of args) {
    if (arg.startsWith("-") && !arg.includes("=")) continue;
    if (skipFirst) { skipFirst = false; continue; }
    for (const piece of arg.split(/[=:,]/)) if (piece) values.push(piece);
  }
  return values;
}

// ── Leseformen ─────────────────────────────────────────────────────────────

function firstVerb(args, valued = new Set()) {
  for (let i = 0; i < args.length; i += 1) {
    if (args[i].startsWith("-")) { if (valued.has(args[i])) i += 1; continue; }
    return { verb: args[i], rest: args.slice(i + 1) };
  }
  return { verb: null, rest: [] };
}

function borgmaticReadOnly(args) {
  if (args.includes("--repair")) return false;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (BORGMATIC_ACTIONS.has(arg) || BORGMATIC_FLAGS.has(arg)) continue;
    if (BORGMATIC_VALUED.has(arg)) { i += 1; continue; }
    if (/^(?:-v-?\d|--(?:verbosity|syslog-verbosity|log-file-verbosity|monitoring-verbosity)=-?\d|--(?:last|first)=\d+)$/.test(arg)) continue;
    return false;
  }
  return true;
}

// Eine der freien Formen: lesen, prüfen, sichern, die Routine starten.
function readOnlyForm(command, segmentText) {
  const { word, args, ok, assignments } = command;
  if (!ok || !word || word.includes(OPAQUE)) return false;
  if (assignments.some((item) => CODE_ENV.test(item.split("=")[0]))) return false;
  if (redirectTargets(segmentText).length > 0) return false;
  const name = baseName(word);
  if (word.includes("/") && !SYSTEM_PREFIXES.some((prefix) => word.startsWith(prefix))) return false;
  if (!READ_ONLY.has(name)) return false;
  const joined = ` ${args.join(" ")} `;
  switch (name) {
    case "borg": {
      if (/\s--repair\b/.test(joined)) return false;
      const { verb } = firstVerb(args);
      return verb !== null && BORG_READ.has(verb) || args.includes("--version");
    }
    case "borgmatic": return borgmaticReadOnly(args);
    case "cockpit-borg-action": return args.length === 1 && (args[0] === "status" || args[0] === "check");
    case "systemctl": {
      const { verb, rest } = firstVerb(args, new Set(["-H", "--host", "-M", "--machine", "-t", "--type", "-p", "--property", "-o", "--output", "-n", "--lines", "--state"]));
      if (args.some((arg) => arg === "-H" || arg.startsWith("--host") || arg === "-M" || arg.startsWith("--machine"))) return false;
      if (verb && SYSTEMCTL_READ.has(verb)) return true;
      return verb === "start" && rest.length > 0 && rest.every((unit) => ROUTINE_UNITS.has(unit));
    }
    case "journalctl": return !/\s--(?:vacuum-\w+|rotate|flush|relinquish-var|setup-keys|sync)\b/.test(joined);
    case "find": return !/\s-(?:delete|exec|execdir|ok|okdir|fprint0?|fprintf|fls)\b/.test(joined);
    case "sort": return !/\s(?:-o|--output)\b/.test(joined);
    case "curl": return !/\s(?:-[a-zA-Z]*[oODcKdFTXbu]|--(?:output|remote-name|dump-header|cookie-jar|config|data|json|form|upload-file|request|post|user))\b/.test(joined);
    case "wget": return /\s(?:-q?O\s*-|--spider)(?:\s|$)/.test(joined) && !/\s--(?:post|method|body)/.test(joined);
    case "dpkg": return /^\s(?:-l|-s|-L|-S|--status|--list|--listfiles|--search|--print-architecture)\b/.test(joined);
    case "apt": return ["list", "show", "policy", "search"].includes(firstVerb(args).verb || "");
    case "apt-mark": return /^show/.test(firstVerb(args).verb || "");
    case "command": return args[0] === "-v" || args[0] === "-V";
    default: return true;
  }
}

// Befehle, deren Wirkung ein unbekannter Wert nicht auf die Backups lenken
// kann: Lesen, Ausgeben, Pakete aus den Quellen holen.
function toleratesOpaque(command, segmentText) {
  const name = command.word ? baseName(command.word) : "";
  if (redirectTargets(segmentText).some((target) => target.includes(OPAQUE))) return false;
  if (command.fromStdin) return false;
  if (name === "echo" || name === "printf" && command.args[0] !== "-v") return true;
  if ((name === "apt-get" || name === "apt") && ["install", "upgrade", "update", "dist-upgrade", "full-upgrade"].includes(firstVerb(command.args, new Set(["-o", "-t", "-c"])).verb || "")) return true;
  if (name === "docker" && firstVerb(command.args).verb === "pull") return true;
  return readOnlyForm(command, segmentText.replace(/(?:^|[^<>])>>?\s*\S+/g, " "));
}

// ── Prüfen ─────────────────────────────────────────────────────────────────

function analyzeScript(prefix, text, context, hits, language = "shell") {
  const hit = (where, kind, reason, code) => hits.push({ where, kind, reason, code: clip(code.trim()) });

  // Roh: Verschleierung, und jede Zeile, die ein Backup-Wort trägt, wird unten
  // als Befehl geprüft; in Daten-Heredocs reicht das Wort selbst.
  const rawCheck = (id, raw) => {
    for (const [pattern, reason] of OBFUSCATION) if (pattern.test(raw)) hit(id, "uncertain", reason, raw);
  };

  if (language !== "shell") {
    // Code einer anderen Sprache (python <<EOF, geschriebenes .py): nur Worte
    // und Primitive; Prozesse, Dateien oder dynamischer Code machen es unsicher.
    text.split("\n").forEach((raw, index) => {
      const id = `${prefix}:L${index + 1}`;
      rawCheck(id, raw);
      if (TOKEN.test(normalize(raw))) hit(id, "backup", "code that names the backups", raw);
      if (CODE_PRIMITIVES.test(raw)) hit(id, "uncertain", `${language} code that starts processes, touches files or builds code at run time`, raw);
    });
    return;
  }

  const { lines, heredocs } = splitScript(prefix, text);

  // Erster Durchgang: Ersetzungen, Segmente, Variablen, Arbeitsverzeichnisse.
  const prepared = lines.map((line) => {
    rawCheck(line.id, line.raw);
    // Eingebetteter Code einer anderen Sprache ist kein Shell-Text: er wird auf
    // Worte und Primitive geprüft (unten) und hier durch CODE ersetzt.
    const shellCode = line.code.replace(INLINE_CODE, (_, flag, program) => {
      if (TOKEN.test(normalize(program))) hit(line.id, "backup", "inline code that names the backups", line.raw);
      return `${flag}CODE`;
    });
    const inner = [];
    const outer = extractSubstitutions(normalize(shellCode), inner);
    const texts = [outer, ...inner];
    const segments = texts.flatMap((part) => splitSegments(part)).map((segment) => ({ ...segment, words: segment.text.split(/\s+/).filter(Boolean) }));
    return { line, segments };
  });
  const resolve = collectVariables(prepared.flatMap((item) => item.segments));
  const cwds = new Set([DEFAULT_CWD]);
  for (const { segments } of prepared) {
    for (const segment of segments) {
      const command = commandOf(segment.words, false);
      if (command.word !== "cd" && command.word !== "pushd") continue;
      const target = command.args.find((arg) => !arg.startsWith("-"));
      for (const variant of target === undefined ? ["/root"] : expandText(target, resolve) || [OPAQUE]) {
        if (variant.startsWith("/") && !variant.includes(OPAQUE)) cwds.add(resolvePath(variant, "/"));
      }
    }
  }

  for (const { line, segments } of prepared) {
    const code = line.raw;
    if (INLINE_INTERPRETER.test(line.code) && CODE_PRIMITIVES.test(line.code)) hit(line.id, "uncertain", "inline interpreter code that starts processes, touches files or builds code at run time", code);
    if (/\b[gm]?awk\b/.test(line.code) && AWK_PRIMITIVES.test(line.code)) hit(line.id, "uncertain", "awk that runs commands or writes files", code);
    if (/\bsed\b[^|;]*\s(?:-[a-zA-Z]*e\s+)?\S*(?:\/[gpIiMm0-9]*e[gpIiMm0-9]*(?:\s|$)|(?:^|;)\s*e\b)/.test(normalize(line.code))) hit(line.id, "uncertain", "sed that executes its pattern space", code);
    // Was ein Backup-Befehl ausgibt, darf nicht in einen schreibenden Befehl
    // fließen (crontab -l | grep -v borgmatic | crontab -).
    let carry = false;
    for (const segment of segments) {
      const variants = expandText(segment.text, resolve);
      if (!variants) { hit(line.id, "uncertain", "too many values for the variables in this command", code); continue; }
      let touching = false;
      for (const text of variants) {
        const result = checkSegment(text, segment, line, context, cwds, hit);
        if (segment.piped && carry && !result.readOnly) hit(line.id, "backup", "output about the backups flows into a command that changes something", code);
        touching ||= result.touching;
      }
      carry = segment.piped ? carry || touching : touching;
    }
  }

  // Heredocs: ein Skript, das dieser Lauf schreibt und ausführt, wird wie
  // seine Schritte geprüft; Daten (Konfiguration) auf Backup-Worte und
  // Verschleierung, ExecStart=-Zeilen einer Unit als Befehle.
  for (const heredoc of heredocs) {
    const normalized = extractSubstitutions(normalize(heredoc.line.code), []);
    const segment = splitSegments(normalized).find((item) => item.text.includes("<<")) || { text: normalized };
    const command = commandOf(segment.text.split(/\s+/).filter(Boolean), false);
    const name = command.word ? baseName(command.word) : "";
    const targets = [...redirectTargets(segment.text), ...(name === "tee" ? command.args.filter((arg) => !arg.startsWith("-") && !arg.startsWith("<<")) : [])]
      .flatMap((target) => expandText(target, resolve) || []).flatMap((target) => [...cwds].map((cwd) => resolvePath(target, cwd)));
    const bodyText = heredoc.body.map((item) => item.raw).join("\n");
    const firstId = heredoc.body[0]?.id || heredoc.line.id;
    const bodyPrefix = firstId.replace(/:L\d+$/, "");
    const offset = Number(firstId.match(/:L(\d+)$/)?.[1] || 1) - 1;
    const shebang = heredoc.body[0]?.raw.match(/^#!\s*\S*?(?:env\s+)?(\S+)\s*$/)?.[1];
    let language = null;
    if (!heredoc.closed) language = "shell";
    else if (name === "source" || name === "." || SHELLS.has(name)) language = "shell";
    else if (INTERPRETERS.test(name)) language = name;
    else if (targets.some((target) => context.executed.has(target))) language = shebang && INTERPRETERS.test(baseName(shebang)) ? baseName(shebang) : "shell";
    if (language) {
      const sub = [];
      analyzeScript(bodyPrefix, bodyText, context, sub, language);
      for (const item of sub) hits.push({ ...item, where: shiftLine(item.where, offset) });
      continue;
    }
    for (const item of heredoc.body) {
      rawCheck(item.id, item.raw);
      const normalizedBody = normalize(item.raw);
      if (TOKEN.test(normalizedBody) || redirectOrPathTouches(normalizedBody)) hit(item.id, "backup", "a file this run writes names the backups", item.raw);
      const exec = item.raw.match(/^\s*Exec[A-Za-z]*\s*=\s*[-@:+!]*(.*)$/);
      if (exec) {
        const sub = [];
        analyzeScript(item.id.replace(/:L\d+$/, ""), exec[1], context, sub, "shell");
        const line = Number(item.id.match(/:L(\d+)$/)?.[1] || 1) - 1;
        for (const found of sub) hits.push({ ...found, where: shiftLine(found.where, line) });
      }
    }
  }
}

function redirectOrPathTouches(text) {
  return (text.match(/(?:^|[\s=:])(\/[^\s;|&<>()`,:=]*)/g) || []).some((token) => pathTouches(resolvePath(token.replace(/^[\s=:]/, ""), "/"), false));
}

function shiftLine(where, offset) {
  return where.replace(/:L(\d+)$/, (_, line) => `:L${Number(line) + offset}`);
}

function checkSegment(text, { piped, quoted }, line, context, cwds, hit) {
  const code = line.raw;
  const words = text.split(/\s+/).filter(Boolean);
  const command = commandOf(words, false);
  const strict = commandOf(words, true);
  const word = command.word || "";
  const name = baseName(word);

  for (const assignment of command.assignments) {
    if (CODE_ENV.test(assignment.split("=")[0]) && !/^PATH=(?:\/usr\/local\/sbin:\/usr\/local\/bin:\/usr\/sbin:\/usr\/bin:\/sbin:\/bin)?$/.test(assignment)) {
      hit(line.id, "uncertain", `${assignment.split("=")[0]} decides which code runs`, code);
    }
  }
  if (command.problem) hit(line.id, "uncertain", command.problem, code);
  if (!word) {
    if (TOKEN.test(text)) hit(line.id, "backup", "a value that names the backups", code);
    return { touching: TOKEN.test(text), readOnly: true };
  }

  // Wer läuft? Ein dynamischer Name ist unsicher.
  if (word.includes(OPAQUE) || word.startsWith("$") || !quoted && GLOB.test(word)) {
    hit(line.id, "uncertain", "the command name is built at run time", code);
    return { touching: true, readOnly: false };
  }
  if (name === "alias" || name === "hash" && command.args.includes("-p") || name === "enable" && command.args.some((arg) => arg.startsWith("-f"))) {
    hit(line.id, "uncertain", `${name} changes what a command name runs`, code);
  }
  if (REMOTE_SHELL.has(name) || name === "rsync" && command.args.some((arg) => /^[^/\s-][^/\s]*:|::|^rsync:\/\/|^-e|^--rsh/.test(arg))) {
    hit(line.id, "uncertain", `${name} reaches another machine: whether it is Lab0 (the borg repository) is not decidable from the text`, code);
  }

  // Code, den der Plan nicht zeigt.
  const isShell = SHELLS.has(name);
  const isInterpreter = INTERPRETERS.test(name);
  if (piped && (isShell || isInterpreter || name === "source" || name === "." || name === "at" || name === "batch")) {
    hit(line.id, "uncertain", `${name} runs text from a pipe`, code);
  }
  if (command.fromStdin && command.prefixes.includes("xargs") && !readOnlyForm({ ...command, prefixes: [] }, text)) {
    hit(line.id, "uncertain", "xargs builds the arguments from its input", code);
  }
  if (isShell || isInterpreter || name === "source" || name === ".") {
    const args = [...command.args];
    let file = null;
    for (let i = 0; i < args.length; i += 1) {
      if (/^-[mcerE]$|^--eval$|^--command$/.test(args[i])) { file = null; break; }
      if (args[i].startsWith("-")) continue;
      file = args[i]; break;
    }
    if (file !== null) {
      const paths = [...cwds].map((cwd) => resolvePath(file, cwd));
      if (file.includes(OPAQUE) || !paths.some((path) => context.written.has(path) || SOURCE_OK.has(path) || SYSTEM_PREFIXES.some((prefix) => path.startsWith(prefix)))) {
        hit(line.id, "uncertain", `${name} runs a script whose content this plan does not show`, code);
      }
    }
  } else if (word.includes("/")) {
    const paths = [...cwds].map((cwd) => resolvePath(word, cwd));
    if (!paths.some((path) => context.written.has(path) || SYSTEM_PREFIXES.some((prefix) => path.startsWith(prefix)) || path === "/opt/gitlab/bin" || path.startsWith("/opt/gitlab/"))) {
      hit(line.id, "uncertain", "runs a program whose content this plan does not show", code);
    }
  }
  if (name === "cd" || name === "pushd") {
    const target = command.args.find((arg) => !arg.startsWith("-"));
    if (target !== undefined && (!target.startsWith("/") || target.includes(OPAQUE))) hit(line.id, "uncertain", "the working directory becomes one this plan does not name", code);
  }

  // Unbekannte Werte: nur dort frei, wo sie die Wirkung nicht auf die Backups
  // lenken können.
  // Ein Schleifenkopf tut selbst nichts; seine Variable ist dann unbekannt.
  if (text.includes(OPAQUE) && !/^(?:for|select|case)$/.test(name) && !toleratesOpaque(command, text)) {
    hit(line.id, "uncertain", "a target or argument comes from a value this plan does not show", code);
  }

  // Berührt der Befehl die Backups?
  const bulk = BULK.has(name) && (!/^(?:chmod|chown|chgrp|setfacl|cp)$/.test(name) || command.args.some((arg) => /^-[a-zA-Z]*[rRa]|^--recursive$|^--archive$/.test(arg)));
  const destructive = BULK.has(name) || /^(?:ln|install|truncate|dd|tee|sed|perl|cp|touch|unlink)$/.test(name);
  const targets = [...redirectTargets(text), ...pathWords(command.args, name).filter((piece) => piece.includes("/") || GLOB.test(piece) || piece.startsWith(".") || destructive)];
  const touchesPath = targets.some((target) => !target.includes(OPAQUE) && [...cwds].some((cwd) => pathTouches(resolvePath(target, cwd), bulk)));
  const unitGlob = /^(?:systemctl|service|invoke-rc\.d|deb-systemd-invoke|update-rc\.d)$/.test(name)
    && command.args.some((arg) => GLOB.test(arg) && UNITS.some((unit) => globRegex(arg).test(unit)));
  const touching = TOKEN.test(text) || touchesPath || unitGlob;
  const readOnly = readOnlyForm(strict, text);
  if (touching && !readOnly) {
    hit(line.id, "backup", `${name} touches the backups (borg repository, retention, borgmatic configuration or timer)`, code);
  }
  return { touching, readOnly };
}

// Wohin der Lauf per Heredoc schreibt, und was er ausführt: ein geschriebenes
// Skript ist sichtbar, wenn es aus einem Heredoc stammt.
function collectContext(scripts) {
  const written = new Set();
  const executed = new Set();
  for (const { text } of scripts) {
    const { lines, heredocs } = splitScript("X", text);
    for (const heredoc of heredocs) {
      const normalized = extractSubstitutions(normalize(heredoc.line.code), []);
      const segment = splitSegments(normalized).find((item) => item.text.includes("<<")) || { text: normalized };
      const words = segment.text.split(/\s+/).filter(Boolean);
      const command = commandOf(words, false);
      const name = command.word ? baseName(command.word) : "";
      if (!heredoc.closed || !(name === "cat" || name === "tee")) continue;
      const targets = [...redirectTargets(segment.text), ...(name === "tee" ? command.args.filter((arg) => !arg.startsWith("-") && !arg.startsWith("<<")) : [])];
      for (const target of targets) if (target.startsWith("/") && !target.includes("$") && !target.includes(OPAQUE)) written.add(resolvePath(target, "/"));
    }
    for (const line of lines) {
      const normalized = extractSubstitutions(normalize(line.code), []);
      for (const segment of splitSegments(normalized)) {
        const command = commandOf(segment.text.split(/\s+/).filter(Boolean), false);
        if (!command.word) continue;
        const name = baseName(command.word);
        if (command.word.startsWith("/")) executed.add(resolvePath(command.word, "/"));
        if (SHELLS.has(name) || INTERPRETERS.test(name) || name === "source" || name === ".") {
          const file = command.args.find((arg) => !arg.startsWith("-"));
          if (file && file.startsWith("/")) executed.add(resolvePath(file, "/"));
        }
      }
    }
  }
  return { written, executed };
}

// Alle Stellen eines host-run-Manifests, die Jochens Freigabe brauchen.
// Leer: der Riegel hat nichts gegen den Lauf.
export function backupGuardHits(manifest) {
  const scripts = [
    ...(Array.isArray(manifest?.steps) ? manifest.steps : []).flatMap((step, index) => (step && typeof step.run === "string" ? [{ prefix: `S${index + 1}`, text: step.run }] : [])),
    ...(Array.isArray(manifest?.checks) ? manifest.checks : []).flatMap((check, index) => (check && typeof check.run === "string" ? [{ prefix: `C${index + 1}`, text: check.run }] : [])),
  ];
  const context = collectContext(scripts);
  const hits = [];
  for (const { prefix, text } of scripts) {
    try {
      analyzeScript(prefix, text, context, hits);
    } catch (error) {
      // Was der Riegel nicht lesen kann, ist unsicher.
      hits.push({ where: prefix, kind: "uncertain", reason: `the backup guard could not read this script (${String(error?.message || error).slice(0, 120)})`, code: clip(text) });
    }
  }
  const seen = new Set();
  return hits.filter((item) => {
    const key = `${item.where}|${item.kind}|${item.reason}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
