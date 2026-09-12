#!/usr/bin/node
// Prüfstand für den Executor. Ruft ihn echt auf, mit gültiger Signatur, gegen
// Wegwerf-Verzeichnisse unter /var/tmp. Nichts davon berührt produktive Pfade.
import { createHash, createHmac } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";

const EXECUTOR = process.argv[2];
if (!EXECUTOR) { console.error("usage: harness <executor.mjs>"); process.exit(64); }

const secret = readFileSync("/etc/wireguard-ops-cockpit/api.env", "utf8")
  .split(/\r?\n/).find((l) => l.startsWith("COCKPIT_EXECUTION_ENVELOPE_SECRET="))
  .split("=").slice(1).join("=").replace(/^['"]|['"]$/g, "");

const canonical = (v) => createHash("sha256").update(JSON.stringify(v)).digest("hex");

function run(manifest, { approved = false } = {}) {
  const unsigned = {
    version: "hermes-execution-envelope/v1",
    jobId: `harness-${Date.now()}`,
    expiresAt: new Date(Date.now() + 600000).toISOString(),
    capabilities: ["service.manage"],
    manifestHash: canonical(manifest),
    operatorApproved: approved,
  };
  const digest = createHmac("sha256", secret).update(JSON.stringify(unsigned)).digest("hex");
  const res = spawnSync("/usr/bin/node", [EXECUTOR], {
    input: JSON.stringify({ manifest, envelope: { ...unsigned, digest } }),
    encoding: "utf8", timeout: 600000, maxBuffer: 8 * 1024 * 1024,
  });
  let parsed = null;
  try { parsed = JSON.parse(res.stdout); } catch { /* nicht-JSON = Fehlerpfad */ }
  return { status: res.status, out: parsed, stderr: (res.stderr || "").trim() };
}

function makeTree() {
  const root = mkdtempSync("/var/tmp/cockpit-harness-");
  const tree = `${root}/site`;
  mkdirSync(`${tree}/sub`, { recursive: true });
  writeFileSync(`${tree}/keep.txt`, "original\n");
  writeFileSync(`${tree}/sub/deep.txt`, "deep-original\n");
  return { root, tree };
}

let failed = 0;
const check = (name, ok, detail = "") => {
  if (!ok) failed += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `\n      ${detail}` : ""}`);
};

// ── 1: v1 verhält sich unverändert ────────────────────────────────────────
{
  const { root } = makeTree();
  const file = `${root}/single.conf`;
  writeFileSync(file, "before\n");
  const r = run({
    version: "cockpit-capability/v1", name: "v1-file", network: "none", risk: ["contained"],
    readablePaths: [], writablePaths: [file],
    steps: [{ argv: ["/usr/bin/tee", file], timeoutSeconds: 20 }],
  });
  check("v1: exact-file scope still works", r.out?.status === "success", `status=${r.status} ${r.stderr.slice(0, 120)}`);
  rmSync(root, { recursive: true, force: true });
}

// ── 2: tree-Scope wird gesichert und der Schritt darf schreiben ───────────
{
  const { root, tree } = makeTree();
  const r = run({
    version: "cockpit-capability/v2", name: "tree-write", network: "none", risk: ["contained", "data_loss"],
    readablePaths: [], writablePaths: [], scopes: [{ kind: "tree", path: tree }],
    steps: [{ argv: ["/usr/bin/rm", "-f", `${tree}/keep.txt`], timeoutSeconds: 30 }],
  });
  // rm steht in stepNeedsApproval -> muss ohne Freigabe abgelehnt werden
  check("tree: a dangerous executable still needs approval", r.status === 77, `status=${r.status}`);
  rmSync(root, { recursive: true, force: true });
}

// ── 3: data_loss ohne Scope bleibt freigabepflichtig ─────────────────────
{
  const { root } = makeTree();
  const r = run({
    version: "cockpit-capability/v2", name: "claims-only", network: "none", risk: ["data_loss"],
    readablePaths: [], writablePaths: [], scopes: [],
    steps: [{ argv: ["/bin/true"], timeoutSeconds: 10 }],
  });
  check("declaring data_loss without a scope earns no autonomy", r.status === 77, `status=${r.status}`);
  rmSync(root, { recursive: true, force: true });
}

// ── 4: data_loss MIT tree-Scope läuft autonom ────────────────────────────
{
  const { root, tree } = makeTree();
  const r = run({
    version: "cockpit-capability/v2", name: "autonomous", network: "none", risk: ["data_loss"],
    readablePaths: [], writablePaths: [], scopes: [{ kind: "tree", path: tree }],
    steps: [{ argv: ["/usr/bin/touch", `${tree}/added.txt`], timeoutSeconds: 20 }],
  });
  check("data_loss WITH a working scope runs autonomously",
    r.out?.status === "success" && existsSync(`${tree}/added.txt`),
    `status=${r.status} out=${r.out?.status} ${r.stderr.slice(0, 160)}`);
  rmSync(root, { recursive: true, force: true });
}

// ── 5: Fehlschlag rollt den Baum vollständig zurück ──────────────────────
{
  const { root, tree } = makeTree();
  const r = run({
    version: "cockpit-capability/v2", name: "rollback", network: "none", risk: ["data_loss"],
    readablePaths: [], writablePaths: [], scopes: [{ kind: "tree", path: tree }],
    steps: [
      { argv: ["/usr/bin/tee", `${tree}/keep.txt`], timeoutSeconds: 20 },
      { argv: ["/bin/false"], timeoutSeconds: 10 },
    ],
  });
  const restored = existsSync(`${tree}/keep.txt`) && readFileSync(`${tree}/keep.txt`, "utf8") === "original\n";
  const deepOk = existsSync(`${tree}/sub/deep.txt`);
  check("a failing step restores the whole tree",
    r.out?.status === "failed_rolled_back" && restored && deepOk,
    `out=${r.out?.status} keep=${restored} deep=${deepOk} ${r.stderr.slice(0, 160)}`);
  rmSync(root, { recursive: true, force: true });
}

// ── 6: Schutzpfade bleiben gesperrt ──────────────────────────────────────
{
  const r = run({
    version: "cockpit-capability/v2", name: "protected", network: "none", risk: ["contained"],
    readablePaths: [], writablePaths: [], scopes: [{ kind: "tree", path: "/opt/nextcloud" }],
    steps: [{ argv: ["/bin/true"], timeoutSeconds: 10 }],
  });
  check("a protected tree still requires approval", r.status === 77, `status=${r.status}`);
}

// ── 7: verbotene Wurzeln bleiben gesperrt ────────────────────────────────
{
  const r = run({
    version: "cockpit-capability/v2", name: "root-scope", network: "none", risk: ["contained"],
    readablePaths: [], writablePaths: [], scopes: [{ kind: "tree", path: "/etc" }],
    steps: [{ argv: ["/bin/true"], timeoutSeconds: 10 }],
  });
  check("a forbidden root cannot be a scope", r.status === 77, `status=${r.status}`);
}

// ── 8: vps-Helfer — löschen und zurückrollen bleiben freigabepflichtig ────
const vpsHelper = "/usr/local/lib/wireguard-ops-cockpit/cockpit-vps-snapshot";
const vpsCredentials = existsSync("/etc/wireguard-ops-cockpit/contabo.env");
for (const action of ["revert", "delete"]) {
  const r = run({
    version: "cockpit-capability/v1", name: `vps-${action}`, network: "outbound", risk: ["contained"],
    readablePaths: [], writablePaths: [],
    steps: [{ argv: ["/usr/bin/python3", vpsHelper, action, "12345"], timeoutSeconds: 30 }],
  });
  check(`vps: ${action} needs operator approval`, r.status === 77 && /approval/.test(r.stderr), `status=${r.status} ${r.stderr.slice(0, 120)}`);
}

// ── 9: vps-Helfer nur mit ausgehendem Netz, nur mit bekannten Aktionen ────
{
  const r = run({
    version: "cockpit-capability/v1", name: "vps-nonet", network: "none", risk: ["contained"],
    readablePaths: [], writablePaths: [],
    steps: [{ argv: ["/usr/bin/python3", vpsHelper, "status"], timeoutSeconds: 30 }],
  });
  check("vps: status without outbound network is rejected", r.status === 77 && /outbound/.test(r.stderr), `status=${r.status} ${r.stderr.slice(0, 120)}`);
  const u = run({
    version: "cockpit-capability/v1", name: "vps-unknown", network: "outbound", risk: ["contained"],
    readablePaths: [], writablePaths: [],
    steps: [{ argv: ["/usr/bin/python3", vpsHelper, "reinstall"], timeoutSeconds: 30 }],
  });
  check("vps: an unknown action is rejected before anything runs", u.status === 77, `status=${u.status} ${u.stderr.slice(0, 120)}`);
}

// ── 10: vps status läuft im Sandkasten — der Helfer findet seine Datei oder
//        sagt, dass sie fehlt. Beides beweist, dass der Bind stimmt. ────────
{
  const r = run({
    version: "cockpit-capability/v1", name: "vps-status", network: "outbound", risk: ["contained"],
    readablePaths: [], writablePaths: [],
    steps: [{ argv: ["/usr/bin/python3", vpsHelper, "status"], timeoutSeconds: 60 }],
  });
  const step = r.out?.outputs?.[0] || {};
  if (vpsCredentials) {
    check("vps: status inside the sandbox reaches the hoster", r.out?.status === "success" && /"instanceId"/.test(step.stdout || ""),
      `out=${r.out?.status} rc=${step.status} ${(step.stderr || "").slice(0, 160)}`);
  } else {
    check("vps: status inside the sandbox reports the missing credentials, nothing else",
      r.out?.status === "failed_rolled_back" && step.status === 69 && /no hoster credentials/.test(step.stderr || ""),
      `out=${r.out?.status} rc=${step.status} ${(step.stderr || "").slice(0, 160)}`);
  }
}

// ── 11: v2 vps-Scope ohne Zugang: der Snapshot scheitert VOR dem ersten
//        Schritt, und nichts wird ausgeführt ────────────────────────────────
if (vpsCredentials) {
  console.log("SKIP  vps: scope without credentials (credentials are deposited; a real snapshot is not a test)");
} else {
  const { root } = makeTree();
  const marker = `${root}/ran.txt`;
  const r = run({
    version: "cockpit-capability/v2", name: "vps-scope", network: "none", risk: ["data_loss"],
    readablePaths: [], writablePaths: [], scopes: [{ kind: "vps" }],
    steps: [{ argv: ["/usr/bin/touch", marker], timeoutSeconds: 10 }],
  });
  check("vps scope: a failed machine snapshot executes nothing",
    r.status === 69 && /machine snapshot failed/.test(r.stderr) && !existsSync(marker),
    `status=${r.status} ran=${existsSync(marker)} ${r.stderr.slice(0, 160)}`);
  rmSync(root, { recursive: true, force: true });
}

// ── 12: vps-Scope nimmt keine Parameter, und nur einen gibt es ────────────
{
  const p = run({
    version: "cockpit-capability/v2", name: "vps-param", network: "none", risk: ["contained"],
    readablePaths: [], writablePaths: [], scopes: [{ kind: "vps", path: "/" }],
    steps: [{ argv: ["/bin/true"], timeoutSeconds: 10 }],
  });
  check("vps scope: parameters are rejected", p.status === 77, `status=${p.status}`);
  const d = run({
    version: "cockpit-capability/v2", name: "vps-double", network: "none", risk: ["contained"],
    readablePaths: [], writablePaths: [], scopes: [{ kind: "vps" }, { kind: "vps" }],
    steps: [{ argv: ["/bin/true"], timeoutSeconds: 10 }],
  });
  check("vps scope: only one is allowed", d.status === 77, `status=${d.status}`);
}

console.log(failed === 0 ? "\nAlle Prüfungen bestanden." : `\n${failed} Prüfung(en) FEHLGESCHLAGEN.`);
process.exit(failed === 0 ? 0 : 1);
