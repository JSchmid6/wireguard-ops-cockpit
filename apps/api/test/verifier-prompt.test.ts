import { describe, expect, it } from "vitest";

import { agentPromptLimit, runBrokerAgent } from "../src/agent-broker.js";
import { VERIFIER_PROMPT_CHARS, boundedVerifierPrompt, clipHandoff, clipLog, clipMiddle } from "../src/verifier-prompt.js";

const { validateRequest } = await import("../../agent-broker/src/index.mjs") as { validateRequest: (request: unknown) => unknown };

function handoff(output: string): string {
  return [
    "## EXECUTION RESULT", "STATUS: success", "EXIT_CODE: 0",
    "WHAT_RAN: host run \"php\": 1 apt-get update success, 2 install success; checks: 1 versions passed",
    `OUTPUT: ${output}`,
    "NOTES: run success; machine snapshot snap-1 (revert only with operator approval)",
  ].join("\n");
}

function runLog(aptLines: number, line = "Setting up php8.3-common (8.3.36-1+ubuntu24.04.1+deb.sury.org+1) ..."): string {
  return [
    "== 2026-10-21T18:20:00.000Z step 1/2: apt-get update (limit 600 s)", "Hit:1 http://archive.ubuntu.com/ubuntu noble InRelease",
    "== 2026-10-21T18:21:00.000Z step 2/2: install (limit 1800 s)", ...Array.from({ length: aptLines }, (_, index) => `${index} ${line}`),
    "== 2026-10-21T18:39:30.000Z check 1/2: installed versions", "ii  php8.3-fpm 8.3.36-1", "PHP 8.3.36 (cli)",
    "== 2026-10-21T18:39:31.000Z check 2/2: services active", "active", "active",
    "== 2026-10-21T18:39:41.000Z run finished: success",
  ].join("\n");
}

