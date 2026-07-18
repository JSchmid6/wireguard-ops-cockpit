import test from "node:test";
import assert from "node:assert/strict";
process.env.NODE_ENV = "test";
const { validateRequest } = await import("../src/index.mjs");
test("agent broker accepts only bounded roles and prompts", () => {
  assert.deepEqual(validateRequest({ requestId: "12345678", role: "planner", prompt: "inspect" }), { requestId: "12345678", role: "planner", prompt: "inspect" });
  assert.throws(() => validateRequest({ requestId: "12345678", role: "root", prompt: "inspect" }), /invalid agent role/);
});
