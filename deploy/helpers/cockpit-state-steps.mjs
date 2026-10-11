// cockpit-state-steps — Zustandsschritte nie mittendrin abbrechen
// (doc/setup/host-run.md, Abschnitt „Unterbrechungssichere Schritte“).
//
// Vorgabe Jochen, 11.10.2026: „Das mit den Zeitlimits ist brandgefährlich.“
// Anlass: Job e9b7faf1 (Stufe A) — die Tür hat apt-get upgrade am Zeitlimit
// des Schritts per SIGKILL beendet; 148 Pakete blieben „unpacked but not
// configured“, sshd lief nicht mehr.
//
// Diese Datei ist die eine Quelle der Erkennung: die API
// (apps/api/src/host-run.ts) zeigt sie dem Türsteher und dem Operator, der
// Root-Helfer (deploy/helpers/cockpit-host-run, installiert daneben als
// cockpit-state-steps.mjs) entscheidet damit, ob er am Zeitlimit beendet oder
// nur meldet. Deterministisch, ohne Modell.
//
// Die Erkennung liest den rohen Text (Name und Skript des Schritts) und sucht
// nur Wörter: kein Shell-Parser, keine Ausnahmen für „harmlose“ Formen. Ein
// Fehltreffer kostet höchstens Warten; ein übersehener Treffer kostet einen
// halb installierten Host. Im Zweifel also unterbrechungssicher (fail safe):
//
//   stepUninterruptible  true, wenn die Erkennung anschlägt ODER der Planer den
//                        Schritt so kennzeichnet ("uninterruptible": true) ODER
//                        der Lauf den Systemzustand ändert (mutates) und der
//                        Planer den Schritt nicht ausdrücklich als abbrechbar
//                        kennzeichnet ("uninterruptible": false). Die Erkennung
//                        schlägt die Kennzeichnung: ein apt-Schritt bleibt
//                        unterbrechungssicher, auch wenn der Planer false sagt.
//   packageStep          der Schritt fasst die Paketverwaltung an (apt, dpkg,
//                        unattended-upgrade): nach einem Fehler räumt der Helfer
//                        dpkg auf und prüft die Dienste.

export const STATE_STEPS_VERSION = "cockpit-state-steps/v1";

// Art → Muster. \b vor und (?![\w-]) hinter dem Wort: "apt" trifft auch
// "apt-get" (eigenes Muster), aber nicht "aptly" oder "adapt".
const KINDS = [
  ["package", /(?:^|[^\w.-])(?:apt|apt-get|aptitude|dpkg|dpkg-reconfigure|unattended-upgrades?|do-release-upgrade|needrestart|snap|nala|pkcon|aptdcon|ubuntu-drivers)(?![\w-])/],
  ["gitlab", /(?:^|[^\w.-])(?:gitlab-ctl|gitlab-rake|gitlab-backup|gitlab-psql)(?![\w-])/],
  ["migration", /(?:^|[^\w.-])(?:occ|mysql_upgrade|mariadb-upgrade|pg_upgrade|pg_upgradecluster|pg_dropcluster|pg_createcluster)(?![\w-])|\bdb:migrate\b/],
  // auch mit Optionen dazwischen: docker --context x compose up, docker -H … compose pull
  ["compose", /(?:^|[^\w.-])docker(?:-compose|(?:[ \t]+-{1,2}[\w-]+(?:[ =](?!compose(?![\w-]))[^\s;&|]+)?)*[ \t]+compose)(?![\w-])/],
  ["update-helper", /(?:^|[^\w.-])(?:cockpit-self-update-action|cockpit-dienste-update-action|cockpit-self-update-run|homeserver-cockpit-deploy(?:\.sh)?|vps-cockpit-deploy(?:\.sh)?)(?![\w-])/],
  ["switch", /umschalt|switch-?over|cut-?over/i],
  ["disk", /(?:^|[^\w.-])(?:mkfs(?:\.\w+)?|parted|sgdisk|sfdisk|fdisk|resize2fs|xfs_growfs|lvextend|lvresize|lvreduce|pvmove|mdadm|cryptsetup|grub-install|update-grub|update-initramfs)(?![\w-])/],
];

/** Arten der Zustandsbefehle in einem Text (leer = keine erkannt). */
export function stateStepKinds(text) {
  const value = typeof text === "string" ? text : "";
  return KINDS.filter(([, pattern]) => pattern.test(value)).map(([kind]) => kind);
}

/**
 * Ob ein Schritt am Zeitlimit beendet werden darf.
 * manifest: { mutates }, step: { name, run, uninterruptible? }
 */
export function stepUninterruptible(manifest, step) {
  const kinds = stateStepKinds(`${step?.name ?? ""}\n${step?.run ?? ""}`);
  const reasons = kinds.map((kind) => `detected:${kind}`);
  if (step?.uninterruptible === true) reasons.push("planner");
  if (manifest?.mutates !== false && step?.uninterruptible !== false) reasons.push("mutating-run");
  return { uninterruptible: reasons.length > 0, kinds, packageStep: kinds.includes("package"), reasons };
}
