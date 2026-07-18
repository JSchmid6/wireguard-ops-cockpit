import { hashCanonical } from "./hermes-security.js";

export type CapabilityRisk = "contained" | "exposure" | "data_loss" | "identity_or_secret";

export interface CapabilityStep {
  argv: string[];
  cwd?: string;
  timeoutSeconds?: number;
}

export interface CapabilityManifest {
  version: "cockpit-capability/v1";
  name: string;
  purpose: string;
  steps: CapabilityStep[];
  writablePaths: string[];
  network: "none" | "outbound" | "host";
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
    || plan.match(/```json\s*\n([\s\S]*?"version"\s*:\s*"cockpit-capability\/v1"[\s\S]*?)```/i);
  if (!match) return null;
  let raw: unknown;
  try { raw = JSON.parse(match[1]); } catch { throw new Error("capability manifest is not valid JSON"); }
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
    const timeoutSeconds = typeof step.timeoutSeconds === "number" && Number.isInteger(step.timeoutSeconds)
      ? Math.min(Math.max(step.timeoutSeconds, 1), 900) : 120;
    return { argv, ...(cwd ? { cwd } : {}), timeoutSeconds };
  });
  const writablePaths = cleanStrings(value.writablePaths, 32, 1000);
  if (writablePaths.some((item) => !item.startsWith("/") || item.includes("\0"))) throw new Error("writable paths must be absolute");
  const network = value.network === "outbound" || value.network === "host" ? value.network : "none";
  const validRisks = new Set<CapabilityRisk>(["contained", "exposure", "data_loss", "identity_or_secret"]);
  const risk = cleanStrings(value.risk, 4, 40).filter((item): item is CapabilityRisk => validRisks.has(item as CapabilityRisk));
  if (risk.length === 0) risk.push("contained");
  const manifest: CapabilityManifest = {
    version: "cockpit-capability/v1", name, purpose, steps, writablePaths: [...new Set(writablePaths)].sort(), network,
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
    "Describe tools with direct absolute argv arrays, not shell syntax; discover current tool help/version before relying on unstable flags. Omit cwd unless host-directory visibility is essential.",
    "Declare only paths that must change. Set network to none, outbound, or host.",
    "Risk values are contained, exposure, data_loss, identity_or_secret. Never understate risk.",
    "Include observable expectedEffects, independent verification criteria, and a concrete rollback procedure.",
    "Example shape: {\"version\":\"cockpit-capability/v1\",\"name\":\"...\",\"purpose\":\"...\",\"steps\":[{\"argv\":[\"/usr/bin/tool\",\"arg\"]}],\"writablePaths\":[],\"network\":\"none\",\"expectedEffects\":[],\"verification\":[],\"rollback\":[],\"risk\":[\"contained\"]}",
  ].join("\n");
}
