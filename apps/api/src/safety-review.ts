import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import type { ExecutionReview, ExecutionRiskClass, PlanReviewVerdict, RunbookDefinition } from "@wireguard-ops-cockpit/domain";
import type { AppConfig } from "./config.js";

type SafetyVerdict = Extract<PlanReviewVerdict, "passed" | "approval_required" | "blocked">;

const REVIEW_SCHEMA_VERSION = "runbook-safety-review/v1";
const PARSER_VERSION = "line-schema/v1";
const COPILOT_TIMEOUT_MS = 30_000;
const SECRET_ENV_VARS = [
  "COCKPIT_ADMIN_PASSWORD",
  "COCKPIT_TERMINAL_SIGNING_SECRET"
].join(",");

export interface RunbookSafetyReviewInput {
  runbook: RunbookDefinition;
  runbookVersionHash: string;
  riskClass: ExecutionRiskClass;
  sessionId: string | null;
  trigger: "manual" | "scheduled";
  scheduleId: string | null;
}

export type SafetyReviewRuntimeConfig = Pick<
  AppConfig,
  "repoRoot" | "plannerRuntime" | "copilotExecutable" | "copilotModel"
>;

export type SafetyReviewRunner = (
  input: RunbookSafetyReviewInput,
  runtime: SafetyReviewRuntimeConfig
) => Promise<ExecutionReview>;

interface ParsedSafetyReport {
  verdict: SafetyVerdict;
  summary: string;
  hazards: string[];
  blastRadius: string;
  expectedImpact: string;
  rollbackHint: string;
  operatorChecks: string[];
}

interface CopilotReviewResult {
  stdout: string;
  exitCode: number;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  model: string | null;
}

export function buildRunbookSafetyPrompt(input: RunbookSafetyReviewInput): string {
  return [
    "You are the safety-agent for wireguard-ops-cockpit.",
    "Review only the provided allowlisted runbook metadata.",
    "Do not ask to inspect the repository, files, tmux sessions, terminals, logs, or the host.",
    "Do not execute commands and do not propose arbitrary shell access.",
    "Return exactly these seven lines and nothing else:",
    "VERDICT: passed|approval_required|blocked",
    "SUMMARY: <one sentence>",
    "HAZARDS: <item 1 | item 2 | item 3 or none>",
    "BLAST_RADIUS: <short phrase>",
    "EXPECTED_IMPACT: <short phrase>",
    "ROLLBACK_HINT: <short phrase>",
    "OPERATOR_CHECKS: <item 1 | item 2 | item 3 or none>",
    "Runbook metadata:",
    JSON.stringify(buildPromptPayload(input))
  ].join("\n");
}

