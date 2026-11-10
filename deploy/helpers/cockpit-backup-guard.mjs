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
//                     - auf dem Proxmox-Host (Rolle box, Karte t_5f5c89fe; der
//                       Riegel gilt rollenunabhängig, anderswo gibt es die
//                       Werkzeuge nicht): vzdump-Sicherungen löschen, kürzen oder
//                       verschieben (/var/lib/vz/dump, /mnt/pve/<speicher>/dump,
//                       vzdump-*, *.vma*), pvesm free auf …:backup/…, pvesm
//                       prune-backups, vzdump --remove, prune-backups/maxfiles
//                       ändern (pvesm, pvesh, /etc/vzdump.conf, /etc/pve/
//                       storage.cfg, /etc/pve/jobs.cfg), einen Backup-Auftrag
//                       ändern oder löschen, qm|pct delsnapshot|rollback|destroy
//                       und ihre API-Formen (pvesh, curl auf /api2/…). Die
//                       Rotation von cockpit-host-snapshot (delsnapshot im
//                       Helfer, create auch aus dem Plan) bleibt frei, ein
//                       delsnapshot im Plan nicht — auch nicht für cockpit-run-*;
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

export const BACKUP_GUARD_VERSION = "cockpit-backup-guard/v6";

// Was die Backups sind. TOKEN greift im normalisierten Text (ohne Quotes und
// Backslashes), also auch in b"o"rg und bo\rg.
const TOKEN = /borg|backup_vserver|\/media\/raid|\b10\.0\.0\.5\b|\blab0\b|timers\.target|api\.contabo\.com|vzdump|\/var\/lib\/vz\/dump/i;
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
  // Proxmox (Rolle box): Aufbewahrung, Ziel und Zeitplan der vzdump-Sicherungen.
  "/etc/vzdump.conf", "/etc/pve/storage.cfg", "/etc/pve/jobs.cfg", "/etc/pve/vzdump.cron", "/etc/cron.d/vzdump",
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
  "/var/lib/vz/dump", // vzdump-Sicherungen im Speicher local (Rolle box); weitere Speicher: vzdumpTouches
];
// Lesen ist hier schon der Schaden: die Zugangsdaten (Passphrase, Schlüssel) und
// der Inhalt des Repos. Metadaten (ls, stat, du, df, test …) bleiben frei.
const SECRETS = ["/etc/borgmatic", "/etc/borgmatic.d", "/root/.config/borg", "/root/.borgmatic", "/etc/cockpit-borg-retention"];
const REPO = ["/media/RAID/backup_VServer"];
const GUARDED_READ = [...SECRETS, ...REPO];
const METADATA = new Set(["ls", "stat", "test", "[", "[[", "du", "df", "findmnt", "readlink", "realpath", "basename", "dirname", "lsblk", "file", "wc", "sha256sum", "sha1sum", "md5sum", "b2sum", "cksum", "cd", "pushd", "mountpoint", "namei", "getfacl", "lsattr"]);
const BORG_TOOLS = /^(?:borg|borgmatic|cockpit-borg-action|cockpit-borg-retention)$/;
// Backup-Quellen ergänzen (Karte t_2b394537, Jochen 31.10.2026: „Ergänzen ja,
// Schwächen nein“): frei sind nur `sources status` und `sources add <pfad>` mit
// einem wörtlichen Pfad mindestens eine Ebene unter diesen Wurzeln — dieselbe
// Liste prüft der Helfer (cockpit-borg-action, SOURCES_ROOTS_FIXED) noch einmal
// samt Existenz und Symlinks.
const BORG_ACTION_PATH = "/usr/local/sbin/cockpit-borg-action";
const SOURCE_ROOTS = ["/opt/stacks", "/srv", "/var/lib/docker/volumes"];
const SOURCE_PATH = /^(?:\/[A-Za-z0-9_@+][A-Za-z0-9._@+-]*)+$/;
export function sourcesFree(args) {
  if (args[0] !== "sources") return false;
  if (args.length === 2) return args[1] === "status";
  if (args.length !== 3 || args[1] !== "add") return false;
  const path = args[2];
  if (path.includes(OPAQUE) || !SOURCE_PATH.test(path) || `${path}/`.includes("/./") || `${path}/`.includes("/../")) return false;
  return SOURCE_ROOTS.some((root) => path.startsWith(`${root}/`) && path.length > root.length + 1);
}
// Der Helfer, wo der Riegel ihn nicht am Befehlswort lesen kann (Zweitprüfung
// t_f65aa80e, Karte t_5ce5f79f): find -exec {}, xargs -I{} {}, perl -e
// 'system(…)', python -c 'os.system(…)' rufen genau den installierten Pfad auf,
// und der Selbstschutz des Helfers greift dort nicht. Darum gilt allgemein:
// nennt ein Befehl den Helfer (Name, auch in Quotes; ein Glob auf seinen Pfad;
// ein find-Namensfilter, der auf ihn passt) und ist er weder die freie
// Direktform noch reines Lesen, ist er ein Treffer.
const HELPER_NAME = /\bcockpit-borg-action\b/;
const FIND_EXEC = /^-(?:exec|execdir|ok|okdir)$/;
const HELPER_ANCESTORS = ["/", "/usr", "/usr/local", "/usr/local/sbin", BORG_ACTION_PATH];
// Liegt der Helfer in diesem Pfad (oder einem, auf den der Glob passt)?
function coversHelper(path) {
  return GLOB.test(path) ? HELPER_ANCESTORS.some((ancestor) => globRegex(path).test(ancestor)) : HELPER_ANCESTORS.includes(path.replace(/(.)\/$/, "$1"));
}
// find mit einem Namensfilter, der auf den Helfer passt, unter einem Start, der
// ihn enthält. Ohne Namensfilter nennt find den Helfer nicht (nur der
// Platzhalter ist dann ein Hinweis).
function findNamesHelper(args, cwds) {
  const starts = findStarts(args);
  if (!(starts.length ? starts : ["."]).some((start) => start.includes(OPAQUE) || [...cwds].some((cwd) => coversHelper(resolvePath(start, cwd))))) return false;
  return args.some((flag, index) => {
    const value = args[index + 1];
    if (value === undefined) return false;
    if (/^-i?name$/.test(flag)) return globRegex(value).test("cockpit-borg-action");
    if (/^-i?(?:path|wholename)$/.test(flag)) return globRegex(value, true).test(BORG_ACTION_PATH);
    if (/^-i?regex$/.test(flag)) { try { return new RegExp(`^(?:${value})$`, flag === "-iregex" ? "i" : "").test(BORG_ACTION_PATH); } catch { return true; } }
    return false;
  });
}
// Nennt dieser (normalisierte) Text den Helfer? Ein {} (find, xargs) zählt im
// Glob wie *.
function namesHelper(text, cwds) {
  if (HELPER_NAME.test(text)) return true;
  const words = text.split(/\s+/).filter(Boolean);
  if (words.some((word) => GLOB.test(word) && !word.includes(OPAQUE) && [...cwds].some((cwd) => globRegex(resolvePath(word.replace(/^[({]+(?=\/)/, "").replaceAll("{}", "*"), cwd)).test(BORG_ACTION_PATH)))) return true;
  const command = commandOf(words, false);
  return Boolean(command.word) && baseName(command.word) === "find" && findNamesHelper(command.args, cwds);
}
// Dasselbe für die ganze logische Zeile (ls … | xargs -I{} {} …, find … \; -exec {} …).
function lineNamesHelper(line, cwds) {
  if (line.namesHelper === undefined) {
    const inner = [];
    const texts = [extractSubstitutions(normalize(line.code), inner), ...inner];
    line.namesHelper = texts.some((text) => namesHelper(text, cwds) || splitSegments(text).some((segment) => namesHelper(segment.text, cwds)))
      || grepNamesHelper(texts.flatMap((text) => splitSegments(text)), cwds);
  }
  return line.namesHelper;
}

// ls oder find über das Verzeichnis des Helfers, gefiltert mit einem grep-Muster,
// das auf seinen Namen passt (cd /usr/local/sbin && ls | grep borg-action | …):
// das nennt den Helfer wie ein find-Namensfilter (Zweitprüfung t_5dd27194, H-1).
function grepNamesHelper(segments, cwds) {
  const heads = segments.map((segment) => commandOf(segment.text.split(/\s+/).filter(Boolean), false)).filter((command) => command.word);
  const lists = heads.some(({ word, args }) => {
    const name = baseName(word);
    if (name === "find") return (findStarts(args).length ? findStarts(args) : ["."]).some((start) => !start.includes(OPAQUE) && [...cwds].some((cwd) => coversHelper(resolvePath(start, cwd))));
    if (name !== "ls") return false;
    const operands = args.filter((arg) => !arg.startsWith("-"));
    return (operands.length ? operands : ["."]).some((operand) => !operand.includes(OPAQUE) && [...cwds].some((cwd) => {
      const path = resolvePath(operand, cwd);
      return GLOB.test(path) ? globRegex(path).test("/usr/local/sbin") || globRegex(path).test(BORG_ACTION_PATH) : path === "/usr/local/sbin" || path === BORG_ACTION_PATH;
    }));
  });
  if (!lists) return false;
  return heads.some(({ word, args }) => {
    if (!/^(?:grep|egrep|fgrep)$/.test(baseName(word))) return false;
    const valued = args.findIndex((arg) => arg === "-e" || arg === "--regexp");
    const pattern = valued >= 0 ? args[valued + 1] : args.find((arg) => !arg.startsWith("-"));
    if (!pattern || pattern.includes(OPAQUE) || args.includes("-v") || args.includes("--invert-match")) return false;
    try { return new RegExp(baseName(word) === "fgrep" || args.includes("-F") ? pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") : pattern, args.some((arg) => /^-[a-zA-Z]*i/.test(arg)) ? "i" : "").test("cockpit-borg-action"); } catch { return true; }
  });
}

// ── Ungekürzter Text (Zweitprüfung t_a7b9a156, Karte t_8334eec9) ───────────
//
// Sechs Runden lang fand jede Zweitprüfung eine neue Stelle, an der der Leser
// Text für Kommentar, Quote oder Heredoc-Körper hielt, den Bash ausführt (# nach
// $(…), in ${…}, \<NL> am Kommentarende, Zeile 2 eines Quotes, $'…', @(…)#,
// <<E"OF"). Darum gilt der Helfer-Riegel zusätzlich auf dem ungekürzten Text,
// jede physische Zeile mit Kommentar, Heredoc-Körper eingeschlossen, egal was
// der Leser daraus macht (fail-closed):
// - Folgt auf den Namen des Helfers ein Wort, muss dort eine freie Form
//   beginnen (status, check, db-access <status|check|ensure|adopt|restore>,
//   sources status, sources add <Pfad unter den Wurzeln>); ein absoluter Pfad
//   als Wort (sha256sum …/cockpit-borg-action /usr/…) nimmt der Helfer nicht an.
// - Nennt eine Zeile den Helfer ohne freie Form öfter, als der Leser in ihrem
//   Code sieht (im Kommentar, im Körper eines Heredocs, den der Riegel nicht als
//   Skript liest), ist das ebenfalls ein Treffer.
// Preis: ein Kommentar oder Heredoc-Text „…cockpit-borg-action repair“ (oder
// nur der Name ohne freie Form) kostet die Freigabe des Operators.
const HELPER_MENTION = /\bcockpit-borg-action\b/g;
// Was nach einer vollständigen freien Form folgt, ist frei: der Helfer prüft bei
// jedem Verb die genaue Zahl der Argumente und bricht sonst mit 64 ab, bevor er
// etwas tut („status prüfen“ in einem Kommentar ruft nichts auf).
const HELPER_FREE_FOLLOWER = /^[ \t]+(?:status|check|db-access[ \t]+(?:status|check|ensure|adopt|restore)|sources[ \t]+status|sources[ \t]+add[ \t]+([^\s;&|)<>`]+))(?=$|[\s;&|)<>`])/;
// Eine Umleitung samt Ziel (Zweitprüfung t_86917c5a, Karte t_70e65772): Bash
// nimmt sie an jeder Stelle des Befehls, die Wörter danach sind weiter
// Argumente — `R <&- repair`, `R >/dev/null repair`, `R 2>&1 repair`,
// `R <<<x repair` starten repair. [n] bzw. {name} vor dem Operator; das Ziel ist
// ein Wort (auch -, &n, <(…), >(…)). Das Ziel liest redirectTargetEnd.
// Fail-closed (Zweitprüfung t_23d4dbd9, Karte t_ac8559f4): ein Operator, dessen
// Ziel nicht vollständig gelesen wird (fehlt, schließt nicht), ist ein Wort
// ("arg"), nie das Ende des Befehls — `R < <(:$(:)) repair` und
// `R >\`echo x\` repair` starten repair.
const HELPER_REDIRECT_OP = /^[ \t]*(?:\d+|\{\w+\})?(?:&>>|&>|>>|>\||>&|<&|<<<|<<-|<<|<>|>|<)[ \t]*/;
// Wo ein Wort endet, das bei from beginnt (Text nach normalize, Quotes weg):
// einfache Zeichen, $(…), <(…)/>(…) mit Klammerzählung, ${…}, `…`. -1: das
// Wort fehlt oder schließt nicht, oder es enthält etwas, das der Riegel nicht
// liest (eine nackte Klammer).
function redirectTargetEnd(text, from) {
  let i = from;
  while (i < text.length) {
    const char = text[i];
    if (/[\s;&|)]/.test(char)) break;
    if (char === "$" && text[i + 1] === "(" || (char === "<" || char === ">") && text[i + 1] === "(") {
      let depth = 1;
      let j = i + 2;
      for (; j < text.length && depth > 0; j += 1) {
        if (text[j] === "(") depth += 1;
        else if (text[j] === ")") depth -= 1;
      }
      if (depth > 0) return -1;
      i = j; continue;
    }
    if (char === "<" || char === ">" || char === "(") return i > from && char !== "(" ? i : -1;
    if (char === "$" && text[i + 1] === "{") { const end = text.indexOf("}", i + 2); if (end < 0) return -1; i = end + 1; continue; }
    // Ein ` ohne Partner schließt die Ersetzung, in der der Helfer steht (`R >/dev/null`).
    if (char === "`") { const end = text.indexOf("`", i + 1); if (end < 0) break; i = end + 1; continue; }
    i += 1;
  }
  return i > from ? i : -1;
}
// Jede Nennung des Helfers in einem Text: "free" (freie Form), "bare" (nur der
// Name, ohne Argument oder mit einem festen absoluten Pfad) oder "arg" (ein
// anderes Wort folgt: repair, sources restore, $v, $(…), ein Glob …).
// Umleitungen hinter dem Namen überspringt der Riegel; das Wort danach zählt,
// als stünde es direkt hinter dem Namen.
function helperMentions(text) {
  const norm = normalize(text).replaceAll(IN_QUOTES, "");
  return [...norm.matchAll(HELPER_MENTION)].map((match) => {
    const after = norm.slice(match.index + match[0].length);
    // Ein längerer fester Name (…/cockpit-borg-action.log) ist ein anderes Wort;
    // was danach folgt, zählt wie hinter dem Helfer. $, ` und Globs bleiben Folge.
    const rest = after.replace(/^[\w.,:@%+=/-]+/, "");
    return followerKind(rest, rest === after);
  });
}
// Was hinter dem Namen folgt, Wort für Wort: Umleitungen überspringen, dann
// freie Form (nur direkt hinter dem genauen Namen bzw. seinen Umleitungen),
// Ende des Befehls ("bare"), ein fester absoluter Pfad (weiter lesen) oder
// sonst ein Wort ("arg"). Eine Prozessersetzung <(…)/>(…) ist ein Wort.
function followerKind(rest, exact) {
  let path = false;
  for (;;) {
    const operator = rest.match(HELPER_REDIRECT_OP);
    // <(…)/>(…) direkt hinter dem Namen ist ein Wort, keine Umleitung.
    if (operator && !/[<>]\($/.test(rest.slice(0, operator[0].length + 1).trimEnd())) {
      const end = redirectTargetEnd(rest, operator[0].length);
      if (end < 0) return "arg";
      rest = rest.slice(end); continue;
    }
    const free = exact && !path ? rest.match(HELPER_FREE_FOLLOWER) : null;
    if (free && (free[1] === undefined || sourcesFree(["sources", "add", free[1]]))) return "free";
    if (/^[ \t]*(?:$|[;&|)`#])/.test(rest)) return "bare";
    const word = rest.match(/^[ \t]+\/[^\s;&|)<>`$*?[\]{}\u0001]*(?=$|[\s;&|)<>`#])/);
    if (!word) return "arg";
    rest = rest.slice(word[0].length); path = true;
  }
}
// Physische Zeilen [from, to), blind an jedem \<NL> verbunden: wo Bash
// verbindet, sieht der Riegel dasselbe, wo nicht (Kommentar, '…'), nur mehr.
function rawChunks(physical, from, to) {
  const chunks = [];
  for (let k = from; k < to; k += 1) {
    const index = k;
    let text = physical[k];
    while (/(^|[^\\])(\\\\)*\\$/.test(text) && k + 1 < to) { k += 1; text = text.slice(0, -1) + physical[k]; }
    chunks.push({ index, text });
  }
  return chunks;
}
const HELPER_ARG_REASON = "names the backup helper with a word other than its free forms (status, check, db-access, sources status, sources add <path>); the bolt reads this on the unabridged text, comments and here-document bodies included";
const HELPER_HIDDEN_REASON = "names the backup helper outside its free forms where the bolt reads a comment or a here-document body; the bolt reads the unabridged text";
function countNonFree(mentions) { return mentions.filter((kind) => kind !== "free").length; }

// ── Zeilen-Allowlist (Zweitprüfung t_605da75b, Karte t_6735af09) ───────────
//
// Vier Runden lang hat der Riegel Senken nachgezogen (Shell als Pipe-Ziel,
// Gruppe, tee, eval …), und jede Runde fand die nächste (|&, if/while als
// Pipe-Ziel, dd/cp/install/sponge/crontab, xargs sh -c, sed …e, awk system(),
// coproc). Darum gilt auf einer logischen Zeile, die den Helfer außerhalb
// seiner freien Direktform nennt, eine Allowlist statt einer Liste von Senken:
// jeder einfache Befehl der Zeile (auch in $(…), <(…), >(…), Gruppen und
// if/while/for/case) muss ein reiner Filter oder eine Datensenke sein. Alles
// andere ist ein Treffer. Listet ein Befehl das Verzeichnis des Helfers (ls
// /usr/local/sbin, find über einem Vorfahren ohne fremden Namensfilter,
// compgen -c, locate), gilt dasselbe für die Befehle hinter ihm in der Pipe.
// Eine Variable, deren Wert den Helfer nennt, nennt ihn überall, wo sie
// vorkommt (x="$(ls …)"⏎eval "$x").
//
// Die Zeile wird dafür eigens zerlegt, mit Quotes und Ersetzungen: das sed-
// oder awk-Programm in Quotes bleibt ein Wort und zerfällt nicht an ; ( |.

// Filter, die ihre Eingabe nur umformen oder zählen; dazu Befehle, die nichts
// ausführen (read setzt nur Variablen, cd wechselt nur das Verzeichnis).
const FILTER_WORDS = new Set(["grep", "egrep", "fgrep", "zgrep", "jq", "head", "tail", "wc", "uniq", "cut", "tr", "column", "nl", "tac", "rev", "cat", "fold", "fmt", "paste", "comm", "join", "expand", "unexpand", "numfmt", "true", "false", ":", "test", "[", "[[", "sleep", "cd", "pushd", "popd", "read", "mapfile", "readarray", "date"]);
// Vorsätze, die nur Rechte, Umgebung, Zeit oder Priorität ändern.
const PLAIN_PREFIXES = new Set(["sudo", "doas", "env", "timeout", "nice", "ionice", "command"]);
const DATA_DEVICES = /^\/dev\/(?:null|stdout|stderr|fd\/[12])$/;

// Die Wörter eines rohen Befehls, wie Bash sie sieht (Quotes aufgelöst, keine
// Erweiterung). dynamic: das Wort enthält außerhalb von '…' ein $, ` oder eine
// Ersetzung — sein Wert steht erst zur Laufzeit fest.
function shellWords(text) {
  const words = [];
  let word = null;
  let i = 0;
  const add = (chars, dynamic = false) => { word ??= { value: "", dynamic: false }; word.value += chars; word.dynamic ||= dynamic; };
  while (i < text.length) {
    const char = text[i];
    if (/\s/.test(char)) { if (word) words.push(word); word = null; i += 1; continue; }
    if (char === "\\") { add(text[i + 1] ?? ""); i += 2; continue; }
    if (char === "'") { const end = text.indexOf("'", i + 1); const stop = end < 0 ? text.length : end; add(text.slice(i + 1, stop)); i = stop + 1; continue; }
    if (char === '"') {
      let j = i + 1;
      add("");
      while (j < text.length && text[j] !== '"') {
        if (text[j] === "\\" && /[$`"\\\n]/.test(text[j + 1] ?? "")) { add(text[j + 1]); j += 2; continue; }
        add(text[j], /[$`]/.test(text[j]) || text[j] === OPAQUE); j += 1;
      }
      i = j + 1; continue;
    }
    add(char, /[$`]/.test(char) || char === OPAQUE); i += 1;
  }
  if (word) words.push(word);
  return words;
}

// Ein sed-Programm, das nur liest, ersetzt und ausgibt (Zweitprüfung t_20ae3cda,
// E; Karte t_d16c58d1): Adressen (Zahl, $, /re/, \cREc, first~step, Bereich,
// !), s mit beliebigem Trenner und den Flags g p i I m M <Zahl>, y, Ausgabe und
// Puffer (p P d D n N g G h H x l z = F q Q), Sprünge (: b t T), Text (a i c)
// und { }. Alles andere — das e- und w-Flag, die Befehle e w W r R v — und
// was sich nicht lesen lässt, ist kein Filter. Positiv statt eines Regex auf
// /…/e: der Trenner ist frei wählbar (s|$| repair|e).
function sedScriptFilters(script) {
  const n = script.length;
  let i = 0;
  const blanks = () => { while (i < n && /[ \t]/.test(script[i])) i += 1; };
  const digits = () => { while (i < n && /\d/.test(script[i])) i += 1; };
  // Bis zum (nicht maskierten) Trenner; false, wenn er fehlt.
  const until = (delimiter) => {
    while (i < n && script[i] !== delimiter) { if (script[i] === "\\") i += 1; i += 1; }
    if (i >= n) return false;
    i += 1; return true;
  };
  // true: Adresse gelesen, null: keine da, false: kaputt.
  const address = () => {
    if (/\d/.test(script[i] ?? "")) { digits(); if (script[i] === "~") { i += 1; digits(); } return true; }
    if (script[i] === "$") { i += 1; return true; }
    if (script[i] === "/" || script[i] === "\\") {
      const delimiter = script[i] === "/" ? "/" : script[i + 1];
      i += script[i] === "/" ? 1 : 2;
      if (!delimiter || delimiter === "\n" || !until(delimiter)) return false;
      while (i < n && /[IM]/.test(script[i])) i += 1;
      return true;
    }
    return null;
  };
  const restOfLine = () => { while (i < n && script[i] !== "\n") { if (script[i] === "\\") i += 1; i += 1; } };
  while (i < n) {
    blanks();
    if (i >= n) break;
    if (/[;\n}]/.test(script[i])) { i += 1; continue; }
    if (script[i] === "#") { restOfLine(); continue; }
    const first = address();
    if (first === false) return false;
    if (first) {
      blanks();
      if (script[i] === ",") {
        i += 1; blanks();
        if (script[i] === "+" || script[i] === "~") { i += 1; digits(); } else if (address() !== true) return false;
      }
    }
    blanks();
    while (script[i] === "!") { i += 1; blanks(); }
    const command = script[i];
    i += 1;
    if (command === undefined) return !first;
    if (command === "{") continue;
    if ("pPdDnNgGhHxlz=F".includes(command)) continue;
    if ("qQ".includes(command)) { blanks(); digits(); continue; }
    if (":btT".includes(command)) { while (i < n && !/[;\n]/.test(script[i])) i += 1; continue; }
    if ("aic".includes(command)) { restOfLine(); continue; }
    if (command === "s" || command === "y") {
      const delimiter = script[i];
      i += 1;
      if (!delimiter || delimiter === "\\" || delimiter === "\n" || !until(delimiter) || !until(delimiter)) return false;
      if (command === "y") continue;
      while (i < n && !/[;\n}]/.test(script[i])) {
        if (/[gpiImM0-9 \t]/.test(script[i])) { i += 1; continue; }
        return false; // e führt aus, w/W schreibt, alles andere ist unbekannt
      }
      continue;
    }
    return false; // e, w, W, r, R, v und Unbekanntes
  }
  return true;
}

// Führt dieser sed-Aufruf nur Programme aus, die filtern? Die Optionen und
// Programme kommen aus dem rohen Text; ein Programm, das erst zur Laufzeit
// feststeht (sed "s/a/$x/"), ist kein Filter.
function sedFilters(text) {
  const words = shellWords(text);
  const at = words.findIndex((word) => !word.dynamic && baseName(word.value) === "sed");
  if (at < 0) return false;
  const args = words.slice(at + 1);
  const scripts = [];
  let explicit = false;
  let operands = false;
  for (let k = 0; k < args.length; k += 1) {
    const { value, dynamic } = args[k];
    if (operands || !value.startsWith("-") || value === "-") {
      if (!explicit && scripts.length === 0) { if (dynamic) return false; scripts.push(value); }
      operands = true; continue;
    }
    if (value === "--") { operands = true; continue; }
    if (dynamic) return false;
    const long = value.match(/^--([a-z-]+)(?:=(.*))?$/s);
    if (long) {
      const [, option, inline] = long;
      if (option === "expression") {
        const program = inline ?? args[k += 1]?.value;
        if (program === undefined || (inline === undefined && args[k].dynamic)) return false;
        scripts.push(program); explicit = true; continue;
      }
      if (option === "line-length") { if (inline === undefined) k += 1; continue; }
      if (/^(?:quiet|silent|regexp-extended|separate|unbuffered|null-data|posix|debug|sandbox|follow-symlinks)$/.test(option)) continue;
      return false;
    }
    for (let c = 1; c < value.length; c += 1) {
      const flag = value[c];
      if ("nErsuz".includes(flag)) continue;
      if (flag === "l") { if (c === value.length - 1) k += 1; break; }
      if (flag === "e") {
        const program = c < value.length - 1 ? value.slice(c + 1) : args[k += 1]?.value;
        if (program === undefined || (c === value.length - 1 && args[k].dynamic)) return false;
        scripts.push(program); explicit = true; break;
      }
      return false; // -i, -f und Unbekanntes
    }
  }
  return scripts.length > 0 && scripts.every((script) => !script.includes(OPAQUE) && sedScriptFilters(script));
}

// Bash liest $((…)) bzw. ((…)) nur als Arithmetik, wenn das erste ) auf Tiefe 0
// (ab from, hinter den zwei Klammern) direkt von einem zweiten ) gefolgt wird;
// sonst als Befehlsersetzung $( (…) …) bzw. Gruppe ( (…) …): echo $((echo x);
// R repair) startet R (Zweitprüfung t_86917c5a, Karte t_70e65772; belegt in
// Bash 5.2, auch $((1)+(2)) ist dort eine Befehlsersetzung). Schließt der Text
// nicht, ist es für den Riegel keine Arithmetik — er liest dann lieber zu viel.
function arithCloses(src, from) {
  let depth = 0;
  for (let i = from; i < src.length; i += 1) {
    const char = src[i];
    if (char === "\\") { i += 1; continue; }
    if (char === "'" || char === '"') {
      let j = i + 1;
      while (j < src.length && src[j] !== char) j += char === '"' && src[j] === "\\" ? 2 : 1;
      if (j >= src.length) return false;
      i = j; continue;
    }
    if (char === "(") depth += 1;
    else if (char === ")") { if (depth === 0) return src[i + 1] === ")"; depth -= 1; }
  }
  return false;
}

// Wo ein Ausdruck in Klammern endet (Index hinter der schließenden), Quotes beachtet.
function parenEnd(src, from) {
  let depth = 1;
  let i = from;
  while (i < src.length && depth > 0) {
    const char = src[i];
    if (char === "\\") { i += 2; continue; }
    if (char === "'") { const end = src.indexOf("'", i + 1); i = end < 0 ? src.length : end + 1; continue; }
    if (char === "(") depth += 1;
    else if (char === ")") depth -= 1;
    i += 1;
  }
  return i;
}

// Einfache Befehle einer logischen Zeile, roh (Quotes bleiben stehen), mit
// piped (liest aus einer Pipe, auch als Teil einer Gruppe hinter einer Pipe)
// und depth (0: die Zeile selbst, >0: in einer Ersetzung). $(…), `…`, <(…) und
// >(…) werden zu OPAQUE, ihr Inhalt zu eigenen Befehlen.
function rawSegments(code) {
  const out = [];
  // $((…)), ((…)) und ein Array-Index rechnen, und Bash führt dabei jedes $(…)
  // und `…` darin aus (echo $(( $(sh) )) liest die Pipe; Zweitprüfung
  // t_20ae3cda, C). Der Ausdruck selbst ist kein Befehl, aber seine Ersetzungen
  // werden eigene Befehle (Karte t_d16c58d1).
  const arith = (src, depth) => {
    let j = 0;
    while (j < src.length) {
      if (src[j] === "\\") { j += 2; continue; }
      if (src.startsWith("$((", j) && arithCloses(src, j + 3)) { const end = parenEnd(src, j + 2); arith(src.slice(j + 3, end - 2), depth); j = end; continue; }
      if (src.startsWith("$(", j)) { const end = parenEnd(src, j + 2); walk(src.slice(j + 2, end - 1), depth + 1); j = end; continue; }
      if (src[j] === "`") { const end = src.indexOf("`", j + 1); const stop = end < 0 ? src.length : end; walk(src.slice(j + 1, stop), depth + 1); j = stop + 1; continue; }
      j += 1;
    }
  };
  const walk = (src, depth) => {
    let current = "";
    let piped = false;
    let nextPiped = false;
    const groups = [];
    const push = () => {
      if (current.trim()) out.push({ text: current.trim(), piped: piped || (groups.length > 0 && groups.at(-1)), depth });
      current = ""; piped = nextPiped; nextPiped = false;
    };
    let i = 0;
    while (i < src.length) {
      const char = src[i];
      if (char === "\\") { current += src.slice(i, i + 2); i += 2; continue; }
      if (char === "'") { const end = src.indexOf("'", i + 1); const stop = end < 0 ? src.length : end + 1; current += src.slice(i, stop); i = stop; continue; }
      if (char === '"') {
        let j = i + 1;
        let text = '"';
        while (j < src.length && src[j] !== '"') {
          if (src[j] === "\\") { text += src.slice(j, j + 2); j += 2; continue; }
          if (src.startsWith("$((", j) && arithCloses(src, j + 3)) { const end = parenEnd(src, j + 2); arith(src.slice(j + 3, end - 2), depth); text += "0"; j = end; continue; }
          if (src.startsWith("$(", j)) { const end = parenEnd(src, j + 2); walk(src.slice(j + 2, end - 1), depth + 1); text += OPAQUE; j = end; continue; }
          if (src[j] === "`") { const end = src.indexOf("`", j + 1); const stop = end < 0 ? src.length : end; walk(src.slice(j + 1, stop), depth + 1); text += OPAQUE; j = stop + 1; continue; }
          text += src[j]; j += 1;
        }
        current += `${text}"`; i = j + 1; continue;
      }
      if (src.startsWith("$((", i) && arithCloses(src, i + 3)) { const end = parenEnd(src, i + 2); arith(src.slice(i + 3, end - 2), depth); current += "0"; i = end; continue; }
      if (src.startsWith("((", i) && !current.trim() && arithCloses(src, i + 2)) { const end = parenEnd(src, i + 1); arith(src.slice(i + 2, end - 2), depth); current += "true"; i = end; continue; }
      if ((char === "$" || char === "<" || char === ">") && src[i + 1] === "(") {
        const end = parenEnd(src, i + 2);
        walk(src.slice(i + 2, end - 1), depth + 1);
        current += char === "$" ? OPAQUE : `${char}${OPAQUE}`; i = end; continue;
      }
      if (char === "`") { const end = src.indexOf("`", i + 1); const stop = end < 0 ? src.length : end; walk(src.slice(i + 1, stop), depth + 1); current += OPAQUE; i = stop + 1; continue; }
      if (char === "|" && src[i + 1] === "|") { push(); piped = false; i += 2; continue; }
      if (char === "|") { nextPiped = true; push(); i += src[i + 1] === "&" ? 2 : 1; continue; }
      if (char === "&" && src[i + 1] === "&") { push(); piped = false; i += 2; continue; }
      if ((char === "&" || char === "<" || char === ">") && (src[i + 1] === ">" || src[i + 1] === "&")) { current += src.slice(i, i + 2); i += 2; continue; }
      if (char === "(" && !current.trim()) { const was = piped; push(); groups.push(was || (groups.length > 0 && groups.at(-1))); piped = false; i += 1; continue; }
      if (char === "{" && !current.trim() && /\s/.test(src[i + 1] ?? "")) { const was = piped; push(); groups.push(was || (groups.length > 0 && groups.at(-1))); piped = false; i += 1; continue; }
      if (char === ")" || char === "}" && !current.trim() && /^(?:[\s;&|)]|$)/.test(src[i + 1] ?? "")) { push(); groups.pop(); piped = false; i += 1; continue; }
      if (char === ";" || char === "&" || char === "\n" || char === "(") { push(); piped = false; i += 1; continue; }
      current += char; i += 1;
    }
    push();
  };
  walk(code, 0);
  return out.map((segment) => {
    const norm = normalize(segment.text).replaceAll(IN_QUOTES, "");
    const words = norm.split(/\s+/).filter(Boolean);
    const command = commandOf(words, false);
    return { ...segment, norm, words, command, name: command.word ? baseName(command.word) : "" };
  });
}

// Wohin ein Befehl per Umleitung schreibt, Quotes ausgeblendet (sed 's/a/>b/'
// leitet nicht um). Ein Ziel in Quotes bleibt unbekannt und zählt als laufbar.
function rawRedirects(text) {
  const bare = text.replace(/'[^']*'|"(?:[^"\\]|\\.)*"/g, "Q");
  return {
    targets: redirectTargets(bare),
    // >&3, >&$fd, >&${COPROC[1]}: in einen Deskriptor, hinter dem ein Prozess stehen kann.
    descriptor: /\d*>&\s*(?![12](?:\s|$|[;&|)])|-)\S/.test(bare),
  };
}

// Listet der Befehl das Verzeichnis des Helfers (und damit seinen Namen)?
function listsHelperDir(command, cwds) {
  const name = command.word ? baseName(command.word) : "";
  const { args } = command;
  const operands = args.filter((arg) => !arg.startsWith("-"));
  const resolved = (list) => list.filter((operand) => !operand.includes(OPAQUE)).flatMap((operand) => [...cwds].map((cwd) => resolvePath(operand, cwd)));
  const isDir = (path) => (GLOB.test(path) ? globRegex(path).test("/usr/local/sbin") : path === "/usr/local/sbin");
  if (name === "compgen") return args.some((arg) => /^-[a-zA-Z]*c/.test(arg)) || args.includes("command");
  if (/^(?:locate|plocate|mlocate)$/.test(name)) return true;
  if (/^(?:ls|dir|vdir|tree)$/.test(name)) {
    const recursive = name === "tree" || args.some((arg) => /^-[a-zA-Z]*R|^--recursive$/.test(arg));
    return resolved(operands.length ? operands : ["."]).some((path) => isDir(path) || (recursive && coversHelper(path)));
  }
  if (name === "du" && args.some((arg) => /^-[a-zA-Z]*a|^--all$/.test(arg))) return resolved(operands.length ? operands : ["."]).some((path) => coversHelper(path));
  if (name === "find") {
    const filtered = args.some((arg, index) => /^-i?(?:name|path|wholename|regex)$/.test(arg) && args[index + 1] !== undefined);
    return !filtered && resolved(findStarts(args).length ? findStarts(args) : ["."]).some((path) => coversHelper(path));
  }
  return false;
}

// Ist dieser Befehl ein reiner Filter oder eine Datensenke? null: ja; sonst,
// was er stattdessen ist.
function notAFilter(segment, cwds, context, resolve) {
  const { command, name, words, norm, text } = segment;
  if (words[0] === "case") return null; // der Kopf eines case führt nichts aus
  const odd = command.prefixes.find((prefix) => !PLAIN_PREFIXES.has(prefix));
  if (odd) return `${odd} runs another command`;
  const { targets, descriptor } = rawRedirects(text);
  if (descriptor) return "a redirect into a file descriptor (coproc, exec >(…))";
  const runnable = (target) => target.includes(OPAQUE) || [...cwds].some((cwd) => {
    const path = resolvePath(target, cwd);
    return !DATA_DEVICES.test(path) && runnableTarget(path, context);
  });
  if (targets.some(runnable)) return "a redirect into a file that can run";
  // Ein Array-Index rechnet, und die Rechnung führt $(…) aus (printf -v 'a[$(sh)]',
  // test -v "a[\$(…)]", read 'a[$(sh)]'; Zweitprüfung t_20ae3cda, C).
  if (/[A-Za-z_]\w*\[[^\]]*(?:\$\(|`|\u0001)/.test(text)) return "an array subscript that runs a command";
  if (!command.word) return command.prefixes.length === 0 ? null : "a prefix without a command";
  if (command.word.includes(OPAQUE) || command.word.includes("$")) {
    // $h status mit h=…/cockpit-borg-action: die freie Direktform über eine Variable.
    const variants = expandText(norm, resolve) || [];
    const direct = variants.length > 0 && variants.every((variant) => {
      const inner = commandOf(variant.split(/\s+/).filter(Boolean), false);
      return inner.word && !inner.word.includes(OPAQUE) && baseName(inner.word) === "cockpit-borg-action" && readOnlyForm({ ...inner, prefixes: [] }, "");
    });
    return direct ? null : "a command name built at run time";
  }
  if (command.word.includes("/") && !SYSTEM_PREFIXES.some((prefix) => command.word.startsWith(prefix))) return `${command.word} (a program this plan does not show)`;
  if (name === "cockpit-borg-action") return null; // seine Verben urteilt segmentBolt
  if (ECHOES.has(name)) return null;
  if (/^(?:mapfile|readarray)$/.test(name) && command.args.some((arg) => /^-[a-zA-Z]*C/.test(arg))) return `${name} with a callback`;
  if (name === "set" && command.args.every((arg) => /^[-+][a-zA-Z]+$/.test(arg) || /^(?:errexit|nounset|pipefail|xtrace|verbose|noclobber|noglob|errtrace|functrace)$/.test(arg))) return null;
  if ((name === "exit" || name === "return") && command.args.every((arg) => /^\d+$/.test(arg))) return null;
  // Listen gibt nur Namen aus; compgen -C/-F rufen dagegen einen Befehl oder eine Funktion.
  if (name === "compgen" && !command.args.some((arg) => /^-[a-zA-Z]*[CF]/.test(arg))) return null;
  if (/^(?:locate|plocate|mlocate)$/.test(name)) return null;
  if (/^[gm]?awk$/.test(name)) {
    if (command.args.some((arg) => /^-[a-zA-Z]*[fEil]$|^--(?:file|exec|include|load)\b/.test(arg))) return `${name} with a program from a file or a library`;
    return AWK_PRIMITIVES.test(text) ? `${name} that runs commands or writes files` : null;
  }
  if (name === "sed") {
    if (command.args.some((arg) => /^-[a-zA-Z]*[if]|^--in-place|^--file\b/.test(arg))) return "sed that edits a file or reads its program from one";
    return sedFilters(text) ? null : "sed with a command other than s, y, print, delete, quit (or an e/w flag)";
  }
  if (name === "tee") return command.args.filter((arg) => !arg.startsWith("-")).some(runnable) ? "tee into a file that can run" : null;
  if (name === "sort") return command.args.some((arg) => /^-[a-zA-Z]*o|^--output|^--compress-program/.test(arg)) ? "sort that writes a file or starts a program" : null;
  if (FILTER_WORDS.has(name)) return null;
  if (readOnlyForm({ ...command, prefixes: [] }, "")) return null;
  return name;
}

// Umbinden über Zeilen (Zweitprüfung t_20ae3cda, A und G; Karte t_d16c58d1):
// Was ein Filter-Name ausführt, entscheidet eine Funktion, ein alias, hash -p
// oder PATH aus einer anderen Zeile (cat(){ sh; }⏎echo '…' | cat); welchen
// Wert eine Variable trägt, entscheiden ${!y}, declare -n, export und env. In
// einem Plan, der den Helfer außerhalb seiner freien Formen nennt, ist darum
// jede solche Zeile ein Treffer — die Allowlist allein sieht nur Namen.
function rebindBolt(line, segments, helperVars) {
  const bare = line.code.replace(/'[^']*'|"(?:[^"\\]|\\.)*"/g, "Q");
  if (/(?:^|[\s;&|(){}])function\s+[^\s;&|()<>]+|(?:^|[\s;&|{}])[^\s;&|(){}<>=$'"]+\s*\(\s*\)/.test(bare)) return "a function definition (it can rebind a filter's name)";
  if (/\$\{!/.test(line.code.replace(/'[^']*'/g, "Q"))) return "an indirect variable reference ${!…}";
  for (const segment of segments) {
    const { command, norm } = segment;
    if (command.problem) return command.problem;
    for (const assignment of command.assignments) {
      const variable = assignment.split("=")[0].replace(/\+$/, "");
      if (CODE_ENV.test(variable) && !/^PATH=(?:\/usr\/local\/sbin:\/usr\/local\/bin:\/usr\/sbin:\/usr\/bin:\/sbin:\/bin)?$/.test(assignment)) return `${variable} decides which code runs`;
    }
    const declared = norm.match(/^(?:export|declare|typeset|local|readonly)\b(.*)$/);
    if (declared && /^export\b|\s-[a-zA-Z]*x/.test(norm)) {
      const exported = declared[1].split(/\s+/).filter((word) => /^[A-Za-z_]/.test(word)).map((word) => word.split("=")[0].replace(/\+$/, ""));
      const helper = exported.find((variable) => helperVars.has(variable));
      if (helper) return `exports ${helper}, whose value names the backup helper (env, printenv and child shells read it)`;
    }
  }
  return null;
}

// Erweiterungen, die Bash als Code auswertet (Zweitprüfung t_f1b3ea8c, Karte
// t_2e391eba). Die Allowlist urteilt über Befehlsnamen; Bash führt aber auch
// einen Wert aus, der in einer solchen Erweiterung landet: ${x@P} macht aus
// x='$(sh)' einen Befehl, PS4='$(sh)' läuft bei set -x vor jedem Befehl, und
// Arithmetik rechnet einen Namen aus, dessen Wert a[$(sh)] ist — auch wenn
// dieser Wert erst aus Teilen entsteht (z=$x$y). Im gekennzeichneten Plan ist
// darum jede solche Stelle ein Treffer, außer sie rechnet nur mit Zahlen. In
// echter Bash belegt (sonden/bash-real-arith-ctx.sh): $((…)), ((…)), $[…],
// let, for ((…)), [[ … -eq … ]], ${s:off:len}, ein Index ${a[i]}/a[i]=, auch als
// Name in unset, test -v, read, printf -v, declare; declare/local/typeset -i
// und die Integer-Variablen RANDOM, SRANDOM, OPTIND, HISTCMD. Nicht: test/[ mit
// -eq, printf %d, shift/exit/return, read -t/-n, ${A[$x]} bei assoziativen
// Arrays (hier trotzdem ein Treffer, der Riegel kennt den Array-Typ nicht).
const INTEGER_VARS = /^(?:RANDOM|SRANDOM|OPTIND|HISTCMD)$/;
const DECLARERS = /^(?:export|local|declare|typeset|readonly)$/;
const ARITH_COMPARE = /^-(?:eq|ne|lt|le|gt|ge)$/;
const SAFE_PATH = /^PATH=(?:\/usr\/local\/sbin:\/usr\/local\/bin:\/usr\/sbin:\/usr\/bin:\/sbin:\/bin)?$/;
// Nur Zahlen (auch 0x1f, 2#101) und Operatoren — kein Name, kein $.
function arithLiteral(expr) {
  return /^[\s\d+\-*/%()<>=!&|^~?:,"]*$/.test(String(expr).replace(/\b0[xX][0-9a-fA-F]+\b|\b\d+#[0-9A-Za-z@_]+/g, "0"));
}
function braceEnd(src, from) {
  let depth = 1;
  let i = from;
  while (i < src.length && depth > 0) {
    if (src[i] === "\\") { i += 2; continue; }
    if (src[i] === "{") depth += 1;
    else if (src[i] === "}") depth -= 1;
    i += 1;
  }
  return i;
}
// Ein gebundener Name (Zuweisung, declare, read, printf -v, for …): bestimmt er,
// welcher Code läuft, ist er eine Integer-Variable, oder rechnet sein Index?
function boundNameCode(name) {
  const base = name.replace(/\[[\s\S]*$/, "");
  if (CODE_ENV.test(base)) return `${base} decides which code runs`;
  if (INTEGER_VARS.test(base)) return `${base} is an integer variable: bash evaluates every value assigned to it as arithmetic`;
  const index = name.match(/^[A-Za-z_]\w*\[([\s\S]*)\]$/);
  if (index && !/^[@*]$/.test(index[1]) && !arithLiteral(index[1])) return `an array index (${clip(name, 60)}) that bash evaluates as arithmetic`;
  return null;
}
// Text mit Erweiterungen (eine Zeile oder ein Heredoc-Körper, roh). Quotes
// bleiben stehen: ein Treffer zu viel in '…' ist der Preis für einen Leser,
// der keine Quote-Verschachtelung raten muss.
function expansionCode(code) {
  for (let i = code.indexOf("${"); i >= 0; i = code.indexOf("${", i + 2)) {
    const body = code.slice(i + 2, braceEnd(code, i + 2) - 1);
    if (/@P$/.test(body)) return "the prompt expansion ${…@P} runs a value as code";
    const parts = body.match(/^([#!]?)([A-Za-z_]\w*|\d+|[@*])(\[[^\]]*\])?([\s\S]*)$/);
    if (!parts) continue;
    const [, , name, index, rest] = parts;
    if (index) { const bound = boundNameCode(`${name}${index}`); if (bound) return bound; }
    if (/^:?=/.test(rest)) { const bound = boundNameCode(name); if (bound) return `\${${name}:=…}: ${bound}`; }
    if (/^:(?![-=?+])/.test(rest) && !rest.slice(1).split(":").every(arithLiteral)) return `the substring offset in \${${clip(body, 40)}} is arithmetic on a name or value`;
  }
  // Zusammengesetzte Zuweisung b=([i]=1): der Schlüssel rechnet wie ein Index.
  for (const compound of code.matchAll(/([A-Za-z_]\w*)\+?=\(/g)) {
    const inner = code.slice(compound.index + compound[0].length, parenEnd(code, compound.index + compound[0].length) - 1);
    for (const key of inner.matchAll(/\[([^\]]*)\]\+?=/g)) { const bound = boundNameCode(`${compound[1]}[${key[1]}]`); if (bound) return bound; }
  }
  for (let i = code.indexOf("(("); i >= 0; i = code.indexOf("((", i + 2)) {
    const end = parenEnd(code, i + 1);
    const expr = code.slice(i + 2, Math.max(i + 2, end - 2));
    if (!arithLiteral(expr)) return `arithmetic on a name or value ((${clip(expr, 40)})) — bash evaluates that value as code`;
  }
  for (let i = code.indexOf("$["); i >= 0; i = code.indexOf("$[", i + 2)) {
    let depth = 1;
    let j = i + 2;
    for (; j < code.length && depth > 0; j += 1) { if (code[j] === "[") depth += 1; else if (code[j] === "]") depth -= 1; }
    if (!arithLiteral(code.slice(i + 2, j - 1))) return "arithmetic on a name or value ($[…]) — bash evaluates that value as code";
  }
  for (const open of code.matchAll(/(?:^|[\s;&|(!{])\[\[(?=\s)/g)) {
    const start = open.index + open[0].length;
    const close = code.slice(start).search(/\s\]\](?=$|[\s;&|)])/);
    const words = code.slice(start, close < 0 ? code.length : start + close).split(/\s+/).filter(Boolean);
    for (let k = 0; k < words.length; k += 1) {
      if (ARITH_COMPARE.test(words[k]) && !(arithLiteral(words[k - 1] ?? "x") && arithLiteral(words[k + 1] ?? "x"))) return `[[ … ${words[k]} … ]] compares arithmetically: bash evaluates a name or value there as code`;
      if (words[k] === "-v") { const bound = boundNameCode((words[k + 1] ?? "").replace(/['"\\]/g, "")); if (bound) return bound; }
    }
  }
  return null;
}
// Namen, die ein einfacher Befehl bindet, und das Integer-Attribut.
function bindingCode(segment) {
  const words = segment.words.map((word) => word.replace(/['"\\]/g, ""));
  let i = 0;
  while (i < words.length && KEYWORDS.test(words[i])) i += 1;
  const head = words[i] ?? "";
  const rest = words.slice(i + 1);
  const names = segment.command.assignments.filter((assignment) => !SAFE_PATH.test(assignment)).map((assignment) => assignment.replace(/\+?=[\s\S]*$/, ""));
  if (/^[A-Za-z_]\w*\[[\s\S]*\]\+?=/.test(head)) names.push(head.replace(/\]\+?=[\s\S]*$/, "]"));
  if (DECLARERS.test(head)) {
    if (rest.some((word) => /^-[A-Za-z]*i/.test(word))) return `${head} -i makes every assignment to the variable arithmetic`;
    names.push(...rest.filter((word) => !/^[-+]/.test(word) && !SAFE_PATH.test(word)).map((word) => word.replace(/\+?=[\s\S]*$/, "")));
  }
  if (head === "let" && !rest.every(arithLiteral)) return "let evaluates a name or value as arithmetic";
  if (/^(?:read|mapfile|readarray|unset)$/.test(head)) names.push(...rest.filter((word) => !word.startsWith("-")));
  if (head === "for" || head === "select") names.push(rest[0] ?? "");
  if (head === "getopts") names.push(rest[1] ?? "");
  rest.forEach((word, index) => {
    if (/^(?:printf|wait)$/.test(head) && /^-v|^-p$/.test(word)) names.push(word.length > 2 ? word.slice(2) : rest[index + 1] ?? "");
    if (/^(?:test|\[)$/.test(head) && word === "-v") names.push(rest[index + 1] ?? "");
  });
  for (const name of names) { const bound = boundNameCode(name); if (bound) return bound; }
  return null;
}

// Nennt der Plan den Helfer außerhalb seiner freien Formen? Frei sind nur die
// Direktform (Befehlswort = Helfer, auch über die Shell-Form) und test/[/[[
// (sie geben nichts aus). Alles andere — echo/printf mit dem Namen, ls,
// sha256sum oder stat auf ihn, ein Glob, ein find-Filter, das Listen seines
// Verzeichnisses, eine Variable mit seinem Namen — macht seinen Namen zu Text,
// der über eine andere Zeile laufen kann (Datei, FIFO, tail -f, Funktion,
// export). Null: der Plan nennt ihn nicht so.
function planTaint(lines, cwds, helperVars) {
  if (helperVars.size > 0) return `a variable holds the backup helper's name (${[...helperVars][0]})`;
  for (const line of lines) {
    const segments = line.rawSegments ??= rawSegments(line.code);
    for (const segment of segments) {
      if (listsHelperDir(segment.command, cwds)) return "a command lists the backup helper's directory";
      if (segment.name === "cockpit-borg-action" || shellHelperArg(segment.name, segment.command.args) >= 0) continue;
      if (/^(?:test|\[|\[\[)$/.test(segment.name) && !segment.text.includes(OPAQUE)) continue;
      if (namesHelper(segment.norm, cwds)) return "a command names the backup helper outside its free forms";
    }
    if (grepNamesHelper(segments.map((segment) => ({ text: segment.norm })), cwds)) return "a filter over a listing names the backup helper";
  }
  return null;
}

// Der Grund, wenn die Zeile den Helfer nennt (oder sein Verzeichnis in eine
// Pipe listet) und dabei etwas anderes tut als filtern und Daten ablegen. Nennt
// der Plan den Helfer außerhalb seiner freien Formen (context.tainted), gilt
// das für jede Zeile des Plans, dazu kein Umbinden (rebindBolt).
function allowlistBolt(line, cwds, context, resolve, helperVars) {
  const segments = line.rawSegments ??= rawSegments(line.code);
  if (context.tainted) {
    const rebind = rebindBolt(line, segments, helperVars);
    if (rebind) return `a plan that names the backup helper outside its free forms may not rebind names or values; here: ${rebind}`;
    const evaluated = expansionCode(line.code) || segments.map(bindingCode).find(Boolean);
    if (evaluated) return `a plan that names the backup helper outside its free forms may not let bash evaluate a value as code; here: ${evaluated}`;
    for (const segment of segments) {
      const what = notAFilter(segment, cwds, context, resolve);
      if (what) return `a plan that names the backup helper outside its free forms (${context.tainted}) may only filter and store data on every line; here: ${what}`;
    }
    return null;
  }
  const usesHelperVar = (segment) => [...helperVars].some((name) => new RegExp(`\\$\\{?${name}\\b`).test(segment.text));
  const names = (segment) => usesHelperVar(segment)
    || (segment.name !== "cockpit-borg-action" && shellHelperArg(segment.name, segment.command.args) < 0 && namesHelper(segment.norm, cwds));
  const named = segments.some(names) || grepNamesHelper(segments.map((segment) => ({ text: segment.norm })), cwds);
  const scope = named ? segments : [];
  if (!named) {
    segments.forEach((segment, index) => {
      if (!listsHelperDir(segment.command, cwds)) return;
      for (let next = index + 1; next < segments.length && segments[next].piped; next += 1) scope.push(segments[next]);
    });
  }
  for (const segment of scope) {
    const what = notAFilter(segment, cwds, context, resolve);
    if (what) {
      return named
        ? `a line that names the backup helper outside its free forms may only filter and store data; here: ${what}`
        : `a pipe from the backup helper's directory listing may only filter and store data; here: ${what}`;
    }
  }
  return null;
}

// Variablen, deren Wert den Helfer nennt (x="$(ls …/cockpit-borg-action | sed …)",
// x='…/cockpit-borg-action repair', read -r x < <(…)); auch über andere Variablen.
// Frei bleibt der Wert der freien Direktform (s=$(…/cockpit-borg-action status)).
function helperVariables(lines, cwds) {
  const marked = new Set();
  const refers = (text) => [...marked].some((name) => new RegExp(`\\$\\{?${name}\\b`).test(text));
  const values = new Map();
  const valueNames = (value) => {
    if (refers(value)) return true;
    if (!values.has(value)) values.set(value, rawSegments(value));
    const parts = values.get(value);
    return parts.some((part) => (part.depth === 0
      ? namesHelper(part.norm, cwds)
      : part.name !== "cockpit-borg-action" && shellHelperArg(part.name, part.command.args) < 0 && namesHelper(part.norm, cwds)));
  };
  for (let changed = true, rounds = 0; changed && rounds < 8; rounds += 1) {
    changed = false;
    const mark = (name) => { if (!marked.has(name)) { marked.add(name); changed = true; } };
    for (const line of lines) {
      const lineNames = () => (line.rawSegments ??= rawSegments(line.code)).some((part) => refers(part.text) || (part.name !== "cockpit-borg-action" && shellHelperArg(part.name, part.command.args) < 0 && namesHelper(part.norm, cwds)));
      for (const match of line.code.matchAll(/(?:^|[\s;&|(])([A-Za-z_]\w*)\+?=((?:'[^']*'|"(?:[^"\\]|\\.)*"|\$\((?:[^()]|\([^()]*\))*\)|`[^`]*`|[^\s;&|])*)/g)) {
        if (valueNames(match[2])) mark(match[1]);
      }
      for (const match of line.code.matchAll(/\b(?:read|mapfile|readarray)\b((?:\s+-[A-Za-z]+(?:\s+(?!-)\S+)?)*)((?:\s+[A-Za-z_]\w*)+)/g)) {
        if (lineNames()) for (const name of match[2].trim().split(/\s+/)) mark(name);
      }
      for (const match of line.code.matchAll(/\bprintf\s+-v\s+([A-Za-z_]\w*)/g)) if (lineNames()) mark(match[1]);
    }
  }
  return marked;
}

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
  "qm", "pct", "pvesm", "pvesh",
]);
// Proxmox: lesende Verben (Rolle box).
const PVE_GUEST_READ = new Set(["list", "listsnapshot", "config", "status", "pending", "showcmd", "df", "help"]);
const PVESM_READ = new Set(["status", "list", "path", "scan", "nfsscan", "cifsscan", "lvmscan", "lvmthinscan", "zfsscan", "iscsiscan", "glusterfsscan", "pbsscan", "apiinfo", "help"]);
const PVESH_READ = new Set(["get", "ls", "usage", "help"]);
// Die Proxmox-CLI nimmt eindeutige Präfixe ihrer Unterbefehle (pve-common
// CLIHandler.pm, expand_command_name mit enforce_exact; Zweitprüfung t_eebb73c0,
// Karte t_a5defddd): qm delsnap ist delsnapshot, pvesh del ist delete. Ein
// exakter Name gilt vor jedem Präfix, ein Alias nur exakt; ein mehrdeutiges
// Präfix lehnt Proxmox ab. Der Riegel löst genauso auf und wertet ein
// mehrdeutiges Präfix, das ein gesperrtes Verb treffen kann, als dieses Verb
// (fail-closed). Die Listen: git.proxmox.com HEAD (qm.pm, pct.pm, pvesm.pm,
// pvesh.pm; help ergänzt CLIHandler), Stand 10.11.2026.
const PVE_COMMANDS = {
  qm: {
    all: ["list", "create", "destroy", "clone", "migrate", "remote-migrate", "set", "config", "pending", "showcmd", "status", "snapshot", "delsnapshot", "listsnapshot", "rollback", "template", "start", "stop", "reset", "shutdown", "reboot", "suspend", "resume", "sendkey", "vncproxy", "wait", "unlock", "disk", "enroll-efi-keys", "monitor", "guest", "mtunnel", "nbdstop", "terminal", "importovf", "cleanup", "cloudinit", "import", "help"],
    aliases: ["importdisk", "move-disk", "move_disk", "rescan", "resize", "unlink", "agent"],
    bolted: ["delsnapshot", "rollback", "destroy"],
  },
  pct: {
    all: ["list", "config", "pending", "set", "resize", "create", "restore", "destroy", "start", "suspend", "resume", "shutdown", "stop", "reboot", "clone", "migrate", "move-volume", "remote-migrate", "snapshot", "delsnapshot", "listsnapshot", "rollback", "template", "status", "console", "enter", "unlock", "exec", "fsck", "mount", "unmount", "push", "pull", "df", "rescan", "cpusets", "fstrim", "help"],
    aliases: ["move_volume"],
    bolted: ["delsnapshot", "rollback", "destroy", "restore"],
  },
  pvesm: {
    all: ["add", "set", "remove", "status", "list", "alloc", "free", "scan", "path", "extractconfig", "export", "import", "apiinfo", "prune-backups", "help"],
    aliases: ["nfsscan", "cifsscan", "iscsiscan", "lvmscan", "lvmthinscan", "zfsscan"],
    bolted: ["free", "prune-backups", "set"],
  },
  pvesh: {
    all: ["usage", "get", "ls", "set", "create", "delete", "help"],
    aliases: [],
    bolted: ["delete", "set", "create"],
  },
};
// Das Verb, das Proxmox ausführt: { verb, unique }. Mehrdeutig (unique false):
// das erste gesperrte Verb unter den Treffern, sonst das Wort unverändert.
function pveVerb(tool, word) {
  const def = PVE_COMMANDS[tool];
  const lower = word.toLowerCase();
  if (def.all.includes(lower) || def.aliases.includes(lower)) return { verb: lower, unique: true };
  const hits = def.all.filter((name) => name.startsWith(lower));
  if (hits.length === 1) return { verb: hits[0], unique: true };
  return { verb: hits.find((name) => def.bolted.includes(name)) || word, unique: false };
}
// Im Text: jedes Verb hinter qm/pct/pvesm/pvesh durch das aufgelöste ersetzen.
const pveVerbs = (text) => text.replace(/(\b(qm|pct|pvesm|pvesh)[\s,[\]()'"]+)([A-Za-z][\w-]*)/gi, (all, head, tool, word) => head + pveVerb(tool.toLowerCase(), word).verb);
// Getopt::Long (JSONSchema.pm get_options: auto_abbrev, prefix_pattern (--|-)):
// jede Option mit - oder -- und jedem Präfix ihres Namens (vzdump --rem 1).
// Ein mehrdeutiges Präfix lehnt Proxmox ab; der Riegel zählt es mit (fail-closed).
const optionPrefix = (name) => [...name].reduceRight((rest, char) => `${char === "-" ? "\\-" : char}${rest ? `(?:${rest})?` : ""}`, "");
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
const CODE_ENV = /^(?:PATH|BASH_ENV|ENV|LD_PRELOAD|LD_LIBRARY_PATH|LD_AUDIT|PYTHONPATH|PYTHONSTARTUP|PYTHONHOME|PERL5LIB|PERL5OPT|PERLLIB|RUBYOPT|RUBYLIB|NODE_OPTIONS|NODE_PATH|PROMPT_COMMAND|PS[0-4]|SHELLOPTS|BASHOPTS|GLOBIGNORE|BASH_FUNC_\w*|BORG_\w+|BORGMATIC_\w+)$/;
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
const AWK_PRIMITIVES = /\bsystem\s*\(|\|\s*getline|\|&|\bprint[^;}]*[>|]|@[A-Za-z_]\w*\s*\(/;

// ── Was den Riegel auslöst ─────────────────────────────────────────────────
// Im normalisierten Text eines Befehls (ohne Quotes), auch in sh -c '…', in
// einem Skript, das der Lauf schreibt, oder in einer Cron-Zeile.
const DELETE_PHRASE = /\bborg(?:matic)?\b(?:[\s,[\]()]+[^\s,[\]()]+){0,8}?[\s,[\]()]+(?:delete|prune|compact|recreate|break-lock|rdelete|repo-delete|key[\s,[\]()]+(?:change-passphrase|import|migrate-to-repokey|change-location|change-algorithm))\b/i;
// prune-backups/maxfiles: die Aufbewahrung der vzdump-Sicherungen (Proxmox).
const RETENTION_PHRASE = /\bkeep[_-](?:within|secondly|minutely|hourly|daily|weekly|monthly|yearly|last|all)\b|\bbackup_keep_time\b|\bkeep(?:Daily|Weekly|Monthly)\b|\bprune-?backups\b|\bmaxfiles\b/i;
// Proxmox (Rolle box): Gast-Snapshots löschen oder zurückrollen, Gäste zerstören,
// vzdump-Sicherungen löschen — als Befehl (qm, pct, pvesm, vzdump, pvesh) und
// über die API (curl … /api2/json/…). Die Pfade der API und von pvesh sind
// dieselben: …/snapshot/<name> (DELETE), …/snapshot/<name>/rollback (POST),
// /nodes/<n>/qemu|lxc/<id> (DELETE), …/storage/<s>/content/<vol> (DELETE, set),
// …/storage/<s>/prunebackups (DELETE), /cluster/backup/<id> (DELETE, set).
const PVE_GUEST = /\b(?:qm|pct)[\s,[\]()'"]+(?:delsnapshot|rollback|destroy)\b/i;
const PVE_BACKUP = new RegExp(String.raw`\bvzdump\b[^\n;&|]*?\s--?${optionPrefix("remove")}(?![\s=]+(?:0|false|no|off)\b)(?=[\s=;&|]|$)|\bpvesm[\s,[\]()]+(?:prune-backups\b|free\b[^\n;&|]*(?::backup\/|\sbackup\/|vzdump-))`, "i");
// Aufbewahrung als abgekürzte Option (pvesm set local --maxfi 1, vzdump --prune …).
const PVE_RETENTION_OPTION = new RegExp(String.raw`\b(?:vzdump|pvesm|pvesh)\b[^\n;&|]*?\s--?(?:${optionPrefix("maxfiles")}|${optionPrefix("prune-backups")})(?=[\s=;&|]|$)`, "i");
// Einen Gast aus einer Sicherung über den bestehenden legen (qmrestore/pct restore
// --force) zerstört ihn samt Snapshots wie destroy.
const PVE_RESTORE = new RegExp(String.raw`\b(?:qmrestore|pct[\s,[\]()'"]+restore)\b[^\n;&|]*?\s--?${optionPrefix("force")}(?![\s=]+(?:0|false|no|off)\b)(?=[\s=;&|]|$)`, "i");
// Am qm/pct vorbei auf der Speicherebene (Box: LVM-thin; ZFS, qcow2): Gast-Volumes
// und ihre Snapshots löschen oder zurückrollen. Andere Volume-Namen sind Fokus
// des Türstehers.
const PVE_STORAGE = /\blvremove\b[^\n;&|]*(?:\b(?:vm|base)-\d+-(?:disk|cloudinit|state)|\bsnap_|\bpve\/data\b)|\blvconvert\b[^\n;&|]*\s--merge\b[^\n;&|]*\bsnap_|\bzfs[\s,[\]()]+(?:destroy|rollback)\b[^\n;&|]*(?:@|\b(?:vm|base|subvol|basevol)-\d+-disk)|\bqemu-img[\s,[\]()]+snapshot\b[^\n;&|]*\s-[a-zA-Z]*[ad]\b/i;
const PVE_API_PATH = String.raw`\/(?:snapshot\/[^\s/'"]+|(?:qemu|lxc)\/\d+|storage\/[^\s/'"]+\/(?:content\/[^\s/'"]+|prunebackups)|cluster\/backup\/[^\s/'"]+)`;
const PVE_API_DELETE = new RegExp(String.raw`\bpvesh[\s,[\]()]+delete\s+(?:-\S+\s+)*\S*${PVE_API_PATH}(?:[\s/'"?]|$)|\bpvesh[\s,[\]()]+set\s+(?:-\S+\s+)*\S*\/(?:storage\/[^\s/'"]+\/content\/|cluster\/backup\/)|\/snapshot\/[^\s/'"]+\/rollback\b|(?:\s-[a-zA-Z]*X|--request|--met(?:h(?:o(?:d)?)?)?)[\s=]*DELETE\b[^\n]*\/api2\/\S*${PVE_API_PATH}(?:[\s/'"?]|$)|\/api2\/\S*${PVE_API_PATH}(?:[\s/'"?]|$)[^\n]*(?:\s-[a-zA-Z]*X|--request|--met(?:h(?:o(?:d)?)?)?)[\s=]*DELETE\b|(?:\s-[a-zA-Z]*X|--request|--met(?:h(?:o(?:d)?)?)?)[\s=]*(?:PUT|POST)\b[^\n]*\/api2\/\S*\/(?:cluster\/backup\/|storage\/[^\s/'"]+\/content\/)|\/api2\/\S*\/(?:cluster\/backup\/|storage\/[^\s/'"]+\/content\/)\S+[^\n]*(?:\s-[a-zA-Z]*X|--request|--met(?:h(?:o(?:d)?)?)?)[\s=]*(?:PUT|POST)\b`, "i");
// Proxmox wirft leere Pfadteile weg (/qemu//100), und pvesh nimmt Pfade auch ohne
// führenden Schrägstrich (cluster/backup/x): beides vor dem Vergleich angleichen.
function pveApiText(text) {
  return text.replace(/(?<!:)\/{2,}/g, "/")
    .replace(/(\bpvesh[\s,[\]()]+(?:get|ls|set|create|delete|usage)\s+(?:-\S+\s+)*)(?=[^\s/-])/g, "$1/");
}
const SNAPSHOT_DELETE = /\bcockpit-vps-snapshot\s+delete\b|(?:\s-[a-zA-Z]*X|--request|--met(?:h(?:o(?:d)?)?)?)[\s=]*DELETE\b[^\n]*\/snapshots\b|\/snapshots\b[^\n]*(?:\s-[a-zA-Z]*X|--request|--met(?:h(?:o(?:d)?)?)?)[\s=]*DELETE\b/i;
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

// Der eine Leser für Quotes, Kommentare und Heredocs einer Zeile, ausgehend
// vom Quote, der am Anfang offen war. Ein "<<X" in Quotes oder in einem
// Kommentar öffnet keinen Heredoc.
//
// Kommentar wie in Bash nur am Wortanfang (Zweitprüfung t_ba8ceb38, Karte
// t_8f78c1ac): nach Leerraum, ; & | ( und nach dem ) einer Gruppe (…) oder
// eines Befehls ((…)). Kein Kommentar ist # direkt nach dem ) einer Ersetzung
// $(…), $((…)), <(…), >(…) (echo $(true)#; … läuft weiter), in ${…}, in
// Arithmetik und in `…` (dort endet der Kommentar am Backtick, nicht an der
// Zeile). Im Zweifel kein Kommentar und kein Heredoc mehr in dieser Zeile:
// ein ), dessen ( der Riegel nicht in der Zeile sieht (x=$(<NL>…<NL>)#; …),
// kann eine Ersetzung schließen — dann liest der Riegel lieber zu viel.
//
// Runde 6 (Zweitprüfung t_a7b9a156, Karte t_8334eec9): $'…' endet nicht an
// \' (ANSI-C-Quote); ( nach @ ! + * ? (extglob) und nach = (Array a=(…)) öffnet
// ein Wort, keine Gruppe — # direkt nach seinem ) ist kein Kommentar.
// continues: die Zeile endet mit einem \, das Bash als Fortsetzung liest
// (nicht im Kommentar, nicht in '…' oder $'…').
function scanShell(line, quote = null) {
  const heredocs = [];
  let commentAt = -1;
  const open = []; // "group" ((), "word" ($( <( >( @( a=( ), "arith" ((( ), "warith" ($(( ), "square" ($[ ), "brace" (${)
  let closed = null; // was das ) direkt vor i geschlossen hat
  let backtick = false;
  let noHeredoc = false;
  let continues = false;
  const inArithmetic = () => open.some((kind) => kind === "arith" || kind === "warith" || kind === "square");
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    const after = closed;
    closed = null;
    if (quote === "'") { if (char === "'") quote = null; continue; }
    if (quote === "$'") { if (char === "\\") i += 1; else if (char === "'") quote = null; continue; }
    if (char === "\\") { if (i === line.length - 1) continues = true; i += 1; continue; }
    if (quote === '"') { if (char === '"') quote = null; continue; }
    if (char === "$" && line[i + 1] === "'") { quote = "$'"; i += 1; continue; }
    if (char === "'" || char === '"') { quote = char; continue; }
    if (char === "`") { backtick = !backtick; continue; }
    if (char === "(" && i > 0 && /[@!+*?=]/.test(line[i - 1])) { open.push("word"); continue; }
    if (char === "$" && line[i + 1] === "(" && line[i + 2] === "(" && arithCloses(line, i + 3)) { open.push("warith"); i += 2; continue; }
    if (char === "$" && line[i + 1] === "[") { open.push("square"); i += 1; continue; }
    if (char === "$" && line[i + 1] === "(" || (char === "<" || char === ">") && line[i + 1] === "(") { open.push("word"); i += 1; continue; }
    if (char === "$" && line[i + 1] === "{") { open.push("brace"); i += 1; continue; }
    if (char === "(" && line[i + 1] === "(" && arithCloses(line, i + 2)) { open.push("arith"); i += 1; continue; }
    if (char === "(") { open.push("group"); continue; }
    if (char === ")") {
      const top = open.at(-1);
      if ((top === "arith" || top === "warith") && line[i + 1] === ")") { open.pop(); i += 1; closed = top; continue; }
      if (top === "square" || top === "brace") continue; // ) in $[ … ] bzw. ${ … }
      closed = open.length > 0 ? open.pop() : "unknown";
      continue;
    }
    if (char === "]" && open.at(-1) === "square") { open.pop(); closed = "warith"; continue; }
    if (char === "}" && open.at(-1) === "brace") { open.pop(); continue; }
    if (char === "#" && !backtick && !open.includes("brace") && !inArithmetic()) {
      if (after === "unknown") { noHeredoc = true; continue; }
      if (i === 0 || /[\s;&|(]/.test(line[i - 1]) || after === "group" || after === "arith") { commentAt = i; break; }
      continue;
    }
    if (!noHeredoc && !backtick && !open.includes("brace") && !inArithmetic() && char === "<" && line[i + 1] === "<" && line[i + 2] !== "<" && line[i - 1] !== "<") {
      const delimiter = heredocDelimiter(line, i + 2);
      // Ein Begrenzer in Quotes oder mit \ (<<'EOF', <<\EOF, <<E"OF"): Bash erweitert den Körper nicht.
      if (delimiter) { heredocs.push({ strip: delimiter.strip, word: delimiter.word, quoted: delimiter.quoted }); i = delimiter.end - 1; }
    }
  }
  return { heredocs, quote, continues, code: commentAt >= 0 ? line.slice(0, commentAt) : line };
}

// Der Begrenzer eines Heredocs hinter << (ab from): das ganze Wort bis zum
// ersten Trenner, Quotes und \ aufgelöst (<<E"OF" und <<E\OF enden an EOF,
// Zweitprüfung t_a7b9a156). Ein Wort, das kein Name ist (<<1, <<$x), öffnet
// für den Riegel keinen Heredoc: er liest die Folgezeilen dann als Befehle.
function heredocDelimiter(line, from) {
  let i = from;
  const strip = line[i] === "-";
  if (strip) i += 1;
  while (line[i] === " " || line[i] === "\t") i += 1;
  let word = "";
  let quoted = false;
  while (i < line.length && !/[\s;&|<>()]/.test(line[i])) {
    const char = line[i];
    if (char === "\\") { word += line[i + 1] ?? ""; quoted = true; i += 2; continue; }
    if (char === "'" || char === '"') {
      const end = line.indexOf(char, i + 1);
      if (end < 0) return null;
      word += line.slice(i + 1, end); quoted = true; i = end + 1; continue;
    }
    word += char; i += 1;
  }
  return /^[A-Za-z_][\w.-]*$/.test(word) ? { strip, word, quoted, end: i } : null;
}

// Außerhalb von Quotes: wo ein Kommentar beginnt und welche Heredocs die Zeile öffnet.
function scanUnquoted(line) { return scanShell(line, null); }

// Der Quote, der am Ende einer Zeile noch offen ist ('…<NL>…'), ausgehend vom
// Quote, der am Anfang offen war. null: alle Quotes geschlossen.
function openQuoteAfter(line, quote) { return scanShell(line, quote).quote; }

// Logische Zeilen (Fortsetzungen verbunden) und Heredoc-Körper, jede mit der
// Kennung ihrer ersten physischen Zeile (S<n>:L<n> wie beim Türsteher).
// Runde 6 (Zweitprüfung t_a7b9a156, Karte t_8334eec9): der Quote, der am Ende
// einer Zeile offen bleibt, gilt am Anfang der nächsten (echo 'a<NL># '; …: das #
// steht in Bash noch im Quote); \<NL> verbindet nur, wo Bash es tut (nicht am
// Ende eines Kommentars, nicht in '…' oder $'…'); im Körper eines Heredocs
// ohne Quotes am Begrenzer verbindet \<NL> vor dem Vergleich mit dem Begrenzer.
// span: die physischen Zeilen [von, bis) der logischen Zeile.
function splitScript(prefix, text) {
  const physical = text.replace(/\r\n/g, "\n").split("\n");
  const lines = [];
  const heredocs = [];
  let index = 0;
  let quote = null;
  while (index < physical.length) {
    const id = `${prefix}:L${index + 1}`;
    const from = index;
    const startQuote = quote;
    let raw = physical[index];
    index += 1;
    // Bash setzt eine Zeile auch nach |, |&, && und || am Zeilenende fort
    // (ls … | sed … |<NL>sh): der Riegel liest das wie die Backslash-Fortsetzung
    // als eine logische Zeile (Zweitprüfung t_5dd27194, B2). Nicht, wenn die
    // Zeile einen Heredoc öffnet (dessen Körper folgt zuerst) oder ein Quote
    // offen bleibt (dann ist das | nur Text).
    for (;;) {
      while (scanShell(raw, startQuote).continues && index < physical.length) { raw = raw.slice(0, -1) + physical[index]; index += 1; }
      const scanned = scanShell(raw, startQuote);
      if (index >= physical.length || scanned.heredocs.length > 0 || scanned.quote !== null || !/(?:\||&&|\|&)\s*$/.test(scanned.code)) break;
      raw = `${scanned.code.replace(/\s+$/, "")} ${physical[index]}`; index += 1;
    }
    const scanned = scanShell(raw, startQuote);
    quote = scanned.quote;
    const line = { id, raw, code: scanned.code, heredocs: [], span: [from, index] };
    lines.push(line);
    for (const doc of scanned.heredocs) {
      const body = [];
      let closed = false;
      while (index < physical.length) {
        // Verglichen wird die verbundene Zeile, im Körper stehen die physischen.
        const start = index;
        let bodyLine = physical[index];
        index += 1;
        if (!doc.quoted) {
          while (/(^|[^\\])(\\\\)*\\$/.test(bodyLine) && index < physical.length) { bodyLine = bodyLine.slice(0, -1) + physical[index]; index += 1; }
        }
        if ((doc.strip ? bodyLine.replace(/^\t+/, "") : bodyLine) === doc.word) { closed = true; break; }
        for (let k = start; k < index; k += 1) body.push({ id: `${prefix}:L${k + 1}`, raw: physical[k] });
      }
      const heredoc = { line, body, closed, quoted: doc.quoted };
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
    // $'…' (ANSI-C): \' schließt nicht; das $ bleibt stehen (der Wert entsteht erst in Bash).
    if (quote === "$'") { if (char === "'") quote = null; else { if (char === "\\") { out += char; i += 1; } const next = code[i] ?? ""; out += QUOTED_SEPARATOR.test(next) ? IN_QUOTES + next : next; } continue; }
    if (char === "$" && code[i + 1] === "'" && quote === null) {
      // Ohne Backslash ist $'…' dasselbe wie '…' (qm del$'s'napshot).
      const end = code.indexOf("'", i + 2);
      if (end >= 0 && !code.slice(i + 2, end).includes("\\")) { quote = "'"; literal = OWN_LANGUAGE.test(code.slice(0, i)); i += 1; continue; }
      out += "$"; quote = "$'"; i += 1; continue;
    }
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
// Arithmetik (Zweitprüfung t_23d4dbd9, Karte t_ac8559f4): Bash führt jedes $(…)
// und `…` in $((…)) aus (echo $(( $(R repair) )) startet R). Der Ausdruck wird
// zu 0, seine Ersetzungen werden wie überall eigene Befehle in inner — derselbe
// Leser, rekursiv im Modus arith (dort ist < bzw. > ein Vergleich, kein <(…)).
// ((…)), $[…], let, for ((…)) und ein Index bleiben Text; ihr $(…)/`…` findet
// dieser Leser ohnehin.
function extractSubstitutions(text, inner, arith = false) {
  let out = "";
  let i = 0;
  while (i < text.length) {
    if (text.startsWith("$((", i) && arithCloses(text, i + 3)) {
      const end = closing(text, i + 3, "(", ")", 2);
      extractSubstitutions(text.slice(i + 3, Math.max(i + 3, end - 2)), inner, true);
      out += "0"; i = end; continue;
    }
    const opener = text.startsWith("$(", i) ? 2 : !arith && (text[i] === "<" || text[i] === ">") && text[i + 1] === "(" ? 2 : 0;
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
  // Eine Gruppe ( … ) oder { …; } hinter einer Pipe liest die Pipe: jeder
  // Befehl darin bekommt sie als Eingabe (echo '…' | (exec bash), | { cd /; sh; };
  // Zweitprüfung t_5dd27194, B1). Der Stapel merkt sich das je Gruppe.
  const groups = [];
  const inPipedGroup = () => groups.length > 0 && groups.at(-1);
  const push = () => {
    if (current.trim()) segments.push({ text: current.trim(), piped: piped || inPipedGroup(), quoted });
    current = ""; piped = nextPiped; nextPiped = false; quoted = nextQuoted; nextQuoted = false;
  };
  const opensGroup = () => { groups.push(piped || inPipedGroup()); };
  for (let i = 0; i < cleaned.length; i += 1) {
    if (cleaned[i] === IN_QUOTES) { nextQuoted = true; continue; }
    const char = cleaned[i];
    if ((char === "(" || char === "{" && /\s/.test(cleaned[i + 1] ?? "")) && !current.trim()) {
      const wasPiped = piped;
      push(); piped = wasPiped; opensGroup(); piped = false; continue;
    }
    if (char === ")" || char === "}" && !current.trim() && /^(?:[\s;&|)]|$)/.test(cleaned[i + 1] ?? "")) {
      push(); groups.pop(); piped = false; continue;
    }
    if (char === "|" && cleaned[i + 1] === "|") { push(); piped = false; i += 1; continue; }
    // |& ist eine Pipe (stdout und stderr), kein | mit nachfolgendem & (Zweitprüfung t_605da75b, N1).
    if (char === "|" && cleaned[i + 1] === "&") { nextPiped = true; push(); i += 1; continue; }
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
      // Der Platzhalter aus -I/-i/--replace zählt wie {} (xargs -I@ /usr/local/sbin/@ repair;
      // Hinweis H-a der Zweitprüfung t_0b3f7290).
      const valued = new Set(["-I", "-d", "-n", "-P", "-L", "-s", "-E", "-a", "--arg-file", "--delimiter", "--max-args", "--max-procs"]);
      let placeholder = null;
      let end = i;
      for (; end < words.length && words[end].startsWith("-") && words[end] !== "--"; end += 1) {
        const flag = words[end];
        if (flag === "-I") placeholder = words[end + 1] ?? null;
        else if (/^-I./.test(flag)) placeholder = flag.slice(2);
        else if (/^-i/.test(flag)) placeholder = flag.slice(2) || "{}";
        else if (/^--replace(?:=|$)/.test(flag)) placeholder = flag.slice("--replace=".length) || "{}";
        if (valued.has(flag)) end += 1;
      }
      if (placeholder && placeholder !== "{}") words = [...words.slice(0, end), ...words.slice(end).map((word) => word.replaceAll(placeholder, "{}"))];
      skipOptions(valued);
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

// Ziele einer Umleitung, die die Datei kürzt (>, >|, n>, &>; nicht >>, >&n).
function truncateTargets(text) {
  return [...text.matchAll(/(?:^|[^<>])>\|?(?![>&(])\s*([^\s;&|<>]+)/g)].map((match) => match[1])
    .filter((target) => !/^\/dev\//.test(target));
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

function globRegex(glob, slash = false) {
  let pattern = "";
  for (let i = 0; i < glob.length; i += 1) {
    const char = glob[i];
    if (char === "*") pattern += slash ? ".*" : "[^/]*";
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
// vzdump-Sicherungen außerhalb von /var/lib/vz/dump (Rolle box): eine Datei
// vzdump-* oder *.vma* an jedem Ort, das dump-Verzeichnis jedes eingehängten
// Speichers (/mnt/pve/<speicher>/dump) und — bei Bäumen — seine Vorfahren. Ein
// Glob im Speichernamen kann jeden Speicher treffen. Das dump-Verzeichnis eines
// Verzeichnis-Speichers an anderem Ort steht nur in storage.cfg; dort greifen die
// Dateinamen.
const VZDUMP_FILE = /vzdump-|\.vma(?:\.|$)/i;
function vzdumpTouches(path, bulk) {
  const parts = path.split("/").filter(Boolean);
  if (VZDUMP_FILE.test(parts.at(-1) || "")) return true;
  const fits = ["mnt", "pve", null, "dump"].every((want, index) => {
    const part = parts[index];
    if (part === undefined || want === null) return true;
    return GLOB.test(part) ? globRegex(part).test(want) : part === want;
  });
  return fits && (parts.length >= 4 || (bulk && parts.length >= 1));
}
const vzdumpAny = (path, bulk) => expandBraces(path).some((variant) => vzdumpTouches(resolvePath(variant, "/"), bulk));
const touchesConfig = (path) => pathTouches(path, false, CONFIG, []);
// Kürzen per Umleitung (: > f, > f, echo > f; Karte t_a5defddd, H1): ein Treffer
// dort, wo nur das Backup-Werkzeug schreibt — Repo, GitLab-Sicherungen,
// vzdump-Sicherungen. In /var/backups bleibt es Fokus des Türstehers: dort legt
// ein Plan den eigenen Rückweg an (wp db export > /var/backups/…).
const TRUNCATE_DATA = ["/media/RAID/backup_VServer", "/var/opt/gitlab/backups", "/var/lib/vz/dump"];
const touchesTruncate = (path) => pathTouches(path, false, TRUNCATE_DATA, []) || vzdumpAny(path, false);
const DATA_ANCESTORS = ancestorsOf(DATA);
const touchesData = (path, bulk) => pathTouches(path, bulk, DATA, DATA_ANCESTORS) || vzdumpAny(path, bulk);
const touchesBolted = (path) => pathTouches(path, true, BOLTED, BOLTED_ANCESTORS) || vzdumpAny(path, true);
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
    case "cockpit-borg-action": return (args.length === 1 && (args[0] === "status" || args[0] === "check")) || (args.length === 2 && args[0] === "db-access" && (args[1] === "status" || args[1] === "check")) || (args.length === 2 && args[0] === "sources" && args[1] === "status");
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
    // Eine Kurzoption nimmt ihren Wert auch angehängt (-XDELETE, -kXDELETE).
    case "curl": return !/\s-[a-zA-Z]*[oODcKdFTXbu]|\s--(?:output|remote-name|dump-header|cookie-jar|config|data|json|form|upload-file|request|post|user)\b/.test(joined);
    case "wget": return /\s(?:-q?O\s*-|--spider)(?:\s|$)/.test(joined) && !/\s--(?:post|met|body)/.test(joined);
    case "dpkg": return /^\s(?:-l|-s|-L|-S|--status|--list|--listfiles|--search|--print-architecture)\b/.test(joined);
    case "apt": return ["list", "show", "policy", "search"].includes(firstVerb(args).verb || "");
    case "apt-mark": return /^show/.test(firstVerb(args).verb || "");
    case "command": return args[0] === "-v" || args[0] === "-V";
    // Nur ein exaktes oder eindeutig aufgelöstes Leseverb (qm listsn = listsnapshot).
    case "qm": case "pct": case "pvesh": {
      const { verb, unique } = pveVerb(name, args[0] || "");
      return unique && (name === "pvesh" ? PVESH_READ : PVE_GUEST_READ).has(verb);
    }
    case "pvesm": {
      const { verb, unique } = pveVerb(name, args[0] || "");
      if (!unique) return false;
      if (PVESM_READ.has(verb)) return true;
      // prune-backups --dry-run listet nur, was ginge. Jede Schreibweise der Option
      // (-dry-run, --dry, --dry-run=…; der letzte Wert gilt) muss wahr sein.
      if (verb !== "prune-backups") return false;
      const dries = args.map((arg, index) => ({ arg, index })).filter(({ arg }) => /^--?d(?:r(?:y(?:-(?:r(?:u(?:n)?)?)?)?)?)?(?:=|$)/.test(arg));
      return dries.length > 0 && dries.every(({ arg, index }) => {
        const value = arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : args[index + 1];
        return arg.includes("=") ? /^(?:1|true|yes|on)$/i.test(value) : value === undefined || value.startsWith("-") || /^(?:1|true|yes|on)$/i.test(value);
      });
    }
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
function phraseBolt(raw) {
  const text = pveVerbs(raw);
  if (DELETE_PHRASE.test(text)) return "deletes backups (borg/borgmatic delete, prune, compact, recreate, break-lock or a key change)";
  if (RETENTION_PHRASE.test(text)) return "changes the retention of the backups";
  if (SNAPSHOT_DELETE.test(text)) return "deletes a machine snapshot";
  if (PVE_GUEST.test(text)) return "deletes or rolls back a Proxmox guest snapshot or destroys a guest (qm/pct delsnapshot, rollback, destroy)";
  if (PVE_BACKUP.test(text)) return "deletes vzdump backups (vzdump --remove, pvesm prune-backups, pvesm free on a backup volume)";
  if (PVE_RETENTION_OPTION.test(text)) return "changes the retention of the backups (an abbreviated maxfiles or prune-backups option)";
  if (PVE_RESTORE.test(text)) return "restores over an existing Proxmox guest (qmrestore/pct restore --force), which destroys it with its snapshots";
  if (PVE_STORAGE.test(text)) return "deletes or rolls back a Proxmox guest volume or snapshot on the storage layer (lvremove, lvconvert --merge, zfs destroy/rollback, qemu-img snapshot)";
  if (PVE_API_DELETE.test(pveApiText(text))) return "deletes or rolls back over the Proxmox API (guest snapshot, guest, storage content, pruning or a backup job)";
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
  // Code einer anderen Sprache (perl -e 'system(…)', python -c 'os.system(…)'),
  // eine Cron-Zeile oder ein Text, der in eine Shell fließt: welches Verb der
  // Helfer dort bekommt, liest der Riegel nicht (t_5ce5f79f).
  if (HELPER_NAME.test(normalized) || paths.some((path) => GLOB.test(path) && globRegex(path).test(BORG_ACTION_PATH))) return "code that runs the backup helper, where the bolt cannot read its verb";
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
      // Code einer anderen Sprache liest der Riegel nicht: jede Nennung des Helfers ohne freie Form zählt.
      const mentions = helperMentions(raw);
      if (mentions.includes("arg")) hit(id, "backup", HELPER_ARG_REASON, raw);
      else if (countNonFree(mentions) > 0) hit(id, "backup", HELPER_HIDDEN_REASON, raw);
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

  const helperVars = helperVariables(lines, cwds);
  // Erster Durchgang von analyzeManifest: merkt, ob der Plan den Helfer
  // außerhalb seiner freien Formen nennt.
  context.taint ||= planTaint(lines, cwds, helperVars);

  // ssh lab0 '<NL>python3 -c …<NL>': ein Quote, der über das Zeilenende reicht,
  // trägt den Befehl nach Lab0 in die Folgezeilen. Dort ist jedes Löschen und
  // alles, was der Riegel nicht lesen kann, ein Treffer — wie in derselben Zeile.
  let quote = null;
  let lab0Block = null;
  for (const { line, segments } of prepared) {
    const code = line.raw;
    const onLab0Block = quote ? lab0Block : null;
    const quotedBefore = quote;
    quote = openQuoteAfter(line.raw, quote);
    // Ein Argument in Quotes über das Zeilenende (sources add '/opt/stacks/x<NL>- /etc'):
    // der Riegel liest jede Zeile für sich, der Helfer bekäme beide (t_5ce5f79f, H1).
    if ((quotedBefore || quote) && HELPER_NAME.test(normalize(line.code))) hit(line.id, "backup", "a quoted argument spans lines next to the backup helper; the bolt reads each line on its own", code);
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
    // Zeilen-Allowlist: nennt die Zeile den Helfer, darf sie nur filtern und Daten ablegen.
    const allowlist = allowlistBolt(line, cwds, context, resolve, helperVars);
    if (allowlist) hit(line.id, "backup", allowlist, code);
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
    let pipeNames = false;
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
      let named = false;
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
        // Pipe-Ausgabe, deren Quelle den Helfer nennt, landet in einer Datei, die
        // laufen kann (> /etc/cron.d/x, | tee /tmp/r, dann bash /tmp/r): dort läuft
        // der Helfer mit einem Verb, das der Riegel nicht liest (Zweitprüfung t_5dd27194, B3/B4).
        if (segment.piped && pipeNames && (result.writes || []).some((target) => runnableTarget(target, context))) hit(line.id, "backup", `pipe output on a line that names the backup helper is written into a file that can run (${result.name || "a redirect"})`, code);
        named ||= result.namesHelper;
        touching ||= result.touching;
        nextEchoed ||= result.echoed;
        nextFound.push(...result.found);
      }
      pipeNames = segment.piped ? pipeNames || named : named;
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
      // Bash erweitert den Körper eines Heredocs ohne Quotes am Begrenzer wie eine Zeile.
      const evaluated = context.tainted && !heredoc.quoted ? expansionCode(item.raw) : null;
      if (evaluated) hit(item.id, "backup", `a plan that names the backup helper outside its free forms may not let bash evaluate a value as code; here (a here-document): ${evaluated}`, item.raw);
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
    // Ein Körper, den der Riegel nicht als Skript liest: jede Nennung des
    // Helfers ohne freie Form zählt (Karte t_8334eec9) — wie wenn der Leser
    // den Begrenzer falsch liest und Bash die Zeile ausführt.
    for (const chunk of rawChunks(heredoc.body.map((item) => item.raw), 0, heredoc.body.length)) {
      if (countNonFree(helperMentions(chunk.text)) > 0) hit(heredoc.body[chunk.index].id, "backup", HELPER_HIDDEN_REASON, chunk.text);
    }
  }

  // Ungekürzter Text (Karte t_8334eec9): der Helfer-Riegel auf jeder physischen
  // Zeile, Kommentare und Heredoc-Körper eingeschlossen (siehe helperMentions).
  // Zuletzt, damit der genauere Grund des Lesers vorn steht.
  const physical = text.replace(/\r\n/g, "\n").split("\n");
  for (const chunk of rawChunks(physical, 0, physical.length)) {
    if (helperMentions(chunk.text).includes("arg")) hit(`${prefix}:L${chunk.index + 1}`, "backup", HELPER_ARG_REASON, chunk.text);
  }
  for (const line of lines) {
    const named = rawChunks(physical, line.span[0], line.span[1]).reduce((sum, chunk) => sum + countNonFree(helperMentions(chunk.text)), 0);
    if (named > countNonFree(helperMentions(line.code))) hit(line.id, "backup", HELPER_HIDDEN_REASON, line.raw);
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
  // Aufbewahrung und schaltet nichts ab — frei wie status und check (helperVerbBolt).
  // sources (Karte t_2b394537): eine Quelle hinzufügen stärkt den Rückweg und ist
  // frei; den Verweis in config.yaml setzen oder lösen und Quellen zurücknehmen
  // (connect, disconnect, restore) bleibt beim Riegel.
  // Eine Kopie oder ein Link des Helfers unter anderem Namen erkennt der Riegel
  // nicht mehr am Befehlswort (Zweitprüfung PR #69, Befund 1).
  if (/^(?:ln|cp|install|rsync|link)$/.test(name) && args.some((arg) => !arg.startsWith("-") && baseName(arg) === "cockpit-borg-action")) return "copies or links the backup helper under another name, where the bolt no longer recognizes it";
  // `bash|sh|source|. /usr/local/sbin/cockpit-borg-action <verb>` läuft den Helfer
  // mit denselben Argumenten: dieselben Regeln (Zweitprüfung PR #69, Befund 1).
  // Das Befehlswort bleibt die Shell, damit ihre eigenen Hinweise (Heredoc als
  // Shell gelesen, Text aus einer Pipe) erhalten bleiben; Optionen wie -s oder -c
  // lesen den Code woanders her und machen die Form selbst nicht frei.
  // Greift, sobald irgendein Argument der Helfer ist (auch hinter -v, -O …, -o …);
  // frei bleibt nur die exakte Form.
  const viaShell = shellHelperArg(name, args);
  if (viaShell >= 0) {
    const inner = args.slice(viaShell + 1);
    const innerDb = inner.length === 2 && inner[0] === "db-access" && ["status", "check", "ensure", "adopt", "restore"].includes(inner[1]);
    if (args[viaShell] !== BORG_ACTION_PATH || args.slice(0, viaShell).some((arg) => arg !== "--" && !/^-[eux]+$/.test(arg)) || !(sourcesFree(inner) || innerDb || (inner.length === 1 && (inner[0] === "status" || inner[0] === "check")))) {
      return "the backup helper through a shell outside status, check, db-access, sources status and sources add <path below the roots>";
    }
  }
  if (name === "cockpit-borg-action") { const verb = helperVerbBolt(helperArgs(args, cwds, context)); if (verb) return verb; }

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
    if (args.includes("-delete") || (exec >= 0 && /^(?:rm|rmdir|shred|unlink|mv)$/.test(baseName(args[exec + 1] || "")))) {
      deleted = resolveAll(findStarts(args));
      // vzdump-Sicherungen nach ihrem Namen, wo der Speicher dem Riegel unbekannt ist.
      if (args.some((arg, index) => /^-(?:i?name|i?path|i?wholename|i?regex)$/.test(args[index - 1] || "") && VZDUMP_FILE.test(arg.replace(/^\*/, "")))) return "find deletes vzdump backups by their name";
    }
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
  if (resolveAll(truncateTargets(text)).some(touchesTruncate)) return `${name || "a redirect"} truncates backups`;
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

// Die Argumente des Helfers ohne Umleitungen, die nur Ausgabe wegschreiben
// (Karte t_70e65772): `R status >/dev/null`, `R check 2>&1`, `R status >
// /tmp/s.txt` sind die freie Form. Ein Deskriptor (n>&m, n<&-) oder eine
// Ausgabe in eine Datendatei bzw. /dev/null fällt weg; jede andere Umleitung
// (Eingabe, Here-String, Datei, die laufen kann, Ziel aus einer Variablen)
// bleibt ein Wort und macht die Form unfrei.
const REDIRECT_WORD = /^(?:\d+|\{\w+\})?(&>>|&>|>>|>\||>&|<&|>|<)(.*)$/;
function helperArgs(args, cwds, context) {
  const out = [];
  for (let k = 0; k < args.length; k += 1) {
    const redirect = args[k].match(REDIRECT_WORD);
    if (!redirect) { out.push(args[k]); continue; }
    const separate = redirect[2] === "" && k + 1 < args.length;
    const target = separate ? args[k + 1] : redirect[2];
    const dup = (redirect[1] === ">&" || redirect[1] === "<&") && /^(?:\d+|-)$/.test(target);
    const sink = /^(?:&>>|&>|>>|>\||>)$/.test(redirect[1]) && target !== "" && (DATA_DEVICES.test(target) || ![...cwds].some((cwd) => runnableTarget(resolvePath(target, cwd), context)));
    if (!dup && !sink) { out.push(args[k]); continue; }
    if (separate) k += 1;
  }
  return out;
}
function helperVerbBolt(args) {
  const dbAccess = args.length === 2 && args[0] === "db-access" && ["status", "check", "ensure", "adopt", "restore"].includes(args[1]);
  if (args[0] === "sources" && !sourcesFree(args)) return "the backup helper's sources outside status and add <path below /opt/stacks, /srv or /var/lib/docker/volumes> (connect, disconnect and restore change the configuration or drop sources)";
  if (args[0] !== "sources" && !dbAccess && !(args.length === 1 && (args[0] === "status" || args[0] === "check"))) return "the backup helper outside status, check, db-access and sources (repair can delete archives)";
  return null;
}

// Welches Argument einer Shell (bash|sh|source|.) der Helfer ist; -1: keins.
function shellHelperArg(name, args) {
  if (!SHELLS.has(name) && name !== "source" && name !== ".") return -1;
  return args.findIndex((arg) => baseName(arg) === "cockpit-borg-action" || (GLOB.test(arg) && globRegex(arg).test(BORG_ACTION_PATH)));
}

// Der Helfer in einer Form, die segmentBolt nicht nach Verben liest (t_5ce5f79f):
// frei bleiben nur die Direktform (Befehlswort = Helfer) und die Shell-Form —
// beide urteilt segmentBolt genau —, reines Lesen (ls, sha256sum, journalctl …)
// und Textausgabe (echo/printf/logger; in eine Datei, die laufen kann, oder in
// eine Pipe prüft codeBolt den Text).
function helperBolt(text, command, name, cwds, line) {
  if (name === "cockpit-borg-action" || ECHOES.has(name) || shellHelperArg(name, command.args) >= 0) return null;
  if (readOnlyForm({ ...command, prefixes: [] }, text)) return null;
  if (namesHelper(text, cwds)) return "names the backup helper in a form whose verb the bolt cannot read (find -exec, xargs, an interpreter, another program); free is only the helper itself with status, check, db-access, sources status or sources add <path>";
  // xargs, oder der Rest von find nach einem \; (-exec {} …): der Befehl entsteht
  // aus Text, und die Zeile nennt den Helfer.
  if ((command.prefixes.includes("xargs") || name.startsWith("-")) && lineNamesHelper(line, cwds)) return "builds a command from input on a line that names the backup helper (find, xargs)";
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

  // Ein Glob, der auf den Backup-Helfer passt, ist der Helfer in einer Form, die
  // der Riegel nicht nach seinen Verben lesen kann — auch in Quotes (sh -c '…; …'),
  // wo die innere Shell ihn expandiert (Zweitprüfung PR #69).
  if (GLOB.test(word) && globRegex(word.replaceAll("{}", "*")).test(BORG_ACTION_PATH)) hit(line.id, "backup", "the backup helper named by a glob", code);
  // Wer läuft? Ein dynamischer Name ist unsicher — und ein Treffer, wenn die
  // Zeile den Helfer nennt (ls …/cockpit-borg-action | xargs -I{} {} restore).
  if (word.includes(OPAQUE) || word.startsWith("$") || !quoted && GLOB.test(word)) {
    hit(line.id, "uncertain", "the command name is built at run time", code);
    if (lineNamesHelper(line, cwds)) hit(line.id, "backup", "the command name is built at run time on a line that names the backup helper", code);
    const bolt = phraseBolt(text);
    if (bolt) hit(line.id, "backup", bolt, code);
    return { touching: true, readOnly: false, name, deletesFromInput: false, runsInput: true, echoed: null, found: [] };
  }
  // eval führt Text aus, der erst zur Laufzeit entsteht (eval "$(echo '…/cockpit-borg-action repair')"):
  // auf einer Zeile, die den Helfer nennt, ein Treffer wie sh -c "$(…)" (Zweitprüfung t_5dd27194, B5).
  if (name === "eval" && lineNamesHelper(line, cwds)) hit(line.id, "backup", "eval runs text built at run time on a line that names the backup helper", code);
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
    // Nennt die Zeile den Helfer, läuft er so mit einem Verb, das der Riegel
    // nicht liest (ls …/cockpit-borg-action | sed 's/$/ repair/' | sh;
    // Zweitprüfung t_0b3f7290).
    if (lineNamesHelper(line, cwds)) hit(line.id, "backup", `${name} runs text from a pipe on a line that names the backup helper`, code);
  }
  if (command.fromStdin && command.prefixes.includes("xargs") && !readOnlyForm({ ...command, prefixes: [] }, text)) {
    hit(line.id, "uncertain", "xargs builds the arguments from its input", code);
  }
  // find -exec {} …: find führt aus, was es findet.
  if (name === "find" && command.args.some((arg, index) => FIND_EXEC.test(arg) && (command.args[index + 1] || "").includes("{}"))) {
    hit(line.id, "uncertain", "find runs what it finds as a command", code);
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
        // bash <(echo '…/cockpit-borg-action repair'): dasselbe über ein Skript,
        // das der Plan nicht zeigt (Zweitprüfung t_0b3f7290).
        if (shellHelperArg(name, command.args) < 0 && lineNamesHelper(line, cwds)) {
          hit(line.id, "backup", `${name} runs a script this plan does not show on a line that names the backup helper`, code);
        }
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
  const bolt = segmentBolt(text, command, name, readOnly, cwds, context, line, piped) || helperBolt(text, command, name, cwds, line);
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
    // Nennt der Befehl den Helfer, ohne ihn selbst zu sein? Seine Ausgabe kann
    // dann eine Helfer-Zeile mit beliebigem Verb sein (ls …/cockpit-borg-action | sed 's/$/ repair/').
    namesHelper: name !== "cockpit-borg-action" && shellHelperArg(name, command.args) < 0 && namesHelper(text, cwds),
    // Wohin er schreibt: Umleitung und tee.
    writes: [...redirectTargets(text), ...(name === "tee" ? command.args.filter((arg) => !arg.startsWith("-")) : [])]
      .filter((target) => !target.includes(OPAQUE)).flatMap((target) => [...cwds].map((cwd) => resolvePath(target, cwd))),
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
  // Plan-Umfang (Zweitprüfung t_20ae3cda, Karte t_d16c58d1): ein erster
  // Durchgang stellt fest, ob irgendeine Zeile den Helfer außerhalb seiner
  // freien Formen nennt; dann gilt die Allowlist im zweiten für alle Zeilen.
  context.taint = null;
  for (const { prefix, text } of scripts) {
    try { analyzeScript(prefix, text, context, []); } catch { /* der zweite Durchgang meldet es */ }
  }
  context.tainted = context.taint;
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
