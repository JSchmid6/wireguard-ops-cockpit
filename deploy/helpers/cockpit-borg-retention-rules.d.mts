// Typen zu cockpit-borg-retention-rules.mjs (API und Riegel importieren die eine Quelle).
export type RetentionField = "keepDaily" | "keepWeekly" | "keepMonthly";
export interface RetentionSettings {
  keepDaily: number;
  keepWeekly: number;
  keepMonthly: number;
  time: string;
}
export interface RetentionBound { floor: number; min: number; max: number }
export interface BorgArchive { id: string; name: string }
export type RetentionClassification =
  | { ok: false; errors: string[] }
  | { ok: true; settings: RetentionSettings; belowMinimum: string[] };
export declare const RETENTION_RULES_VERSION: "cockpit-borg-retention/v1";
export declare const RETENTION_BOUNDS: Readonly<Record<RetentionField, Readonly<RetentionBound>>>;
export declare const RETENTION_TIME_WINDOW: Readonly<{ earliest: string; latest: string }>;
export declare const DEFAULT_RETENTION: Readonly<RetentionSettings>;
export declare const RETENTION_FIELDS: readonly RetentionField[];
export declare const PRUNE_ARCHIVE_GLOB: string;
export declare const ARCHIVE_ID: RegExp;
export declare function classifyRetention(input: unknown): RetentionClassification;
export declare function retentionArgs(settings: RetentionSettings): [string, string, string, string];
export declare function parseRetentionArgs(args: unknown): Record<string, unknown> | null;
export declare function missingArchives(baseline: BorgArchive[], current: BorgArchive[]): BorgArchive[];
export declare function parsePrunedArchives(output: string): Array<{ name: string; id: string | null }>;
export declare function unexplainedLoss(before: BorgArchive[], after: BorgArchive[], pruned: Array<{ name: string; id: string | null }>): BorgArchive[];
