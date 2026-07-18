import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
process.env.NODE_ENV = "test"; process.env.COCKPIT_EXECUTOR_BROKER_SECRET = "test-secret";
const { validateRequest } = await import("../src/index.mjs");
const payload = { action: "service.status", target: "apache2", expiresAt: "2030-01-01T00:00:00.000Z", envelopeDigest: "a".repeat(64) };
const signature = createHmac("sha256", "test-secret").update(JSON.stringify(payload)).digest("hex");
test("executor broker validates signature, expiry, action and target", () => {
  assert.deepEqual(validateRequest({ payload, signature }, Date.parse("2029-01-01T00:00:00Z")), payload);
  assert.throws(() => validateRequest({ payload: { ...payload, target: "ssh" }, signature }, Date.parse("2029-01-01T00:00:00Z")));
});
