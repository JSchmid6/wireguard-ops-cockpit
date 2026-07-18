import { describe, expect, it } from "vitest";
import { capabilityManifestHash, capabilityNeedsOperatorApproval, parseCapabilityManifest } from "../src/capability-manifest.js";

const contained = `\`\`\`capability
{"version":"cockpit-capability/v1","name":"adapt tool","purpose":"Apply a reversible config change","steps":[{"argv":["/usr/bin/tool","--current-flag"],"cwd":"/tmp"}],"writablePaths":["/tmp/example.conf"],"network":"none","expectedEffects":["configuration updated"],"verification":["tool reports target state"],"rollback":["restore snapshot"],"risk":["contained"]}
\`\`\``;

describe("dynamic capability manifest", () => {
  it("parses direct argv without binding policy to tool flags", () => {
    const manifest = parseCapabilityManifest(contained);
    expect(manifest?.steps[0].argv).toEqual(["/usr/bin/tool", "--current-flag"]);
    expect(capabilityNeedsOperatorApproval(manifest!)).toBe(false);
    expect(capabilityManifestHash(manifest!)).toMatch(/^[a-f0-9]{64}$/);
  });

  it("requires operator approval only for high-impact effect classes", () => {
    const manifest = parseCapabilityManifest(contained)!;
    expect(capabilityNeedsOperatorApproval({ ...manifest, risk: ["data_loss"] })).toBe(true);
    expect(capabilityNeedsOperatorApproval({ ...manifest, network: "host" })).toBe(true);
  });

  it("rejects shell-shaped and unverifiable manifests", () => {
    expect(() => parseCapabilityManifest(contained.replace('"/usr/bin/tool"', '"tool"'))).toThrow(/absolute/);
    expect(() => parseCapabilityManifest(contained.replace('"tool reports target state"', ""))).toThrow();
  });
});
