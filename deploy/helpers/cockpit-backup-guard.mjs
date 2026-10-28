// cockpit-backup-guard — Backups löschen nur mit Jochens Freigabe
// (doc/setup/host-run.md, Abschnitt „Backup-Riegel“).
//
// Vorgabe Jochen, 30.09.2026: „Ein Admin muss auch die Backups löschen können.
// Aber halt mit Freigabe.“ Geschärft am 10.10.2026: „Ich bin eh der Meinung,
// dass Updates nicht freigegeben werden müssten.“ Die Freigabe gilt NUR für
// echtes Löschen von Sicherungen; alles andere ist Sache des Türstehers.
//
// Diese Datei ist die eine Quelle der Erkennung: die API
// (apps/api/src/host-run.ts) fragt sie, bevor sie einen Envelope signiert, und
// der Root-Helfer (deploy/helpers/cockpit-host-run, installiert daneben als
// cockpit-backup-guard.mjs) fragt sie noch einmal, bevor er startet.
// Deterministisch, ohne Modell. Gelesen wird jede Zeile, die läuft (Schritte
// und Prüfschritte), samt der Skripte, die der Lauf per Heredoc schreibt.
//
// Zwei Ausgaben:
//
//   backupGuardHits   der Riegel (Art "backup"): der Lauf startet nur mit
//                     operatorApproved, auch wenn der Türsteher grün gibt.
//                     Er greift bei
//                     - borg/borgmatic delete, prune, compact, recreate,
//                       break-lock, Schlüsseländerung, check --repair, einem
//                       borgmatic-Lauf mit fremder Konfiguration oder Override;
//                     - jeder Änderung der Aufbewahrung (keep_*, keepDaily …,
//                       backup_keep_time; der Aufräum-Dienst auf Lab0 außerhalb
//                       seiner Routine);
//                     - Schreiben in die borgmatic-/Retention-Konfiguration,
//                       borg-Schlüssel, Units, Drop-ins und Generatoren;
//                     - Löschen, Verschieben oder Überschreiben (rm, mv, shred,
//                       truncate, dd, find -delete, rsync --delete, git clean)
//                       in Backup-Zielen: borg-Repo, /var/backups,
//                       /var/opt/gitlab/backups — auch über einen Vorfahren
//                       (rm -rf /var) und per ssh auf Lab0;
//                     - Abschalten, Stoppen oder Maskieren der borgmatic- und
//                       Retention-Units (auch per Glob oder Zielwechsel), dem
//                       Entfernen der borg-Pakete, dem Streichen ihres Cron-
//                       Eintrags;
//                     - dem Löschen eines Maschinen-Snapshots
//                       (cockpit-vps-snapshot delete, DELETE …/snapshots). Die
//                       Rotation des Werkzeugs selbst (create räumt den ältesten
//                       eigenen Snapshot) bleibt frei (Jochen, 28.09.2026);
//                     - dem Lesen der Zugangsdaten (borgmatic-Konfiguration,
//                       borg-Schlüssel, Passphrase des Aufräum-Dienstes) und des
//                       Repo-Inhalts (cat, cp, scp, rsync, sshfs …; borg/borgmatic
//                       mount, extract, export-tar, restore). Metadaten (ls, stat,
//                       du, df, test) bleiben frei;
//                     - Code auf Lab0, den der Plan nicht zeigt: ssh zu Lab0 mit
//                       Text aus einer Pipe oder Datei, oder ein Befehl dort, den der
//                       Riegel nicht lesen kann (fremdes Skript, eval, $CMD …).
//                       Sichtbare Routine auf Lab0 (systemctl restart
//                       android-adb.service, Status, Logs) bleibt frei (Jochen,
//                       13.10.2026: „ein umkehrbarer Routineschritt braucht kein Ja“).
//   backupGuardFocus  Hinweise für den Türsteher (Art "mention" oder
//                     "uncertain"), die den Lauf NICHT anhalten: ein Befehl
//                     nennt oder berührt die Backups, ohne zu löschen
//                     (apt-Updates mit borgbackup, docker run mit einer
//                     Einhängung, Lesen); oder der ausgeführte Text ist nicht
//                     der gelesene (eval, Dekodieren, Code aus einer Pipe, ein
//                     Skript, das der Plan nicht zeigt, ein Ziel aus einer
//                     unbekannten Variable, ssh zu einem anderen Rechner). Dort
//                     entscheidet der Türsteher mit Belegpflicht (X4 verlangt,
//                     jede Verschleierung eines Löschbefehls zu melden).
//
// Frei bleiben die Routine und das Lesen: `systemctl start borgmatic.service`,
// ein nacktes `borgmatic` (mit der konfigurierten Aufbewahrung), borg
// list/info/check/create, der Aufräum-Dienst auf Lab0 (doc/setup/borg-retention.md)
// mit `run`, `status` und `set` innerhalb der festen Grenzen
// (cockpit-borg-retention-rules.mjs), Paket-Updates, lesende docker-Befehle,
// Erwähnungen in Kommentaren. Neue Sicherungen anlegen (cp/install/mkdir nach
// /var/backups) löscht nichts und ist frei.
//
// Ehrliche Grenze: Programme, die schon auf dem Host liegen und über ihren
// Namen aufgerufen werden, nimmt der Riegel für das, was ihr Name sagt; ihren
// Inhalt sieht er nicht. Text, den er nicht lesen kann, hält ihn nicht an —
// dafür liest der Türsteher mit (X4) und belegt seinen Befund.

import { classifyRetention, parseRetentionArgs } from "./cockpit-borg-retention-rules.mjs";

export const BACKUP_GUARD_VERSION = "cockpit-backup-guard/v4";

