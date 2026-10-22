import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
process.env.NODE_ENV = "test";
// A stand-in for opencode: reports its arguments, then echoes stdin.
const fakeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cockpit-agent-fake-"));
const fakeOpencode = path.join(fakeRoot, "opencode");
fs.writeFileSync(fakeOpencode, "#!/bin/sh\nprintf 'argc=%s last=%s\\n' \"$#\" \"$(eval echo \\\"\\$$#\\\")\"\ncat\n", { mode: 0o755 });
process.env.COCKPIT_OPENCODE_EXECUTABLE = fakeOpencode;
process.env.COCKPIT_AGENT_WORKSPACE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "cockpit-agent-run-"));
const { cleanupStaleWorkspaces, createSessionWorkspace, removeSessionWorkspace, runAgent, validateRequest } = await import("../src/index.mjs");
const { PROMPT_LIMITS, promptLimit, promptLimitProblem } = await import("../src/prompt-limits.mjs");
test.after(() => {
  fs.rmSync(process.env.COCKPIT_AGENT_WORKSPACE_ROOT, { recursive: true, force: true });
  fs.rmSync(fakeRoot, { recursive: true, force: true });
});
test("agent broker accepts only bounded roles and prompts", () => {
  assert.deepEqual(validateRequest({ requestId: "12345678", role: "planner", prompt: "inspect" }), { requestId: "12345678", role: "planner", prompt: "inspect" });
  assert.deepEqual(validateRequest({ requestId: "12345678", role: "research", prompt: "inspect" }), { requestId: "12345678", role: "research", prompt: "inspect" });
  assert.throws(() => validateRequest({ requestId: "12345678", role: "root", prompt: "inspect" }), /invalid agent role/);
});

test("only the safety and verifier roles get the larger budget", () => {
  const review = "d".repeat(90000);
  assert.equal(validateRequest({ requestId: "12345678", role: "safety", prompt: review }).prompt.length, 90000);
  assert.equal(validateRequest({ requestId: "12345678", role: "verifier", prompt: review }).prompt.length, 90000);
  assert.throws(() => validateRequest({ requestId: "12345678", role: "verifier", prompt: "d".repeat(100001) }), /^Error: prompt length 100001 exceeds verifier limit 100000$/);
  assert.throws(() => validateRequest({ requestId: "12345678", role: "planner", prompt: review }), /^Error: prompt length 90000 exceeds planner limit 30000$/);
  assert.throws(() => validateRequest({ requestId: "12345678", role: "runner", prompt: review }), /^Error: prompt length 90000 exceeds runner limit 30000$/);
  assert.throws(() => validateRequest({ requestId: "12345678", role: "verifier", prompt: "" }), /prompt is empty/);
  assert.throws(() => validateRequest({ requestId: "12345678", role: "verifier", prompt: 7 }), /prompt is empty or not a string/);
  assert.throws(() => validateRequest({ requestId: "12345678", role: "safety", prompt: "d".repeat(100001) }), /exceeds safety limit 100000/);
  // The prompt goes on stdin: no argv byte bound any more, multi-byte text
  // counts by characters like any other.
  assert.equal(validateRequest({ requestId: "12345678", role: "safety", prompt: "\u20ac".repeat(100000) }).prompt.length, 100000);
});

test("the bounds have one definition: every role, one number, one wording", () => {
  assert.deepEqual(Object.keys(PROMPT_LIMITS).sort(), ["planner", "research", "runner", "safety", "verifier"]);
  assert.equal(Object.isFrozen(PROMPT_LIMITS), true);
  for (const [role, limit] of Object.entries(PROMPT_LIMITS)) {
    assert.equal(promptLimit(role), limit);
    assert.equal(promptLimitProblem(role, "x".repeat(limit)), null);
    assert.equal(promptLimitProblem(role, "x".repeat(limit + 1)), `prompt length ${limit + 1} exceeds ${role} limit ${limit}`);
    assert.doesNotThrow(() => validateRequest({ requestId: "12345678", role, prompt: "x".repeat(limit) }));
  }
  assert.throws(() => promptLimit("root"), /invalid agent role/);
  assert.throws(() => promptLimit("constructor"), /invalid agent role/);
});

test("agent broker creates a private role-scoped workspace and removes only that workspace", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cockpit-agent-test-"));
  const workspace = createSessionWorkspace({ requestId: "12345678", role: "planner", prompt: "inspect" }, root);
  const instructions = fs.readFileSync(path.join(workspace, "AGENTS.md"), "utf8");
  assert.match(instructions, /disposable session workspace/);
  assert.match(instructions, /Planner role/);
  assert.match(instructions, /configured HaRP/);
  assert.equal(fs.statSync(workspace).mode & 0o777, 0o700);
  removeSessionWorkspace(workspace, root);
  assert.equal(fs.existsSync(workspace), false);
  assert.throws(() => removeSessionWorkspace(root, root), /refusing/);
  fs.rmSync(root, { recursive: true });
});

test("startup cleanup removes stale bounded workspaces but preserves unrelated directories", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cockpit-agent-stale-"));
  const stale = path.join(root, "agent-stale-planner-test");
  const unrelated = path.join(root, "operator-data");
  fs.mkdirSync(stale); fs.mkdirSync(unrelated);
  fs.utimesSync(stale, new Date(0), new Date(0));
  cleanupStaleWorkspaces(root, Date.now());
  assert.equal(fs.existsSync(stale), false);
  assert.equal(fs.existsSync(unrelated), true);
  fs.rmSync(root, { recursive: true });
});

test("agent process exit removes its complete session workspace", async () => {
  const result = await runAgent({ requestId: "87654321", role: "verifier", prompt: "verify" });
  assert.equal(result.ok, true);
  assert.deepEqual(fs.readdirSync(process.env.COCKPIT_AGENT_WORKSPACE_ROOT), []);
});

// Linux caps one argv element at 128 KiB (MAX_ARG_STRLEN); 100,000 three-byte
// characters are 300,000 bytes. On stdin the prompt arrives whole and unchanged
// (quotes and backslashes too), and argv ends with the options.
test("the prompt reaches opencode on stdin, whole, beyond the old argv bound", async () => {
  const prompt = `say "hi" \\ ${"\u20ac".repeat(100000 - 11)}`;
  assert.equal(prompt.length, 100000);
  const result = await runAgent({ requestId: "87654322", role: "verifier", prompt });
  assert.equal(result.ok, true, result.error);
  const [head, ...rest] = result.output.split("\n");
  assert.match(head, /^argc=\d+ last=--print-logs$/);
  assert.equal(rest.join("\n"), prompt);
});
