import net from "node:net";
import fs from "node:fs";
import { createHmac, timingSafeEqual } from "node:crypto";
import { spawn } from "node:child_process";

const socketPath = process.env.COCKPIT_EXECUTOR_BROKER_SOCKET || "/run/wireguard-ops-cockpit/executor.sock";
const secret = process.env.COCKPIT_EXECUTOR_BROKER_SECRET || "";
const helper = "/usr/local/sbin/cockpit-service-action";
const diskHelper = "/usr/local/sbin/cockpit-disk-action";
const selfUpdateHelper = "/usr/local/sbin/cockpit-self-update-action";
const diensteUpdateHelper = "/usr/local/sbin/cockpit-dienste-update-action";
const capabilityHelper = "/usr/local/lib/wireguard-ops-cockpit/cockpit-capability-action.mjs";
const capabilityNode = "/opt/node-v20.19.1-linux-x64/bin/node";
// The general host door (doc/setup/host-run.md): host.run hands the signed
// manifest to the root helper, which starts the run in its own unit and returns
// at once; host.status reads that run's state. The helper verifies the envelope
// itself, so this broker only checks the request's shape.
const hostRunHelper = "/usr/local/lib/wireguard-ops-cockpit/cockpit-host-run.mjs";
const hostRunJobId = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;
const services = new Set(["apache2", "wireguard-ops-cockpit-ttyd"]);
const diskActions = new Set(["disk.status", "disk.remove", "disk.add", "disk.smart", "disk.smarttest"]);
const diskDevice = /^sd[a-z]$/;
// Borg-Betrieb: status ist lesend und läuft in einer eigenen transienten Unit
// (--wait --pipe --collect); check/repair starten eine benannte Unit ohne Warten
// (der Lauf hält dort die Repo-Sperre selbst) und kehren sofort zurück.
const borgHelper = "/usr/local/sbin/cockpit-borg-action";
const borgActions = new Set(["borg.status", "borg.check", "borg.repair"]);
// Aufräum-Dienst auf Lab0 (doc/setup/borg-retention.md): fünf gepinnte Formen.
// Ob eine Einstellung unter der Untergrenze oder ein Fortsetzen freigegeben ist,
// entscheidet die API (nur Jochens Sitzung); der Helfer prüft Grenzen und Form
// noch einmal selbst.
const retentionHelper = "/usr/local/sbin/cockpit-borg-retention";
const retentionActions = new Set(["borg.retention.status", "borg.retention.run", "borg.retention.set", "borg.retention.set-approved", "borg.retention.resume"]);
const retentionSetting = /^(\d{1,3})-(\d{1,3})-(\d{1,3})-([01]\d|2[0-3]):([0-5]\d)$/;
const retentionAnomaly = /^[a-f0-9]{16}$/;
const selfUpdateActions = new Set(["self.update", "self.status", "self.diff"]);
// server-dienste (the root supervisor of the agent's Docker services): the same
// three forms, installed by its own helper, reviewed with its own guarantees.
const diensteUpdateActions = new Set(["dienste.update", "dienste.status", "dienste.diff"]);
const reviewedUpdates = new Set(["self.update", "dienste.update"]);
const selfUpdateSha = /^[a-f0-9]{40}$/;
const reviewedDiffHash = /^[a-f0-9]{64}$/;
// The review diff carries a bounded excerpt (runner cap 200 KB plus focus-area
// hunks, JSON-escaped); anything larger is refused instead of cut mid-JSON.
const selfDiffOutputLimit = 2_000_000;

