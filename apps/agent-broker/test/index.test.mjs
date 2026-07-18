import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
process.env.NODE_ENV = "test";
process.env.COCKPIT_OPENCODE_EXECUTABLE = "/bin/true";
process.env.COCKPIT_AGENT_WORKSPACE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "cockpit-agent-run-"));
const { cleanupStaleWorkspaces, createSessionWorkspace, removeSessionWorkspace, runAgent, validateRequest } = await import("../src/index.mjs");
test.after(() => fs.rmSync(process.env.COCKPIT_AGENT_WORKSPACE_ROOT, { recursive: true, force: true }));
test("agent broker accepts only bounded roles and prompts", () => {
  assert.deepEqual(validateRequest({ requestId: "12345678", role: "planner", prompt: "inspect" }), { requestId: "12345678", role: "planner", prompt: "inspect" });
  assert.throws(() => validateRequest({ requestId: "12345678", role: "root", prompt: "inspect" }), /invalid agent role/);
});

test("agent broker creates a private role-scoped workspace and removes only that workspace", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cockpit-agent-test-"));
  const workspace = createSessionWorkspace({ requestId: "12345678", role: "planner", prompt: "inspect" }, root);
  const instructions = fs.readFileSync(path.join(workspace, "AGENTS.md"), "utf8");
  assert.match(instructions, /disposable session workspace/);
  assert.match(instructions, /Planner role/);
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
