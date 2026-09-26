import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { retainValidatedCapability } from "../src/app.js";
import { capabilityManifestHash, capabilityNeedsOperatorApproval, capabilityPlannerContract, parseCapabilityManifest } from "../src/capability-manifest.js";

const contained = `\`\`\`capability
{"version":"cockpit-capability/v1","name":"adapt tool","purpose":"Apply a reversible config change","steps":[{"argv":["/usr/bin/tool","--current-flag"],"cwd":"/tmp","runAsUser":"www-data"}],"readablePaths":["/var/www/nextcloud"],"writablePaths":["/tmp/example.conf"],"network":"none","expectedEffects":["configuration updated"],"verification":["tool reports target state"],"rollback":["restore snapshot"],"risk":["contained"]}
\`\`\``;

describe("dynamic capability manifest", () => {
  it("parses direct argv without binding policy to tool flags", () => {
    const manifest = parseCapabilityManifest(contained);
    expect(manifest?.steps[0].argv).toEqual(["/usr/bin/tool", "--current-flag"]);
    expect(manifest?.steps[0].runAsUser).toBe("www-data");
    expect(manifest?.readablePaths).toEqual(["/var/www/nextcloud"]);
    expect(capabilityNeedsOperatorApproval(manifest!)).toBe(false);
    expect(capabilityManifestHash(manifest!)).toMatch(/^[a-f0-9]{64}$/);
  });

  it("documents the semantic Nextcloud helper without granting arbitrary occ", () => {
    expect(capabilityPlannerContract()).toContain("cockpit-nextcloud-app-action");
    expect(capabilityPlannerContract()).toContain("cockpit-nextcloud-context-action");
    expect(capabilityPlannerContract()).toContain("cockpit-exact-file-replace");
    expect(capabilityPlannerContract()).toContain("no disable, uninstall, or arbitrary occ");
  });

  it("requires operator approval only for high-impact effect classes", () => {
    const manifest = parseCapabilityManifest(contained)!;
    expect(capabilityNeedsOperatorApproval({ ...manifest, risk: ["data_loss"] })).toBe(true);
    expect(capabilityNeedsOperatorApproval({ ...manifest, network: "local" })).toBe(false);
    expect(capabilityNeedsOperatorApproval({ ...manifest, network: "host" })).toBe(true);
  });

  it("rejects shell-shaped and unverifiable manifests", () => {
    expect(() => parseCapabilityManifest(contained.replace('"/usr/bin/tool"', '"tool"'))).toThrow(/absolute/);
    expect(() => parseCapabilityManifest(contained.replace('"tool reports target state"', ""))).toThrow();
  });

  it("rejects root as a delegated step identity", () => {
    expect(() => parseCapabilityManifest(contained.replace('"www-data"', '"root"'))).toThrow(/non-root/);
  });

  it("parses a semantic manifest from an unlabeled fence", () => {
    const unlabeled = contained.replace("```capability", "```");
    expect(parseCapabilityManifest(unlabeled)?.name).toBe("adapt tool");
  });

  it("parses a standalone semantic JSON manifest without accepting surrounding prose", () => {
    const standalone = contained.replace(/^```capability\n|\n```$/g, "");
    expect(parseCapabilityManifest(standalone)?.name).toBe("adapt tool");
    expect(parseCapabilityManifest(`Plan: ${standalone}`)).toBeNull();
  });

  it("keeps retention opt-in and binds it into the manifest hash", () => {
    const plain = parseCapabilityManifest(contained)!;
    const recurring = parseCapabilityManifest(contained.replace('"risk":["contained"]', '"risk":["contained"],"retain":true'))!;
    const stringy = parseCapabilityManifest(contained.replace('"risk":["contained"]', '"risk":["contained"],"retain":"true"'))!;
    expect(plain.retain).toBe(false);
    expect(recurring.retain).toBe(true);
    expect(stringy.retain).toBe(false);
    expect(capabilityManifestHash(recurring)).not.toBe(capabilityManifestHash(plain));
    expect(capabilityManifestHash(stringy)).toBe(capabilityManifestHash(plain));
    expect(capabilityPlannerContract()).toContain('Set "retain": true only for an operation expected to recur');
  });

  it("retains a validated manifest only when it asks for it", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cockpit-retain-"));
    try {
      const capabilityDir = path.join(root, "capabilities");
      expect(await retainValidatedCapability(capabilityDir, "job-once", parseCapabilityManifest(contained))).toBeNull();
      expect(await retainValidatedCapability(capabilityDir, "job-none", null)).toBeNull();
      expect(fs.existsSync(capabilityDir)).toBe(false);
      const recurring = parseCapabilityManifest(contained.replace('"risk":["contained"]', '"risk":["contained"],"retain":true'))!;
      const retained = await retainValidatedCapability(capabilityDir, "job-recurring", recurring);
      expect(retained).toBe(path.join(capabilityDir, `${capabilityManifestHash(recurring)}.json`));
      expect(fs.statSync(retained!).mode & 0o777).toBe(0o600);
      expect(JSON.parse(fs.readFileSync(retained!, "utf8"))).toMatchObject({ validatedByJob: "job-recurring", manifest: { retain: true } });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
