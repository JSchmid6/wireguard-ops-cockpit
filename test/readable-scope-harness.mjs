#!/usr/bin/node
// Prüfstand für die lesenden Scopes und Unix-Sockets der Capability-Sandbox
// (27.09.2026, Befund aus dem Review von PR #10). Ruft den Executor echt auf,
// mit gültiger Signatur; Dateien nur unter /var/tmp.
//   sudo node test/readable-scope-harness.mjs deploy/helpers/cockpit-capability-action
//   sudo node test/readable-scope-harness.mjs ops/cockpit-capability-action.mjs
import { createHash, createHmac } from "node:crypto";
import { mkdtempSync, readFileSync, existsSync, rmSync, chmodSync, mkdirSync, writeFileSync } from "node:fs";
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

// ── Nachbesserung aus dem Re-Review von PR #11 (27.09.2026) ──────────────────
// Befund 1: gebunden wird der ganze Unterbaum — ein Elternverzeichnis darf
// geschuetzte Pfade darin nicht mehr durchlassen. Befund 2: Sicherungs- und
// Variantedateien (shadow-, *.bak, /var/backups) brauchen die Freigabe.
{
  const dir = mkdtempSync("/var/tmp/readable-harness-bak-");
  chmodSync(dir, 0o755);
  writeFileSync(`${dir}/shadow-`, "nur-ein-test\n");
  const r = run(manifest([`${dir}/shadow-`], ["/bin/true"]));
  check("Befund 2: Sicherungskopie shadow- ohne Freigabe abgewiesen", r.status === 77 && /requires operator approval/.test(r.out), r.out);
  const auf = run(manifest([`${dir}/shadow-`], ["/bin/true"]), { approved: true });
  check("Befund 2: Sicherungskopie shadow- mit Freigabe erlaubt (Validierung)", auf.status !== 77, auf.out);
  rmSync(dir, { recursive: true, force: true });
}
{
  const dir = mkdtempSync("/var/tmp/readable-harness-bak2-");
  chmodSync(dir, 0o755);
  writeFileSync(`${dir}/config.bak`, "nur-ein-test\n");
  const r = run(manifest([`${dir}/config.bak`], ["/bin/true"]));
  check("Befund 2: Sicherungskopie *.bak ohne Freigabe abgewiesen", r.status === 77 && /requires operator approval/.test(r.out), r.out);
  rmSync(dir, { recursive: true, force: true });
}
{
  const dir = mkdtempSync("/var/tmp/readable-harness-tree-");
  chmodSync(dir, 0o755);
  mkdirSync(`${dir}/keys`);
  writeFileSync(`${dir}/keys/id_rsa`, "nur-ein-test\n");
  const r = run(manifest([dir], ["/bin/true"]));
  check("Befund 1: Elternverzeichnis mit geschuetztem Unterbaum abgewiesen", r.status === 77 && /inside bound tree/.test(r.out) && /requires operator approval/.test(r.out), r.out);
  const auf = run(manifest([dir], ["/bin/true"]), { approved: true });
  check("Befund 1: Elternverzeichnis mit Freigabe erlaubt (Validierung)", auf.status !== 77, auf.out);
  rmSync(dir, { recursive: true, force: true });
}
{
  const dir = mkdtempSync("/var/tmp/readable-harness-deep-");
  chmodSync(dir, 0o755);
  mkdirSync(`${dir}/sub/dir`, { recursive: true });
  writeFileSync(`${dir}/sub/dir/shadow-`, "nur-ein-test\n");
  const r = run(manifest([dir], ["/bin/true"]));
  check("Befund 1+2: tief verschachtelte Sicherungskopie abgewiesen", r.status === 77 && /inside bound tree/.test(r.out), r.out);
  rmSync(dir, { recursive: true, force: true });
}
{
  if (!existsSync("/var/backups")) console.log("SKIP  /var/backups (fehlt hier)");
  else {
    const r = run(manifest(["/var/backups"], ["/bin/true"]));
    check("Befund 2: /var/backups ohne Freigabe abgewiesen", r.status === 77 && /requires operator approval/.test(r.out), r.out);
  }
}
{
  if (!existsSync("/etc/ssl/private")) console.log("SKIP  /etc/ssl (kein private/)");
  else {
    const r = run(manifest(["/etc/ssl"], ["/bin/true"]));
    check("Befund 1: /etc/ssl mit private/ ohne Freigabe abgewiesen", r.status === 77 && /inside bound tree/.test(r.out), r.out);
  }
}
// v2-Baum-Scopes tragen dieselbe Unterbaum-Regel (nur Fassungen, die v2 kennen).
if (/\bcapability\/v2\b/.test(readFileSync(EXECUTOR, "utf8"))) {
  const dir = mkdtempSync("/var/tmp/readable-harness-scope-");
  chmodSync(dir, 0o755);
  mkdirSync(`${dir}/keys`);
  const r = run({
    version: "cockpit-capability/v2", name: "readable-scope-harness", risk: ["contained"], network: "none",
    readablePaths: [], writablePaths: [], scopes: [{ kind: "tree", path: dir }], steps: [{ argv: ["/bin/true"] }], verification: [], rollback: [],
  });
  check("tree-Scope mit geschuetztem Unterbaum braucht Freigabe", r.status === 77 && /requires operator approval/.test(r.out), r.out);
  rmSync(dir, { recursive: true, force: true });
} else {
  console.log("SKIP  tree-Scope (Fassung kennt nur v1)");
}

console.log(failed ? `\n${failed} FAIL` : "\nalles grün");
process.exit(failed ? 1 : 0);
