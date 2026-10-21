import { describe, expect, it } from "vitest";

import { VERIFIER_PROMPT_BYTES, VERIFIER_PROMPT_CHARS, boundedVerifierPrompt, clipHandoff, clipMiddle } from "../src/verifier-prompt.js";

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
  it("is the broker's own bound", () => {
    const at = (prompt: string) => () => validateRequest({ requestId: "12345678", role: "verifier", prompt });
    expect(at("v".repeat(VERIFIER_PROMPT_CHARS))).not.toThrow();
    expect(at("v".repeat(VERIFIER_PROMPT_CHARS + 1))).toThrow(/prompt length is invalid/);
    expect(at("ä".repeat(VERIFIER_PROMPT_BYTES / 2))).not.toThrow();
    expect(at("ä".repeat(VERIFIER_PROMPT_BYTES / 2 + 1))).toThrow(/prompt length is invalid/);
  });

  it("leaves a handoff that fits unchanged", () => {
    const text = handoff(runLog(20));
    expect(clipHandoff(text, text.length)).toBe(text);
    const built = boundedVerifierPrompt("You are the verifier-agent. Intent: update php", "```host-run\n{}\n```", text);
    expect(built.clipped).toBe(false);
    expect(built.prompt).toContain(JSON.stringify(text).slice(1, -1));
  });

  it("keeps the header fields, every run-log line and the checks, and cuts the step bodies in the middle", () => {
    const text = handoff(runLog(3000));
    const clipped = clipHandoff(text, 20000);
    expect(clipped.length).toBeLessThanOrEqual(20000);
    for (const line of text.split("\n").filter((item) => /^(## |STATUS|EXIT_CODE|WHAT_RAN|NOTES|== )/.test(item) || item.startsWith("OUTPUT: =="))) expect(clipped).toContain(line);
    expect(clipped).toContain("ii  php8.3-fpm 8.3.36-1\nPHP 8.3.36 (cli)");
    expect(clipped).toContain("active\nactive");
    // Head and end of the long step stay, the cut is marked.
    expect(clipped).toContain("0 Setting up php8.3-common");
    expect(clipped).toContain("2999 Setting up php8.3-common");
    expect(clipped).not.toContain("\n1500 Setting up");
    expect(clipped).toMatch(/\[\.\.\. \d+ characters of this section left out for the verifier's prompt bound; the job record keeps the full text \.\.\.\]/);
  });

  it("brings an oversized handoff within both bounds without touching the trusted instruction", () => {
    const instruction = `You are the verifier-agent. Intent: ${"keep the php packages patched; ".repeat(300)}`;
    const plan = "```host-run\n" + JSON.stringify({ steps: [{ run: "x".repeat(8000) }] }) + "\n```";
    for (const output of [runLog(4000), runLog(1500, "€äö Unpacking … ".repeat(8)), runLog(3000, "\"quoted\"\t\\escaped\\ ".repeat(6))]) {
      const built = boundedVerifierPrompt(instruction, plan, handoff(output));
      expect(built.clipped).toBe(true);
      expect(built.prompt.length).toBeLessThanOrEqual(VERIFIER_PROMPT_CHARS);
      expect(Buffer.byteLength(built.prompt, "utf8")).toBeLessThanOrEqual(VERIFIER_PROMPT_BYTES);
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
  });
});
