#!/bin/bash
# ============================================================================
# cockpit-disk-sandbox-e2e-inner.sh — läuft IM Wegwerf-Container (root, echtes
# systemd). Wird von test/cockpit-disk-sandbox-e2e.sh aufgerufen; bitte dort
# starten. Installiert Runner und Disk-Helfer an ihre Produktionspfade, legt
# ein Test-Secret an und fährt den Runner mit signierten Envelopes.
# ============================================================================
set -u

NODE_BIN="$(command -v node || true)"
if [ -z "$NODE_BIN" ]; then echo "FEHLER: node fehlt im Container"; exit 2; fi
echo "node:   $("$NODE_BIN" --version)"
echo "systemd: $(systemctl --version | head -n1)"

# --- Installation exakt wie das Deploy-Skript (gleiche Pfade, root-owned) -----
install -d -m 0755 /usr/local/lib/wireguard-ops-cockpit /usr/local/sbin
install -m 0755 /pkg/deploy/helpers/cockpit-capability-action /usr/local/lib/wireguard-ops-cockpit/cockpit-capability-action.mjs
install -m 0755 /pkg/deploy/helpers/cockpit-disk-action /usr/local/sbin/cockpit-disk-action

# --- Envelope-Secret (nur Testwert, keine Produktionsdaten) -------------------
install -d -m 0700 /etc/wireguard-ops-cockpit
printf 'COCKPIT_EXECUTION_ENVELOPE_SECRET=e2e-sandbox-secret\n' > /etc/wireguard-ops-cockpit/api.env
chmod 600 /etc/wireguard-ops-cockpit/api.env

# --- Harness ------------------------------------------------------------------
cat > /tmp/e2e-harness.mjs <<'JS'
// Fährt den installierten Runner (wie der Broker: node <runner>.mjs) mit
// signierten Envelopes und prüft die Disk-Helfer-Regeln auf echtem systemd.
import { createHash, createHmac } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const RUNNER = "/usr/local/lib/wireguard-ops-cockpit/cockpit-capability-action.mjs";
const HELPER = "/usr/local/sbin/cockpit-disk-action";
const secret = readFileSync("/etc/wireguard-ops-cockpit/api.env", "utf8").split(/\r?\n/)
  .find((line) => line.startsWith("COCKPIT_EXECUTION_ENVELOPE_SECRET=")).split("=").slice(1).join("=").trim();
const canonical = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

let failed = 0;
const check = (name, ok, detail = "") => {
  if (!ok) failed += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `\n      ${detail}` : ""}`);
};

function run(manifest, { approved = false } = {}) {
  const unsigned = {
    version: "hermes-execution-envelope/v1",
    jobId: `e2e-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
    expiresAt: new Date(Date.now() + 600000).toISOString(),
    capabilities: ["disk.manage", "read.host"],
    manifestHash: canonical(manifest),
    operatorApproved: approved,
  };
  const digest = createHmac("sha256", secret).update(JSON.stringify(unsigned)).digest("hex");
  const res = spawnSync(process.execPath, [RUNNER], {
    input: JSON.stringify({ manifest, envelope: { ...unsigned, digest } }),
    encoding: "utf8", timeout: 300000, maxBuffer: 8 * 1024 * 1024,
  });
  let parsed = null;
  try { parsed = JSON.parse(res.stdout); } catch { /* Fehlerpfad: kein JSON */ }
  return { status: res.status, out: parsed, stderr: (res.stderr || "").trim() };
}

const base = (steps, extra = {}) => ({
  version: "cockpit-capability/v1", name: "e2e-disk", purpose: "sandbox e2e",
  steps, readablePaths: [], writablePaths: [], network: "none",
  expectedEffects: [], verification: [], rollback: [], risk: ["contained"], ...extra,
});

// -- 1: Helfer-status im Sandbox (vor dem Fix: exit 67 "/proc/mdstat is not readable")
{
  const r = run(base([{ argv: [HELPER, "status"], timeoutSeconds: 60 }]));
  const step = r.out?.outputs?.[0];
  check("Runner: status läuft (kein 67, keine Envelope-Fehler)",
    r.status === 0 && r.out?.status === "success",
    `rc=${r.status} stderr=${r.stderr.slice(0, 200)} out=${JSON.stringify(r.out)?.slice(0, 200)}`);
  check("Helper: status liest die gebundene mdstat und antwortet ok:true",
    !!step && step.status === 0 && /"ok":true/.test(step.stdout || ""),
    `step=${JSON.stringify(step)?.slice(0, 260)}`);
}

// -- 2: remove/add werden vor jeder Ausführung verweigert
for (const verb of ["remove", "add"]) {
  const r = run(base([{ argv: [HELPER, verb, "sdb"], timeoutSeconds: 60 }]));
  check(`${verb} wird im Sandbox verweigert (Typed-Executor-Pfad)`,
    r.status === 77 && /typed executor path/.test(r.stderr),
    `rc=${r.status} stderr=${r.stderr.slice(0, 200)}`);
}

// -- 3: fremde Schritte bekommen keinen Disk-Grant
{
  const r = run(base([{ argv: ["/usr/bin/env"], timeoutSeconds: 30 }]));
  const out = r.out?.outputs?.[0]?.stdout || "";
  check("fremder Schritt: kein COCKPIT_DISK_ACTION_MDSTAT im Environment",
    r.status === 0 && !/COCKPIT_DISK_ACTION_MDSTAT/.test(out), `rc=${r.status}`);
  const r2 = run(base([{ argv: ["/bin/cat", "/run/mdstat"], timeoutSeconds: 30 }]));
  const step = r2.out?.outputs?.[0];
  check("fremder Schritt: /run/mdstat existiert nicht",
    r2.status !== 0 && /No such file/.test(`${step?.stderr || ""}${step?.stdout || ""}`),
    `rc=${r2.status} step=${JSON.stringify(step)?.slice(0, 200)}`);
}

// -- 4: deklariertes /proc/mdstat wird auf den neutralen Pfad normalisiert
{
  const r = run(base([{ argv: ["/bin/cat", "/run/mdstat"], timeoutSeconds: 30 }], { readablePaths: ["/proc/mdstat"] }));
  const out = r.out?.outputs?.[0]?.stdout || "";
  check("deklariertes /proc/mdstat: read-only unter /run/mdstat verfügbar",
    r.status === 0 && /Personalities/.test(out),
    `rc=${r.status} step=${JSON.stringify(r.out?.outputs?.[0])?.slice(0, 200)}`);
}

console.log(failed === 0 ? "\nE2E-Harness: alle Prüfungen bestanden" : `\nE2E-Harness: ${failed} Prüfung(en) fehlgeschlagen`);
process.exit(failed === 0 ? 0 : 1);
JS

"$NODE_BIN" /tmp/e2e-harness.mjs
rc=$?
echo
if [ "$rc" -eq 0 ]; then echo "INNEN-ERGEBNIS: GRUEN"; else echo "INNEN-ERGEBNIS: ROT (rc=$rc)"; fi
exit "$rc"
