import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import type { ExecutionReview, ExecutionRiskClass, PlanReviewVerdict, RunbookDefinition } from "@wireguard-ops-cockpit/domain";
import type { AppConfig } from "./config.js";

type SafetyVerdict = Extract<PlanReviewVerdict, "passed" | "approval_required" | "blocked">;

const REVIEW_SCHEMA_VERSION = "runbook-safety-review/v1";
const PARSER_VERSION = "line-schema/v1";
const COPILOT_TIMEOUT_MS = 30_000;
const OPENCODE_TIMEOUT_MS = 60_000;
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
  "repoRoot" | "plannerRuntime" | "copilotExecutable" | "copilotModel" | "opencodeExecutable" | "opencodeModel"
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
  // Read the actual script content so the safety LLM can see the commands
  let scriptContent = "(script not available)";
  try {
    const fs = require("node:fs");
    const repoRoot = process.env.COCKPIT_REPO_ROOT || "/opt/wireguard-ops-cockpit";
    for (const sid of input.runbook.scriptIds) {
      const p = `${repoRoot}/bin/${sid}`;
      if (fs.existsSync(p)) { scriptContent = fs.readFileSync(p, "utf-8"); break; }
    }
  } catch { /* best-effort */ }

  return [
    "You are the safety-agent for wireguard-ops-cockpit.",
    "Your job is to classify whether a runbook script is safe to execute automatically.",
    "",
    "## Verdict rules (use these thresholds):",
    "- **blocked**: Destructive operations on system-critical paths (/etc, /var, /opt, /boot, /usr, /root).",
    "  Examples: rm -rf /etc/*, wipefs, mkfs, dd to /dev/sd*, truncate -s 0 /var/log/*, chmod 777 /etc/passwd.",
    "- **approval_required**: Operations that modify configs, services, or packages but could be rolled back.",
    "  Examples: systemctl restart a service, apt-get install, editing /etc/* config files, docker restart.",
    "  Also: anything requiring sudo on production paths, opening ports in iptables, or changing file ownership.",
    "- **passed**: Read-only, informational, or trivial cleanup of non-critical paths.",
    "  Examples: date, uptime, ls, cat, head/tail on logs, rm -rf /tmp/cache/*, rm stale .lock files.",
    "  Also: systemctl status (not restart), apt-get update (not upgrade), git status.",
    "",
    "## Privilege Escalation Rules — The Hermes Agent Boundaries:",
    "The AI agent (Hermes) manages itself. Some self-modification is OK, some is NOT.",
    "Hermes config lives under /home/hermes/.hermes/ (config.yaml, .env, skills/, plugins/).",
    "Hermes container config lives in /usr/local/lib/hermes-agent/ (docker-compose.yml).",
    "",
    "## BLOCK — return blocked — if the script:",
    "1. Grants ANY user sudo/NOPASSWD access (edits /etc/sudoers, /etc/sudoers.d/*)",
    "2. Adds 'privileged: true', 'cap_add', 'network_mode: host', or 'user: root' to docker-compose",
    "3. Mounts '/' or '/etc' or '/root' or '/proc' or '/sys' as a container volume",
    "4. Mounts /var/run/docker.sock into non-privileged containers",
    "5. Changes command:/entrypoint: in Hermes docker-compose (code injection)",
    "6. Overwrites EXISTING API tokens/secrets in .env (HERMES_GATEWAY_TOKEN, DEEPSEEK_API_KEY, etc.)",
    "7. Modifies Cockpit API source code under /opt/wireguard-ops-cockpit/apps/ or /opt/wireguard-ops-cockpit/packages/",
    "8. Adds sshd config, reverse shells, connect-back tunnels, or remote access backdoors",
    "9. Creates new Linux users, edits /etc/passwd, /etc/shadow, or /etc/group",
    "10. Adds cron jobs or systemd timers that execute as root or hermes user",
    "11. Runs docker exec/docker cp targeting hermes or hermes-dashboard containers",
    "",
    "## ALLOW — passed or approval_required — if the script:",
    "A. Edits Hermes config.yaml (model, memory, skills, display, timeouts) → passed",
    "B. ADDS (not overwrites) new API tokens to .env (new services, new integrations) → approval_required",
    "C. Creates/edits skill files under /home/hermes/.hermes/skills/ → passed",
    "D. Creates/edits plugin files under /home/hermes/.hermes/plugins/ → passed",
    "E. Adds new volume mounts to docker-compose (app data, logs, cache) → approval_required",
    "F. Changes resource limits (mem_limit, cpu_shares) in docker-compose → passed",
    "G. Edits /etc/apache2/, /etc/nginx/, /etc/php/ (web server config) → approval_required",
    "H. apt-get install/update, pip install, npm install → approval_required",
    "I. systemctl restart/reload on services (Apache, MySQL, PHP-FPM) → approval_required",
    "J. docker restart on non-hermes containers (email-archive, frigate, etc.) → approval_required",
    "K. git operations in /opt/wireguard-ops-cockpit (add, commit, push) → approval_required",
    "L. Reading/cat-ing ANY file on the system → passed",
    "",
    "## Context:",
    "This host runs Nextcloud, GitLab, WordPress, Frigate, Apache, and Hermes agent.",
    "The operator (Hermes) is authorized for system maintenance and self-configuration.",
    "But it must NEVER escalate to host root, expose services, or overwrite security credentials.",
    "If the script touches critical security boundaries → BLOCK. Routine self-config → allow.",
    "",
    "Return exactly these seven lines and nothing else:",
    "VERDICT: passed|approval_required|blocked",
    "SUMMARY: <one sentence>",
    "HAZARDS: <item 1 | item 2 | item 3 or none>",
    "BLAST_RADIUS: <short phrase>",
    "EXPECTED_IMPACT: <short phrase>",
    "ROLLBACK_HINT: <short phrase>",
    "OPERATOR_CHECKS: <item 1 | item 2 | item 3 or none>",
    "",
    "## Runbook metadata:",
    JSON.stringify(buildPromptPayload(input)),
    "",
    "## Script content to evaluate:",
    scriptContent
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
  const isOpencode = runtime.plannerRuntime === "opencode";
  const runtimeSource = isOpencode ? "opencode" : "copilot-cli";

  try {
    const runtimeResult = isOpencode
      ? await runOpencodeSafetyReview(prompt, runtime)
      : await runCopilotSafetyReview(prompt, runtime);
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
        source: runtimeSource,
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
    return createFailedReview(input, inputHash, reason, runtimeSource);
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

function createFailedReview(input: RunbookSafetyReviewInput, inputHash: string, reason: string, source: string = "copilot-cli"): ExecutionReview {
  const highRiskFailure = input.runbook.requiresApproval || input.riskClass === "high";

  return {
    actorId: "safety-agent",
    verdict: highRiskFailure ? "blocked" : "not_run",
    summary: highRiskFailure
      ? `${input.runbook.name} was blocked because the safety-agent did not produce a bounded risk report.`
      : `${input.runbook.name} did not receive a complete safety report. Review the bounded plan manually before relying on the advisory result.`,
    details: {
      schemaVersion: REVIEW_SCHEMA_VERSION,
      source,
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

async function runOpencodeSafetyReview(
  prompt: string,
  runtime: SafetyReviewRuntimeConfig
): Promise<CopilotReviewResult> {
  const args = [
    "run",
    "--auto",
    "--print-logs",
    "--dir",
    runtime.repoRoot,
    prompt
  ];

  return await new Promise((resolve, reject) => {
    const startedAt = new Date().toISOString();
    const started = Date.now();
    const child = spawn(runtime.opencodeExecutable, args, {
      cwd: runtime.repoRoot,
      env: { ...process.env },
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error("OpenCode safety review timed out"));
    }, OPENCODE_TIMEOUT_MS);

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
        reject(new Error(stderr.trim() || `OpenCode exited with status ${exitCode ?? "unknown"}`));
        return;
      }

      resolve({
        stdout: stdout.trim(),
        exitCode: exitCode ?? 0,
        startedAt,
        completedAt: new Date().toISOString(),
        durationMs: Date.now() - started,
        model: runtime.opencodeModel || null
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