describe("verifier prompt bound", () => {
  it("is the broker's own bound, read from the one definition", () => {
    expect(VERIFIER_PROMPT_CHARS).toBe(agentPromptLimit("verifier"));
    const at = (prompt: string) => () => validateRequest({ requestId: "12345678", role: "verifier", prompt });
    expect(at("v".repeat(VERIFIER_PROMPT_CHARS))).not.toThrow();
    expect(at("v".repeat(VERIFIER_PROMPT_CHARS + 1))).toThrow(`prompt length ${VERIFIER_PROMPT_CHARS + 1} exceeds verifier limit ${VERIFIER_PROMPT_CHARS}`);
    // Characters count, not bytes: the prompt reaches opencode on stdin.
    expect(at("\u00e4".repeat(VERIFIER_PROMPT_CHARS))).not.toThrow();
  });

  it("refuses an oversized prompt on the requester side already, naming bound and length", async () => {
    // No broker listens at this path: the check must come before the socket.
    const socket = "/nonexistent/cockpit-agent.sock";
    await expect(runBrokerAgent(socket, "verifier", "v".repeat(41234 + VERIFIER_PROMPT_CHARS - 30000))).rejects.toThrow(`prompt length ${41234 + VERIFIER_PROMPT_CHARS - 30000} exceeds verifier limit ${VERIFIER_PROMPT_CHARS}`);
    await expect(runBrokerAgent(socket, "runner", "r".repeat(41234))).rejects.toThrow("prompt length 41234 exceeds runner limit 30000");
    await expect(runBrokerAgent(socket, "planner", "")).rejects.toThrow("prompt is empty");
    await expect(runBrokerAgent(socket, "planner", "fits")).rejects.toThrow(/ENOENT/);
  });

  it("leaves a handoff that fits unchanged", () => {
    const text = handoff(runLog(20));
    expect(clipHandoff(text, text.length)).toBe(text);
    const built = boundedVerifierPrompt("You are the verifier-agent. Intent: update php", "```host-run\n{}\n```", text);
    expect(built.clipped).toBe(false);
    expect(built.prompt).toContain(JSON.stringify(text).slice(1, -1));
  });

  it("keeps the header fields, every run-log line and the checks, and cuts the step bodies line by line", () => {
    const text = handoff(runLog(3000));
    const clipped = clipHandoff(text, 20000);
    expect(clipped.length).toBeLessThanOrEqual(20000);
    for (const line of text.split("\n").filter((item) => /^(## |STATUS|EXIT_CODE|WHAT_RAN|NOTES|== )/.test(item) || item.startsWith("OUTPUT: =="))) expect(clipped).toContain(line);
    expect(clipped).toContain("ii  php8.3-fpm 8.3.36-1\nPHP 8.3.36 (cli)");
    expect(clipped).toContain("active\nactive");
    // Head and end of the long step stay as whole lines, the cut is marked with its size.
    expect(clipped).toContain("\n0 Setting up php8.3-common (8.3.36-1+ubuntu24.04.1+deb.sury.org+1) ...\n");
    expect(clipped).toContain("\n2999 Setting up php8.3-common (8.3.36-1+ubuntu24.04.1+deb.sury.org+1) ...\n");
    expect(clipped).not.toContain("\n1500 Setting up");
    expect(clipped).toMatch(/\n\[\.\.\. \d+ lines \(\d+ characters\) left out for the verifier's prompt bound; the job record keeps the full text \.\.\.\]\n/);
    for (const line of clipped.split("\n")) expect(line === "" || /^(?:## |[A-Z_]+: |== |\d+ Setting up php8\.3-common \(8\.3\.36-1\+ubuntu24\.04\.1\+deb\.sury\.org\+1\) \.\.\.$|\[\.\.\. |Hit:1 |ii  |PHP |active$)/.test(line)).toBe(true);
  });

  it("keeps the error and exit-code lines of a cut body, not only its head and end", () => {
    const apt = Array.from({ length: 3000 }, (_, index) => {
      if (index === 1200) return "E: Sub-process /usr/bin/dpkg returned an error code (1)";
      if (index === 1700) return "dpkg: error processing package php8.3-fpm (--configure):";
      if (index === 2100) return "step exit code 0 after retry";
      return `${index} Setting up php8.3-common (8.3.36-1) ...`;
    });
    const output = ["== 2026-10-21T18:21:00.000Z step 1/1: install (limit 1800 s)", ...apt, "== 2026-10-21T18:39:41.000Z run finished: failed"].join("\n");
    const clipped = clipHandoff(handoff(output), 12000);
    expect(clipped.length).toBeLessThanOrEqual(12000);
    expect(clipped).toContain("\nE: Sub-process /usr/bin/dpkg returned an error code (1)\n");
    expect(clipped).toContain("\ndpkg: error processing package php8.3-fpm (--configure):\n");
    expect(clipped).toContain("\nstep exit code 0 after retry\n");
    expect(clipped).toContain("2999 Setting up");
    expect(clipped).toContain("== 2026-10-21T18:39:41.000Z run finished: failed");
    // The left-out lines add up: shown + left out = the whole body.
    const left = [...clipped.matchAll(/\[\.\.\. (\d+) lines? \(\d+ characters\) left out/g)].reduce((sum, match) => sum + Number(match[1]), 0);
    const shown = clipped.split("\n").filter((line) => /^\d+ Setting up|^E: |^dpkg: |^step exit/.test(line)).length;
    expect(shown + left).toBe(3000);
  });

  it("says ahead of the evidence what was left out, and only when something was", () => {
    const small = boundedVerifierPrompt("You are the verifier-agent. Intent: x", "plan", handoff(runLog(20)));
    expect(small.prompt).not.toContain("cockpit-prompt-budget");
    const big = boundedVerifierPrompt("You are the verifier-agent. Intent: x", "plan", handoff(runLog(4000)));
    expect(big.clipped).toBe(true);
    expect(big.prompt).toContain("\"source\":\"cockpit-prompt-budget\"");
    expect(big.prompt).toContain(`limited to ${VERIFIER_PROMPT_CHARS} characters`);
    expect(big.prompt).toContain("reviewed-plan: complete (4 characters).");
    expect(big.prompt).toMatch(/runner-handoff: shortened from \d+ to \d+ characters; \d+ cuts? \(\d+ lines\), each marked in place/);
    expect(big.prompt.indexOf("cockpit-prompt-budget")).toBeLessThan(big.prompt.indexOf("runner-handoff\",\"trust"));
  });

  it("clips a log without line structure by head and end", () => {
    const text = "a".repeat(5000) + "b".repeat(5000);
    expect(clipLog(text, 1000)).toBe(clipMiddle(text, 1000));
    expect(clipLog("short", 1000)).toBe("short");
  });

  it("brings an oversized handoff within the bound without touching the trusted instruction", () => {
    const instruction = `You are the verifier-agent. Intent: ${"keep the php packages patched; ".repeat(300)}`;
    const plan = "```host-run\n" + JSON.stringify({ steps: [{ run: "x".repeat(8000) }] }) + "\n```";
    for (const output of [runLog(4000), runLog(1500, "€äö Unpacking … ".repeat(8)), runLog(3000, "\"quoted\"\t\\escaped\\ ".repeat(6))]) {
      const built = boundedVerifierPrompt(instruction, plan, handoff(output));
      expect(built.clipped).toBe(true);
      expect(built.prompt.length).toBeLessThanOrEqual(VERIFIER_PROMPT_CHARS);
      expect(() => validateRequest({ requestId: "12345678", role: "verifier", prompt: built.prompt })).not.toThrow();
      expect(built.prompt).toContain(instruction);
      expect(built.prompt).toContain("PHP 8.3.36 (cli)");
      expect(built.prompt).toContain("NOTES: run success");
    }
  });

  it("clips the plan as well when the handoff alone cannot make room", () => {
    const instruction = "You are the verifier-agent. Intent: update php";
    const built = boundedVerifierPrompt(instruction, "p".repeat(150000), handoff(runLog(100)));
    expect(built.prompt.length).toBeLessThanOrEqual(VERIFIER_PROMPT_CHARS);
    expect(built.prompt).toContain("PHP 8.3.36 (cli)");
  });

  it("builds a valid prompt for an empty handoff and an empty output", () => {
    for (const text of ["", handoff("")]) {
      const built = boundedVerifierPrompt("You are the verifier-agent. Intent: x", "plan", text);
      expect(built.clipped).toBe(false);
      expect(() => validateRequest({ requestId: "12345678", role: "verifier", prompt: built.prompt })).not.toThrow();
    }
  });

  it("refuses rather than cuts the trusted instruction", () => {
    expect(() => boundedVerifierPrompt("i".repeat(VERIFIER_PROMPT_CHARS), "plan", "handoff")).toThrow(/trusted intent alone exceeds/);
  });

  it("clips plain text in the middle within its limit", () => {
    const text = "a".repeat(5000) + "b".repeat(5000);
    const clipped = clipMiddle(text, 1000);
    expect(clipped.length).toBeLessThanOrEqual(1000);
    expect(clipped.startsWith("a")).toBe(true);
    expect(clipped.endsWith("b")).toBe(true);
    expect(clipMiddle("short", 1000)).toBe("short");
    // Even a limit below the marker's length leaves a marked cut, never silence.
    expect(clipMiddle("x".repeat(500), 0)).toBe("[... 500 characters cut ...]");
  });

  it("marks every cut body when many sections share a small room", () => {
    const output = Array.from({ length: 30 }, (_, index) => `== 2026-10-21T18:00:00.000Z step ${index + 1}/30: s${index}\n${"y".repeat(1000)}`).join("\n")
      + "\n== 2026-10-21T18:30:00.000Z check 1/1: proof\n" + "z".repeat(1000);
    const clipped = clipHandoff(handoff(output), 5000);
    for (const section of clipped.slice(0, clipped.lastIndexOf("\nNOTES:")).split("\n== ").slice(1)) {
      const body = section.split("\n").slice(1).join("\n");
      expect(/characters\)? (of this section )?(left out|cut)/.test(body) || body === "y".repeat(1000) || body === "z".repeat(1000)).toBe(true);
    }
    expect(clipped).toContain("NOTES: run success");
  });
});
