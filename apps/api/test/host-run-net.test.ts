import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { defaultHostRunNet, describeHostRunNet, parseHostRunNet } from "../../../deploy/helpers/cockpit-host-run-net.mjs";
import {
  buildHostRunReviewPrompt,
  hostRunManifestHash,
  hostRunPlannerContract,
  hostRunPolicy,
  hostRunResultText,
  loadHostRunNet,
  parseHostRunManifest,
  parseHostRunReviewAnswer,
  parseHostRunStatus,
  verifyHostRunFindings,
  type HostRunManifest,
} from "../src/host-run.js";

// The safety net under the door, per host (doc/setup/host-run.md, section 4).
// The helper enforces it (host-run-helper.test.ts); here: the shared parser,
// the shipped example files and what the doorkeeper, the planner and the
// operator are told.

const CONFIG = (name: string) => fileURLToPath(new URL(`../../../deploy/config/${name}`, import.meta.url));
const lab0 = () => parseHostRunNet(JSON.parse(readFileSync(CONFIG("host-run-net.lab0.json"), "utf8")));

function manifest(steps: unknown[]): HostRunManifest {
  const value = parseHostRunManifest(["```host-run", JSON.stringify({
    version: "cockpit-host-run/v1", name: "release upgrade", purpose: "upgrade Lab0 to 26.04",
    steps, checks: [{ name: "release", run: "grep -q 26.04 /etc/os-release" }], rollback: ["restore the system backup on site"],
  }), "```"].join("\n"));
  if (!value) throw new Error("no manifest");
  return value;
}
const upgrade = manifest([{ name: "upgrade", run: "do-release-upgrade -f DistUpgradeViewNonInteractive" }, { name: "reboot", reboot: true }]);

describe("parseHostRunNet", () => {
  it("reads the shipped files: Lab0 a system backup on the RAID, the VPS as before", () => {
    const net = lab0();
    expect(net.net).toBe("system-backup");
    expect(net.systemBackup).toMatchObject({ mount: "/media/RAID", target: "/media/RAID/lab0-systemsicherung", raidDevice: "md126", keep: 3 });
    expect(net.reboot).toEqual({ onSite: true, mustBeEnabled: [["wg-quick@wg0.service"], ["ssh.service", "ssh.socket"]] });
    expect(net.retentionService).toBe(true);
    const vps = parseHostRunNet(JSON.parse(readFileSync(CONFIG("host-run-net.vps.json"), "utf8")));
    expect(vps).toEqual(defaultHostRunNet());
  });

  const base = JSON.parse(readFileSync(CONFIG("host-run-net.lab0.json"), "utf8"));
  const backup = (patch: Record<string, unknown>) => ({ ...base, systemBackup: { ...base.systemBackup, ...patch } });
  it("refuses a long path with a foreign character at once (no regex backtracking)", () => {
    const started = Date.now();
    expect(() => parseHostRunNet(backup({ target: `/media/RAID/${"a".repeat(5000)} ` }))).toThrow("below systemBackup.mount");
    expect(() => parseHostRunNet(backup({ target: `/media/RAID/lab0-systemsicherung-vor-dem-release-upgrade-ä` }))).toThrow("below systemBackup.mount");
    expect(Date.now() - started).toBeLessThan(1000);
    expect(parseHostRunNet(backup({ target: "/media/RAID/lab0/" })).systemBackup?.target).toBe("/media/RAID/lab0");
    expect(() => parseHostRunNet(backup({ target: "/media/RAID//lab0" }))).toThrow("below systemBackup.mount");
  });

  it.each([
    ["an unknown field", { ...base, command: "rm -rf /" }, "unknown field command"],
    ["an unknown net", { ...base, net: "lvm-snapshot" }, "net must be"],
    ["a wrong version", { ...base, version: "v0" }, "version must be"],
    ["a target outside the backup disk", backup({ target: "/var/backups/lab0" }), "below systemBackup.mount"],
    ["the backup disk itself as target", backup({ target: "/media/RAID" }), "below systemBackup.mount"],
    ["a target with ..", backup({ target: "/media/RAID/../etc" }), "below systemBackup.mount"],
    ["/ as backup disk", backup({ mount: "/", target: "/backup" }), "not /"],
    ["a source holding the backup disk", backup({ sources: ["/media"] }), "contains the backup disk"],
    ["a source on the backup disk", backup({ sources: ["/media/RAID/backup_VServer"] }), "lies on the backup disk"],
    ["a relative source", backup({ sources: ["etc"] }), "not an absolute path"],
    ["no RAID array", backup({ raidDevice: "/dev/sda" }), "md array"],
    ["keep 0", backup({ keep: 0 }), "keep must be an integer from 1 to 10"],
    ["an endless time limit", backup({ timeoutSeconds: 100000 }), "timeoutSeconds"],
    ["a unit name with a command", { ...base, reboot: { onSite: true, mustBeEnabled: [["ssh.service; reboot"]] } }, "unit names"],
    ["a system backup on the VPS net", { ...base, net: "hoster-snapshot" }, "systemBackup belongs to net system-backup"],
  ])("refuses %s", (_label, value, message) => {
    expect(() => parseHostRunNet(value)).toThrow(message);
  });
});

