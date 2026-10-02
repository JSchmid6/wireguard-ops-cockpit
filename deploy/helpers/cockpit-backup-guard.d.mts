// Typen zu cockpit-backup-guard.mjs (die API importiert die eine Quelle).
export interface BackupGuardHit {
  where: string;
  kind: "backup" | "uncertain";
  reason: string;
  code: string;
}
export declare const BACKUP_GUARD_VERSION: "cockpit-backup-guard/v2";
export declare function backupGuardHits(manifest: { steps?: Array<{ run?: string }>; checks?: Array<{ run?: string }> }): BackupGuardHit[];
