// Typen zu cockpit-backup-guard.mjs (die API importiert die eine Quelle).
export interface BackupGuardHit {
  where: string;
  kind: "backup" | "mention" | "uncertain";
  reason: string;
  code: string;
}
type GuardManifest = { steps?: Array<{ run?: string }>; checks?: Array<{ run?: string }> };
export declare const BACKUP_GUARD_VERSION: "cockpit-backup-guard/v3";
// Der Riegel: nur Art "backup"; jeder Treffer verlangt operatorApproved.
export declare function backupGuardHits(manifest: GuardManifest): BackupGuardHit[];
// Hinweise für den Türsteher ("mention", "uncertain"); halten den Lauf nicht an.
export declare function backupGuardFocus(manifest: GuardManifest): BackupGuardHit[];