describe("loadHostRunNet (API side)", () => {
  it("falls back to the VPS net without a file and says so when the file is broken", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "host-run-net-"));
    try {
      expect(loadHostRunNet(path.join(dir, "missing.json"))).toEqual(defaultHostRunNet());
      const broken = path.join(dir, "broken.json");
      writeFileSync(broken, "{\"version\":\"cockpit-host-run-net/v1\",\"net\":\"zfs\"}");
      chmodSync(broken, 0o644);
      expect(loadHostRunNet(broken)).toBeNull();
      expect(describeHostRunNet(null).summary).toContain("refuses every run that changes the system");
      expect(loadHostRunNet(CONFIG("host-run-net.lab0.json"))?.net).toBe("system-backup");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("what the door says on Lab0", () => {
  it("tells the doorkeeper about the system backup and the reboot of a physical host", () => {
    const { prompt } = buildHostRunReviewPrompt(upgrade, { net: lab0(), nonce: "n" });
    expect(prompt).toContain("file-level system backup to /media/RAID/lab0-systemsicherung");
    expect(prompt).toContain("There is no machine snapshot");
    expect(prompt).not.toContain("machine snapshot at the hoster");
    expect(prompt).toContain("only someone on site can help");
    expect(prompt).toContain("wg-quick@wg0.service; ssh.service or ssh.socket");
    expect(prompt).toContain("REBOOT of the host; the run continues with the next step after boot. PHYSICAL HOST");
  });

  it("keeps the VPS wording by default", () => {
    const { prompt } = buildHostRunReviewPrompt(upgrade, { nonce: "n" });
    expect(prompt).toContain("the last borg backup must be younger than 24 h, then the runner takes a machine snapshot at the hoster");
    expect(prompt).not.toContain("someone on site");
  });

  it("says it in the decision the operator sees, without changing the decision", () => {
    const material = buildHostRunReviewPrompt(upgrade, { net: lab0() });
    const outcome = { manifestHash: hostRunManifestHash(upgrade), complete: true, missing: [], focus: material.focus, answer: verifyHostRunFindings(parseHostRunReviewAnswer("VERDICT: pass"), upgrade) };
    const policy = hostRunPolicy(upgrade, outcome, lab0());
    expect(policy.status).toBe("ready");
    expect(policy.reason).toContain("The plan reboots a physical host: if it does not come back, only someone on site can help.");
    expect(policy.evidence).toContain("safety net: system-backup");
    expect(policy.evidence.join("\n")).toContain("before each reboot the runner checks these are enabled at boot: wg-quick@wg0.service; ssh.service or ssh.socket");
    const noReboot = manifest([{ name: "upgrade", run: "apt-get -y upgrade" }]);
    expect(hostRunPolicy(noReboot, { ...outcome, manifestHash: hostRunManifestHash(noReboot), answer: verifyHostRunFindings(parseHostRunReviewAnswer("VERDICT: pass"), noReboot) }, lab0()).reason).not.toContain("on site");
    expect(hostRunPolicy(upgrade, outcome).reason).not.toContain("on site");
  });

  it("tells the planner, and names the system backup in the result", () => {
    const contract = hostRunPlannerContract(lab0());
    expect(contract).toContain("file-level system backup");
    expect(contract).toContain("only someone on site can help");
    expect(contract).not.toContain("younger than 24 h");
    const result = parseHostRunStatus(JSON.stringify({ ok: true, state: { phase: "finished", status: "failed", error: "step 1 exited 1", steps: [], checks: [], systemBackup: { path: "/media/RAID/lab0-systemsicherung/cockpit-run-20261002T120000Z-j1" } }, logTail: "" }));
    expect(result.systemBackupPath).toBe("/media/RAID/lab0-systemsicherung/cockpit-run-20261002T120000Z-j1");
    expect(hostRunResultText(upgrade, result)).toContain("system backup /media/RAID/lab0-systemsicherung/cockpit-run-20261002T120000Z-j1 (file level, restore on site only with operator approval)");
  });
});