function signature(payload) { return createHmac("sha256", secret).update(JSON.stringify(payload)).digest("hex"); }
export function validateRequest(value, now = Date.now()) {
  if (!secret) throw new Error("executor broker secret is not configured");
  if (!value || typeof value !== "object" || !value.payload || typeof value.signature !== "string") throw new Error("invalid signed request");
  const expected = signature(value.payload);
  if (!/^[a-f0-9]{64}$/.test(value.signature) || !timingSafeEqual(Buffer.from(value.signature, "hex"), Buffer.from(expected, "hex"))) throw new Error("invalid request signature");
  const { action, target, expiresAt, envelopeDigest } = value.payload;
  if (action !== "service.restart" && action !== "service.status" && action !== "capability.execute" && action !== "host.run" && action !== "host.status" && !diskActions.has(action) && !selfUpdateActions.has(action) && !diensteUpdateActions.has(action) && !borgActions.has(action) && !retentionActions.has(action)) throw new Error("unsupported capability action");
  if (action.startsWith("service.") && !services.has(target)) throw new Error("service target is not allowlisted");
  if (action === "borg.status" && target !== "state") throw new Error("borg status target is not allowlisted");
  if ((action === "borg.check" || action === "borg.repair") && target !== "repo") throw new Error("borg maintenance target is not allowlisted");
  if ((action === "borg.retention.status" || action === "borg.retention.run") && target !== "state") throw new Error("borg retention target is not allowlisted");
  if ((action === "borg.retention.set" || action === "borg.retention.set-approved") && (typeof target !== "string" || !retentionSetting.test(target))) throw new Error("borg retention setting is not valid");
  if (action === "borg.retention.resume" && (typeof target !== "string" || !retentionAnomaly.test(target))) throw new Error("borg retention anomaly id is not valid");
  if (action === "disk.status" && target !== "md127") throw new Error("disk target is not allowlisted");
  if ((action === "disk.remove" || action === "disk.add" || action === "disk.smart" || action === "disk.smarttest") && (typeof target !== "string" || !diskDevice.test(target))) throw new Error("disk device is not allowlisted");
  if (action === "self.status" && target !== "state") throw new Error("self-update status target is not allowlisted");
  if ((action === "self.update" || action === "self.diff") && (typeof target !== "string" || !selfUpdateSha.test(target))) throw new Error("self-update commit is not allowlisted");
  if (action === "dienste.status" && target !== "state") throw new Error("dienste status target is not allowlisted");
  if ((action === "dienste.update" || action === "dienste.diff") && (typeof target !== "string" || !selfUpdateSha.test(target))) throw new Error("dienste commit is not allowlisted");
  // Every update carries the hash of the diff the running Cockpit reviewed;
  // the runner recomputes it and refuses a mismatch before anything deploys.
  if (reviewedUpdates.has(action) && (typeof value.payload.diffSha256 !== "string" || !reviewedDiffHash.test(value.payload.diffSha256))) throw new Error(`${action} requires the reviewed diff sha256`);
  if (!reviewedUpdates.has(action) && value.payload.diffSha256 !== undefined) throw new Error("diffSha256 is only valid for self.update and dienste.update");
  if (action === "capability.execute" && (!value.payload.manifest || !value.payload.envelope)) throw new Error("dynamic capability payload is incomplete");
  if (action === "host.run" && (!value.payload.manifest || !value.payload.envelope || value.payload.manifest.version !== "cockpit-host-run/v1")) throw new Error("host run payload is incomplete");
  if (action === "host.status" && (typeof target !== "string" || !hostRunJobId.test(target))) throw new Error("host run job id is not valid");
  if (typeof envelopeDigest !== "string" || !/^[a-f0-9]{64}$/.test(envelopeDigest)) throw new Error("invalid envelope digest");
  if (typeof expiresAt !== "string" || now > Date.parse(expiresAt)) throw new Error("execution request expired");
  return value.payload;
}

