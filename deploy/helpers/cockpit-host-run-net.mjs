// cockpit-host-run-net — welches Netz unter der Tür liegt, je Kiste
// (doc/setup/host-run.md, Abschnitt 4).
//
// Eine Quelle für Helfer und API: der Root-Helfer (cockpit-host-run) liest die
// Einstellung vor jedem verändernden Lauf und baut danach sein Netz, die API
// liest dieselbe Datei nur, um dem Türsteher und dem Planer ehrlich zu sagen,
// was darunter liegt. Umgebungsvariablen gibt es dafür bewusst nicht: sudo
// setzt sie zurück, und die Lauf-Unit bekommt nur COCKPIT_HOST_RUN_IN_UNIT.
//
// Datei: /etc/wireguard-ops-cockpit/host-run-net.json (root, 0644; der Helfer
// lehnt eine Datei ab, die nicht root gehört oder für Gruppe/andere schreibbar
// ist). Fehlt sie, gilt das Netz des VPS ("hoster-snapshot") — so wie vor
// dieser Einstellung. Die Datei nennt nur Werte, nie Befehle: welche Programme
// laufen, steht hier im Code.
//
//   hoster-snapshot  VPS: das letzte borg-Backup jünger als 24 h, dann ein
//                    Maschinen-Snapshot beim Hoster (cockpit-vps-snapshot).
//   system-backup    physische Kiste (Lab0, Entscheidung Jochen 02.10.2026):
//                    RAID gesund, Ziel auf dem eingehängten RAID, genug Platz,
//                    Aufräum-Dienst ohne Anomalie, dann ein borg-Archiv der
//                    Quellen (unverschlüsselt, -x) im eigenen Repo <target>/repo,
//                    daneben die Standalone-borg-Binary und NOTFALL.txt für das
//                    Rescue-System. Aufbewahrung je Reihe: keepPreRun Vor-Lauf-
//                    und keepWeekly Wochen-Archive (Timer
//                    cockpit-systemsicherung.timer); geprunt wird nur in diesem
//                    Repo und nur nach den eigenen Archivnamen.
//
// reboot (beide Netze, optional): onSite sagt, dass nur jemand vor Ort hilft,
// wenn die Kiste nach einem Neustart nicht hochkommt; mustBeEnabled nennt
// Gruppen von Units, von denen je mindestens eine `enabled` sein muss, bevor
// der Lauf (und jeder Neustart-Schritt) die Kiste neu startet.

export const HOST_RUN_NET_VERSION = "cockpit-host-run-net/v1";
export const HOST_RUN_NET_FILE = "host-run-net.json";

export const SYSTEM_BACKUP_BOUNDS = Object.freeze({
  keepPreRun: [1, 20],
  keepWeekly: [1, 12],
  reserveGB: [0, 10000],
  timeoutSeconds: [600, 21600],
  sources: [1, 8],
  exclude: [0, 32],
});

// Nach dem Archiv: prune und compact, je höchstens so lange (Helfer und API
// rechnen es in ihre Fristen ein).
export const SYSTEM_BACKUP_UPKEEP_SECONDS = 1800;

const DEFAULT_NET = Object.freeze({ version: HOST_RUN_NET_VERSION, net: "hoster-snapshot", systemBackup: null, retentionService: false, reboot: { onSite: false, mustBeEnabled: [] } });

const SEGMENT = /^[A-Za-z0-9._@+-]{1,255}$/;
const UNIT = /^[A-Za-z0-9@._:-]{1,120}\.(?:service|socket|target|path|timer)$/;
const MD = /^md[0-9]{1,3}$/;

// Absolut, Abschnitt für Abschnitt (kein verschachtelter Regex: der liefe bei
// einem langen Pfad mit einem fremden Zeichen am Ende ewig), ohne . und ..
function cleanPath(value) {
  if (typeof value !== "string" || !value.startsWith("/") || value.length > 1024) return null;
  if (value === "/") return value;
  const parts = value.slice(1).replace(/\/+$/, "").split("/");
  return parts.every((part) => SEGMENT.test(part) && part !== "." && part !== "..") ? `/${parts.join("/")}` : null;
}

function within(path, base) {
  return path === base || path.startsWith(`${base === "/" ? "" : base}/`);
}

function exactKeys(value, allowed, where) {
  const extra = Object.keys(value).filter((key) => !allowed.includes(key));
  if (extra.length) throw new Error(`${where}: unknown field ${extra.join(", ")}`);
}

