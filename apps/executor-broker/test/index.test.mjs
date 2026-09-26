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

const diskBase = { expiresAt: "2030-01-01T00:00:00.000Z", envelopeDigest: "c".repeat(64) };
const sign = (payload) => createHmac("sha256", "test-secret").update(JSON.stringify(payload)).digest("hex");
const validAt = Date.parse("2029-01-01T00:00:00Z");

test("executor broker admits the typed disk actions on allowlisted targets", () => {
  for (const [action, target] of [["disk.status", "md127"], ["disk.remove", "sda"], ["disk.add", "sdz"], ["disk.smart", "sda"], ["disk.smarttest", "sdb"]]) {
    const payload = { ...diskBase, action, target };
    assert.deepEqual(validateRequest({ payload, signature: sign(payload) }, validAt), payload);
  }
});

test("executor broker rejects disk targets and actions outside the allowlist", () => {
  const rejected = [
    { action: "disk.status", target: "md126" },
    { action: "disk.status", target: "md127 " },
    { action: "disk.remove", target: "sda1" },
    { action: "disk.remove", target: "../sda" },
    { action: "disk.remove", target: "/dev/sda" },
    { action: "disk.add", target: "md127" },
    { action: "disk.smart", target: "sda1" },
    { action: "disk.smart", target: "/dev/sda" },
    { action: "disk.smarttest", target: "md127" },
    { action: "disk.smarttest", target: "sdaa" },
    { action: "disk.fail", target: "sda" },
  ];
  for (const partial of rejected) {
    const payload = { ...diskBase, ...partial };
    let threw = false;
    try { validateRequest({ payload, signature: sign(payload) }, validAt); } catch { threw = true; }
    assert.equal(threw, true, `expected rejection: ${JSON.stringify(partial)}`);
  }
});

const selfBase = { expiresAt: "2030-01-01T00:00:00.000Z", envelopeDigest: "d".repeat(64) };
const selfSha = "0123456789abcdef0123456789abcdef01234567";

const reviewedHash = "e".repeat(64);

test("executor broker admits the typed self-update actions on allowlisted targets", () => {
  for (const partial of [
    { action: "self.update", target: selfSha, diffSha256: reviewedHash },
    { action: "self.status", target: "state" },
    { action: "self.diff", target: selfSha },
  ]) {
    const payload = { ...selfBase, ...partial };
    assert.deepEqual(validateRequest({ payload, signature: sign(payload) }, validAt), payload);
  }
});

test("executor broker requires the reviewed diff hash for self.update and nowhere else", () => {
  const rejected = [
    { action: "self.update", target: selfSha },
    { action: "self.update", target: selfSha, diffSha256: reviewedHash.toUpperCase() },
    { action: "self.update", target: selfSha, diffSha256: reviewedHash.slice(1) },
    { action: "self.update", target: selfSha, diffSha256: `${reviewedHash} --force` },
    { action: "self.update", target: selfSha, diffSha256: 42 },
    { action: "self.diff", target: selfSha, diffSha256: reviewedHash },
    { action: "self.status", target: "state", diffSha256: reviewedHash },
    { action: "service.status", target: "apache2", diffSha256: reviewedHash },
  ];
  for (const partial of rejected) {
    const payload = { ...selfBase, ...partial };
    assert.throws(() => validateRequest({ payload, signature: sign(payload) }, validAt), undefined, `expected rejection: ${JSON.stringify(partial)}`);
  }
});

test("the reviewed diff hash is covered by the request signature", () => {
  const payload = { ...selfBase, action: "self.update", target: selfSha, diffSha256: reviewedHash };
  const tampered = { ...payload, diffSha256: "f".repeat(64) };
  assert.throws(() => validateRequest({ payload: tampered, signature: sign(payload) }, validAt), /invalid request signature/);
});

test("executor broker rejects self-update targets outside the allowlist", () => {
  const rejected = [
    { action: "self.status", target: "all" },
    { action: "self.status", target: "state " },
    { action: "self.update", target: "main" },
    { action: "self.update", target: selfSha.toUpperCase() },
    { action: "self.update", target: selfSha.slice(0, 39) },
    { action: "self.update", target: `${selfSha}f` },
    { action: "self.update", target: `${selfSha} --force` },
    { action: "self.diff", target: "main" },
    { action: "self.diff", target: selfSha.slice(0, 12) },
    { action: "self.diff", target: `${selfSha} --stat` },
    { action: "self.reboot", target: "state" },
  ];
  for (const partial of rejected) {
    // A valid reviewed hash on self.update: the target alone must be the reason.
    const payload = { ...selfBase, ...partial, ...(partial.action === "self.update" ? { diffSha256: reviewedHash } : {}) };
    let threw = false;
    try { validateRequest({ payload, signature: sign(payload) }, validAt); } catch { threw = true; }
    assert.equal(threw, true, `expected rejection: ${JSON.stringify(partial)}`);
  }
});