export function parseRunbookSafetyOutput(output: string): ParsedSafetyReport {
  const sanitized = output
    .trim()
    .replace(/^```(?:text)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();
  const lines = sanitized
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length !== 7) {
    throw new Error(`expected 7 non-empty lines, received ${lines.length}`);
  }

  const values = new Map<string, string>();
  for (const line of lines) {
    const separator = line.indexOf(":");
    if (separator <= 0) {
      throw new Error(`invalid review line: ${line}`);
    }
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    values.set(key, value);
  }

  const verdict = values.get("VERDICT");
  const summary = values.get("SUMMARY");
  const hazards = values.get("HAZARDS");
  const blastRadius = values.get("BLAST_RADIUS");
  const expectedImpact = values.get("EXPECTED_IMPACT");
  const rollbackHint = values.get("ROLLBACK_HINT");
  const operatorChecks = values.get("OPERATOR_CHECKS");

  if (!verdict || !summary || !hazards || !blastRadius || !expectedImpact || !rollbackHint || !operatorChecks) {
    throw new Error("missing one or more required safety review lines");
  }

  if (verdict !== "passed" && verdict !== "approval_required" && verdict !== "blocked") {
    throw new Error(`invalid verdict ${verdict}`);
  }

  return {
    verdict,
    summary: clampText(summary, 240),
    hazards: parseList(hazards),
    blastRadius: clampText(blastRadius, 160),
    expectedImpact: clampText(expectedImpact, 200),
    rollbackHint: clampText(rollbackHint, 200),
    operatorChecks: parseList(operatorChecks)
  };
}

export async function generateRunbookSafetyReview(
  input: RunbookSafetyReviewInput,
  runtime: SafetyReviewRuntimeConfig
): Promise<ExecutionReview> {
  if (runtime.plannerRuntime === "demo-local") {
    return createSyntheticReview(input);
  }

  const prompt = buildRunbookSafetyPrompt(input);
  const inputHash = hashValue(prompt);

  try {
    const runtimeResult = await runCopilotSafetyReview(prompt, runtime);
    const parsed = parseRunbookSafetyOutput(runtimeResult.stdout);
    const effectiveVerdict = resolveEffectiveVerdict(parsed.verdict, input.runbook.requiresApproval);

    return {
      actorId: "safety-agent",
      verdict: effectiveVerdict,
      summary:
        effectiveVerdict === "approval_required" && parsed.verdict === "passed" && input.runbook.requiresApproval
          ? `${parsed.summary} Human approval stays mandatory because this runbook requests a privileged helper.`
          : parsed.summary,
      details: {
        schemaVersion: REVIEW_SCHEMA_VERSION,
        source: "copilot-cli",
        parserVersion: PARSER_VERSION,
        parseStatus: "ok",
        runbookId: input.runbook.id,
        runbookVersionHash: input.runbookVersionHash,
        scriptIds: input.runbook.scriptIds,
        integration: input.runbook.integration,
        requiresApproval: input.runbook.requiresApproval,
        privilegedHelperRequested: input.runbook.privilegedHelperRequested,
        sessionId: input.sessionId,
        trigger: input.trigger,
        scheduleId: input.scheduleId,
        riskClass: input.riskClass,
        hazards: parsed.hazards,
        blastRadius: parsed.blastRadius,
        expectedImpact: parsed.expectedImpact,
        rollbackHint: parsed.rollbackHint,
        operatorChecks: parsed.operatorChecks,
        model: runtimeResult.model,
        exitCode: runtimeResult.exitCode,
        startedAt: runtimeResult.startedAt,
        completedAt: runtimeResult.completedAt,
        durationMs: runtimeResult.durationMs,
        inputHash,
        outputHash: hashValue(runtimeResult.stdout),
        modelVerdict: parsed.verdict,
        effectiveVerdict
      }
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : "unknown safety review failure";
    return createFailedReview(input, inputHash, reason);
  }
}

function buildPromptPayload(input: RunbookSafetyReviewInput) {
  return {
    runbookId: input.runbook.id,
    runbookVersionHash: input.runbookVersionHash,
    scriptIds: input.runbook.scriptIds,
    integration: input.runbook.integration,
    requiresApproval: input.runbook.requiresApproval,
    privilegedHelperRequested: input.runbook.privilegedHelperRequested,
    riskClass: input.riskClass,
    trigger: input.trigger,
    scheduleId: input.scheduleId
  };
}

function createSyntheticReview(input: RunbookSafetyReviewInput): ExecutionReview {
  const verdict: ExecutionReview["verdict"] = input.runbook.requiresApproval ? "approval_required" : "passed";

  return {
    actorId: "safety-agent",
    verdict,
    summary: input.runbook.requiresApproval
      ? `Safety review kept ${input.runbook.name} behind human approval because the allowlisted helper can mutate host state.`
      : `Safety review kept ${input.runbook.name} inside the bounded allowlisted contract.`,
    details: {
      schemaVersion: REVIEW_SCHEMA_VERSION,
      source: "demo-local",
      parserVersion: PARSER_VERSION,
      parseStatus: "synthetic",
      runbookId: input.runbook.id,
      runbookVersionHash: input.runbookVersionHash,
      scriptIds: input.runbook.scriptIds,
      integration: input.runbook.integration,
      requiresApproval: input.runbook.requiresApproval,
      privilegedHelperRequested: input.runbook.privilegedHelperRequested,
      sessionId: input.sessionId,
      trigger: input.trigger,
      scheduleId: input.scheduleId,
      riskClass: input.riskClass,
      hazards: input.runbook.privilegedHelperRequested
        ? ["Privileged helper execution can change host state."]
        : ["Low-risk diagnostics still rely on operator review of the resulting session output."],
      blastRadius: input.runbook.privilegedHelperRequested ? "single host service scope" : "single task session",
      expectedImpact: input.runbook.privilegedHelperRequested
        ? "bounded allowlisted host mutation after approval"
        : "bounded diagnostics inside the selected task session",
      rollbackHint: input.runbook.privilegedHelperRequested
        ? "Use the linked rollback path in the runbook before retrying."
        : "No rollback required for read-only diagnostics.",
      operatorChecks: input.runbook.privilegedHelperRequested
        ? ["Confirm the selected host scope.", "Review linked rollback hints before approving."]
        : ["Review the tmux output after the runbook finishes."]
    }
  };
}

function createFailedReview(input: RunbookSafetyReviewInput, inputHash: string, reason: string): ExecutionReview {
  const highRiskFailure = input.runbook.requiresApproval || input.riskClass === "high";

  return {
    actorId: "safety-agent",
    verdict: highRiskFailure ? "blocked" : "not_run",
    summary: highRiskFailure
      ? `${input.runbook.name} was blocked because the safety-agent did not produce a bounded risk report.`
      : `${input.runbook.name} did not receive a complete safety report. Review the bounded plan manually before relying on the advisory result.`,
    details: {
      schemaVersion: REVIEW_SCHEMA_VERSION,
      source: "copilot-cli",
      parserVersion: PARSER_VERSION,
      parseStatus: "error",
      runbookId: input.runbook.id,
      runbookVersionHash: input.runbookVersionHash,
      scriptIds: input.runbook.scriptIds,
      integration: input.runbook.integration,
      requiresApproval: input.runbook.requiresApproval,
      privilegedHelperRequested: input.runbook.privilegedHelperRequested,
      sessionId: input.sessionId,
      trigger: input.trigger,
      scheduleId: input.scheduleId,
      riskClass: input.riskClass,
      hazards: [],
      blastRadius: "unknown",
      expectedImpact: "unknown",
      rollbackHint: "Do not dispatch until a valid safety report exists or the operator reviews the change manually.",
      operatorChecks: ["Inspect the reviewed runbook definition before dispatch.", "Re-run the safety review after fixing the runtime problem."],
      inputHash,
      blockedReason: highRiskFailure ? reason : null,
      fallbackReason: highRiskFailure ? null : reason
    }
  };
}

function resolveEffectiveVerdict(verdict: SafetyVerdict, requiresApproval: boolean): ExecutionReview["verdict"] {
  if (verdict === "blocked") {
    return "blocked";
  }
  if (requiresApproval) {
    return "approval_required";
  }
  return verdict;
}

async function runCopilotSafetyReview(
  prompt: string,
  runtime: SafetyReviewRuntimeConfig
): Promise<CopilotReviewResult> {
  const args = [
    "-s",
    "-p",
    prompt,
    "--mode",
    "plan",
    "--no-auto-update",
    "--disable-builtin-mcps",
    "--disallow-temp-dir",
    "--no-custom-instructions",
    "--deny-tool=shell",
    "--deny-tool=write",
    "--add-dir",
    runtime.repoRoot,
    "--secret-env-vars",
    SECRET_ENV_VARS,
    "--stream",
    "off"
  ];
  if (runtime.copilotModel) {
    args.push("--model", runtime.copilotModel);
  }

  return await new Promise((resolve, reject) => {
    const startedAt = new Date().toISOString();
    const started = Date.now();
    const child = spawn(runtime.copilotExecutable, args, {
      cwd: runtime.repoRoot,
      env: buildCopilotEnvironment(),
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error("Copilot CLI safety review timed out"));
    }, COPILOT_TIMEOUT_MS);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (exitCode) => {
      clearTimeout(timeout);
      if (exitCode !== 0) {
        reject(new Error(stderr.trim() || `Copilot CLI exited with status ${exitCode ?? "unknown"}`));
        return;
      }

      resolve({
        stdout: stdout.trim(),
        exitCode: exitCode ?? 0,
        startedAt,
        completedAt: new Date().toISOString(),
        durationMs: Date.now() - started,
        model: runtime.copilotModel || null
      });
    });
  });
}

function parseList(value: string): string[] {
  if (!value || /^none$/i.test(value)) {
    return [];
  }

  return value
    .split("|")
    .map((item) => clampText(item.trim(), 160))
    .filter(Boolean)
    .slice(0, 6);
}

function clampText(value: string, maxLength: number): string {
  return value.replace(/\s+/g, " ").trim().slice(0, maxLength) || "n/a";
}

function hashValue(value: unknown): string {
  return createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex");
}

function buildCopilotEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  if (env.GITHUB_TOKEN?.startsWith("ghp_")) {
    delete env.GITHUB_TOKEN;
  }
  if (env.GH_TOKEN?.startsWith("ghp_")) {
    delete env.GH_TOKEN;
  }
  return env;
}