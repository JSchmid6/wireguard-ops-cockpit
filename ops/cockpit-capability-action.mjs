#!/usr/bin/node
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync, copyFileSync, renameSync, rmSync, statfsSync } from "node:fs";
import { dirname, normalize, resolve } from "node:path";
import { spawnSync } from "node:child_process";

function fail(message, code = 64) { process.stderr.write(`${message}\n`); process.exit(code); }
function canonicalHash(value) { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
function readSecret() {
  const env = readFileSync("/etc/wireguard-ops-cockpit/api.env", "utf8");
  const line = env.split(/\r?\n/).find((item) => item.startsWith("COCKPIT_EXECUTION_ENVELOPE_SECRET="));
  if (!line) fail("execution authority is unavailable", 78);
  return line.slice(line.indexOf("=") + 1).replace(/^['"]|['"]$/g, "");
}
function verifyEnvelope(envelope, manifest) {
  if (!envelope || envelope.version !== "hermes-execution-envelope/v1" || typeof envelope.digest !== "string") fail("invalid execution envelope");
  const { digest, ...unsigned } = envelope;
  const expected = createHmac("sha256", readSecret()).update(JSON.stringify(unsigned)).digest("hex");
  if (!/^[a-f0-9]{64}$/.test(digest) || !timingSafeEqual(Buffer.from(digest, "hex"), Buffer.from(expected, "hex"))) fail("execution envelope signature mismatch", 77);
  if (Date.now() > Date.parse(envelope.expiresAt)) fail("execution envelope expired", 77);
  if (envelope.manifestHash !== canonicalHash(manifest)) fail("capability manifest drift", 77);
}

let input = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) { input += chunk; if (input.length > 524288) fail("capability request too large"); }
let request;
try { request = JSON.parse(input); } catch { fail("invalid capability request JSON"); }
const { manifest, envelope } = request || {};
verifyEnvelope(envelope, manifest);
if (!/^[a-zA-Z0-9_.-]{1,128}$/.test(envelope.jobId || "")) fail("invalid envelope job id");
const MANIFEST_VERSIONS = new Set(["cockpit-capability/v1", "cockpit-capability/v2"]);
if (!manifest || !MANIFEST_VERSIONS.has(manifest.version) || !Array.isArray(manifest.steps) || manifest.steps.length < 1 || manifest.steps.length > 24) fail("invalid capability manifest");
const isV2 = manifest.version === "cockpit-capability/v2";

const forbiddenRootsEarly = new Set(["/", "/bin", "/boot", "/dev", "/etc", "/home", "/lib", "/lib64", "/opt", "/proc", "/root", "/run", "/sbin", "/sys", "/usr", "/var"]);
const protectedPathEarly = /(?:^|\/)(?:\.ssh|sudoers(?:\.d)?|shadow|gshadow|passwd|group|ssh|wireguard|secrets?|credentials?|private|keys?)(?:\/|$)|\.(?:key|pem|p12|env|db|sqlite3?)$|^\/(?:opt\/nextcloud|opt\/gitlab|var\/www\/nextcloud\/config|var\/lib\/wireguard-ops-cockpit)(?:\/|$)/i;
const approved = envelope.operatorApproved === true;
const risky = new Set(["exposure", "data_loss", "identity_or_secret"]);

// ── Snapshot-Anbieter ──────────────────────────────────────────────────────
// Ein Anbieter darf nur dann Autonomie begründen, wenn er sichern, pruefen UND
// zurueckspielen kann. Fehlt eines davon, ist es kein Anbieter, sondern eine
// Absichtserklaerung — und dann entscheidet der Operator.
const TREE_MAX_BYTES = 4 * 1024 * 1024 * 1024;

function dirBytes(target) {
  const out = spawnSync("/usr/bin/du", ["-sb", "--", target], { encoding: "utf8", timeout: 120000, maxBuffer: 1024 * 1024 });
  if (out.status !== 0) fail(`cannot size ${target}`, 77);
  return Number.parseInt(out.stdout.split(/\s+/)[0], 10) || 0;
}

function snapshotTree(target, backupDir, index) {
  const bytes = dirBytes(target);
  const limit = TREE_MAX_BYTES;
  if (bytes > limit) fail(`tree scope is too large for an automatic snapshot: ${target} (${bytes} bytes)`, 77);
  // Platz pruefen, BEVOR gesichert wird: ein Snapshot, der mitten im tar am
  // vollen Dateisystem scheitert, ist schlimmer als gar keiner.
  const free = statfsSync(backupDir);
  const available = free.bavail * free.bsize;
  if (available < bytes * 1.2) fail(`not enough free space to snapshot ${target}: need ~${Math.round(bytes * 1.2)}, have ${available}`, 77);

  const archive = `${backupDir}/${index}.tar.gz`;
  const parent = dirname(target);
  const base = target.split("/").at(-1);
  const created = spawnSync("/usr/bin/tar", ["-czf", archive, "-C", parent, base], { encoding: "utf8", timeout: 1800000, maxBuffer: 4 * 1024 * 1024 });
  if (created.status !== 0) fail(`snapshot of ${target} failed: ${(created.stderr || "").slice(-400)}`, 70);
  // Lesbarkeit pruefen. Ein unverifizierter Snapshot ist kein Snapshot.
  const listed = spawnSync("/usr/bin/tar", ["-tzf", archive], { encoding: "utf8", timeout: 900000, maxBuffer: 4 * 1024 * 1024 });
  if (listed.status !== 0 || !(listed.stdout || "").trim()) fail(`snapshot of ${target} did not verify`, 70);
  return { kind: "tree", target, backup: archive, existed: true, bytes };
}

function restoreTree(item) {
  // Erst in ein Zwischenverzeichnis entpacken, dann tauschen: ein tar, das auf
  // halber Strecke scheitert, darf den lebenden Baum nicht zerlegen.
  const parent = dirname(item.target);
  const base = item.target.split("/").at(-1);
  const staging = `${parent}/.cockpit-restore.${process.pid}`;
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true, mode: 0o700 });
  const extracted = spawnSync("/usr/bin/tar", ["-xzf", item.backup, "-C", staging], { encoding: "utf8", timeout: 1800000, maxBuffer: 4 * 1024 * 1024 });
  if (extracted.status !== 0) { rmSync(staging, { recursive: true, force: true }); throw new Error(`extract failed: ${(extracted.stderr || "").slice(-300)}`); }
  const previous = `${parent}/.cockpit-previous.${process.pid}`;
  rmSync(previous, { recursive: true, force: true });
  renameSync(item.target, previous);
  renameSync(`${staging}/${base}`, item.target);
  rmSync(staging, { recursive: true, force: true });
  rmSync(previous, { recursive: true, force: true });
}

