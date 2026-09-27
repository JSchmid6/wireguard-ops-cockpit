#!/usr/bin/node
// Prüfstand für die lesenden Scopes und Unix-Sockets der Capability-Sandbox
// (27.09.2026, Befund aus dem Review von PR #10). Ruft den Executor echt auf,
// mit gültiger Signatur; Dateien nur unter /var/tmp.
//   sudo node test/readable-scope-harness.mjs deploy/helpers/cockpit-capability-action
//   sudo node test/readable-scope-harness.mjs ops/cockpit-capability-action.mjs
import { createHash, createHmac } from "node:crypto";
import { mkdtempSync, readFileSync, existsSync, rmSync, chmodSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";

const EXECUTOR = process.argv[2];
if (!EXECUTOR) { console.error("usage: readable-scope-harness <executor>"); process.exit(64); }
const PINNED = "/opt/node-v20.19.1-linux-x64/bin/node";
const NODE = existsSync(PINNED) ? PINNED : "/usr/bin/node";
const secret = readFileSync("/etc/wireguard-ops-cockpit/api.env", "utf8")
  .split(/\r?\n/).find((l) => l.startsWith("COCKPIT_EXECUTION_ENVELOPE_SECRET="))
  .split("=").slice(1).join("=").replace(/^['"]|['"]$/g, "");
const canonical = (v) => createHash("sha256").update(JSON.stringify(v)).digest("hex");

function run(manifest, { approved = false } = {}) {
  const unsigned = {
    version: "hermes-execution-envelope/v1", jobId: `readable-harness-${Date.now()}`,
    expiresAt: new Date(Date.now() + 600000).toISOString(), capabilities: ["read.host"],
    manifestHash: canonical(manifest), operatorApproved: approved,
  };
  const digest = createHmac("sha256", secret).update(JSON.stringify(unsigned)).digest("hex");
  const res = spawnSync(NODE, [EXECUTOR], { input: JSON.stringify({ manifest, envelope: { ...unsigned, digest } }), encoding: "utf8", timeout: 120000 });
  return { status: res.status, out: `${res.stdout || ""}\n${res.stderr || ""}` };
}

const manifest = (readablePaths, argv, extra = {}) => ({
  version: "cockpit-capability/v1", name: "readable-scope-harness", intent: "harness", risk: [], network: "none",
  readablePaths, writablePaths: [], steps: [{ argv }], verification: [], rollback: [], ...extra,
});

let failed = 0;
const check = (name, ok, detail = "") => { if (!ok) failed += 1; console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `\n      ${detail.slice(-600)}`}`); };

for (const pfad of ["/var/run/docker.sock", "/etc/shadow", "/root/.bash_history", "/proc/1/environ", "/sys/kernel", "/var/lib/docker"]) {
  if (!existsSync(pfad)) { console.log(`SKIP  ${pfad} (fehlt hier)`); continue; }
  const r = run(manifest([pfad], ["/bin/true"]));
  check(`ohne Freigabe abgewiesen: ${pfad}`, r.status === 77 && /requires operator approval|socket is never an autonomous/.test(r.out), r.out);
}
const log = mkdtempSync("/var/tmp/readable-harness-log-");
chmodSync(log, 0o755);
const ok = run(manifest([log], ["/bin/ls", log]));
check("gewöhnlicher Ordner bleibt autonom lesbar", ok.status === 0, ok.out);
rmSync(log, { recursive: true, force: true });

// Ein echter Unix-Socket in einem Wegwerf-Ordner: eingehängt, aber ohne Freigabe nicht erreichbar.
const dir = mkdtempSync("/var/tmp/readable-harness-");
chmodSync(dir, 0o755);
const sock = `${dir}/probe.sock`;
const server = spawn("/usr/bin/python3", ["-c", `
import socket, os, sys
s = socket.socket(socket.AF_UNIX); s.bind(${JSON.stringify(sock)}); os.chmod(${JSON.stringify(sock)}, 0o666); s.listen(4)
print("bereit", flush=True)
while True:
    c, _ = s.accept(); c.sendall(b"hallo\\n"); c.close()
`], { stdio: ["ignore", "pipe", "inherit"] });
await new Promise((resolve) => server.stdout.once("data", resolve));
const probe = ["/usr/bin/python3", "-c", `
import socket, sys
try:
    s = socket.socket(socket.AF_UNIX); s.connect(${JSON.stringify(sock)}); print("VERBUNDEN", s.recv(16))
except OSError as e:
    print("GESPERRT", e.errno); sys.exit(3)
`];
const stdout = (r) => { try { return JSON.parse(r.out.trim().split("\n")[0]).outputs.map((o) => o.stdout).join(""); } catch { return r.out; } };
const zu = run(manifest([dir], probe));
check("Socket ohne Freigabe nicht erreichbar (AF_UNIX gesperrt)", /GESPERRT 97/.test(stdout(zu)) && !/VERBUNDEN/.test(stdout(zu)), zu.out);
const auf = run(manifest([dir], probe), { approved: true });
check("Socket mit Freigabe erreichbar", auf.status === 0 && /VERBUNDEN/.test(auf.out), auf.out);
server.kill();
rmSync(dir, { recursive: true, force: true });

console.log(failed ? `\n${failed} FAIL` : "\nalles grün");
process.exit(failed ? 1 : 0);
