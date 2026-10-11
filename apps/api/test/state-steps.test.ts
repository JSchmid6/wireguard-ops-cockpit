import { describe, expect, it } from "vitest";

import { parseHostRunManifest } from "../src/host-run.js";
import { stateStepKinds, stepUninterruptible } from "../../../deploy/helpers/cockpit-state-steps.mjs";

// Zustandsschritte nie mittendrin abbrechen (Vorgabe Jochen, 11.10.2026):
// die eine Erkennung, die API und Root-Helfer teilen. Fail safe — im Zweifel
// unterbrechungssicher.

describe("cockpit-state-steps: detection", () => {
  it.each([
    ["apt-get update && apt-get -y upgrade", "package"],
    ["DEBIAN_FRONTEND=noninteractive apt -y full-upgrade", "package"],
    ["/usr/bin/dpkg --configure -a", "package"],
    ["unattended-upgrade -v", "package"],
    ["snap refresh", "package"],
    ["gitlab-ctl reconfigure", "gitlab"],
    ["gitlab-rake db:migrate", "gitlab"],
    ["sudo -u www-data php /var/www/nextcloud/occ upgrade", "migration"],
    ["cd /opt/frigate && docker compose pull && docker compose up -d", "compose"],
    ["docker-compose -f x.yml up -d", "compose"],
    ["/usr/local/sbin/cockpit-dienste-update-action 0123", "update-helper"],
    ["# Umschalten auf Lab0\nwg-quick up wg1", "switch"],
    ["update-initramfs -u", "disk"],
  ])("%s → %s", (script, kind) => {
    expect(stateStepKinds(script)).toContain(kind);
  });

  it.each([
    "uptime",
    "df -h /",
    "cockpit-vps-snapshot list",
    "echo adapt && cat /etc/aptly.conf",
    "docker ps --format '{{.Names}}'",
  ])("%s → nothing", (script) => {
    expect(stateStepKinds(script)).toEqual([]);
  });
});

describe("cockpit-state-steps: which step may be ended", () => {
  const mutating = { mutates: true };
  const readOnly = { mutates: false };

  it("never ends a detected step, whatever the planner marks", () => {
    expect(stepUninterruptible(readOnly, { name: "x", run: "apt-get -y upgrade", uninterruptible: false })).toMatchObject({ uninterruptible: true, packageStep: true });
  });

  it("follows the planner's mark", () => {
    expect(stepUninterruptible(readOnly, { name: "x", run: "sleep 1", uninterruptible: true }).reasons).toEqual(["planner"]);
  });

  it("makes every step of a mutating run uninterruptible unless the planner says false", () => {
    expect(stepUninterruptible(mutating, { name: "x", run: "sleep 1" })).toMatchObject({ uninterruptible: true, reasons: ["mutating-run"], packageStep: false });
    expect(stepUninterruptible(mutating, { name: "x", run: "sleep 1", uninterruptible: false }).uninterruptible).toBe(false);
  });

  it("lets a plain step of a read-only run be ended", () => {
    expect(stepUninterruptible(readOnly, { name: "x", run: "uptime" }).uninterruptible).toBe(false);
  });
});

describe("host-run manifest: uninterruptible mark", () => {
  const plan = (step: Record<string, unknown>) => "```host-run\n" + JSON.stringify({
    version: "cockpit-host-run/v1", name: "n", purpose: "p", mutates: true,
    steps: [{ name: "s", run: "true", timeoutSeconds: 60, ...step }],
    checks: [{ name: "c", run: "true" }], rollback: ["r"], risk: ["contained"],
  }) + "\n```";

  it("keeps the mark only when the planner set it (unmarked manifests hash as before)", () => {
    expect(parseHostRunManifest(plan({}))!.steps[0]).not.toHaveProperty("uninterruptible");
    expect(parseHostRunManifest(plan({ uninterruptible: true }))!.steps[0].uninterruptible).toBe(true);
    expect(parseHostRunManifest(plan({ uninterruptible: false }))!.steps[0].uninterruptible).toBe(false);
  });

  it("refuses a mark that is not a boolean", () => {
    expect(() => parseHostRunManifest(plan({ uninterruptible: "yes" }))).toThrow(/uninterruptible must be true or false/);
  });
});