function integer(value, [min, max], where) {
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${where} must be an integer from ${min} to ${max}`);
  return value;
}

function parseReboot(value) {
  if (value === undefined) return { onSite: false, mustBeEnabled: [] };
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("reboot must be an object");
  exactKeys(value, ["onSite", "mustBeEnabled"], "reboot");
  if (value.onSite !== undefined && typeof value.onSite !== "boolean") throw new Error("reboot.onSite must be true or false");
  const groups = value.mustBeEnabled ?? [];
  if (!Array.isArray(groups) || groups.length > 8) throw new Error("reboot.mustBeEnabled must be a list of at most 8 groups");
  for (const group of groups) {
    if (!Array.isArray(group) || group.length < 1 || group.length > 4 || !group.every((unit) => typeof unit === "string" && UNIT.test(unit))) {
      throw new Error("reboot.mustBeEnabled: each group is a list of 1 to 4 unit names (for example [\"ssh.service\", \"ssh.socket\"])");
    }
  }
  return { onSite: value.onSite === true, mustBeEnabled: groups.map((group) => [...group]) };
}

function parseSystemBackup(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("systemBackup must be an object");
  exactKeys(value, ["target", "mount", "raidDevice", "sources", "exclude", "keepPreRun", "keepWeekly", "reserveGB", "timeoutSeconds"], "systemBackup");
  const mount = cleanPath(value.mount);
  if (!mount || mount === "/") throw new Error("systemBackup.mount must be the absolute mount point of the backup disk (not /)");
  const target = cleanPath(value.target);
  if (!target || target === mount || !within(target, mount)) throw new Error("systemBackup.target must be a directory below systemBackup.mount");
  if (typeof value.raidDevice !== "string" || !MD.test(value.raidDevice)) throw new Error("systemBackup.raidDevice must name an md array (for example md0)");
  const sources = value.sources;
  if (!Array.isArray(sources) || sources.length < SYSTEM_BACKUP_BOUNDS.sources[0] || sources.length > SYSTEM_BACKUP_BOUNDS.sources[1]) throw new Error("systemBackup.sources must list 1 to 8 absolute paths");
  const cleanSources = sources.map((source) => {
    const clean = cleanPath(source);
    if (!clean) throw new Error(`systemBackup.sources: ${String(source).slice(0, 80)} is not an absolute path`);
    // Die Sicherung läge sonst in sich selbst.
    if (within(mount, clean) && clean !== "/") throw new Error(`systemBackup.sources: ${clean} contains the backup disk`);
    if (within(clean, mount)) throw new Error(`systemBackup.sources: ${clean} lies on the backup disk`);
    return clean;
  });
  const exclude = value.exclude ?? [];
  if (!Array.isArray(exclude) || exclude.length > SYSTEM_BACKUP_BOUNDS.exclude[1] || !exclude.every((item) => typeof item === "string" && /^\/[^\n\0]{0,200}$/.test(item))) {
    throw new Error("systemBackup.exclude must list at most 32 absolute borg patterns");
  }
  return {
    target, mount, raidDevice: value.raidDevice, sources: cleanSources, exclude: [...exclude],
    keepPreRun: integer(value.keepPreRun, SYSTEM_BACKUP_BOUNDS.keepPreRun, "systemBackup.keepPreRun"),
    keepWeekly: integer(value.keepWeekly, SYSTEM_BACKUP_BOUNDS.keepWeekly, "systemBackup.keepWeekly"),
    reserveGB: integer(value.reserveGB, SYSTEM_BACKUP_BOUNDS.reserveGB, "systemBackup.reserveGB"),
    timeoutSeconds: integer(value.timeoutSeconds, SYSTEM_BACKUP_BOUNDS.timeoutSeconds, "systemBackup.timeoutSeconds"),
  };
}

// Prüft die Form streng: ein unbekanntes Feld oder ein Wert außerhalb der
// Grenzen ist ein Fehler, kein stiller Rückfall.
export function parseHostRunNet(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("the net configuration must be a JSON object");
  if (value.version !== HOST_RUN_NET_VERSION) throw new Error(`version must be ${HOST_RUN_NET_VERSION}`);
  exactKeys(value, ["version", "net", "systemBackup", "retentionService", "reboot"], "net configuration");
  if (value.retentionService !== undefined && typeof value.retentionService !== "boolean") throw new Error("retentionService must be true or false");
  const reboot = parseReboot(value.reboot);
  if (value.net === "hoster-snapshot") {
    if (value.systemBackup !== undefined) throw new Error("systemBackup belongs to net system-backup");
    return { version: HOST_RUN_NET_VERSION, net: "hoster-snapshot", systemBackup: null, retentionService: value.retentionService === true, reboot };
  }
  if (value.net === "system-backup") {
    return { version: HOST_RUN_NET_VERSION, net: "system-backup", systemBackup: parseSystemBackup(value.systemBackup), retentionService: value.retentionService === true, reboot };
  }
  throw new Error("net must be hoster-snapshot or system-backup");
}

export function defaultHostRunNet() {
  return { ...DEFAULT_NET, reboot: { onSite: false, mustBeEnabled: [] } };
}

// Englisch wie der Rest des Türsteher-Prompts und des Planer-Vertrags.
export function describeHostRunNet(net) {
  if (!net) {
    return {
      summary: "the net configuration of this host could not be read; the runner refuses every run that changes the system until it is fixed",
      reboot: "",
    };
  }
  const reboot = net.reboot.onSite
    ? `This is a physical machine without a hoster console: if it does not come back after a reboot, only someone on site can help.${net.reboot.mustBeEnabled.length ? ` Before the run and again right before each reboot the runner requires these to be enabled at boot: ${net.reboot.mustBeEnabled.map((group) => group.join(" or ")).join("; ")}; otherwise it does not reboot.` : ""}`
    : net.reboot.mustBeEnabled.length ? `Before the run and again right before each reboot the runner requires these to be enabled at boot: ${net.reboot.mustBeEnabled.map((group) => group.join(" or ")).join("; ")}.` : "";
  if (net.net === "system-backup") {
    const backup = net.systemBackup;
    return {
      summary: `the RAID ${backup.raidDevice} must be healthy, the backup disk ${backup.mount} mounted with enough space${net.retentionService ? ", the backup retention service not halted" : ""}, then the runner creates a borg archive of ${backup.sources.join(", ")} (unencrypted, one file system each) in its own repository ${backup.target}/repo on the RAID (the last ${backup.keepPreRun} pre-run archives and ${backup.keepWeekly} weekly archives kept). There is no machine snapshot: restoring that system backup means booting a rescue system on site (NOTFALL.txt and a standalone borg binary lie next to the repository); a backup of a running system is not crash-consistent for databases`,
      reboot,
    };
  }
  return {
    summary: `the last borg backup must be younger than 24 h, then the runner takes a machine snapshot at the hoster${net.retentionService ? "; the backup retention service must not be halted" : ""}`,
    reboot,
  };
}
