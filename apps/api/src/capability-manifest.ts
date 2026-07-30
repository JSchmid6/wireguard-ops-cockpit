import { hashCanonical } from "./hermes-security.js";

export type CapabilityRisk = "contained" | "exposure" | "data_loss" | "identity_or_secret";

export interface CapabilityStep {
  argv: string[];
  cwd?: string;
  runAsUser?: string;
  timeoutSeconds?: number;
}

export interface CapabilityManifest {
  version: "cockpit-capability/v1";
  name: string;
  purpose: string;
  steps: CapabilityStep[];
  readablePaths: string[];
  writablePaths: string[];
  network: "none" | "local" | "outbound" | "host";
  expectedEffects: string[];
  verification: string[];
  rollback: string[];
  risk: CapabilityRisk[];
}

const MAX_STEPS = 24;
const MAX_ARGS = 64;

function cleanStrings(value: unknown, maximum: number, length = 1000): string[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, maximum).flatMap((item) => typeof item === "string" && item.trim()
    ? [item.trim().slice(0, length)] : []);
}

export function parseCapabilityManifest(plan: string): CapabilityManifest | null {
  const match = plan.match(/```(?:json\s+)?capability\s*\n([\s\S]*?)```/i)
    || plan.match(/```(?:json)?\s*\n([\s\S]*?"version"\s*:\s*"cockpit-capability\/v1"[\s\S]*?)```/i);
  const standalone = plan.trim();
  const manifestText = match?.[1] || (standalone.startsWith("{") && standalone.endsWith("}")
    && standalone.includes('"version":"cockpit-capability/v1"') ? standalone : null);
  if (!manifestText) return null;
  let raw: unknown;
  try { raw = JSON.parse(manifestText); } catch { throw new Error("capability manifest is not valid JSON"); }
  if (!raw || typeof raw !== "object") throw new Error("capability manifest must be an object");
  const value = raw as Record<string, unknown>;
  if (value.version !== "cockpit-capability/v1") throw new Error("unsupported capability manifest version");
  const name = typeof value.name === "string" ? value.name.trim().slice(0, 120) : "";
  const purpose = typeof value.purpose === "string" ? value.purpose.trim().slice(0, 2000) : "";
  if (!name || !purpose) throw new Error("capability manifest requires name and purpose");
  if (!Array.isArray(value.steps) || value.steps.length === 0 || value.steps.length > MAX_STEPS) throw new Error("capability manifest requires 1-24 steps");
  const steps = value.steps.map((candidate, index): CapabilityStep => {
    if (!candidate || typeof candidate !== "object") throw new Error(`capability step ${index + 1} is invalid`);
    const step = candidate as Record<string, unknown>;
    const argv = cleanStrings(step.argv, MAX_ARGS, 4000);
    if (!Array.isArray(step.argv) || argv.length !== step.argv.length || argv.length === 0) throw new Error(`capability step ${index + 1} requires string argv`);
    if (!argv[0].startsWith("/")) throw new Error(`capability step ${index + 1} executable must be absolute`);
    const cwd = typeof step.cwd === "string" ? step.cwd.trim() : undefined;
    if (cwd && !cwd.startsWith("/")) throw new Error(`capability step ${index + 1} cwd must be absolute`);
    const runAsUser = typeof step.runAsUser === "string" ? step.runAsUser.trim() : undefined;
    if (runAsUser && (!/^[a-z_][a-z0-9_-]{0,31}$/.test(runAsUser) || runAsUser === "root")) {
      throw new Error(`capability step ${index + 1} runAsUser must name a non-root local account`);
    }
    const timeoutSeconds = typeof step.timeoutSeconds === "number" && Number.isInteger(step.timeoutSeconds)
      ? Math.min(Math.max(step.timeoutSeconds, 1), 900) : 120;
    return { argv, ...(cwd ? { cwd } : {}), ...(runAsUser ? { runAsUser } : {}), timeoutSeconds };
  });
  const readablePaths = cleanStrings(value.readablePaths, 32, 1000);
  if (readablePaths.some((item) => !item.startsWith("/") || item.includes("\0"))) throw new Error("readable paths must be absolute");
  const writablePaths = cleanStrings(value.writablePaths, 32, 1000);
  if (writablePaths.some((item) => !item.startsWith("/") || item.includes("\0"))) throw new Error("writable paths must be absolute");
  const network = value.network === "local" || value.network === "outbound" || value.network === "host" ? value.network : "none";
  const validRisks = new Set<CapabilityRisk>(["contained", "exposure", "data_loss", "identity_or_secret"]);
  const risk = cleanStrings(value.risk, 4, 40).filter((item): item is CapabilityRisk => validRisks.has(item as CapabilityRisk));
  if (risk.length === 0) risk.push("contained");
  const manifest: CapabilityManifest = {
    version: "cockpit-capability/v1", name, purpose, steps,
    readablePaths: [...new Set(readablePaths)].sort(), writablePaths: [...new Set(writablePaths)].sort(), network,
    expectedEffects: cleanStrings(value.expectedEffects, 32), verification: cleanStrings(value.verification, 32),
    rollback: cleanStrings(value.rollback, 32), risk: [...new Set(risk)].sort(),
  };
  if (manifest.verification.length === 0) throw new Error("capability manifest requires verification criteria");
  return manifest;
}

export function capabilityManifestHash(manifest: CapabilityManifest): string {
  return hashCanonical(manifest);
}

export function capabilityNeedsOperatorApproval(manifest: CapabilityManifest): boolean {
  return manifest.network === "host" || manifest.risk.some((risk) => risk === "exposure" || risk === "data_loss" || risk === "identity_or_secret");
}