// ── Scopes (v2) ────────────────────────────────────────────────────────────
const scopeList = isV2 && Array.isArray(manifest.scopes) ? manifest.scopes : [];
if (scopeList.length > 8) fail("too many scopes");
const treeScopes = [];
for (const scope of scopeList) {
  if (!scope || typeof scope !== "object") fail("invalid scope");
  if (scope.kind !== "tree") fail(`unsupported scope kind: ${scope.kind}`, 77);
  if (typeof scope.path !== "string" || !scope.path.startsWith("/") || scope.path.includes("\0")) fail("invalid tree scope path");
  const resolved = realpathSync(normalize(scope.path));
  if (forbiddenRootsEarly.has(resolved)) fail(`tree scope is too broad: ${resolved}`, 77);
  if (!approved && protectedPathEarly.test(resolved)) fail(`protected path requires operator approval: ${resolved}`, 77);
  if (!existsSync(resolved) || !lstatSync(resolved).isDirectory()) fail(`tree scope must be an existing directory: ${resolved}`, 77);
  treeScopes.push(resolved);
}
// Ueberschneidungen verbieten: zwei Scopes, die einander enthalten, machen die
// Reihenfolge des Zurueckspielens bedeutsam — und damit das Ergebnis unklar.
for (const a of treeScopes) for (const b of treeScopes) {
  if (a !== b && (a === b || a.startsWith(`${b}/`))) fail(`tree scopes overlap: ${a} inside ${b}`, 77);
}

// Autonomie wird BERECHNET, nicht geglaubt: sie gilt, wenn jeder schreibende
// Bereich von einem Anbieter gedeckt ist, der auch zurueckspielen kann. Ein
// Manifest, das `contained` behauptet, ohne Scopes zu deklarieren, bekommt
// deshalb keine Freiheit, sondern eine Freigabepflicht.
const declaredRisky = (manifest.risk || []).some((item) => risky.has(item));
const rollbackGuaranteed = isV2 && treeScopes.length > 0;
if (!approved && manifest.network === "host") fail("operator approval is required for host networking", 77);
if (!approved && declaredRisky && !rollbackGuaranteed) fail("operator approval is required for exposure, data-loss, identity, or secret risk", 77);