// Was die Backups sind. TOKEN greift im normalisierten Text (ohne Quotes und
// Backslashes), also auch in b"o"rg und bo\rg.
const TOKEN = /borg|backup_vserver|\/media\/raid|\b10\.0\.0\.5\b|\blab0\b|timers\.target|api\.contabo\.com/i;
// Was der Riegel schützt. CONFIG: jedes Schreiben dort ändert, was gesichert
// und wie lange aufbewahrt wird, oder schaltet die Sicherung ab.
const CONFIG = [
  "/etc/borgmatic", "/etc/borgmatic.d", "/root/.config/borg", "/root/.borgmatic",
  "/etc/systemd/system/borgmatic.timer", "/etc/systemd/system/borgmatic.service",
  "/lib/systemd/system/borgmatic.timer", "/lib/systemd/system/borgmatic.service",
  "/usr/lib/systemd/system/borgmatic.timer", "/usr/lib/systemd/system/borgmatic.service",
  "/etc/systemd/system/timers.target.wants/borgmatic.timer",
  "/usr/bin/borg", "/usr/bin/borgmatic", "/usr/local/sbin/cockpit-borg-action",
  // Der Aufräum-Dienst auf Lab0: Einstellung, Passphrase, Vergleichsstand, Code, Units.
  "/etc/cockpit-borg-retention", "/var/lib/cockpit-borg-retention",
  "/usr/local/sbin/cockpit-borg-retention",
  "/usr/local/lib/wireguard-ops-cockpit/cockpit-borg-retention.mjs", "/usr/local/lib/wireguard-ops-cockpit/cockpit-borg-retention-rules.mjs",
  "/etc/systemd/system/cockpit-borg-retention.service", "/etc/systemd/system/cockpit-borg-retention.service.d",
  "/etc/systemd/system/cockpit-borg-retention.timer", "/etc/systemd/system/cockpit-borg-retention.timer.d",
  // Drop-ins, die systemd ebenfalls auf diese Units anwendet, ohne dass ihr Name
  // "borg" enthält: Präfix-Drop-ins (cockpit-.service.d) und globale (service.d),
  // in jedem Unit-Verzeichnis. Darüber ließe sich der Dienst sonst still abschalten.
  ...["/etc/systemd/system", "/etc/systemd/system.control", "/run/systemd/system", "/run/systemd/system.control", "/run/systemd/transient", "/usr/local/lib/systemd/system", "/usr/lib/systemd/system", "/lib/systemd/system"]
    .flatMap((dir) => ["cockpit-.service.d", "cockpit-.timer.d", "service.d", "timer.d"].map((name) => `${dir}/${name}`)),
  // Generatoren schreiben solche Drop-ins beim daemon-reload selbst; portable
  // Units hängen sich über system.attached ein.
  "/etc/systemd/system-generators", "/usr/local/lib/systemd/system-generators", "/usr/lib/systemd/system-generators",
  "/lib/systemd/system-generators", "/run/systemd/system-generators",
  "/run/systemd/generator", "/run/systemd/generator.early", "/run/systemd/generator.late",
  "/etc/systemd/system.attached", "/run/systemd/system.attached",
];
// DATA: die Sicherungen selbst. Löschen, Verschieben, Überschreiben greift;
// eine neue Sicherung dazulegen (cp, install, mkdir) nicht.
const DATA = [
  "/media/RAID/backup_VServer", // das Repo, falls es je eingehängt ist; macht /media zum Vorfahren
  "/var/backups",
  "/var/opt/gitlab/backups",
];
// Lesen ist hier schon der Schaden: die Zugangsdaten (Passphrase, Schlüssel) und
// der Inhalt des Repos. Metadaten (ls, stat, du, df, test …) bleiben frei.
const SECRETS = ["/etc/borgmatic", "/etc/borgmatic.d", "/root/.config/borg", "/root/.borgmatic", "/etc/cockpit-borg-retention"];
const REPO = ["/media/RAID/backup_VServer"];
const GUARDED_READ = [...SECRETS, ...REPO];
const METADATA = new Set(["ls", "stat", "test", "[", "[[", "du", "df", "findmnt", "readlink", "realpath", "basename", "dirname", "lsblk", "file", "wc", "sha256sum", "sha1sum", "md5sum", "b2sum", "cksum", "cd", "pushd", "mountpoint", "namei", "getfacl", "lsattr"]);
const BORG_TOOLS = /^(?:borg|borgmatic|cockpit-borg-action|cockpit-borg-retention)$/;
// Lesen, die einen ganzen Baum durchgehen (grep -r /etc) oder einhängen.
const TREE_READERS = /^(?:rg|sshfs|mount|bindfs|rclone)$/;
const BORG_READ_OUT = new Set(["mount", "extract", "export-tar"]);
const BORGMATIC_READ_OUT = new Set(["mount", "extract", "export-tar", "restore"]);
// Nur Hinweis für den Türsteher: berührt den Rückweg, löscht aber keine Sicherung.
const WATCH = ["/root/.cache/borg", "/root/.ssh"];
const PROTECTED = [...CONFIG, ...DATA, ...WATCH];
const BOLTED = [...CONFIG, ...DATA];
const UNITS = ["borgmatic.timer", "borgmatic.service", "timers.target", "cockpit-borg-retention.timer", "cockpit-borg-retention.service"];
const ancestorsOf = (items) => [...new Set(items.flatMap((item) => {
  const parts = item.split("/").slice(1, -1);
  return ["/", ...parts.map((_, index) => `/${parts.slice(0, index + 1).join("/")}`)];
}))];
const ANCESTORS = ancestorsOf(PROTECTED);
const BOLTED_ANCESTORS = ancestorsOf(BOLTED);
const GUARDED_READ_ANCESTORS = ancestorsOf(GUARDED_READ);
const DEFAULT_CWD = "/"; // cockpit-host-run startet jeden Schritt mit cwd "/"

// Befehle, die einen ganzen Baum treffen: für sie zählt auch ein Vorfahr eines
// geschützten Pfads (rm -rf /etc, mv /root …, docker -v /:/host).
const BULK = new Set(["rm", "rmdir", "mv", "cp", "find", "cd", "pushd", "chroot", "mount", "umount", "rsync", "tar", "unzip", "docker", "podman", "systemd-nspawn", "nsenter", "chmod", "chown", "chgrp", "chattr", "setfacl", "shred", "git"]);
const SHELLS = new Set(["sh", "bash", "dash", "zsh", "ksh", "ash", "mksh", "busybox"]);
const INTERPRETERS = /^(?:python[\d.]*|perl[\d.]*|ruby[\d.]*|node|nodejs|php[\d.]*|lua[\d.]*|tclsh|Rscript|pwsh)$/;
const REMOTE_SHELL = new Set(["ssh", "scp", "sftp", "sshfs", "autossh", "mosh", "sshpass", "rclone"]);
const READ_ONLY = new Set([
  "cat", "head", "tail", "less", "more", "grep", "egrep", "fgrep", "zgrep", "rg", "ls", "stat", "test", "[", "[[", "wc", "du", "df",
  "sha256sum", "sha1sum", "md5sum", "b2sum", "cksum", "file", "readlink", "realpath", "basename", "dirname", "diff", "cmp", "which",
  "whereis", "type", "true", "false", "pgrep", "pidof", "ps", "id", "date", "hostname", "uptime", "free", "lsblk", "findmnt", "getent",
  "jq", "cut", "tr", "column", "nl", "tac", "strings", "zcat", "xzcat", "bzcat", "echo", "printf", "dpkg-query", "apt-cache", "sleep",
  "nproc", "uname", "whoami", "lsof", "ss", "find", "journalctl", "systemctl", "dpkg", "apt", "apt-mark", "command", "curl", "wget",
  "borg", "borgmatic", "cockpit-borg-action", "cockpit-borg-retention", "sort", ":", "docker",
]);
const DOCKER_READ = new Set(["ps", "images", "inspect", "logs", "stats", "version", "info", "top", "port", "diff", "history"]);
const SYSTEMCTL_READ = new Set(["status", "is-active", "is-enabled", "is-failed", "show", "cat", "list-timers", "list-units", "list-unit-files", "list-dependencies", "help"]);
const ROUTINE_UNITS = new Set(["borgmatic", "borgmatic.service", "borgmatic.timer", "cockpit-borg-retention", "cockpit-borg-retention.service", "cockpit-borg-retention.timer"]);
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