export function capabilityPlannerContract(): string {
  return [
    "For a change, include exactly one fenced `capability` JSON manifest using version cockpit-capability/v1.",
    "Render the complete manifest JSON on one physical line between the opening and closing fence. Do not pretty-print it: the unattended OpenCode console can omit brace-only and array-only display lines.",
    "Describe tools with direct absolute argv arrays, not shell syntax; discover current tool help/version before relying on unstable flags. Omit cwd unless host-directory visibility is essential.",
    "For a step that must run as a non-root service account, declare runAsUser instead of invoking sudo or runuser.",
    "For Nextcloud app lifecycle changes, use /usr/local/sbin/cockpit-nextcloud-app-action with php-install, php-enable, php-status, exapp-catalog-refresh, exapp-register, exapp-reinitialize, exapp-restart-reinitialize, or exapp-status plus a syntactically valid app id, runAsUser www-data, outbound network, and empty readablePaths/writablePaths. The helper supplies its fixed internal scopes; never guess apps-external or other implementation paths. exapp-catalog-refresh resets only the regenerable AppAPI app-store catalog through Nextcloud AppData and immediately refetches it. exapp-reinitialize repeats the supported initialization and enable handshake of an already registered ExApp without unregistering it or recreating its container or persistent volume. exapp-restart-reinitialize first performs a supported AppAPI stop/start to reset failed child processes, then repeats initialization; it still does not unregister, recreate, update, or delete the app or volume. This semantic helper intentionally offers no disable, uninstall, or arbitrary occ action; the stop/start exists only as an inseparable part of bounded recovery.",
    "For a bounded Nextcloud Context Chat end-to-end check, use /usr/local/sbin/cockpit-nextcloud-context-action with create-test, inspect-test, stats, search-test, or prompt-test plus a syntactically valid user id and unique lowercase marker, runAsUser www-data, outbound network, and empty readablePaths/writablePaths. create-test writes only a new non-overwriting text file below Cockpit E2E Tests through the Nextcloud Files API; inspect-test reports that exact marker file's path, id, and size without changing it; the other modes expose only fixed Context Chat commands and prompts. File evidence is duplicated to stderr because the Nextcloud bootstrap may consume stdout. The helper intentionally offers no arbitrary path, content, deletion, or occ command.",
    "For installing the reviewed FullDialog Hermes skill, use /bin/sh /usr/local/lib/wireguard-ops-cockpit/cockpit-hermes-skill-action install present-work-view with no runAsUser, no network, and empty readablePaths/writablePaths. The fixed root-owned helper requires the reviewed source tree, refuses an existing target, installs exactly three allowlisted files as hermes, and verifies hashes. Only after explicit operator approval to remove the known empty failed-install directories, use one manifest containing exactly two ordered steps: remove-empty-target present-work-view followed by install present-work-view. The first rejects any unexpected entry and removes only those two empty directories with rmdir as root; the second runs as Hermes through the semantic executor boundary and installs the three files without privileged ownership syscalls.",
    "For deploying the reviewed Email Archive source, use /bin/sh /usr/local/lib/wireguard-ops-cockpit/cockpit-email-archive-deploy build-push 63f39b2 with no runAsUser, outbound network, and empty readablePaths/writablePaths. The helper verifies the exact clean source commit, builds only the fixed private-registry tags, pushes them, and performs no container/volume deletion or public-port operation. This helper always requires operator approval. Follow it with the supported exapp-restart-reinitialize and exapp-status actions for email_archive.",
    "For changing GitLab's restricted rootless DinD service policy, use /usr/bin/python3 /usr/local/lib/wireguard-ops-cockpit/cockpit-gitlab-runner-rootless-dind enable|disable with readablePaths and writablePaths both set exactly to /etc/gitlab-runner/config.toml, network none, and risk identity_or_secret. The helper always preserves privileged=false for jobs. Enable adds only services_privileged=true and the four reviewed docker:*dind-rootless allowlist patterns. Disable removes only those two exact settings and refuses any conflicting policy. The Email Archive pipeline now uses daemonless Kaniko, so the production target state is disabled.",
    "Declare minimal readablePaths for read-only host visibility and only exact writablePaths that must change. Do not duplicate a writable path in readablePaths: write authority already implies reading that exact file, and the executor normalizes accidental overlap to the writable bind. Set network to none, local (host loopback only, no listening), outbound, or host.",
    "To replace known content in an authorized exact regular file, invoke /usr/local/sbin/cockpit-exact-file-replace directly with the absolute target, exact old text, and exact new text, and omit runAsUser. The installed executable selects its pinned runtime itself: never copy it, wrap it with another interpreter, create a temporary helper, or request root as runAsUser. The target must also be the same entry in writablePaths. This writes the existing inode so it works inside the exact-file bind mount, requires exactly one old-text match, and relies on the executor snapshot for rollback. Do not use rename-based in-place editors such as sed -i on exact-file mounts.",
    "Risk values are contained, exposure, data_loss, identity_or_secret. Never understate risk.",
    "Include observable expectedEffects, independent verification criteria, and a concrete rollback procedure.",
    "Example shape: {\"version\":\"cockpit-capability/v1\",\"name\":\"...\",\"purpose\":\"...\",\"steps\":[{\"argv\":[\"/usr/bin/tool\",\"arg\"],\"runAsUser\":\"service-user\"}],\"readablePaths\":[],\"writablePaths\":[],\"network\":\"none\",\"expectedEffects\":[],\"verification\":[],\"rollback\":[],\"risk\":[\"contained\"]}",
  ].join("\n");
}