const forbiddenRoots = forbiddenRootsEarly;
const _unusedForbidden = new Set(["/", "/bin", "/boot", "/dev", "/etc", "/home", "/lib", "/lib64", "/opt", "/proc", "/root", "/run", "/sbin", "/sys", "/usr", "/var"]);
const protectedPath = protectedPathEarly;
const _unusedProtected = /(?:^|\/)(?:\.ssh|sudoers(?:\.d)?|shadow|gshadow|passwd|group|ssh|wireguard|secrets?|credentials?|private|keys?)(?:\/|$)|\.(?:key|pem|p12|env|db|sqlite3?)$|^\/(?:opt\/nextcloud|opt\/gitlab|var\/www\/nextcloud\/config|var\/lib\/wireguard-ops-cockpit)(?:\/|$)/i;
const paths = Array.isArray(manifest.writablePaths) ? manifest.writablePaths : [];
const readPaths = Array.isArray(manifest.readablePaths) ? manifest.readablePaths : [];
if (readPaths.length > 32) fail("too many readable paths");
const readablePaths = readPaths.map((item) => {
  if (typeof item !== "string" || !item.startsWith("/") || item.includes("\0")) fail("invalid readable path");
  const resolved = realpathSync(normalize(item));
  if (forbiddenRoots.has(resolved)) fail(`readable scope is too broad: ${resolved}`, 77);
  return resolved;
});
if (paths.length > 32) fail("too many writable paths");
const writablePaths = paths.map((item) => {
  if (typeof item !== "string" || !item.startsWith("/") || item.includes("\0")) fail("invalid writable path");
  const clean = normalize(item);
  if (forbiddenRoots.has(clean)) fail(`writable scope is too broad: ${clean}`, 77);
  const parent = existsSync(clean) ? realpathSync(dirname(clean)) : realpathSync(dirname(clean));
  const resolved = resolve(parent, clean.split("/").at(-1));
  if (!resolved.startsWith(`${parent}/`)) fail("writable path escapes its parent");
  if (!approved && protectedPath.test(resolved)) fail(`protected path requires operator approval: ${resolved}`, 77);
  if (!existsSync(resolved)) fail(`writable target must already exist so it can be snapshotted: ${resolved}`, 77);
  const stat = lstatSync(resolved);
  if (!stat.isFile()) fail(`autonomous writable scope must be an exact regular file: ${resolved}`, 77);
  if (stat.size > 10 * 1024 * 1024) fail(`writable file is too large for automatic snapshot: ${resolved}`, 77);
  return resolved;
});

const dangerousExecutable = /\/(?:rm|shred|dd|mkfs(?:\.[^/]*)?|fdisk|parted|iptables|nft|ufw|ip|wg|wg-quick|useradd|userdel|usermod|groupadd|groupdel|passwd|visudo|sudo|runuser|su)$/;
const nextcloudAppHelper = "/usr/local/sbin/cockpit-nextcloud-app-action";
const nextcloudContextHelper = "/usr/local/sbin/cockpit-nextcloud-context-action";
const exactFileReplaceHelper = "/usr/local/sbin/cockpit-exact-file-replace";
const hermesSkillHelper = "/usr/local/lib/wireguard-ops-cockpit/cockpit-hermes-skill-action";
const emailArchiveDeployHelper = "/usr/local/lib/wireguard-ops-cockpit/cockpit-email-archive-deploy";
const readOnlyContainerCommands = new Set(["ps", "inspect", "version", "info"]);
function stepNeedsApproval(step) {
  const executable = step?.argv?.[0] || "";
  if (executable === "/bin/sh" && step?.argv?.[1] === emailArchiveDeployHelper) return true;
  if (executable === "/bin/sh" && step?.argv?.[1] === hermesSkillHelper && step?.argv?.[2] === "remove-empty-target") return true;
  if (dangerousExecutable.test(executable)) return true;
  if (/\/(?:docker|podman)$/.test(executable)) return !readOnlyContainerCommands.has(step?.argv?.[1] || "");
  return false;
}
if (!approved && manifest.steps.some(stepNeedsApproval)) fail("requested operation can cause exposure or irreversible loss and requires operator approval", 77);

