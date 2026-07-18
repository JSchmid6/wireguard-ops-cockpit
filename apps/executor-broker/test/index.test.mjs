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
test("executor broker accepts a signed dynamic manifest and rejects an incomplete one", () => {
  const dynamic = {
    action: "capability.execute", expiresAt: "2030-01-01T00:00:00.000Z", envelopeDigest: "b".repeat(64),
    manifest: { version: "cockpit-capability/v1", steps: [{ argv: ["/usr/bin/true"] }] }, envelope: { digest: "b".repeat(64) },
  };
  const signed = createHmac("sha256", "test-secret").update(JSON.stringify(dynamic)).digest("hex");
  assert.deepEqual(validateRequest({ payload: dynamic, signature: signed }, Date.parse("2029-01-01T00:00:00Z")), dynamic);
  const incomplete = { ...dynamic, manifest: null };
  const incompleteSignature = createHmac("sha256", "test-secret").update(JSON.stringify(incomplete)).digest("hex");
  assert.throws(() => validateRequest({ payload: incomplete, signature: incompleteSignature }, Date.parse("2029-01-01T00:00:00Z")));
});
