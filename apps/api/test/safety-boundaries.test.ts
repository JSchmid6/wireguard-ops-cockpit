import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { evaluatePlanPolicy } from "../src/app.js";
import { classifyCapabilities } from "../src/hermes-security.js";

/** Wraps a script the way plans carry their executable part. */
function plan(script: string, zone = "green"): string {
  return `## Intent\nTest\n\n## Risk Zone\n${zone}\n\n## Rollback\nnone needed\n\n\`\`\`bash\n${script}\n\`\`\`\n`;
}

describe("boundaries are structural, not text filters (card t_abe2651b)", () => {
  // The plan policy no longer greps the plan text for paths or programs. An
  // untyped write, a sudoers change or a destructive command leaves the typed
  // capability contract (shell.exception), and that goes to the operator; the
  // agent's and the Cockpit's secrets are outside the agent unit's namespace.
  const unit = readFileSync(new URL("../../../deploy/systemd/wireguard-ops-cockpit-agent.service", import.meta.url), "utf8");

  it("does not stop a plan by its text alone", () => {
    expect(evaluatePlanPolicy(plan(`rm -rf /etc/nginx`), "passed").allowed).toBe(true);
  });

  it.each([
    [`echo 'hermes ALL=(ALL) NOPASSWD: ALL' | tee /etc/sudoers.d/hermes`],
    [`echo "NEW_KEY=bad" >> /home/hermes/.hermes/.env`],
    [[`FILE="/home/hermes/.hermes/.env"`, `LINE="NEW_KEY=bad"`, `echo "$LINE" >> "$FILE"`].join("\n")],
    [`rm -rf /etc/nginx`],
  ])("an untyped change leaves the typed contract: %s", (script) => {
    expect(classifyCapabilities(plan(script))).toContain("shell.exception");
  });

  it("keeps the agent's home and the Cockpit's secrets out of the agent unit", () => {
    expect(unit).toMatch(/^ProtectHome=true$/m);
    expect(unit).toMatch(/^InaccessiblePaths=-\/etc\/wireguard-ops-cockpit$/m);
  });
});