export function execute(payload) {
  return new Promise((resolve) => {
    if (payload.action === "capability.execute" || payload.action === "host.run") {
      const child = spawn("sudo", ["-n", capabilityNode, ...(payload.action === "host.run" ? [hostRunHelper, "start"] : [capabilityHelper])], { env: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin" }, stdio: ["pipe", "pipe", "pipe"] });
      let output = ""; let error = "";
      child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk) => { output += chunk; }); child.stderr.on("data", (chunk) => { error += chunk; });
      child.on("error", (reason) => resolve({ ok: false, error: reason.message }));
      child.on("close", (code) => resolve({
        ok: code === 0,
        exitCode: code,
        output: output.slice(-50000),
        error: code === 0 ? null : [error, output].filter(Boolean).join("\n").slice(-50000),
      }));
      child.stdin.end(JSON.stringify({ manifest: payload.manifest, envelope: payload.envelope }));
      return;
    }
    if (payload.action === "host.status") {
      const child = spawn("sudo", ["-n", capabilityNode, hostRunHelper, "status", payload.target], { env: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin" }, stdio: ["ignore", "pipe", "pipe"] });
      let hostOutput = ""; let hostError = "";
      child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk) => { hostOutput += chunk; }); child.stderr.on("data", (chunk) => { hostError += chunk; });
      child.on("error", (reason) => resolve({ ok: false, error: reason.message }));
      child.on("close", (code) => resolve({ ok: code === 0, exitCode: code, output: hostOutput.slice(-200000), error: code === 0 ? null : [hostError, hostOutput].filter(Boolean).join("\n").slice(-4000) }));
      return;
    }
    if (selfUpdateActions.has(payload.action) || diensteUpdateActions.has(payload.action)) {
      // The helper starts the one-shot deploy unit and waits for it; the unit
      // re-verifies the allowlisted repo, the merged commit and the reviewed
      // diff hash on its own. *.diff is the read-only review input.
      const verb = payload.action.slice(payload.action.indexOf(".") + 1);
      const selfArgs = verb === "update" ? [payload.target, payload.diffSha256]
        : verb === "diff" ? ["diff", payload.target] : ["status"];
      const outputLimit = verb === "diff" ? selfDiffOutputLimit : 20000;
      const updateHelper = diensteUpdateActions.has(payload.action) ? diensteUpdateHelper : selfUpdateHelper;
      const child = spawn("sudo", ["-n", updateHelper, ...selfArgs], { env: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin" }, stdio: ["ignore", "pipe", "pipe"] });
      let selfOutput = ""; let selfError = "";
      child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk) => { selfOutput += chunk; });
      child.stderr.on("data", (chunk) => { selfError += chunk; });
      child.on("error", (reason) => resolve({ ok: false, error: reason.message }));
      child.on("close", (code) => {
        if (code === 0 && verb === "diff" && selfOutput.length > outputLimit) {
          resolve({ ok: false, exitCode: code, error: `${payload.action} output exceeds ${outputLimit} characters` });
          return;
        }
        resolve({ ok: code === 0, exitCode: code, output: selfOutput.slice(-outputLimit), error: code === 0 ? null : [selfError, selfOutput].filter(Boolean).join("\n").slice(-4000) });
      });
      return;
    }
    if (borgActions.has(payload.action)) {
      // Three pinned verbs. status is read-only; check/repair start a detached
      // run inside the helper and return at once (the run holds the repo lock),
      // so this slot never waits for the hours-long check.
      const borgVerb = payload.action.slice("borg.".length);
      const child = spawn("sudo", ["-n", borgHelper, borgVerb], { env: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin" }, stdio: ["ignore", "pipe", "pipe"] });
      let borgOutput = ""; let borgError = "";
      child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk) => { borgOutput += chunk; });
      child.stderr.on("data", (chunk) => { borgError += chunk; });
      child.on("error", (reason) => resolve({ ok: false, error: reason.message }));
      child.on("close", (code) => resolve({ ok: code === 0, exitCode: code, output: borgOutput.slice(-40000), error: code === 0 ? null : [borgError, borgOutput].filter(Boolean).join("\n").slice(-4000) }));
      return;
    }
    if (retentionActions.has(payload.action)) {
      const verb = payload.action.slice("borg.retention.".length);
      const setting = retentionSetting.exec(payload.target);
      const retentionArgs = verb === "status" || verb === "run" ? [verb]
        : verb === "resume" ? ["freigeben", payload.target]
        : ["set", setting[1], setting[2], setting[3], `${setting[4]}:${setting[5]}`, ...(verb === "set-approved" ? ["--freigabe"] : [])];
      const child = spawn("sudo", ["-n", retentionHelper, ...retentionArgs], { env: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin" }, stdio: ["ignore", "pipe", "pipe"] });
      let retentionOutput = ""; let retentionError = "";
      child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk) => { retentionOutput += chunk; }); child.stderr.on("data", (chunk) => { retentionError += chunk; });
      child.on("error", (reason) => resolve({ ok: false, error: reason.message }));
      child.on("close", (code) => resolve({ ok: code === 0, exitCode: code, output: retentionOutput.slice(-60000), error: code === 0 ? null : [retentionError, retentionOutput].filter(Boolean).join("\n").slice(-4000) }));
      return;
    }
    if (payload.action.startsWith("disk.")) {
      const diskVerb = payload.action.slice("disk.".length);
      const diskArgs = diskVerb === "status" ? [diskVerb] : [diskVerb, payload.target];
      const child = spawn("sudo", ["-n", diskHelper, ...diskArgs], { env: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin" }, stdio: ["ignore", "pipe", "pipe"] });
      let diskOutput = ""; let diskError = "";
      child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk) => { diskOutput += chunk; }); child.stderr.on("data", (chunk) => { diskError += chunk; });
      child.on("error", (reason) => resolve({ ok: false, error: reason.message }));
      child.on("close", (code) => resolve({ ok: code === 0, exitCode: code, output: diskOutput.slice(-20000), error: code === 0 ? null : [diskError, diskOutput].filter(Boolean).join("\n").slice(-4000) }));
      return;
    }
    const verb = payload.action === "service.restart" ? "restart" : "status";
    const child = spawn("sudo", ["-n", helper, verb, payload.target], { env: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin" }, stdio: ["ignore", "pipe", "pipe"] });
    let output = ""; let error = "";
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { output += chunk; }); child.stderr.on("data", (chunk) => { error += chunk; });
    child.on("error", (reason) => resolve({ ok: false, error: reason.message }));
    child.on("close", (code) => resolve({ ok: code === 0, exitCode: code, output: output.slice(-20000), error: code === 0 ? null : error.slice(-4000) }));
  });
}

if (process.env.NODE_ENV !== "test") {
  try { fs.unlinkSync(socketPath); } catch (error) { if (error.code !== "ENOENT") throw error; }
  const server = net.createServer((connection) => {
    let input = ""; let handled = false; connection.setEncoding("utf8");
    connection.on("data", async (chunk) => {
      input += chunk; if (input.length > 524288) { connection.destroy(); return; }
      if (handled || !input.includes("\n")) return;
      handled = true;
      try { connection.end(JSON.stringify(await execute(validateRequest(JSON.parse(input.slice(0, input.indexOf("\n"))))))); }
      catch (error) { connection.end(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : "invalid request" })); }
    });
  });
  server.listen(socketPath, () => fs.chmodSync(socketPath, 0o660));
}
