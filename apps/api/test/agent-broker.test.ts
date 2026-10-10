import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { describeEngine, reviewerLabel, reviewerText, runBrokerAgent, runBrokerAgentReport } from "../src/agent-broker.js";
import { computeRunbookVersionHash, findRunbook } from "../src/registries.js";
import { generateRunbookSafetyReview } from "../src/safety-review.js";
import { applyUpdateReviewPolicy, parseUpdateReviewAnswer, type UpdateReviewOutcome } from "../src/update-review.js";
import { evaluatePlanPolicy } from "../src/app.js";

const SHA = "0123456789abcdef0123456789abcdef01234567";
const BASE = "89abcdef0123456789abcdef0123456789abcdef";
const HASH = "a".repeat(64);
const CLAUDE = { antrieb: "claude", modell: "claude-opus-5-5", cliVersion: "2.1.283", etikett: null, lauf: "x-safety" };
const OPENCODE = { antrieb: "opencode", modell: "deepseek/deepseek-v4-pro", cliVersion: null, etikett: "DeepSeek/opencode deepseek/deepseek-v4-pro (Prüfer, andere Modellfamilie als Claude)" };
const UNAVAILABLE = { ok: false, error: "agent engine claude not available: Token-Datei fehlt (/run/credentials/x/claude-oauth-token); no review, nothing is approved", verdict: { status: "nicht_verfuegbar" }, engine: { ...CLAUDE, modell: null, cliVersion: null } };

const servers: net.Server[] = [];
afterEach(() => { for (const server of servers.splice(0)) server.close(); });

// A stand-in for the agent broker socket that answers every request with `reply`.
async function fakeBroker(reply: unknown): Promise<string> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cockpit-fake-broker-"));
  const socket = path.join(dir, "agent.sock");
  const server = net.createServer((connection) => {
    connection.on("data", () => connection.end(JSON.stringify(reply)));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(socket, resolve));
  return socket;
}

const SAFETY_ANSWER = [
  "VERDICT: passed",
  "SUMMARY: bounded read-only plan",
  "HAZARDS: none",
  "BLAST_RADIUS: none",
  "EXPECTED_IMPACT: read-only",
  "ROLLBACK_HINT: none",
  "OPERATOR_CHECKS: none",
].join("\n");

function safetyInput() {
  const runbook = findRunbook("nextcloud-update-plan")!;
  return { runbook, runbookVersionHash: computeRunbookVersionHash(runbook), riskClass: "high" as const, sessionId: "s", trigger: "manual" as const, scheduleId: null };
}

function runtime(socket: string) {
  return { repoRoot: process.cwd(), plannerRuntime: "opencode" as const, copilotExecutable: "copilot", copilotModel: null, opencodeExecutable: "opencode", opencodeModel: "api-side-model", agentBrokerSocket: socket };
}

describe("agent broker engine report", () => {
  it("names the engine: Claude with model and CLI version, any other engine by its label", () => {
    expect(describeEngine(CLAUDE)).toBe("claude claude-opus-5-5 (CLI 2.1.283)");
    expect(describeEngine(OPENCODE)).toBe(OPENCODE.etikett);
    expect(describeEngine(null)).toBeNull();
    expect(reviewerText("plain")).toBe("plain");
    expect(reviewerLabel("plain")).toBeNull();
    expect(reviewerLabel({ output: "x", engine: OPENCODE })).toBe(OPENCODE.etikett);
  });

  it("returns the output with the engine the broker ran", async () => {
    const socket = await fakeBroker({ ok: true, output: "VERDICT: approve", engine: CLAUDE, verdict: { status: "erfolg" } });
    await expect(runBrokerAgentReport(socket, "safety", "p")).resolves.toEqual({ output: "VERDICT: approve", engine: CLAUDE });
    await expect(runBrokerAgent(socket, "safety", "p")).resolves.toBe("VERDICT: approve");
  });

  it("rejects when the engine is not available, so no caller can read it as a review", async () => {
    const socket = await fakeBroker(UNAVAILABLE);
    await expect(runBrokerAgentReport(socket, "safety", "p")).rejects.toThrow(/not available: Token-Datei fehlt.*nothing is approved/);
  });
});

describe("reviews through the agent broker", () => {
  it("plan safety review: an unavailable Claude reviewer blocks, it never passes", async () => {
    const review = await generateRunbookSafetyReview(safetyInput(), runtime(await fakeBroker(UNAVAILABLE)));
    expect(review.verdict).toBe("blocked");
    expect(review.details.parseStatus).toBe("error");
  });

  it("plan safety review records the engine; a non-Claude engine is labelled in the verdict summary", async () => {
    const claude = await generateRunbookSafetyReview(safetyInput(), runtime(await fakeBroker({ ok: true, output: SAFETY_ANSWER, engine: CLAUDE })));
    expect(claude.summary).toBe("bounded read-only plan Human approval stays mandatory because this runbook requests a privileged helper.");
    expect(claude.details.model).toBe("claude claude-opus-5-5 (CLI 2.1.283)");
    const deepseek = await generateRunbookSafetyReview(safetyInput(), runtime(await fakeBroker({ ok: true, output: SAFETY_ANSWER, engine: OPENCODE })));
    expect(deepseek.summary.startsWith(`[${OPENCODE.etikett}] `)).toBe(true);
    expect(deepseek.details.model).toBe(OPENCODE.etikett);
  });

  it("update review policy shows which engine reviewed, next to the verdict", () => {
    const readyPolicy = evaluatePlanPolicy([
      "## Required Permissions", "/usr/local/sbin/cockpit-self-update-action", "",
      "```bash", `/usr/local/sbin/cockpit-self-update-action ${SHA}`, "```",
      "## Risk Zone", "yellow", "## Rollback", "self.update the previous commit",
    ].join("\n"), "passed");
    const base: UpdateReviewOutcome = { bindings: [{ base: BASE, sha: SHA, diffSha256: HASH }], coverage: [{ sha: SHA, incomplete: [], cut: [], omitted: [] }] };
    const approved = applyUpdateReviewPolicy(readyPolicy, { ...base, answer: parseUpdateReviewAnswer("VERDICT: approve\nNOTES: fine"), reviewer: OPENCODE.etikett });
    expect(approved.status).toBe("ready");
    expect(approved.evidence).toContain(`reviewer: ${OPENCODE.etikett}`);
    const failed = applyUpdateReviewPolicy(readyPolicy, { ...base, reviewerError: UNAVAILABLE.error });
    expect(failed.allowed).toBe(false);
    expect(failed.reason).toContain("not available");
  });
});