// ── Was den Riegel auslöst ─────────────────────────────────────────────────
// Im normalisierten Text eines Befehls (ohne Quotes), auch in sh -c '…', in
// einem Skript, das der Lauf schreibt, oder in einer Cron-Zeile.
const DELETE_PHRASE = /\bborg(?:matic)?\b(?:[\s,[\]()]+[^\s,[\]()]+){0,8}?[\s,[\]()]+(?:delete|prune|compact|recreate|break-lock|rdelete|repo-delete|key[\s,[\]()]+(?:change-passphrase|import|migrate-to-repokey|change-location|change-algorithm))\b/i;
const RETENTION_PHRASE = /\bkeep[_-](?:within|secondly|minutely|hourly|daily|weekly|monthly|yearly|last)\b|\bbackup_keep_time\b|\bkeep(?:Daily|Weekly|Monthly)\b/i;
const SNAPSHOT_DELETE = /\bcockpit-vps-snapshot\s+delete\b|(?:\s-[a-zA-Z]*X|--request)[\s=]*DELETE\b[^\n]*\/snapshots\b|\/snapshots\b[^\n]*(?:\s-[a-zA-Z]*X|--request)[\s=]*DELETE\b/i;
const BORG_DELETE = new Set(["delete", "prune", "compact", "recreate", "break-lock", "rdelete", "repo-delete"]);
const BORG_KEY_CHANGE = new Set(["change-passphrase", "import", "migrate-to-repokey", "change-location", "change-algorithm"]);
const BORGMATIC_DELETE = new Set([...BORG_DELETE, "borg", "key"]);
const BORGMATIC_ALL_ACTIONS = new Set([...BORGMATIC_ACTIONS, ...BORGMATIC_DELETE, "extract", "restore", "mount", "umount", "export-tar", "config", "bootstrap", "generate", "validate", "spot", "transfer", "rcreate", "repo-create", "init", "export"]);
// Diese Verben lassen eine Unit laufen oder lesen sie; alle anderen (stop,
// disable, mask, kill, edit, revert, set-property, freeze …) halten sie an.
const UNIT_KEEPS = new Set([...SYSTEMCTL_READ, "start", "restart", "reload", "try-restart", "reload-or-restart", "try-reload-or-restart", "enable", "reenable", "unmask", "reset-failed", "daemon-reload"]);
const ECHOES = new Set(["echo", "printf", "logger"]);
// Löschen ganzer Bäume: für sie zählt auch ein Vorfahr (rm -rf /var).
const DELETERS = new Set(["rm", "rmdir", "shred", "unlink", "wipe", "srm"]);
// Schreiben, das eine vorhandene Datei überschreibt oder unbrauchbar macht.
const OVERWRITERS = new Set(["truncate", "dd", "chattr"]);
// Schreiben in eine Datei oder einen Baum (Konfiguration ändern).
const WRITERS = new Set(["tee", "sed", "perl", "touch", "ln", "install", "cp", "mv", "rsync", "chmod", "chown", "chgrp", "setfacl", "tar", "unzip", "patch", "git", ...OVERWRITERS]);
const CODE_DELETE = /\b(?:unlink|rmtree|remove|rmdir|rename|replace|truncate|move|rm_rf|rm_r|delete|rm|mv|shred|dd|wipe)\b|\bfind\b[^\n]*\s-delete\b|\brsync\b[^\n]*\s--del/;
const CODE_WRITE = /\b(?:open|write|write_text|write_bytes|writeFile|writeFileSync|copy|copyfile|symlink|chmod|chown)\b/;

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

// Der Quote, der am Ende einer Zeile noch offen ist ('…<NL>…'), ausgehend vom
// Quote, der am Anfang offen war. null: alle Quotes geschlossen.
function openQuoteAfter(line, quote) {
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (quote === "'") { if (char === "'") quote = null; continue; }
    if (char === "\\") { i += 1; continue; }
    if (quote === '"') { if (char === '"') quote = null; continue; }
    if (char === "'" || char === '"') { quote = char; continue; }
    if (char === "#" && (i === 0 || /[\s;&|()]/.test(line[i - 1]))) break;
  }
  return quote;
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
      const dashC = words.slice(i).findIndex((word) => word === "-c" || word === "--command");
      if (dashC >= 0) { i += dashC + 1; continue; }
      if (name === "su") { i = words.length; continue; } // su ohne -c startet nur eine Shell
      skipOptions(new Set(["-u", "--user", "-g", "--group", "-G", "--supp-group", "-s", "--shell", "-w", "--whitelist-environment"])); // runuser -u borg -- borg compact
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
// list: welche Orte zählen (Vorgabe: alles, was den Rückweg berührt).
// {a,b/c} → a, b/c (auch verschachtelt, höchstens 64 Varianten).
function expandBraces(path, limit = 64) {
  const open = path.search(/\{[^{}]*,[^{}]*\}/);
  if (open < 0) return [path];
  const close = path.indexOf("}", open);
  const variants = path.slice(open + 1, close).split(",").flatMap((alt) => expandBraces(path.slice(0, open) + alt + path.slice(close + 1), limit));
  return variants.length > limit ? [path.slice(0, open) + "*" + path.slice(close + 1)] : variants;
}

function pathTouches(path, bulk, list = PROTECTED, ancestors = ANCESTORS) {
  if (/\{[^{}]*,[^{}]*\}/.test(path)) return expandBraces(path).some((variant) => pathTouches(resolvePath(variant, "/"), bulk, list, ancestors));
  if (GLOB.test(path)) {
    // Ein Glob trifft einen geschützten Ort, wenn seine ersten Teile auf ihn
    // passen (dann liegt jeder Treffer darin), oder — bei Bäumen — wenn er auf
    // einen seiner Vorfahren passt.
    const parts = path.split("/").slice(1);
    return list.some((item) => {
      const itemParts = item.split("/").slice(1);
      if (parts.length >= itemParts.length) return globRegex(`/${parts.slice(0, itemParts.length).join("/")}`).test(item);
      return bulk && globRegex(path).test(`/${itemParts.slice(0, parts.length).join("/")}`);
    }) || (bulk && ancestors.some((item) => globRegex(path).test(item)));
  }
  return list.some((item) => within(path, item) || (bulk && within(item, path)));
}
const touchesConfig = (path) => pathTouches(path, false, CONFIG, []);
const DATA_ANCESTORS = ancestorsOf(DATA);
const touchesData = (path, bulk) => pathTouches(path, bulk, DATA, DATA_ANCESTORS);
const touchesBolted = (path) => pathTouches(path, true, BOLTED, BOLTED_ANCESTORS);
const touchesGuardedRead = (path, tree) => pathTouches(path, tree, GUARDED_READ, GUARDED_READ_ANCESTORS);

