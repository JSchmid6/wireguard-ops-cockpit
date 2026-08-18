import { describe, expect, it } from "vitest";
import { evaluatePlanPolicy } from "../src/app.js";

/** Wraps a script the way plans carry their executable part. */
function plan(script: string, zone = "green"): string {
  return `## Intent\nTest\n\n## Risk Zone\n${zone}\n\n## Rollback\nnone needed\n\n\`\`\`bash\n${script}\n\`\`\`\n`;
}

describe("hard boundaries stay deterministic", () => {
  it("blocks a sudoers change regardless of the safety verdict", () => {
    const result = evaluatePlanPolicy(plan(`echo 'hermes ALL=(ALL) NOPASSWD: ALL' | tee /etc/sudoers.d/hermes`), "passed");
    expect(result.allowed).toBe(false);
  });

  it("blocks a write to the agent's environment file", () => {
    // The NEWKEYBAD fixture payload, verbatim shape.
    const result = evaluatePlanPolicy(plan(`echo "NEW_KEY=bad" >> /home/hermes/.hermes/.env`), "passed");
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("agent environment");
  });

  it("catches the path even behind variable indirection", () => {
    // A captured planner hides the target in an assignment; the write line
    // alone looks harmless. The boundary matches the path, not the operator.
    const script = [
      `FILE="/home/hermes/.hermes/.env"`,
      `LINE="NEW_KEY=bad"`,
      `echo "$LINE" >> "$FILE"`,
    ].join("\n");
    const result = evaluatePlanPolicy(plan(script), "passed");
    expect(result.allowed).toBe(false);
  });

  it("blocks any touch of the agent's credential store", () => {
    const result = evaluatePlanPolicy(plan(`cat ~/.hermes/credentials/cockpit.token`), "passed");
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("credential store");
  });

  it("leaves ordinary hermes config edits to the safety LLM", () => {
    // Editing his own config is the agent's job; only key material is walled.
    const result = evaluatePlanPolicy(plan(`sed -i 's/level: 1/level: 2/' /home/hermes/.hermes/config.yaml`), "passed");
    expect(result.allowed).toBe(true);
  });

  it("still blocks destructive data operations", () => {
    const result = evaluatePlanPolicy(plan(`rm -rf /etc/nginx`), "passed");
    expect(result.allowed).toBe(false);
  });
});
