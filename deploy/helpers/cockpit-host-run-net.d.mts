// Typen zu cockpit-host-run-net.mjs (die API importiert die eine Quelle).
export interface HostRunSystemBackup {
  target: string;
  mount: string;
  raidDevice: string;
  sources: string[];
  exclude: string[];
  keep: number;
  reserveGB: number;
  timeoutSeconds: number;
}
export interface HostRunNet {
  version: "cockpit-host-run-net/v1";
  net: "hoster-snapshot" | "system-backup";
  systemBackup: HostRunSystemBackup | null;
  retentionService: boolean;
  reboot: { onSite: boolean; mustBeEnabled: string[][] };
}
export declare const HOST_RUN_NET_VERSION: "cockpit-host-run-net/v1";
export declare const HOST_RUN_NET_FILE: "host-run-net.json";
export declare const SYSTEM_BACKUP_BOUNDS: Readonly<Record<"keep" | "reserveGB" | "timeoutSeconds" | "sources" | "exclude", [number, number]>>;
export declare function parseHostRunNet(value: unknown): HostRunNet;
export declare function defaultHostRunNet(): HostRunNet;
export declare function describeHostRunNet(net: HostRunNet | null): { summary: string; reboot: string };