const backupRoot = `/var/lib/wireguard-ops-cockpit/capability-snapshots/${envelope.jobId}`;
mkdirSync(backupRoot, { recursive: true, mode: 0o700 });
const snapshot = [];
for (const [index, target] of writablePaths.entries()) {
  if (existsSync(target)) {
    const backup = `${backupRoot}/${index}`; copyFileSync(target, backup); snapshot.push({ kind: "file", target, backup, existed: true });
  } else snapshot.push({ kind: "file", target, backup: null, existed: false });
}
for (const [index, target] of treeScopes.entries()) {
  snapshot.push(snapshotTree(target, backupRoot, `tree-${index}`));
}
writeFileSync(`${backupRoot}/manifest.json`, JSON.stringify({ manifest, snapshot }, null, 2), { mode: 0o600 });

const outputs = [];
for (const [index, step] of manifest.steps.entries()) {
  if (!step || !Array.isArray(step.argv) || step.argv.length < 1 || step.argv.length > 64 || step.argv.some((arg) => typeof arg !== "string" || arg.includes("\0"))) fail(`invalid step ${index + 1}`);
  if (!step.argv[0].startsWith("/") || !existsSync(step.argv[0])) fail(`step ${index + 1} executable is unavailable`);
  if (step.argv[0] === exactFileReplaceHelper && (step.argv.length !== 4 || !writablePaths.includes(resolve(step.argv[1])))) {
    fail(`step ${index + 1} exact-file replacement target must be an authorized writable file`, 77);
  }
  const runAsUser = typeof step.runAsUser === "string" ? step.runAsUser : "";
  if (runAsUser && (!/^[a-z_][a-z0-9_-]{0,31}$/.test(runAsUser) || runAsUser === "root")) fail(`step ${index + 1} has invalid runAsUser`);
  const isHermesSkillStep = step.argv[0] === "/bin/sh" && step.argv[1] === hermesSkillHelper;
  const isEmailArchiveDeployStep = step.argv[0] === "/bin/sh" && step.argv[1] === emailArchiveDeployHelper;
  const properties = [
    "--property=Type=exec", "--property=NoNewPrivileges=yes", "--property=PrivateTmp=yes", "--property=TemporaryFileSystem=/:ro",
    `--property=ProtectHome=${isHermesSkillStep ? "read-only" : "yes"}`, "--property=ProtectKernelTunables=yes", "--property=ProtectKernelModules=yes", "--property=ProtectControlGroups=yes",
    "--property=RestrictSUIDSGID=yes", "--property=LockPersonality=yes", "--property=RestrictRealtime=yes", "--property=PrivateDevices=yes",
    "--property=CapabilityBoundingSet=CAP_DAC_OVERRIDE CAP_CHOWN CAP_FOWNER",
    "--property=RestrictNamespaces=yes", "--property=ProtectProc=invisible", "--property=ProcSubset=pid",
    "--property=SystemCallFilter=~@mount @swap @reboot @raw-io @privileged",
    "--property=BindReadOnlyPaths=/usr /bin /lib /lib64 /etc/ld.so.cache /etc/alternatives",
    ...readablePaths.filter((item) => !writablePaths.includes(item)).map((item) => `--property=BindReadOnlyPaths=${item}`),
    ...writablePaths.map((item) => `--property=BindPaths=${item}`),
      ...treeScopes.map((item) => `--property=BindPaths=${item}`),
  ];
  if (step.argv[0] === nextcloudAppHelper || step.argv[0] === nextcloudContextHelper) {
    if (runAsUser !== "www-data") fail(`step ${index + 1} Nextcloud action must run as www-data`, 77);
    if (manifest.network !== "outbound") fail(`step ${index + 1} Nextcloud action requires outbound-only network scope`, 77);
    properties.push(
      "--property=BindReadOnlyPaths=/run/mysqld",
      "--property=BindReadOnlyPaths=/run/clamav:/var/run/clamav",
      "--property=BindReadOnlyPaths=/etc/php",
      "--property=BindReadOnlyPaths=/var/www/nextcloud",
      "--property=BindPaths=/var/www/nextcloud/apps",
      "--property=BindPaths=/var/www/nextcloud/config",
      "--property=BindPaths=/opt/nextcloud",
    );
  }
  if (isHermesSkillStep) {
    const skillAction = step.argv[2];
    if (step.argv.length !== 4 || !["install", "remove-empty-target"].includes(skillAction) || step.argv[3] !== "present-work-view" || runAsUser) {
      fail(`step ${index + 1} has an invalid Hermes skill action`, 77);
    }
    properties.push(
      "--property=BindReadOnlyPaths=/home/hermes/.hermes/interface-app-4-ai-agents/tools/hermes-skills/present-work-view",
      "--property=BindPaths=/home/hermes/.hermes/skills",
    );
    if (skillAction === "install") properties.push("--property=User=1007", "--property=Group=1007");
  }
  if (isEmailArchiveDeployStep) {
    if (step.argv.length !== 4 || step.argv[2] !== "build-push" || step.argv[3] !== "63f39b2" || runAsUser) {
      fail(`step ${index + 1} has an invalid Email Archive deployment action`, 77);
    }
    if (manifest.network !== "outbound") fail(`step ${index + 1} Email Archive deployment requires outbound-only network`, 77);
    properties.push(
      "--property=ProtectHome=read-only",
      "--property=BindReadOnlyPaths=/home/hermes/.hermes/email-archive",
      "--property=BindPaths=/var/run/docker.sock",
    );
  }
  if (runAsUser) properties.push(`--property=User=${runAsUser}`);
  if (manifest.network === "none") properties.push("--property=PrivateNetwork=yes", "--property=RestrictAddressFamilies=AF_UNIX");
  if (manifest.network === "local") properties.push(
    "--property=RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6", "--property=SocketBindDeny=any",
    "--property=IPAddressDeny=any", "--property=IPAddressAllow=localhost",
    ...["/etc/nsswitch.conf", "/etc/hosts"].filter((item) => !writablePaths.includes(item)).map((item) => `--property=BindReadOnlyPaths=${item}`),
  );
  if (manifest.network === "outbound") properties.push(
    "--property=RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6", "--property=SocketBindDeny=any",
    ...["/etc/resolv.conf", "/etc/nsswitch.conf", "/etc/hosts", "/etc/ssl/certs", "/etc/ca-certificates.conf"]
      .filter((item) => !writablePaths.includes(item))
      .map((item) => `--property=BindReadOnlyPaths=${item}`),
  );
  if (manifest.network === "host") properties.push("--property=RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6");
  if (step.cwd) {
    const cwd = realpathSync(step.cwd);
    if (!approved && cwd !== "/tmp" && cwd !== "/var/tmp") fail(`host working-directory access requires operator approval; use direct paths for contained execution: ${cwd}`, 77);
    if (approved) properties.push(`--property=BindReadOnlyPaths=${cwd}`);
    properties.push(`--working-directory=${cwd}`);
  }
  const requestedTimeout = Number.isInteger(step.timeoutSeconds) ? Math.min(Math.max(step.timeoutSeconds, 1), 900) : 120;
  const timeout = step.argv[0] === nextcloudAppHelper && step.argv[1] === "exapp-register"
    ? 3000
    : step.argv[0] === nextcloudAppHelper || step.argv[0] === nextcloudContextHelper ? Math.max(requestedTimeout, 900) : requestedTimeout;
  const result = spawnSync("/usr/bin/systemd-run", ["--wait", "--pipe", "--collect", "--quiet", `--property=TimeoutStartSec=${timeout}`, ...properties, "--", ...step.argv], {
    encoding: "utf8", timeout: (timeout + 10) * 1000, maxBuffer: 1024 * 1024, env: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin", LANG: "C.UTF-8" },
  });
  outputs.push({ step: index + 1, argv: step.argv, status: result.status, stdout: (result.stdout || "").slice(-12000), stderr: (result.stderr || "").slice(-4000) });
  if (result.status !== 0) {
    const rollbackErrors = [];
    for (const item of snapshot) {
      if (!item.existed || !item.backup) continue;
      try {
        if (item.kind === "tree") restoreTree(item);
        else copyFileSync(item.backup, item.target);
      } catch (error) { rollbackErrors.push({ target: item.target, error: error instanceof Error ? error.message : String(error) }); }
    }
    process.stdout.write(JSON.stringify({
      status: rollbackErrors.length === 0 ? "failed_rolled_back" : "failed_rollback_incomplete",
      snapshot: backupRoot, outputs, rollbackErrors,
    }));
    process.exit(result.status || 1);
  }
}
process.stdout.write(JSON.stringify({ status: "success", snapshot: backupRoot, outputs }));
