// cockpit-borg-retention-rules — die festen Grenzen des Aufräum-Diensts auf Lab0
// (doc/setup/borg-retention.md).
//
// Jochen, 02.10.2026: „Wir deployen fürs Aufräumen einen Dienst, und der kann in
// bestimmten Bereichen eingestellt werden.“ Diese Datei ist die eine Quelle der
// Bereiche. Drei Stellen fragen sie:
//
//   * die Cockpit-API (apps/api/src/borg-retention.ts), bevor sie eine Änderung
//     an den Helfer gibt,
//   * der Root-Helfer cockpit-borg-retention (set) und der Dienstlauf selbst,
//     bevor sie eine Einstellung schreiben oder nach ihr löschen,
//   * der Backup-Riegel (cockpit-backup-guard.mjs): ein `set` innerhalb der
//     Grenzen ist im host-run frei, alles darunter braucht Jochens Freigabe.
//
// Mehr behalten geht immer, bis zur Obergrenze (max). Weniger als die
// Untergrenze (min) nur mit Freigabe, und nie weniger als der Boden (floor):
// ohne mindestens ein tägliches Archiv würde prune das ganze Repo leeren.

export const RETENTION_RULES_VERSION = "cockpit-borg-retention/v1";

export const RETENTION_BOUNDS = Object.freeze({
  keepDaily: Object.freeze({ floor: 1, min: 3, max: 30 }),
  keepWeekly: Object.freeze({ floor: 0, min: 2, max: 12 }),
  keepMonthly: Object.freeze({ floor: 0, min: 0, max: 24 }),
});

// Täglich nach dem nächtlichen Backup des VPS (borgmatic.timer, ~00:30–02:30).
export const RETENTION_TIME_WINDOW = Object.freeze({ earliest: "04:00", latest: "22:00" });

export const DEFAULT_RETENTION = Object.freeze({ keepDaily: 3, keepWeekly: 2, keepMonthly: 0, time: "06:00" });

export const RETENTION_FIELDS = Object.freeze(["keepDaily", "keepWeekly", "keepMonthly"]);

// prune räumt nur die Serie des nächtlichen VPS-Backups (borgmatic,
// "{hostname}-{now}"). Archive mit anderem Namen — etwa ein Handarchiv vor einem
// Upgrade — fasst der Dienst nie an; der Vergleich gegen fremde Löschungen
// umfasst trotzdem alle Archive.
export const PRUNE_ARCHIVE_GLOB = "vmd61162-*";

// Feldname im Helfer-Aufruf und in borg (--keep-daily …), für Meldungen.
const BORG_FLAG = { keepDaily: "keep_daily", keepWeekly: "keep_weekly", keepMonthly: "keep_monthly" };

const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;

function integer(value) {
  if (typeof value === "number") return Number.isSafeInteger(value) ? value : null;
  if (typeof value === "string" && /^\d{1,4}$/.test(value)) return Number(value);
  return null;
}

function minutes(time) {
  const match = TIME.exec(time);
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

// Prüft eine Einstellung gegen die Grenzen.
//   { ok: false, errors }                 nie zulässig (Form, über max, unter floor, Uhrzeit)
//   { ok: true, settings, belowMinimum }  zulässig; belowMinimum nicht leer heißt:
//                                         nur mit Jochens Freigabe
export function classifyRetention(input) {
  const errors = [];
  const settings = {};
  const belowMinimum = [];
  const source = input && typeof input === "object" ? input : {};
  for (const field of RETENTION_FIELDS) {
    const bounds = RETENTION_BOUNDS[field];
    const value = integer(source[field]);
    if (value === null) { errors.push(`${BORG_FLAG[field]} must be a whole number`); continue; }
    if (value > bounds.max) errors.push(`${BORG_FLAG[field]} ${value} is above the upper limit ${bounds.max}`);
    else if (value < bounds.floor) errors.push(`${BORG_FLAG[field]} ${value} is below the floor ${bounds.floor}, even with approval`);
    else if (value < bounds.min) belowMinimum.push(`${BORG_FLAG[field]} ${value} is below the minimum ${bounds.min}`);
    settings[field] = value;
  }
  const time = typeof source.time === "string" ? source.time : "";
  const at = minutes(time);
  if (at === null) errors.push("time must be HH:MM (24 h)");
  else if (at < minutes(RETENTION_TIME_WINDOW.earliest) || at > minutes(RETENTION_TIME_WINDOW.latest)) {
    errors.push(`time ${time} is outside ${RETENTION_TIME_WINDOW.earliest}–${RETENTION_TIME_WINDOW.latest} (the service runs after the nightly backup)`);
  }
  settings.time = time;
  return errors.length > 0 ? { ok: false, errors } : { ok: true, settings, belowMinimum };
}

// Die Argumente des Helfers: set <daily> <weekly> <monthly> <HH:MM>.
export function retentionArgs(settings) {
  return [String(settings.keepDaily), String(settings.keepWeekly), String(settings.keepMonthly), settings.time];
}

export function parseRetentionArgs(args) {
  if (!Array.isArray(args) || args.length !== 4) return null;
  const [keepDaily, keepWeekly, keepMonthly, time] = args;
  return { keepDaily, keepWeekly, keepMonthly, time };
}

// ── Bestand ────────────────────────────────────────────────────────────────
// Ein Archiv ist {id, name}. Verglichen wird über die id: ein recreate oder
// rename behält vielleicht den Namen, aber nicht die id — auch das ist ein
// Archiv, das der Dienst nicht selbst entfernt hat.

export const ARCHIVE_ID = /^[a-f0-9]{64}$/;

// Archive des letzten Laufs, die jetzt fehlen.
export function missingArchives(baseline, current) {
  const present = new Set((current || []).map((archive) => archive.id));
  return (baseline || []).filter((archive) => !present.has(archive.id));
}

// Was prune laut seiner eigenen Liste entfernt hat (borg prune --list):
//   "Pruning archive (1/2):          vmd61162-2026-09-28T00:37:11  Mon, 2026-09-28 … [<id>]"
// Ältere borg-Versionen schreiben die Zeile ohne Zähler.
export function parsePrunedArchives(output) {
  const pruned = [];
  for (const line of String(output || "").split("\n")) {
    const match = /^\s*Pruning archive(?:\s*\(\d+\/\d+\))?:\s+(\S+)(?:.*\[([a-f0-9]{64})\])?/.exec(line);
    if (match) pruned.push({ name: match[1], id: match[2] || null });
  }
  return pruned;
}

// Fehlt nach prune etwas, das prune nicht genannt hat? Das hat jemand anders
// entfernt (gleichzeitig vom VPS vorgemerkt) — dann wird nicht kompaktiert.
export function unexplainedLoss(before, after, pruned) {
  const prunedIds = new Set(pruned.filter((item) => item.id).map((item) => item.id));
  const prunedNames = new Set(pruned.filter((item) => !item.id).map((item) => item.name));
  return missingArchives(before, after).filter((archive) => !prunedIds.has(archive.id) && !prunedNames.has(archive.name));
}