// Quellen einer Eingabe-Umleitung (cat < f, done < f); nicht <<, <<<, <(, <&.
function inputSources(text) {
  const sources = [];
  const pattern = /(?:^|[^<\d])\d*<(?![<(&])\s*([^\s;&|<>()]+)/g;
  let match;
  while ((match = pattern.exec(text)) !== null) sources.push(match[1]);
  return sources.filter((source) => source !== "/dev/null");
}

// Liest der Befehl die Zugangsdaten der Sicherung oder den Inhalt des Repos?
// Metadaten (ls, stat, du, df, test …) und die borg-Werkzeuge selbst nicht; was
// borg/borgmatic aus dem Repo holen, prüft segmentBolt. Ein Baum (grep -r /etc,
// cp -a /etc, tar c /root, sshfs lab0:/media) zählt auch über einen Vorfahren.
function readBolt(text, command, name, cwds) {
  const resolveAll = (list) => list.filter((target) => !target.includes(OPAQUE)).flatMap((target) => [...cwds].map((cwd) => resolvePath(target, cwd)));
  const reads = (paths, tree) => (paths.some((path) => touchesGuardedRead(path, tree)) ? "reads the backup credentials (borgmatic configuration, borg keys, retention passphrase) or the borg repository" : null);
  if (!METADATA.has(name)) { const viaInput = reads(resolveAll(inputSources(text)), false); if (viaInput) return viaInput; }
  if (!name || METADATA.has(name) || ECHOES.has(name) || BORG_TOOLS.test(name)) return null;
  const { args } = command;
  if (name === "find" && !args.some((arg) => /^-(?:exec|execdir|ok|okdir|fprint0?|fprintf|fls)$/.test(arg))) return null;
  const tree = TREE_READERS.test(name) || name === "rsync" || name === "find"
    || (/^(?:grep|egrep|fgrep|zgrep)$/.test(name) && args.some((arg) => /^-[a-zA-Z]*[rR]|^--(?:dereference-)?recursive$/.test(arg)))
    || (/^(?:cp|scp|zip)$/.test(name) && args.some((arg) => /^-[a-zA-Z]*[rRa]|^--recursive$|^--archive$/.test(arg)))
    || (name === "tar" && args.some((arg) => /^-?[a-zA-Z]*c[a-zA-Z]*$/.test(arg) || arg === "--create"));
  return reads(resolveAll((name === "find" ? findStarts(args) : pathWords(args, name)).filter((word) => word !== "{}" && word !== "{}+")), tree);
}

// Die Wörter eines Befehls, die Pfade sein können, aufgelöst gegen jedes cwd.
function pathWords(args, name) {
  const values = [];
  let skipFirst = name === "chmod" || name === "chown" || name === "chgrp";
  for (const arg of args) {
    if (arg.startsWith("-") && !arg.includes("=")) continue;
    if (arg.includes("{{")) continue; // Go-Vorlage (docker --format '{{.Names}}'), kein Pfad
    if (skipFirst) { skipFirst = false; continue; }
    // Kommas trennen Werte (--opt=a,b), aber nicht in {a,b} (Klammer-Expansion).
    for (const piece of arg.split(arg.includes("{") ? /[=:]/ : /[=:,]/)) if (piece) values.push(piece);
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
    case "cockpit-borg-action": return (args.length === 1 && (args[0] === "status" || args[0] === "check")) || (args.length === 2 && args[0] === "db-access" && (args[1] === "status" || args[1] === "check"));
    case "cockpit-borg-retention": return retentionRoutine(args);
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
    case "docker": {
      // Lesen am lokalen Daemon: ps, images, inspect, logs, stats, version, info …
      if (args.some((arg) => arg === "-H" || arg.startsWith("--host"))) return false;
      const { verb, rest } = firstVerb(args, new Set(["--context", "-c", "--config", "-l", "--log-level"]));
      if (DOCKER_READ.has(verb)) return true;
      const sub = firstVerb(rest, new Set(["-f", "--file", "-p", "--project-name", "--project-directory", "--profile", "--env-file"])).verb;
      return (verb === "compose" && ["ps", "config", "logs", "ls", "images", "version", "top"].includes(sub))
        || (["image", "container", "volume", "network", "context", "system"].includes(verb) && ["ls", "list", "inspect", "show", "df", "info"].includes(sub));
    }
    default: return true;
  }
}

// Der Aufräum-Dienst: status, run und eine Einstellung innerhalb der Grenzen
// sind Routine. Unter der Untergrenze (--freigabe), freigeben und jede andere
// Form brauchen die Freigabe.
function retentionRoutine(args) {
  if (args.length === 1) return args[0] === "status" || args[0] === "run";
  if (args[0] !== "set" || args.length !== 5) return false;
  const verdict = classifyRetention(parseRetentionArgs(args.slice(1)));
  return verdict.ok && verdict.belowMinimum.length === 0;
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

// ── Riegel ─────────────────────────────────────────────────────────────────

// Im normalisierten Text: ein Löschbefehl, eine Aufbewahrung, ein Snapshot-Löschen.
function phraseBolt(text) {
  if (DELETE_PHRASE.test(text)) return "deletes backups (borg/borgmatic delete, prune, compact, recreate, break-lock or a key change)";
  if (RETENTION_PHRASE.test(text)) return "changes the retention of the backups";
  if (SNAPSHOT_DELETE.test(text)) return "deletes a machine snapshot";
  return null;
}

// Reine Datendateien: Notizen, Logs, Tabellen. Jede andere Datei kann später
// als root laufen (Skript, Cron, logrotate-Hook, gitlab.rb, udev, .bashrc …).
const DATA_ONLY = /\.(?:md|txt|log|csv|tsv|json|ya?ml\.example)$|^\/var\/log\/|^\/run\/[^/]+\/[^/]+\.(?:json|txt|log)$/;
function runnableTarget(path, context) {
  return context.executed.has(path) || !DATA_ONLY.test(path);
}

const pathTokens = (text) => (text.match(/(?:^|[\s=:'"(,])(\/[^\s;|&<>()`,:='"]*)/g) || []).map((token) => resolvePath(token.replace(/^[\s=:'"(,]/, ""), "/"));
const namesUnit = (path) => path.split("/").some((part) => UNITS.some((unit) => part === unit || part === `${unit}.d`));

// Eine Zeile Code einer anderen Sprache (python <<EOF, perl -e '…') oder Daten,
// die später laufen können (Cron-Zeile, Unit).
function codeBolt(raw) {
  const normalized = normalize(raw);
  const phrase = phraseBolt(normalized);
  if (phrase) return phrase;
  const paths = pathTokens(normalized);
  if (CODE_DELETE.test(raw) && paths.some((path) => touchesBolted(path) || namesUnit(path))) return "code that deletes or moves backups or their configuration";
  if (CODE_WRITE.test(raw) && paths.some((path) => touchesConfig(path) || namesUnit(path))) return "code that writes the backup configuration, retention or timer";
  return null;
}

function analyzeScript(prefix, text, context, hits, language = "shell") {
  const hit = (where, kind, reason, code) => hits.push({ where, kind, reason, code: clip(code.trim()) });

  // Roh: Verschleierung ist ein Hinweis für den Türsteher.
  const rawCheck = (id, raw) => {
    for (const [pattern, reason] of OBFUSCATION) if (pattern.test(raw)) hit(id, "uncertain", reason, raw);
  };
  const codeCheck = (id, raw, what) => {
    const bolt = codeBolt(raw);
    if (bolt) hit(id, "backup", bolt, raw);
    else if (TOKEN.test(normalize(raw))) hit(id, "mention", `${what} that names the backups`, raw);
  };

  if (language !== "shell") {
    // Code einer anderen Sprache (python <<EOF, geschriebenes .py): Löschworte
    // und Pfade binden; Prozesse, Dateien oder dynamischer Code sind Hinweise.
    text.split("\n").forEach((raw, index) => {
      const id = `${prefix}:L${index + 1}`;
      rawCheck(id, raw);
      codeCheck(id, raw, "code");
      if (CODE_PRIMITIVES.test(raw)) hit(id, "uncertain", `${language} code that starts processes, touches files or builds code at run time`, raw);
    });
    return;
  }

  const { lines, heredocs } = splitScript(prefix, text);

  // Erster Durchgang: Ersetzungen, Segmente, Variablen, Arbeitsverzeichnisse.
  const prepared = lines.map((line) => {
    rawCheck(line.id, line.raw);
    // Eingebetteter Code einer anderen Sprache ist kein Shell-Text: er wird auf
    // Löschworte, Pfade und Primitive geprüft und hier durch CODE ersetzt.
    const shellCode = line.code.replace(INLINE_CODE, (_, flag, program) => {
      codeCheck(line.id, program, "inline code");
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

  // ssh lab0 '<NL>python3 -c …<NL>': ein Quote, der über das Zeilenende reicht,
  // trägt den Befehl nach Lab0 in die Folgezeilen. Dort ist jedes Löschen und
  // alles, was der Riegel nicht lesen kann, ein Treffer — wie in derselben Zeile.
  let quote = null;
  let lab0Block = null;
  for (const { line, segments } of prepared) {
    const code = line.raw;
    const onLab0Block = quote ? lab0Block : null;
    quote = openQuoteAfter(line.raw, quote);
    if (!quote) lab0Block = null;
    else if (!onLab0Block) lab0Block = segments.map((segment) => commandOf(segment.words, false)).map((head) => (head.word ? remoteCommand(baseName(head.word), head.args) : null)).find((remote) => remote && remote.lab0)?.host || null;
    if (onLab0Block && REMOTE_DELETE.test(` ${line.raw}`)) hit(line.id, "backup", `deletes on Lab0 (${onLab0Block}), the machine that holds the borg repository`, code);
    // Code, den der Riegel nicht liest (python -c, awk system(), sed …e). Geht
    // die Zeile per ssh nach Lab0, ist er dort ein Treffer: der Inline-Code ist
    // oben schon durch CODE ersetzt, die Analyse des ssh-Befehls sieht ihn nicht.
    const unreadable = [];
    if (INLINE_INTERPRETER.test(line.code) && CODE_PRIMITIVES.test(line.code)) unreadable.push("inline interpreter code that starts processes, touches files or builds code at run time");
    if (/\b[gm]?awk\b/.test(line.code) && AWK_PRIMITIVES.test(line.code)) unreadable.push("awk that runs commands or writes files");
    if (/\bsed\b[^|;]*\s(?:-[a-zA-Z]*e\s+)?\S*(?:\/[gpIiMm0-9]*e[gpIiMm0-9]*(?:\s|$)|(?:^|;)\s*e\b)/.test(normalize(line.code))) unreadable.push("sed that executes its pattern space");
    for (const reason of unreadable) hit(line.id, "uncertain", reason, code);
    if (unreadable.length > 0) {
      const toLab0 = segments.map((segment) => commandOf(segment.words, false)).map((head) => (head.word ? remoteCommand(baseName(head.word), head.args) : null)).find((remote) => remote && remote.lab0);
      for (const reason of toLab0 ? unreadable : []) hit(line.id, "backup", `on Lab0 (${toLab0.host}), the machine that holds the borg repository: ${reason}`, code);
    }
    // Was ein Backup-Befehl ausgibt, darf nicht in einen schreibenden Befehl
    // fließen. In crontab heißt das: der Eintrag der Sicherung wird gestrichen
    // (crontab -l | grep -v borgmatic | crontab -); sonst ein Hinweis.
    // Ebenso: ein Löschwort, das echo/printf in eine Pipe gibt (echo 'borg
    // delete' | tee s.sh), und Pfade aus find, die xargs löscht.
    let carry = false;
    let echoed = null;
    let found = [];
    // ssh lab0 'a; b | c': was nach einem Trenner in Quotes kommt, läuft auf Lab0.
    // Dort ist jedes Löschen und alles, was der Riegel nicht lesen kann, ein Treffer.
    let lab0 = null;
    for (const segment of segments) {
      if (!segment.quoted) lab0 = null;
      const onLab0 = lab0;
      const segmentHit = !onLab0 ? hit : (where, kind, reason, text) => {
        hit(where, kind, reason, text);
        if (kind === "uncertain") hit(where, "backup", `on Lab0 (${onLab0}), the machine that holds the borg repository: ${reason}`, text);
      };
      const variants = expandText(segment.text, resolve);
      if (!variants) { segmentHit(line.id, "uncertain", "too many values for the variables in this command", code); continue; }
      if (onLab0 && REMOTE_DELETE.test(` ${segment.text}`)) hit(line.id, "backup", `deletes on Lab0 (${onLab0}), the machine that holds the borg repository`, code);
      const head = commandOf(segment.words, false);
      const remote = head.word ? remoteCommand(baseName(head.word), head.args) : null;
      if (remote && remote.lab0) lab0 = remote.host;
      let touching = false;
      let nextEchoed = null;
      let nextFound = [];
      for (const text of variants) {
        const result = checkSegment(text, segment, line, context, cwds, segmentHit);
        if (segment.piped && carry && !result.readOnly) {
          if (result.name === "crontab") hit(line.id, "backup", "rewrites the crontab from output about the backups: that drops or changes their schedule", code);
          else hit(line.id, "mention", "output about the backups flows into a command that changes something", code);
        }
        if (segment.piped && echoed && (result.runsInput || (echoed.retention && !result.readOnly))) hit(line.id, "backup", `${echoed.reason} (text piped into ${result.name || "a command"})`, code);
        if (segment.piped && result.deletesFromInput && found.some((path) => touchesBolted(path))) hit(line.id, "backup", `${result.name} deletes what find lists in the backups`, code);
        touching ||= result.touching;
        nextEchoed ||= result.echoed;
        nextFound.push(...result.found);
      }
      carry = segment.piped ? carry || touching : touching;
      echoed = segment.piped ? echoed || nextEchoed : nextEchoed;
      found = segment.piped ? [...found, ...nextFound] : nextFound;
    }
    if (onLab0Block) {
      for (const item of hits.filter((found) => found.where === line.id && found.kind === "uncertain")) {
        hit(line.id, "backup", `on Lab0 (${onLab0Block}), the machine that holds the borg repository: ${item.reason}`, code);
      }
    }
  }

  // Heredocs: ein Skript, das dieser Lauf schreibt und ausführt, wird wie
  // seine Schritte geprüft; Daten (Konfiguration, Cron, Unit) auf Löschworte,
  // Aufbewahrung und Pfade, ExecStart=-Zeilen einer Unit als Befehle. Wohin der
  // Heredoc schreibt, prüft checkSegment an seiner Kopfzeile (Umleitung, tee).
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
    else if (name === "source" || name === "." || SHELLS.has(name) || /^(?:ssh|autossh)$/.test(name)) language = "shell";
    else if (INTERPRETERS.test(name)) language = name;
    else if (targets.some((target) => context.executed.has(target))) language = shebang && INTERPRETERS.test(baseName(shebang)) ? baseName(shebang) : "shell";
    if (language) {
      const sub = [];
      analyzeScript(bodyPrefix, bodyText, context, sub, language);
      for (const item of sub) hits.push({ ...item, where: shiftLine(item.where, offset) });
      const remote = remoteCommand(name, command.args.filter((arg) => !arg.startsWith("<<")));
      if (remote && remote.lab0 && REMOTE_DELETE.test(` ${bodyText}`)) hit(heredoc.line.id, "backup", `deletes on Lab0 (${remote.host}), the machine that holds the borg repository`, heredoc.line.raw);
      const unclear = remote && remote.lab0 && sub.find((item) => item.kind === "uncertain");
      if (unclear) hit(heredoc.line.id, "backup", `on Lab0 (${remote.host}), the machine that holds the borg repository: ${unclear.reason}`, heredoc.line.raw);
      continue;
    }
    // cat <<EOF ohne Umleitung und ohne Pipe gibt nur Text aus.
    const printsOnly = targets.length === 0 && name === "cat" && !/\|/.test(heredoc.line.code);
    const runnable = !printsOnly && (targets.length === 0 || Boolean(shebang) || targets.some((target) => runnableTarget(target, context)));
    for (const item of heredoc.body) {
      rawCheck(item.id, item.raw);
      const bolt = runnable ? codeBolt(item.raw) : (RETENTION_PHRASE.test(normalize(item.raw)) ? "changes the retention of the backups" : null);
      if (bolt) hit(item.id, "backup", `a file this run writes: ${bolt.replace(/^code that /, "")}`, item.raw);
      else if (TOKEN.test(normalize(item.raw)) || redirectOrPathTouches(normalize(item.raw))) hit(item.id, "mention", "a file this run writes names the backups", item.raw);
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

// Der Befehl, den ssh auf dem anderen Rechner ausführt, und wohin.
const SSH_VALUED = new Set(["-b", "-c", "-D", "-E", "-e", "-F", "-I", "-i", "-J", "-L", "-l", "-m", "-O", "-o", "-p", "-Q", "-R", "-S", "-W", "-w", "-B"]);
// lab0: das Ziel ist Lab0, auch über eine Option (-o HostName=10.0.0.5, -J lab0).
// Ein Heredoc-Wort (<<EOF) gehört nicht zum Befehl; den Heredoc liest analyzeScript.
function remoteCommand(name, args) {
  if (!/^(?:ssh|autossh|mosh)$/.test(name)) return null;
  let i = 0;
  while (i < args.length && args[i].startsWith("-")) { if (SSH_VALUED.has(args[i])) i += 1; i += 1; }
  if (i >= args.length) return null;
  const lab0 = LAB0_HOST.test(args[i]) || args.slice(0, i).some((arg) => LAB0_HOST.test(arg.replace(/^-o\s*\w+=|^\w+=/i, "")));
  return { host: args[i], lab0, command: args.slice(i + 1).filter((arg) => !/^<<-?\S*$/.test(arg)).join(" ").replace(/<<-?\s*\S+/g, " ").trim() };
}
const LAB0_HOST = /\b10\.0\.0\.5\b|\blab0\b|^borg@/i;
const REMOTE_DELETE = /(?:^|[\s;&|"'(`])(?:sudo\s+)?(?:rm|rmdir|mv|shred|unlink|truncate|dd|wipefs|mkfs\S*|lvremove|vgremove|zfs\s+destroy|btrfs\s+subvolume\s+delete)\s|\bfind\b[^\n]*\s-delete\b|\brsync\b[^\n]*\s--delete/;

// Schlägt der Riegel bei diesem einfachen Befehl an? Liefert den Grund oder null.
function segmentBolt(text, command, name, readOnly, cwds, context, line, piped) {
  const { args } = command;
  // Lesen ist nie Löschen. echo/printf/logger geben Text aus: ein Löschwort
  // darin zählt erst, wenn es in eine Datei geht (hier) oder in eine Pipe
  // (analyzeScript, am nächsten Befehl).
  if (ECHOES.has(name)) {
    // Text in eine Datei: eine Aufbewahrung zählt immer (gitlab.rb, Konfig),
    // ein Löschbefehl nur, wenn die Datei später läuft (Skript, Cron, Unit).
    const targets = redirectTargets(text).flatMap((target) => [...cwds].map((cwd) => resolvePath(target, cwd)));
    if (targets.length === 0) return null;
    if (RETENTION_PHRASE.test(text)) return "changes the retention of the backups";
    if (targets.some((target) => runnableTarget(target, context))) { const phrase = codeBolt(text); if (phrase) return `text written into a file that can run: ${phrase.replace(/^code that /, "")}`; }
  } else if (!readOnly) {
    const phrase = phraseBolt(text);
    if (phrase) return phrase;
  }
  // Auch ein Lesebefehl: Zugangsdaten und Repo-Inhalt (cat /etc/borgmatic/config.yaml).
  const read = readBolt(text, command, name, cwds);
  if (read) return read;
  // ssh nach Lab0, das seinen Befehl aus einer Pipe oder Datei liest: der Text,
  // der dort läuft, steht nicht im Plan (ein Heredoc wird eigens gelesen).
  const remote = remoteCommand(name, args);
  if (remote && remote.lab0 && (piped || inputSources(text).length > 0)) return `runs text from a pipe or file on Lab0 (${remote.host}), the machine that holds the borg repository`;
  if (readOnly) return null;

  if (name === "borg") {
    const key = args.indexOf("key");
    if (args.some((arg) => BORG_DELETE.has(arg)) || (key >= 0 && BORG_KEY_CHANGE.has(args[key + 1]))) return "deletes backups (borg delete, prune, compact, recreate, break-lock or a key change)";
    if (args.includes("--repair")) return "borg check --repair can delete archives";
    if (args.some((arg) => BORG_READ_OUT.has(arg))) return "reads backup contents out of the repository (borg mount, extract or export-tar)";
  }
  if (name === "borgmatic") {
    if (args.some((arg) => BORGMATIC_DELETE.has(arg))) return "deletes backups (borgmatic delete, prune, compact, recreate, break-lock, key or raw borg)";
    if (args.includes("--repair")) return "borgmatic check --repair can delete archives";
    if (args.some((arg) => BORGMATIC_READ_OUT.has(arg))) return "reads backup contents out of the repository (borgmatic mount, extract, export-tar or restore)";
    const actions = args.filter((arg) => BORGMATIC_ALL_ACTIONS.has(arg));
    if (actions.length === 0 && args.some((arg) => /^(?:-c|--config|--override)(?:=|$)/.test(arg))) return "a borgmatic run with another configuration or an override prunes with other retention";
  }
  if (name === "cockpit-borg-retention" && !retentionRoutine(args)) return "the retention service outside its routine (below its minimum, resumed after an anomaly, or another form)";
  if (INTERPRETERS.test(name)) {
    const index = args.findIndex((arg) => baseName(arg) === "cockpit-borg-retention.mjs");
    if (index >= 0 && !retentionRoutine(args.slice(index + 1))) return "the retention service outside its routine";
  }
  // db-access (Karte t_30c9ea52) richtet nur den DB-Zugang des Backups ein bzw.
  // spielt dessen alte Optionsdatei zurück: es löscht kein Archiv, ändert keine
  // Aufbewahrung und schaltet nichts ab — frei wie status und check.
  const dbAccess = args.length === 2 && args[0] === "db-access" && ["status", "check", "ensure", "adopt", "restore"].includes(args[1]);
  if (name === "cockpit-borg-action" && !dbAccess && !(args.length === 1 && (args[0] === "status" || args[0] === "check"))) return "the backup helper outside status, check and db-access (repair can delete archives)";

  // Die Units der Sicherung und des Aufräum-Dienstes anhalten, abschalten, maskieren.
  if (/^(?:systemctl|service|invoke-rc\.d|deb-systemd-invoke|update-rc\.d)$/.test(name)) {
    const named = args.some((arg) => !arg.startsWith("-") && UNITS.some((unit) => arg === unit || `${arg}.service` === unit || (GLOB.test(arg) && globRegex(arg).test(unit))));
    if (name === "systemctl") {
      const { verb } = firstVerb(args, new Set(["-H", "--host", "-M", "--machine", "-t", "--type", "-p", "--property", "-o", "--output", "-n", "--lines", "--state", "--signal", "-s", "--kill-whom", "--root"]));
      if (verb && /^(?:isolate|rescue|emergency)$/.test(verb)) return "switching the target stops every timer, borgmatic.timer too";
      if (named && verb && !UNIT_KEEPS.has(verb)) return `systemctl ${verb} stops or switches off the backup or retention unit`;
    } else if (named && args.some((arg) => /^(?:stop|disable|mask|remove|kill)$/.test(arg))) {
      return `${name} stops or switches off the backup or retention unit`;
    }
  }
  if (/^(?:init|telinit)$/.test(name) && args.length > 0) return "switching the runlevel stops every timer, borgmatic.timer too";

  // Die Pakete der Sicherung entfernen.
  if (/^(?:apt|apt-get|aptitude)$/.test(name) && /^(?:remove|purge|autoremove)$/.test(firstVerb(args, new Set(["-o", "-t", "-c"])).verb || "") && args.some((arg) => /borg/i.test(arg))) return "removes the backup software";
  if (name === "dpkg" && args.some((arg) => /^(?:-r|-P|--remove|--purge)$/.test(arg)) && args.some((arg) => /borg/i.test(arg))) return "removes the backup software";

  // Pfade: löschen, überschreiben, schreiben.
  const resolveAll = (list) => list.filter((target) => !target.includes(OPAQUE) && target !== "{}").map((target) => target.replaceAll("{}", "*")).flatMap((target) => [...cwds].map((cwd) => resolvePath(target, cwd)));
  const words = pathWords(args, name);
  const operands = args.filter((arg) => !arg.startsWith("-"));
  let deleted = [];
  let overwritten = [];
  const written = resolveAll(redirectTargets(text));
  if (DELETERS.has(name) || name === "mv" || (name === "git" && args.some((arg) => arg === "clean" || arg === "rm"))) deleted = resolveAll(words);
  else if (name === "find") {
    const exec = args.findIndex((arg) => /^-(?:exec|execdir|ok|okdir)$/.test(arg));
    if (args.includes("-delete") || (exec >= 0 && /^(?:rm|rmdir|shred|unlink|mv)$/.test(baseName(args[exec + 1] || "")))) deleted = resolveAll(findStarts(args));
  } else if (name === "rsync") {
    const dest = operands.at(-1);
    if (args.some((arg) => arg.startsWith("--remove-source-files"))) deleted = resolveAll(words);
    else if (dest && args.some((arg) => /^--(?:delete|del\b)/.test(arg))) deleted = resolveAll(dest.split(/[=:,]/).filter(Boolean));
    if (dest) written.push(...resolveAll(dest.split(/[=:,]/).filter(Boolean)));
  } else if (OVERWRITERS.has(name)) {
    overwritten = name === "dd" ? resolveAll(args.filter((arg) => arg.startsWith("of=")).map((arg) => arg.slice(3))) : resolveAll(words);
  } else if (name === "cp" || name === "install" || name === "ln") {
    const target = args.find((arg, index) => args[index - 1] === "-t" || args[index - 1] === "--target-directory") || args.find((arg) => arg.startsWith("--target-directory="))?.slice(19);
    written.push(...resolveAll(name === "install" && args.includes("-d") ? operands : [target || operands.at(-1)].filter(Boolean)));
  } else if (name === "sed" || name === "perl") {
    // Nur mit -i schreiben sie eine Datei, und dann überschreiben sie sie.
    if (args.some((arg) => /^-[a-zA-Z]*i/.test(arg) || arg.startsWith("--in-place"))) { written.push(...resolveAll(words)); overwritten = resolveAll(words); }
  } else if (WRITERS.has(name)) written.push(...resolveAll(words));

  // 5: Ein Optionswert aus mehreren Wörtern in Quotes (systemd-run --description
  // "alte Sicherungen" rm …) verschiebt das Befehlswort. Darum zählt auch ein
  // Löschbefehl weiter hinten in einem Befehl, der nicht nur liest.
  const later = words.length === 0 ? -1 : command.args.findIndex((arg) => DELETERS.has(baseName(arg)) || baseName(arg) === "mv");
  if (later >= 0 && !DELETERS.has(name) && name !== "mv" && name !== "find") deleted.push(...resolveAll(pathWords(command.args.slice(later + 1), "rm")));

  if (deleted.some((path) => touchesBolted(path) || namesUnit(path))) return `${name} deletes or moves backups or their configuration`;
  if (overwritten.some((path) => touchesConfig(path) || touchesData(path, false) || namesUnit(path))) return `${name} overwrites backups or their configuration`;
  if (written.some((path) => touchesConfig(path) || namesUnit(path))) return `${name} writes the backup configuration, retention, keys or timer`;

  // Auf Lab0, dem Rechner mit dem borg-Repo: jedes Löschen, und jeder Befehl,
  // den der Riegel nicht lesen kann (dort ist er selbst der Weg zum Repo).
  if (remote && remote.command) {
    const sub = [];
    analyzeScript(`${line.id}>`, remote.command, context, sub);
    const inner = sub.find((item) => item.kind === "backup");
    if (inner) return `over ${name}: ${inner.reason}`;
    if (remote.lab0 && REMOTE_DELETE.test(` ${remote.command}`)) return `deletes on Lab0 (${remote.host}), the machine that holds the borg repository`;
    const unclear = remote.lab0 && sub.find((item) => item.kind === "uncertain");
    if (unclear) return `on Lab0 (${remote.host}), the machine that holds the borg repository: ${unclear.reason}`;
  }
  return null;
}

// Die Startpfade von find: nach -H/-L/-P/-O3/-D <x>, bis zum ersten Ausdruck.
function findStarts(args) {
  let i = 0;
  while (i < args.length && /^-(?:H|L|P|O\d*|D)$/.test(args[i])) i += args[i] === "-D" ? 2 : 1;
  const starts = [];
  for (; i < args.length && !args[i].startsWith("-") && args[i] !== "(" && args[i] !== "!"; i += 1) starts.push(args[i]);
  return starts;
}

// Paketpflege: borgbackup oder borgmatic unter den Paketen ist kein Hinweis.
function packageRoutine(command) {
  const name = command.word ? baseName(command.word) : "";
  const verb = firstVerb(command.args, new Set(["-o", "-t", "-c"])).verb || "";
  if (/^(?:apt|apt-get|aptitude)$/.test(name)) return /^(?:install|upgrade|update|dist-upgrade|full-upgrade|reinstall)$/.test(verb);
  if (name === "dpkg") return command.args.some((arg) => /^(?:-i|--install|--configure|-l|-s|-L)$/.test(arg));
  return false;
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
    // Nur Zuweisungen, oder ein Vorsatz ohne erkennbaren Befehl (runuser -u borg -- …).
    const bolt = phraseBolt(text) || readBolt(text, command, "", cwds);
    if (bolt) hit(line.id, "backup", bolt, code);
    else if (TOKEN.test(text)) hit(line.id, "mention", "a value that names the backups", code);
    return { touching: TOKEN.test(text), readOnly: true, name, deletesFromInput: false, runsInput: false, echoed: null, found: [] };
  }

  // Wer läuft? Ein dynamischer Name ist unsicher.
  if (word.includes(OPAQUE) || word.startsWith("$") || !quoted && GLOB.test(word)) {
    hit(line.id, "uncertain", "the command name is built at run time", code);
    const bolt = phraseBolt(text);
    if (bolt) hit(line.id, "backup", bolt, code);
    return { touching: true, readOnly: false, name, deletesFromInput: false, runsInput: true, echoed: null, found: [] };
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
  // lenken können. Ein Schleifenkopf tut selbst nichts.
  if (text.includes(OPAQUE) && !/^(?:for|select|case)$/.test(name) && !toleratesOpaque(command, text)) {
    hit(line.id, "uncertain", "a target or argument comes from a value this plan does not show", code);
  }

  // Der Riegel: löscht oder verkürzt der Befehl Sicherungen, schaltet er sie ab?
  const readOnly = readOnlyForm(strict, text);
  const bolt = segmentBolt(text, command, name, readOnly, cwds, context, line, piped);
  if (bolt) hit(line.id, "backup", bolt, code);

  // Sonst: nennt oder berührt er die Backups? Dann ist es ein Hinweis.
  const bulk = BULK.has(name) && (!/^(?:chmod|chown|chgrp|setfacl|cp)$/.test(name) || command.args.some((arg) => /^-[a-zA-Z]*[rRa]|^--recursive$|^--archive$/.test(arg)));
  const destructive = BULK.has(name) || /^(?:ln|install|truncate|dd|tee|sed|perl|cp|touch|unlink)$/.test(name);
  const targets = [...redirectTargets(text), ...pathWords(command.args, name).filter((piece) => piece.includes("/") || GLOB.test(piece) || piece.startsWith(".") || destructive)];
  const touchesPath = targets.some((target) => !target.includes(OPAQUE) && [...cwds].some((cwd) => pathTouches(resolvePath(target, cwd), bulk)));
  const unitGlob = /^(?:systemctl|service|invoke-rc\.d|deb-systemd-invoke|update-rc\.d)$/.test(name)
    && command.args.some((arg) => GLOB.test(arg) && UNITS.some((unit) => globRegex(arg).test(unit)));
  const touching = TOKEN.test(text) || touchesPath || unitGlob;
  if (touching && !readOnly && !bolt && !packageRoutine(command)) {
    hit(line.id, "mention", `${name} names or touches the backups without deleting them; the doorkeeper decides`, code);
  }
  return {
    touching, readOnly, name,
    deletesFromInput: command.prefixes.includes("xargs") && (DELETERS.has(name) || name === "mv"),
    // Führt der Befehl seine Eingabe aus oder schreibt er sie dorthin, wo sie
    // später laufen kann? Frei: Lesen, logger, tee/Umleitung nur in Datendateien.
    runsInput: !readOnly && !ECHOES.has(name) && !(name === "tee" && command.args.filter((arg) => !arg.startsWith("-"))
      .flatMap((target) => [...cwds].map((cwd) => resolvePath(target, cwd))).every((target) => !runnableTarget(target, context))),
    echoed: ECHOES.has(name) && codeBolt(text) ? { reason: codeBolt(text), retention: RETENTION_PHRASE.test(text) } : null,
    found: name === "find" ? findStarts(command.args).filter((start) => !start.includes(OPAQUE)).flatMap((start) => [...cwds].map((cwd) => resolvePath(start, cwd))) : [],
  };
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

// Alle Stellen eines host-run-Manifests, an denen der Riegel oder der
// Türsteher hinsehen soll.
function analyzeManifest(manifest) {
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
      // Was der Riegel nicht lesen kann, ist ein Hinweis; ein Löschwort im Text
      // hält den Lauf trotzdem an.
      hits.push({ where: prefix, kind: "uncertain", reason: `the backup guard could not read this script (${String(error?.message || error).slice(0, 120)})`, code: clip(text) });
      const bolt = phraseBolt(normalize(text));
      if (bolt) hits.push({ where: prefix, kind: "backup", reason: bolt, code: clip(text) });
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

// Der Riegel: jeder Treffer braucht Jochens Freigabe. Leer: der Riegel hat
// nichts gegen den Lauf.
export function backupGuardHits(manifest) {
  return analyzeManifest(manifest).filter((item) => item.kind === "backup");
}

// Hinweise für den Türsteher; sie halten den Lauf nicht an.
export function backupGuardFocus(manifest) {
  return analyzeManifest(manifest).filter((item) => item.kind !== "backup");
}
