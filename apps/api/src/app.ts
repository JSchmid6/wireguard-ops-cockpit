import { createHash, createHmac } from "node:crypto";
import { execSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import Fastify from "fastify";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type {
  AgentManifest,
  ExecutionCheckpointDefinition,
  ExecutionCheckpointState,
  ExecutionPlan,
  ExecutionReview,
  ExecutionRiskClass,
  JobRecord,
  RunbookDefinition,
  ScheduledRunbook,
  ScheduledRunbookMode,
  UserSummary
} from "@wireguard-ops-cockpit/domain";
import { createTmuxAdapter } from "@wireguard-ops-cockpit/tmux-adapter";
import { AUTH_COOKIE, clearAuthCookie, parseCookies, serializeAuthCookie } from "./auth.js";
import { loadConfig, type AppConfig } from "./config.js";
import { CockpitDatabase } from "./db.js";
import {
  computeAgentManifestDigest,
  computeRunbookVersionHash,
  INTERNAL_EXECUTION_AGENTS,
  RUNBOOKS,
  buildAgentCommand,
  buildRunbookDispatch,
  findAgent,
  listScripts,
  listAgents,
  findRunbook,
  buildRunnerPrompt,
  buildBrokerAgentPrompt,
  registerDynamicRunbook,
  unregisterDynamicRunbook,
  loadDynamicRunbooks,
  listDynamicRunbooks
} from "./registries.js";
import { generateRunbookSafetyReview, type SafetyReviewRunner } from "./safety-review.js";
import { runBrokerAgent } from "./agent-broker.js";
import { runDynamicCapability, runExecutorAction } from "./executor-broker.js";
import {
  capabilityManifestHash, capabilityNeedsOperatorApproval, capabilityPlannerContract,
  parseCapabilityManifest, type CapabilityManifest,
} from "./capability-manifest.js";
import {
  approveExecutionEnvelope,
  buildAgentTask,
  classifyCapabilities,
  createExecutionEnvelope,
  hashCanonical,
  normalizeAllowedCapabilities,
  normalizeEvidence,
  verifyExecutionEnvelopeSignature,
  type CapabilityId,
  type ExecutionEnvelope,
} from "./hermes-security.js";

interface AppOptions {
  config?: AppConfig;
  bootstrapUsers?: Array<{ username: string; password: string; role?: UserSummary["role"] }>;
  safetyReviewRunner?: SafetyReviewRunner;
}

interface LoginAttemptState {
  count: number;
  windowStartedAt: number;
  blockedUntil: number;
}

const MAX_LOGIN_ATTEMPTS = 5;
const LOGIN_WINDOW_MS = 10 * 60 * 1000;
const LOGIN_BLOCK_MS = 15 * 60 * 1000;

function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24);
}

type HermesPhase = "queued" | "planning" | "reviewing" | "executing" | "verifying" | "finished";

interface HermesExplanation {
  phase: HermesPhase;
  intent: string;
  completed: string[];
  reason: string;
  evidence: string[];
  neededToContinue: string[];
  recommendedAction: string;
  rollbackAvailable: boolean;
}

interface PlanPolicyResult {
  zone: "green" | "yellow" | "red";
  allowed: boolean;
  status: "ready" | "blocked_policy" | "blocked_user_approval" | "blocked_prerequisite";
  reason: string;
  evidence: string[];
  neededToContinue: string[];
  rollbackAvailable: boolean;
}

function sectionValue(plan: string, heading: string): string {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = plan.match(new RegExp(`## ${escaped}\\s*\\n([\\s\\S]*?)(?=\\n## |$)`, "i"));
  return match?.[1]?.trim() || "";
}

export function evaluatePlanPolicy(plan: string, safetyVerdict: string): PlanPolicyResult {
  const declared = sectionValue(plan, "Risk Zone").toLowerCase();
  let zone: PlanPolicyResult["zone"] = declared.includes("red")
    ? "red"
    : declared.includes("yellow")
      ? "yellow"
      : "green";
  const rollback = sectionValue(plan, "Rollback");
  const rollbackAvailable = Boolean(rollback && !/^none\.?$/i.test(rollback));
  const executableScript = plan.match(/```(?:bash|sh)\s*\n([\s\S]*?)```/i)?.[1] || "";

  // These are intentionally few hard boundaries. Contextual classification
  // remains the Safety LLM's job.
  const hardBoundaries: Array<[RegExp, string]> = [
    [/\b(rm\s+-rf|mkfs|wipefs|shred)\b/i, "destructive data operation"],
    [/\b(iptables|nft|ufw|useradd|userdel|usermod|groupadd|groupdel|visudo)\b/i, "network or identity boundary"],
    [/\b(mysql|mariadb)\b.{0,80}\b(nextcloud|oc_)/i, "direct Nextcloud database access"],
    [/(?:>|tee\b|sed\s+-i\b)[^\n]*(?:\/etc\/sudoers|NOPASSWD)/i, "sudo authority change"],
  ];
  const hit = hardBoundaries.find(([pattern]) => pattern.test(executableScript));
  if (hit) {
    return {
      zone: "red", allowed: false, status: "blocked_user_approval",
      reason: `The plan crosses a protected boundary: ${hit[1]}.`,
      evidence: [hit[1]],
      neededToContinue: ["Explicit operator approval or a lower-impact alternative."],
      rollbackAvailable,
    };
  }
  if (safetyVerdict === "blocked" || safetyVerdict === "not_run") {
    return {
      zone: "red", allowed: false, status: "blocked_policy",
      reason: "The independent safety review did not authorize execution.",
      evidence: [`safety verdict: ${safetyVerdict}`],
      neededToContinue: ["Resolve the safety finding and submit a revised plan."],
      rollbackAvailable,
    };
  }
  if (zone === "red") {
    return {
      zone, allowed: false, status: "blocked_user_approval",
      reason: "The planner classified the operation as red.",
      evidence: ["planner risk zone: red"],
      neededToContinue: ["Explicit operator approval."],
      rollbackAvailable,
    };
  }
  if (zone === "yellow" && !rollbackAvailable) {
    return {
      zone, allowed: false, status: "blocked_prerequisite",
      reason: "Yellow operations require a concrete rollback plan.",
      evidence: ["rollback section is missing or none"],
      neededToContinue: ["Add and validate a concrete rollback procedure."],
      rollbackAvailable: false,
    };
  }
  if (safetyVerdict === "approval_required") zone = "yellow";
  return {
    zone, allowed: true, status: "ready",
    reason: zone === "green" ? "Read-only or low-impact plan passed review." : "Reversible scoped change passed review.",
    evidence: [`safety verdict: ${safetyVerdict}`, `risk zone: ${zone}`],
    neededToContinue: [], rollbackAvailable,
  };
}

function terminalUrl(baseUrl: string | null, sessionId: string, signingSecret: Buffer): string | null {
  if (!baseUrl) {
    return null;
  }

  const token = createHmac("sha256", signingSecret).update(sessionId).digest("hex");
  return `${baseUrl.replace(/\/$/, "")}/?arg=${encodeURIComponent(sessionId)}&arg=${encodeURIComponent(token)}`;
}

function createPlanHash(payload: Record<string, unknown>): string {
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

function recomputePlanHash(plan: ExecutionPlan): string {
  return createPlanHash({
    targetType: plan.targetType,
    targetId: plan.targetId,
    sessionId: plan.sessionId,
    requestedBy: plan.requestedBy,
    normalizedInput: plan.normalizedInput,
    riskClass: plan.riskClass
  });
}

function review(
  actorId: string | null,
  verdict: ExecutionReview["verdict"],
  summary: string,
  details: Record<string, unknown> = {}
): ExecutionReview {
  return {
    actorId,
    verdict,
    summary,
    details
  };
}

function createCheckpointContractDigest(checkpointContract: ExecutionCheckpointDefinition[]): string | null {
  if (checkpointContract.length === 0) {
    return null;
  }

  return createHash("sha256").update(JSON.stringify(checkpointContract)).digest("hex");
}

function cloneCheckpointContract(checkpointContract: ExecutionCheckpointDefinition[]): ExecutionCheckpointDefinition[] {
  return checkpointContract.map((checkpoint) => ({ ...checkpoint }));
}

function parseCheckpointContractValue(value: unknown): ExecutionCheckpointDefinition[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((entry) => {
    if (!entry || typeof entry !== "object") {
      return [];
    }

    const candidate = entry as Record<string, unknown>;
    if (
      typeof candidate.id !== "string" ||
      typeof candidate.label !== "string" ||
      typeof candidate.description !== "string" ||
      typeof candidate.kind !== "string"
    ) {
      return [];
    }

    if (
      candidate.kind !== "analysis" &&
      candidate.kind !== "operator-checkpoint" &&
      candidate.kind !== "runbook" &&
      candidate.kind !== "verify"
    ) {
      return [];
    }

    if (candidate.runbookId !== undefined && typeof candidate.runbookId !== "string") {
      return [];
    }

    return [
      {
        id: candidate.id,
        label: candidate.label,
        description: candidate.description,
        kind: candidate.kind,
        ...(candidate.runbookId ? { runbookId: candidate.runbookId } : {})
      } satisfies ExecutionCheckpointDefinition
    ];
  });
}

function createInitialCheckpointState(
  checkpointContract: ExecutionCheckpointDefinition[]
): { checkpoints: ExecutionCheckpointState[]; activeCheckpointId: string | null } {
  const checkpoints = checkpointContract.map((checkpoint, index) => ({
    ...checkpoint,
    status: (index === 0 ? "awaiting_operator" : "planned") as ExecutionCheckpointState["status"],
  }));

  return {
    checkpoints,
    activeCheckpointId: checkpoints[0]?.id || null
  };
}

function parseCheckpointStateValue(value: unknown): ExecutionCheckpointState[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((entry) => {
    if (!entry || typeof entry !== "object") {
      return [];
    }

    const candidate = entry as Record<string, unknown>;
    if (
      typeof candidate.id !== "string" ||
      typeof candidate.label !== "string" ||
      typeof candidate.description !== "string" ||
      typeof candidate.kind !== "string" ||
      typeof candidate.status !== "string"
    ) {
      return [];
    }

    if (
      candidate.kind !== "analysis" &&
      candidate.kind !== "operator-checkpoint" &&
      candidate.kind !== "runbook" &&
      candidate.kind !== "verify"
    ) {
      return [];
    }

    if (
      candidate.status !== "planned" &&
      candidate.status !== "awaiting_operator" &&
      candidate.status !== "completed"
    ) {
      return [];
    }

    if (candidate.runbookId !== undefined && typeof candidate.runbookId !== "string") {
      return [];
    }

    return [
      {
        id: candidate.id,
        label: candidate.label,
        description: candidate.description,
        kind: candidate.kind,
        status: candidate.status,
        ...(candidate.runbookId ? { runbookId: candidate.runbookId } : {})
      } satisfies ExecutionCheckpointState
    ];
  });
}

function advanceCheckpointState(
  checkpoints: ExecutionCheckpointState[],
  checkpointId: string
): { checkpoints: ExecutionCheckpointState[]; activeCheckpointId: string | null; completedCheckpointLabel: string } | null {
  const currentIndex = checkpoints.findIndex((checkpoint) => checkpoint.id === checkpointId);
  if (currentIndex < 0 || checkpoints[currentIndex]?.status !== "awaiting_operator") {
    return null;
  }

  const updatedCheckpoints = checkpoints.map((checkpoint, index) => {
    if (index === currentIndex) {
      return {
        ...checkpoint,
        status: "completed" as const
      };
    }

    if (index === currentIndex + 1 && checkpoint.status === "planned") {
      return {
        ...checkpoint,
        status: "awaiting_operator" as const
      };
    }

    return checkpoint;
  });

  return {
    checkpoints: updatedCheckpoints,
    activeCheckpointId: updatedCheckpoints.find((checkpoint) => checkpoint.status === "awaiting_operator")?.id || null,
    completedCheckpointLabel: checkpoints[currentIndex].label
  };
}

function normalizePrompt(value: string | undefined, maxLength = 240) {
  const basePrompt = (value || "Inspect the current maintenance context and report back.").trim();
  const withoutControlChars = basePrompt.replace(/[\u0000-\u001f\u007f]+/g, " ");
  const compact = withoutControlChars.replace(/\s+/g, " ").trim();
  const normalized = (compact || "Inspect the current maintenance context and report back.").slice(0, maxLength);

  return {
    prompt: normalized,
    removedControlChars: withoutControlChars !== basePrompt,
    truncated: normalized.length < compact.length
  };
}

function isHighRiskRunbook(runbook: RunbookDefinition) {
  return runbook.requiresApproval || runbook.privilegedHelperRequested;
}

function validateWeekday(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 6;
}

function validateTimeUtc(value: unknown): value is string {
  return typeof value === "string" && /^([01]\d|2[0-3]):([0-5]\d)$/.test(value);
}

function computeNextWeeklyRunAt(weekday: number, timeUtc: string, from = new Date()): string {
  const [hoursText, minutesText] = timeUtc.split(":");
  const hours = Number(hoursText);
  const minutes = Number(minutesText);
  const target = new Date(from);
  target.setUTCSeconds(0, 0);
  target.setUTCHours(hours, minutes, 0, 0);

  let daysAhead = (weekday - from.getUTCDay() + 7) % 7;
  if (daysAhead === 0 && target.getTime() <= from.getTime()) {
    daysAhead = 7;
  }

  target.setUTCDate(from.getUTCDate() + daysAhead);
  return target.toISOString();
}

function planJobOutput(plan: ExecutionPlan, summary: string) {
  const runbookVersionHash =
    typeof plan.normalizedInput.runbookVersionHash === "string" ? plan.normalizedInput.runbookVersionHash : null;
  const checkpointContractDigest =
    typeof plan.normalizedInput.checkpointContractDigest === "string"
      ? plan.normalizedInput.checkpointContractDigest
      : null;
  const checkpointCount = parseCheckpointContractValue(plan.normalizedInput.checkpointContract).length;

  return {
    summary,
    planId: plan.id,
    planHash: plan.planHash,
    targetType: plan.targetType,
    targetId: plan.targetId,
    riskClass: plan.riskClass,
    runbookVersionHash,
    checkpointContractDigest,
    checkpointCount,
    plannerVerdict: plan.plannerReview.verdict,
    safetySummary: plan.safetyReview.summary,
    safetyVerdict: plan.safetyReview.verdict,
    policyVerdict: plan.policyReview.verdict
  };
}

function scheduleJobOutput(schedule: ScheduledRunbook, summary: string) {
  return {
    summary,
    scheduleId: schedule.id,
    runbookId: schedule.runbookId,
    effectiveMode: schedule.effectiveMode,
    nextRunAt: schedule.nextRunAt
  };
}

function runbookDispatchOutput(
  runbook: RunbookDefinition,
  sessionName: string,
  tmuxSessionName: string,
  windowName: string,
  actor: UserSummary,
  note: string
) {
  return {
    summary: `${runbook.name} dispatched to the host tmux executor.`,
    lines: [
      `Requested by ${actor.username}.`,
      `Linked session: ${sessionName}.`,
      `tmux target: ${tmuxSessionName}:${windowName}.`,
      note,
      `Manual attach: sudo -u wgops tmux attach -t ${tmuxSessionName}`
    ]
  };
}

function agentOutput(agent: AgentManifest, prompt: string, started: boolean, note: string) {
  return {
    summary: `${agent.name} ${started ? "started" : "recorded"} through the control plane.`,
    prompt,
    note
  };
}

function resolveRunbookPlanState(runbook: RunbookDefinition, safetyReview: ExecutionReview) {
  if (safetyReview.verdict === "blocked") {
    return {
      status: "blocked" as const,
      requiresApproval: false
    };
  }

  // If the safety review failed to run (not_run), treat as requiring approval.
  // Better to block execution than to silently pass un-reviewed commands.
  if (safetyReview.verdict === "not_run") {
    return {
      status: "pending_approval" as const,
      requiresApproval: true
    };
  }

  const requiresApproval = runbook.requiresApproval || safetyReview.verdict === "approval_required";
  return {
    status: requiresApproval ? ("pending_approval" as const) : ("ready" as const),
    requiresApproval
  };
}

function createRunbookApprovalReason(plan: ExecutionPlan, runbook: RunbookDefinition) {
  if (!runbook.requiresApproval && plan.safetyReview.verdict === "approval_required") {
    return `${runbook.name} was escalated by the safety review and now requires human approval before dispatch.`;
  }

  return `${runbook.name} requires explicit approval before dispatching the bounded host helper.`;
}

function createAgentApprovalReason(agent: AgentManifest) {
  if (agent.supervisionMode === "session-observed") {
    return `${agent.name} requires operator approval before it can present ${agent.checkpointTemplate.length} staged remediation checkpoints in the session.`;
  }

  if (agent.privilegedHelperRequested) {
    return `${agent.name} requires explicit approval before launch because it may request a privileged helper.`;
  }

  return `${agent.name} requires explicit approval before launch.`;
}

async function requireActor(
  request: FastifyRequest,
  reply: FastifyReply,
  database: CockpitDatabase
): Promise<UserSummary | null> {
  const authorization = request.headers.authorization;
  if (authorization?.startsWith("Bearer ")) {
    const apiIdentity = database.findUserByApiToken(authorization.slice(7).trim());
    if (!apiIdentity) {
      await reply.code(401).send({ message: "authentication required" });
      return null;
    }
    const route = request.routeOptions.url || "";
    const scope = `${request.method.toUpperCase()} ${route}`;
    if (apiIdentity.actor.role !== "automation" || !apiIdentity.scopes.includes(scope)) {
      await reply.code(403).send({ message: "API token is not authorized for this endpoint" });
      return null;
    }
    return apiIdentity.actor;
  }
  const cookies = parseCookies(request.headers.cookie);
  const token = cookies[AUTH_COOKIE];
  if (!token) {
    await reply.code(401).send({ message: "authentication required" });
    return null;
  }

  const actor = database.findUserByAuthToken(token);
  if (!actor) {
    await reply.code(401).send({ message: "authentication required" });
    return null;
  }

  return actor;
}

export async function createApp(options: AppOptions = {}) {
  const config = options.config || loadConfig();
  const changeRuntimeFingerprint = hashCanonical({
    plannerModel: config.opencodeModel,
    safetyModel: config.safetyOpencodeModel,
    capabilityContract: hashCanonical(capabilityPlannerContract()),
    brokerRoleContract: "ephemeral-role-workspace-v7",
    executorBoundaryContract: "dynamic-capability-v2-nextcloud-semantic",
  });
  if (config.nodeEnv === "production" && config.adminPassword === "change-me-now") {
    throw new Error("COCKPIT_ADMIN_PASSWORD must be changed before running in production");
  }
  if (config.nodeEnv === "production" && config.terminalSigningSecret === "development-terminal-secret") {
    throw new Error("COCKPIT_TERMINAL_SIGNING_SECRET must be changed before running in production");
  }
  if (config.requireModelDiversity && config.opencodeModel === config.safetyOpencodeModel) {
    throw new Error("COCKPIT_REQUIRE_MODEL_DIVERSITY requires different planner and safety models");
  }

  const database = new CockpitDatabase(config.dbPath);
  const tmux = createTmuxAdapter(config.tmuxMode);
  const agents = listAgents(config.plannerRuntime);
  const scripts = listScripts();
  const safetyReviewRunner = options.safetyReviewRunner || generateRunbookSafetyReview;
  const terminalSigningSecret = Buffer.from(config.terminalSigningSecret, "utf8");
  const loginAttempts = new Map<string, LoginAttemptState>();
  const scheduleLocks = new Set<string>();
  const activeOrders = new Set<string>(); // Rate limiting: max 1 order per session

  async function createRunbookPlan(
    actor: UserSummary,
    runbook: RunbookDefinition,
    session: { id: string; name: string } | null,
    options: { trigger: "manual" | "scheduled"; autoDispatch: boolean; scheduleId?: string } = {
      trigger: "manual",
      autoDispatch: true
    }
  ) {
    const runbookVersionHash = computeRunbookVersionHash(runbook);
    const riskClass: ExecutionRiskClass = runbook.requiresApproval || runbook.privilegedHelperRequested ? "high" : "low";
    const normalizedInput = {
      runbookId: runbook.id,
      runbookVersionHash,
      sessionId: session?.id || null,
      sessionName: session?.name || null,
      trigger: options.trigger,
      scheduleId: options.scheduleId || null
    };

    const plannerReview = review(
      INTERNAL_EXECUTION_AGENTS.planner.id,
      "passed",
      `${INTERNAL_EXECUTION_AGENTS.planner.name} normalized ${runbook.name} into a bounded runbook request.`,
      {
        integration: runbook.integration,
        privilegedHelperRequested: runbook.privilegedHelperRequested,
        sessionLinked: Boolean(session),
        runbookVersionHash
      }
    );
    const safetyReview = await safetyReviewRunner(
      {
        runbook,
        runbookVersionHash,
        riskClass,
        sessionId: session?.id || null,
        trigger: options.trigger,
        scheduleId: options.scheduleId || null
      },
      {
        repoRoot: config.repoRoot,
        plannerRuntime: config.plannerRuntime,
        copilotExecutable: config.copilotExecutable,
        copilotModel: config.copilotModel,
        opencodeExecutable: config.opencodeExecutable,
        opencodeModel: config.safetyOpencodeModel,
        agentBrokerSocket: config.agentBrokerSocket,
      }
    );
    const planState = resolveRunbookPlanState(runbook, safetyReview);
    const policyReview = review(
      null,
      "passed",
      "Deterministic policy gate confirmed the runbook is allowlisted and the request stayed within the manifest contract.",
      {
        runbookId: runbook.id,
        targetType: "runbook",
        runbookVersionHash
      }
    );
    const preExecutionHook = review(
      null,
      planState.status === "blocked" ? "blocked" : "passed",
      planState.status === "blocked"
        ? "Pre-exec hook kept the runbook blocked because the safety review did not approve bounded dispatch."
        : session
          ? "Pre-exec hook bound the runbook request to the selected cockpit session."
          : "Pre-exec hook accepted the runbook request without a linked tmux session.",
      {
        sessionId: session?.id || null,
        runbookVersionHash
      }
    );
    const runtimeHook = review(
      null,
      planState.status === "blocked"
        ? "not_run"
        : planState.requiresApproval
          ? "not_run"
          : options.autoDispatch
            ? "pending"
            : "not_run",
      planState.status === "blocked"
        ? "Runtime hook did not arm because the safety review blocked dispatch."
        : planState.requiresApproval
          ? "Runtime hook is waiting for approval before dispatch."
          : options.autoDispatch
            ? "Runtime hook is armed for bounded placeholder dispatch."
            : "Runtime hook is waiting for an operator or schedule policy to dispatch the bounded executor.",
      {}
    );
    const postExecutionHook = review(
      null,
      planState.status === "blocked"
        ? "not_run"
        : planState.requiresApproval
          ? "not_run"
          : options.autoDispatch
            ? "pending"
            : "not_run",
      planState.status === "blocked"
        ? "Post-exec verification is skipped because the safety review blocked bounded execution."
        : planState.requiresApproval
          ? "Post-exec verification will run only after approval and dispatch."
          : options.autoDispatch
            ? "Post-exec verification will confirm the placeholder output and audit trail."
            : "Post-exec verification will start only after a later bounded dispatch occurs.",
      {}
    );

    const plan = database.createExecutionPlan({
      sessionId: session?.id || null,
      targetType: "runbook",
      targetId: runbook.id,
      requestedBy: actor.id,
      status: planState.status,
      riskClass,
      requiresApproval: planState.requiresApproval,
      planHash: createPlanHash({
        targetType: "runbook",
        targetId: runbook.id,
        sessionId: session?.id || null,
        requestedBy: actor.id,
        normalizedInput,
        riskClass
      }),
      planSummary:
        planState.status === "blocked"
          ? `${runbook.name} was blocked by the safety review before the bounded executor could continue.`
          : options.trigger === "scheduled"
            ? `${runbook.name} was generated by a weekly schedule and will still pass planner, safety review, policy validation, and hooks before any bounded execution continues.`
            : `${runbook.name} will run through planner, safety review, policy validation, and hooks before the bounded executor can continue.`,
      normalizedInput,
      plannerReview,
      safetyReview,
      policyReview,
      preExecutionHook,
      runtimeHook,
      postExecutionHook
    });

    database.createAudit({
      actorId: actor.id,
      action: "execution.plan.safety_reviewed",
      targetType: "execution-plan",
      targetId: plan.id,
      details: {
        runbookId: runbook.id,
        runbookVersionHash,
        verdict: plan.safetyReview.verdict,
        source: plan.safetyReview.details.source || null,
        parseStatus: plan.safetyReview.details.parseStatus || null
      }
    });

    return plan;
  }

  function createPendingApprovalForPlan(plan: ExecutionPlan, actor: UserSummary, reason: string) {
    const pendingJob = database.createJob({
      sessionId: plan.sessionId,
      kind: "execution.plan",
      subjectId: plan.id,
      status: "pending_approval",
      requiresApproval: true,
      output: planJobOutput(plan, reason)
    });
    const approval = database.createApproval({
      jobId: pendingJob.id,
      requestedBy: actor.id,
      reason
    });
    const job = database.updateJob(pendingJob.id, {
      status: "pending_approval",
      approvalId: approval.id,
      output: planJobOutput(plan, reason)
    });
    const updatedPlan = database.updateExecutionPlan(plan.id, {
      approvalId: approval.id,
      status: "pending_approval"
    });

    database.createAudit({
      actorId: actor.id,
      action: "execution.plan.pending_approval",
      targetType: "execution-plan",
      targetId: updatedPlan.id,
      details: {
        approvalId: approval.id,
        requestedBy: actor.username
      }
    });

    if (plan.sessionId) {
      database.recordSessionActivity(plan.sessionId);
    }

    return { plan: updatedPlan, job, approval };
  }

  function createReadyPlanRecord(plan: ExecutionPlan, actor: UserSummary, summary: string) {
    const job = database.createJob({
      sessionId: plan.sessionId,
      kind: "execution.plan",
      subjectId: plan.id,
      status: "completed",
      requiresApproval: false,
      output: planJobOutput(plan, summary),
      completedAt: new Date().toISOString()
    });

    database.createAudit({
      actorId: actor.id,
      action: "execution.plan.ready",
      targetType: "execution-plan",
      targetId: plan.id,
      details: {
        jobId: job.id,
        requestedBy: actor.username
      }
    });

    if (plan.sessionId) {
      database.recordSessionActivity(plan.sessionId);
    }

    return { plan, job };
  }

  function createBlockedPlanRecord(plan: ExecutionPlan, actor: UserSummary, summary: string) {
    const job = database.createJob({
      sessionId: plan.sessionId,
      kind: "execution.plan",
      subjectId: plan.id,
      status: "failed",
      requiresApproval: false,
      output: {
        ...planJobOutput(plan, summary),
        blockedReason: plan.safetyReview.summary
      },
      completedAt: new Date().toISOString()
    });

    database.createAudit({
      actorId: actor.id,
      action: "execution.plan.blocked",
      targetType: "execution-plan",
      targetId: plan.id,
      details: {
        jobId: job.id,
        safetyVerdict: plan.safetyReview.verdict,
        requestedBy: actor.username
      }
    });

    if (plan.sessionId) {
      database.recordSessionActivity(plan.sessionId);
    }

    return { plan, job };
  }

  function pauseSchedule(scheduleId: string, actorId: string | null, summary: string, details: Record<string, unknown>) {
    const schedule = database.updateScheduledRunbook(scheduleId, {
      status: "paused"
    });
    database.createAudit({
      actorId,
      action: "schedule.paused",
      targetType: "scheduled-runbook",
      targetId: schedule.id,
      details: {
        ...details,
        summary
      }
    });
    return schedule;
  }

  async function processDueScheduledRunbooks() {
    const dueSchedules = database.listDueScheduledRunbooks(new Date().toISOString());

    for (const schedule of dueSchedules) {
      if (scheduleLocks.has(schedule.id)) {
        continue;
      }

      scheduleLocks.add(schedule.id);
      try {
        const actor = database.getUserById(schedule.ownerId);
        const runbook = findRunbook(schedule.runbookId);
        const session = database.getSessionByIdForActor(schedule.sessionId, schedule.ownerId);

        if (!actor || !runbook || !session) {
          pauseSchedule(schedule.id, actor?.id || null, "Scheduled runbook paused because actor, runbook, or session no longer resolves.", {
            actorFound: Boolean(actor),
            runbookFound: Boolean(runbook),
            sessionFound: Boolean(session)
          });
          continue;
        }

        const currentVersionHash = computeRunbookVersionHash(runbook);
        if (currentVersionHash !== schedule.runbookVersionHash) {
          pauseSchedule(schedule.id, actor.id, "Scheduled runbook paused because the reviewed runbook version changed.", {
            expectedRunbookVersionHash: schedule.runbookVersionHash,
            currentRunbookVersionHash: currentVersionHash
          });
          continue;
        }

        if (isHighRiskRunbook(runbook) && schedule.effectiveMode !== "scheduled-plan-only") {
          pauseSchedule(schedule.id, actor.id, "Scheduled runbook paused because high-risk runbooks cannot auto-dispatch in this slice.", {
            effectiveMode: schedule.effectiveMode,
            runbookId: runbook.id
          });
          continue;
        }

        const plan = await createRunbookPlan(actor, runbook, session, {
          trigger: "scheduled",
          autoDispatch: schedule.effectiveMode === "scheduled-auto",
          scheduleId: schedule.id
        });

        database.createAudit({
          actorId: actor.id,
          action: "execution.plan.created",
          targetType: "execution-plan",
          targetId: plan.id,
          details: {
            targetType: plan.targetType,
            targetId: plan.targetId,
            sessionId: session.id,
            riskClass: plan.riskClass,
            runbookVersionHash: plan.normalizedInput.runbookVersionHash,
            scheduleId: schedule.id,
            trigger: "scheduled"
          }
        });

        let executedAt: string | null = null;
        if (plan.status === "blocked") {
          createBlockedPlanRecord(plan, actor, `${runbook.name} was generated by a weekly schedule but the safety review blocked dispatch.`);
          pauseSchedule(schedule.id, actor.id, "Scheduled runbook paused because the safety review blocked the reviewed runbook version.", {
            runbookId: runbook.id,
            runbookVersionHash: plan.normalizedInput.runbookVersionHash,
            safetyVerdict: plan.safetyReview.verdict
          });
        } else if (plan.requiresApproval) {
          createPendingApprovalForPlan(
            plan,
            actor,
            `${runbook.name} was generated by a weekly schedule and requires human approval before dispatch.`
          );
        } else if (schedule.effectiveMode === "scheduled-auto" && plan.safetyReview.verdict === "passed") {
          executeRunbookPlan(plan, actor, runbook);
          executedAt = new Date().toISOString();
        } else {
          createReadyPlanRecord(
            plan,
            actor,
            plan.safetyReview.verdict === "not_run"
              ? `${runbook.name} was generated by a weekly schedule, but the safety report is incomplete and needs operator review.`
              : `${runbook.name} was generated by a weekly schedule and is ready for operator review.`
          );
        }

        const nextRunAt = computeNextWeeklyRunAt(schedule.weekday, schedule.timeUtc, new Date(new Date(schedule.nextRunAt).getTime() + 1000));
        const updatedSchedule = database.updateScheduledRunbook(schedule.id, {
          lastPlannedAt: new Date().toISOString(),
          lastRunAt: executedAt,
          nextRunAt
        });

        database.createAudit({
          actorId: actor.id,
          action: "schedule.triggered",
          targetType: "scheduled-runbook",
          targetId: updatedSchedule.id,
          details: {
            effectiveMode: updatedSchedule.effectiveMode,
            executedAt,
            nextRunAt: updatedSchedule.nextRunAt,
            runbookId: updatedSchedule.runbookId
          }
        });
      } finally {
        scheduleLocks.delete(schedule.id);
      }
    }
  }

  function createAgentPlan(actor: UserSummary, agent: AgentManifest, sessionId: string, prompt?: string, promptMaxLength = 240) {
    const normalizedPrompt = normalizePrompt(prompt, promptMaxLength);
    const riskClass: ExecutionRiskClass = agent.requiresApproval || agent.privilegedHelperRequested ? "high" : "moderate";
    const agentManifestDigest = computeAgentManifestDigest(agent);
    const checkpointContract = cloneCheckpointContract(agent.checkpointTemplate);
    const checkpointContractDigest = createCheckpointContractDigest(checkpointContract);
    const normalizedInput = {
      sessionId,
      prompt: normalizedPrompt.prompt,
      promptLength: normalizedPrompt.prompt.length,
      agentManifestDigest,
      promptContractId: agent.promptContractId,
      checkpointContractId: agent.checkpointContractId,
      checkpointContractDigest,
      checkpointContract,
      supervisionMode: agent.supervisionMode,
      executionAuthority: agent.executionAuthority
    };

    const plannerReview = review(
      INTERNAL_EXECUTION_AGENTS.planner.id,
      "passed",
      `${INTERNAL_EXECUTION_AGENTS.planner.name} reduced the agent request to a bounded launch contract for ${agent.name}.`,
      {
        integration: agent.integration,
        promptLength: normalizedPrompt.prompt.length,
        truncated: normalizedPrompt.truncated,
        agentManifestDigest,
        promptContractId: agent.promptContractId,
        checkpointContractId: agent.checkpointContractId,
        checkpointContractDigest,
        checkpointCount: checkpointContract.length
      }
    );
    const safetyReview = review(
      INTERNAL_EXECUTION_AGENTS.safety.id,
      agent.requiresApproval ? "approval_required" : "passed",
      agent.requiresApproval
        ? agent.supervisionMode === "session-observed"
          ? `${INTERNAL_EXECUTION_AGENTS.safety.name} requires explicit operator approval before ${agent.name} can start presenting staged remediation checkpoints in the session.`
          : `${INTERNAL_EXECUTION_AGENTS.safety.name} requires explicit approval before ${agent.name} can request any privileged helper.`
        : `${INTERNAL_EXECUTION_AGENTS.safety.name} accepted the prompt because the launch path stays inside the bounded local agent launcher contract.`,
      {
        removedControlChars: normalizedPrompt.removedControlChars,
        truncated: normalizedPrompt.truncated,
        requiresApproval: agent.requiresApproval,
        supervisionMode: agent.supervisionMode,
        executionAuthority: agent.executionAuthority,
        checkpointContractDigest,
        checkpointCount: checkpointContract.length
      }
    );
    const policyReview = review(
      null,
      "passed",
      "Deterministic policy gate confirmed the agent manifest is allowlisted and no browser-supplied shell command crosses the boundary.",
      {
        agentId: agent.id,
        targetType: "agent",
        agentManifestDigest,
        promptContractId: agent.promptContractId,
        checkpointContractDigest,
        checkpointCount: checkpointContract.length
      }
    );
    const preExecutionHook = review(
      null,
      "passed",
      normalizedPrompt.removedControlChars || normalizedPrompt.truncated
        ? "Pre-exec hook normalized the agent prompt before dispatching the bounded launch request."
        : "Pre-exec hook accepted the agent prompt without modifications.",
      {
        removedControlChars: normalizedPrompt.removedControlChars,
        truncated: normalizedPrompt.truncated,
        sessionId,
        agentManifestDigest,
        checkpointContractDigest
      }
    );
    const runtimeHook = review(
      null,
      agent.requiresApproval ? "not_run" : "pending",
      agent.requiresApproval
        ? "Runtime hook is waiting for approval before dispatch."
        : "Runtime hook is ready to observe the bounded local agent launch.",
      {}
    );
    const postExecutionHook = review(
      null,
      agent.requiresApproval ? "not_run" : "pending",
      agent.requiresApproval
        ? "Post-exec verification will only run after approval."
        : "Post-exec verification will capture the launch result and keep the session auditable.",
      {}
    );

    return database.createExecutionPlan({
      sessionId,
      targetType: "agent",
      targetId: agent.id,
      requestedBy: actor.id,
      status: agent.requiresApproval ? "pending_approval" : "ready",
      riskClass,
      requiresApproval: agent.requiresApproval,
      planHash: createPlanHash({
        targetType: "agent",
        targetId: agent.id,
        sessionId,
        requestedBy: actor.id,
        normalizedInput,
        riskClass
      }),
      planSummary:
        agent.supervisionMode === "session-observed"
          ? `${agent.name} will launch in the current tmux session only after approval and will stop at ${checkpointContract.length} explicit operator review checkpoints.`
          : `${agent.name} will launch only after planner and safety review, deterministic policy validation, and hook checks have passed.`,
      normalizedInput,
      plannerReview,
      safetyReview,
      policyReview,
      preExecutionHook,
      runtimeHook,
      postExecutionHook
    });
  }

  function filterSensitiveContent(text: string): string {
    // Remove API keys, tokens, passwords, and debug noise from output
    return text
      .replace(/sk-[a-zA-Z0-9]{20,}/g, "[REDACTED:API_KEY]")
      .replace(/glpat-[a-zA-Z0-9_.-]{20,}/g, "[REDACTED:TOKEN]")
      .replace(/eyJ[a-zA-Z0-9_-]{20,}\.[a-zA-Z0-9_-]{20,}\.[a-zA-Z0-9_-]{20,}/g, "[REDACTED:JWT]")
      .replace(/password[=:]\s*\S+/gi, "password=[REDACTED]")
      .replace(/passphrase[=:]\s*\S+/gi, "passphrase=[REDACTED]")
      .replace(/timestamp=.*level=.*/g, "")  // Remove debug log lines
      .replace(/^\s*\n/gm, "");              // Remove blank lines from removed logs
  }

  function extractAnswer(rawOutput: string): string {
    // Extract the actual answer from opencode output (after "exiting loop", before "disposing")
    const lines = rawOutput.split("\n");
    let answerStart = -1;
    let answerEnd = -1;
    for (let i = lines.length - 1; i >= 0; i--) {
      if (lines[i].includes("exiting loop")) answerStart = i + 1;
      if (lines[i].includes("disposing instance") && answerStart > 0) { answerEnd = i; break; }
    }
    if (answerStart > 0 && answerEnd > answerStart) {
      return lines.slice(answerStart, answerEnd).join("\n").trim();
    }
    // Fallback: return last 500 chars, filtered
    return filterSensitiveContent(rawOutput.slice(-500));
  }

  function extractRequiredPermissions(runbook: RunbookDefinition): string[] {
    // Look for the .md file content to find ## Required Permissions section
    try {
      const mdPath = `${config.repoRoot}/bin/${runbook.scriptIds[0] || ""}`;
      if (!mdPath.endsWith(".md")) return [];
      const content = readFileSync(mdPath, "utf-8");
      const permMatch = content.match(/## Required Permissions\n([\s\S]*?)(?:\n\n|\n```|$)/);
      if (!permMatch) return [];
      return permMatch[1].split("\n")
        .map((l: string) => l.trim())
        .filter((l: string) => l.startsWith("/") && !l.includes(" ") && l.length > 2);
    } catch {
      return [];
    }
  }

  function executeRunbookPlan(plan: ExecutionPlan, actor: UserSummary, runbook: RunbookDefinition) {
    const session = plan.sessionId ? database.getSessionByIdForActor(plan.sessionId, plan.requestedBy) : null;
    if (!session) {
      throw new Error("session not found for runbook plan");
    }

    // Privilege is granted only by the versioned, administrator-installed
    // sudoers manifest. Runtime plans can request a registered helper, but
    // they can never manufacture new sudo authority.
    // If the operating system has no matching static sudoers entry, `sudo -n`
    // fails closed and the job records a prerequisite failure.

    const dispatch = buildRunbookDispatch(config.repoRoot, runbook);
    const launch = tmux.launchCommand(session.tmuxSessionName, dispatch.windowName, dispatch.command);

    const job = database.createJob({
      sessionId: session.id,
      kind: "runbook",
      subjectId: runbook.id,
      status: "running",
      requiresApproval: false,
      output: {
        ...runbookDispatchOutput(runbook, session.name, session.tmuxSessionName, dispatch.windowName, actor, launch.note),
        planId: plan.id,
        planHash: plan.planHash,
        tmuxBackend: launch.backend,
        tmuxWindowName: dispatch.windowName
      }
    });

    const updatedPlan = database.updateExecutionPlan(plan.id, {
      status: "executed",
      executedJobId: job.id,
      runtimeHook: review(
        null,
        "passed",
        "Runtime hook dispatched the runbook into the host tmux session through the bounded executor contract.",
        { jobId: job.id, backend: launch.backend, windowName: dispatch.windowName }
      ),
      postExecutionHook: review(
        null,
        "pending",
        "Post-exec verification is waiting for the operator or a future runtime callback to confirm the final outcome.",
        { jobId: job.id, tmuxSessionName: session.tmuxSessionName, windowName: dispatch.windowName }
      )
    });

    database.recordSessionActivity(session.id);

    database.createAudit({
      actorId: actor.id,
      action: "execution.plan.executed",
      targetType: "execution-plan",
      targetId: plan.id,
      details: {
        targetType: plan.targetType,
        targetId: plan.targetId,
        executedJobId: job.id
      }
    });
    database.createAudit({
      actorId: actor.id,
      action: "runbook.dispatched",
      targetType: "runbook",
      targetId: runbook.id,
      details: {
        runbookId: runbook.id,
        sessionId: session.id,
        tmuxSessionName: session.tmuxSessionName,
        tmuxWindowName: dispatch.windowName
      }
    });

    return { plan: updatedPlan, job };
  }

  function executeAgentPlan(
    plan: ExecutionPlan,
    actor: UserSummary,
    agent: AgentManifest,
    windowSuffix = "",
    opencodeModel = config.opencodeModel,
  ) {
    if (config.agentBrokerSocket) {
      throw new Error("local agent execution is disabled while the isolated agent broker is configured");
    }
    const session = plan.sessionId ? database.getSessionRuntimeTargetForActor(plan.sessionId, plan.requestedBy) : null;
    if (!session) {
      throw new Error("session not found for agent plan");
    }

    const prompt =
      typeof plan.normalizedInput.prompt === "string"
        ? plan.normalizedInput.prompt
        : "Inspect the current maintenance context and report back.";
    const logFile = `/tmp/opencode-${session.id.substring(0,8)}-${agent.id}${windowSuffix}.log`;
    const command = buildAgentCommand(config.repoRoot, agent, prompt, {
      plannerRuntime: config.plannerRuntime,
      copilotExecutable: config.copilotExecutable,
      copilotModel: config.copilotModel,
      opencodeExecutable: config.opencodeExecutable,
      opencodeModel,
      logFile,
    });
    const checkpointContract = parseCheckpointContractValue(plan.normalizedInput.checkpointContract);
    const checkpointState = createInitialCheckpointState(checkpointContract);

    // Log and launch agent in tmux
    const windowName = slugify(`agent-${agent.id}${windowSuffix}`);
    const launch = tmux.launchCommand(session.tmuxSessionName, windowName, command);
    const job = database.createJob({
      sessionId: session.id,
      kind: "agent",
      subjectId: agent.id,
      status: "completed",
      requiresApproval: false,
      output: {
        ...agentOutput(agent, prompt, launch.started, launch.note),
        planId: plan.id,
        planHash: plan.planHash,
        agentManifestDigest: typeof plan.normalizedInput.agentManifestDigest === "string" ? plan.normalizedInput.agentManifestDigest : null,
        promptContractId: typeof plan.normalizedInput.promptContractId === "string" ? plan.normalizedInput.promptContractId : null,
        checkpointContractId:
          typeof plan.normalizedInput.checkpointContractId === "string" ? plan.normalizedInput.checkpointContractId : null,
        checkpointContractDigest:
          typeof plan.normalizedInput.checkpointContractDigest === "string"
            ? plan.normalizedInput.checkpointContractDigest
            : null,
        checkpoints: checkpointState.checkpoints,
        activeCheckpointId: checkpointState.activeCheckpointId,
        supervisionMode: typeof plan.normalizedInput.supervisionMode === "string" ? plan.normalizedInput.supervisionMode : null
      },
      completedAt: new Date().toISOString()
    });

    const updatedPlan = database.updateExecutionPlan(plan.id, {
      status: "executed",
      executedJobId: job.id,
      runtimeHook: review(
        null,
        "passed",
        "Runtime hook observed the bounded local agent launch complete through the tmux adapter contract.",
        { jobId: job.id, started: launch.started, backend: launch.backend }
      ),
      postExecutionHook: review(
        null,
        "passed",
        "Post-exec hook captured the launch outcome and preserved the audit trail for operator takeover.",
        { jobId: job.id }
      )
    });

    database.recordSessionActivity(session.id);
    database.createAudit({
      actorId: actor.id,
      action: "execution.plan.executed",
      targetType: "execution-plan",
      targetId: plan.id,
      details: {
        targetType: plan.targetType,
        targetId: plan.targetId,
        executedJobId: job.id
      }
    });
    database.createAudit({
      actorId: actor.id,
      action: "agent.launched",
      targetType: "agent",
      targetId: agent.id,
      details: {
        sessionId: session.id,
        tmuxBackend: launch.backend,
        planId: plan.id,
        checkpointContractDigest:
          typeof plan.normalizedInput.checkpointContractDigest === "string"
            ? plan.normalizedInput.checkpointContractDigest
            : null,
        activeCheckpointId: checkpointState.activeCheckpointId
      }
    });

    return { plan: updatedPlan, job };
  }

  database.initialize();
  database.seedAdmin(config.adminUsername, config.adminPassword);
  // Load persisted dynamic runbooks
  loadDynamicRunbooks(database.listDynamicRunbooks());
  for (const user of options.bootstrapUsers || []) {
    database.createUser(user.username, user.password, user.role || "admin");
  }

  const app = Fastify({ logger: false }) as FastifyInstance & {
    processDueScheduledRunbooks?: () => Promise<void>;
  };

  const schedulerInterval = setInterval(() => {
    void processDueScheduledRunbooks();
  }, 30_000);

  app.processDueScheduledRunbooks = processDueScheduledRunbooks;

  app.addHook("onClose", async () => {
    clearInterval(schedulerInterval);
    database.close();
  });

  app.get("/api/health", async () => ({
    ok: true,
    tmuxBackend: tmux.backend,
    security: {
      modelDiversity: config.opencodeModel !== config.safetyOpencodeModel,
      agentIsolation: Boolean(config.agentBrokerSocket && existsSync(config.agentBrokerSocket)),
      typedExecutor: Boolean(config.executorBrokerSocket && existsSync(config.executorBrokerSocket)),
      warning: config.opencodeModel === config.safetyOpencodeModel
        ? "Planner and safety reviewer use the same configured model; role isolation remains, but correlated errors are more likely."
        : null,
    },
  }));

  app.post("/api/research", async (request, reply) => {
    const actor = await requireActor(request, reply, database);
    if (!actor) return;

    const body = (request.body || {}) as { prompt?: string; sessionId?: string };
    if (!body.prompt || !body.sessionId) {
      return reply.code(400).send({ message: "prompt and sessionId are required" });
    }

    // Delegate to the agent launch endpoint (same proven code path)
    const agent = findAgent("planner-agent", "opencode");
    if (!agent) return reply.code(500).send({ message: "planner not available" });

    const session = database.getSessionRuntimeTargetForActor(body.sessionId, actor.id);
    if (!session) return reply.code(404).send({ message: "session not found" });

    const plan = createAgentPlan(actor, agent, session.id, body.prompt);
    executeAgentPlan(plan, actor, agent);

    return reply.code(202).send({
      message: "research started",
      sessionId: session.id,
      note: "Planner is analyzing. Results available at GET /api/sessions/:id/output in ~45s."
    });
  });

  function extractRunnerHandoff(raw: string): string {
    const noTimestamps = raw
      .split("\n")
      .filter(l => !l.startsWith("timestamp=") && !l.startsWith("tee:") && l.trim() !== "")
      .join("\n");
    // Primary: look for ## EXECUTION RESULT handoff section
    const handoffStart = noTimestamps.search(/\n## EXECUTION RESULT/);
    if (handoffStart > 0) {
      let output = noTimestamps.slice(handoffStart + 1);
      const endMarkers = [/\nng loop"/, /\nsing instance"/, /\nroot@vmd/, /\nexec bash/];
      for (const m of endMarkers) {
        const idx = output.search(m);
        if (idx > 0) { output = output.slice(0, idx); }
      }
      return output.trim();
    }
    // Fallback: find the model's execution output
    // Runner outputs after reading the .md: "$ command", then actual stdout, then model summary
    const execIndex = noTimestamps.search(/\n\$ \/usr\/|\n\$ \w+.*&&/);
    if (execIndex > 0) {
      let output = noTimestamps.slice(execIndex + 1);
      const endMarkers = [/\nng loop"/, /\nsing instance"/, /\nroot@vmd/, /\nexec bash/];
      for (const m of endMarkers) {
        const idx = output.search(m);
        if (idx > 0) { output = output.slice(0, idx); }
      }
      return output
        .split("\n")
        .filter(l => !l.includes("/root/.local/share/opencode/snapshot/") && l.trim() !== "")
        .join("\n")
        .trim();
    }
    // Alternative: look for "EXECUTION RESULT" or "Done." or "Executing"
    const altIndex = noTimestamps.search(/\n(EXECUTION RESULT|Done\.|Executing|STATUS:)/);
    if (altIndex > 0) {
      let output = noTimestamps.slice(altIndex + 1);
      const endMarkers = [/\nng loop"/, /\nsing instance"/, /\nroot@vmd/];
      for (const m of endMarkers) {
        const idx = output.search(m);
        if (idx > 0) { output = output.slice(0, idx); }
      }
      return output
        .split("\n")
        .filter(l => !l.includes("/root/.local/share/opencode/snapshot/") && l.trim() !== "")
        .join("\n")
        .trim();
    }
    // Last resort: strip debug, keep anything that looks like content
    return noTimestamps
      .split("\n")
      .filter(l => l.length > 10 && !l.match(/^[a-z]+ \w+=\w+/))
      .join("\n")
      .trim();
  }

  function extractCleanOutput(raw: string): string {
    const noTimestamps = raw
      .split("\n")
      .filter(l => !l.startsWith("timestamp=") && !l.startsWith("tee:") && l.trim() !== "")
      .join("\n");
    // Planner output: preserve a dynamic capability fence even when it precedes legacy markdown sections.
    const capabilityStart = noTimestamps.search(
      /(?:^|\n)```(?:capability|json)?\s*\n(?=\s*\{[\s\S]{0,1000}?"version"\s*:\s*"cockpit-capability\/v1")/i
    );
    const modelStart = noTimestamps.search(/(?:^|\n)## /);
    const contentStart = capabilityStart >= 0 ? capabilityStart + (noTimestamps[capabilityStart] === "\n" ? 1 : 0)
      : modelStart >= 0 ? modelStart + (noTimestamps[modelStart] === "\n" ? 1 : 0) : -1;
    if (contentStart >= 0) {
      let output = noTimestamps.slice(contentStart);
      // Stop at trailing debug wrap noise
      const endMarkers = [/\nng loop"/, /\nsing instance"/, /\nroot@vmd/, /\nng hash=/];
      for (const m of endMarkers) {
        const idx = output.search(m);
        if (idx > 0) { output = output.slice(0, idx); }
      }
      return output.trim();
    }
    // Runner output: strip ALL debug fragments, keep only command output
    return noTimestamps
      .split("\n")
      .filter(l => {
        const t = l.trim();
        // Keep lines that look like real content
        if (t.startsWith("#") || t.startsWith("```") || t.startsWith("echo") ||
            t.startsWith("$ ") || t.startsWith("===") || t.startsWith("> ") ||
            t.startsWith("/") || t.startsWith("[") ||
            t.match(/^[A-Z][a-z]/) || t.match(/^\d/) ||
            t.includes(": ") || t.match(/^[a-z]+ [a-z]+ [a-z]+:/i) ||
            t.length > 60) return true;
        // Drop: short fragments, wrapped debug, navigation output
        if (t.length < 30 && !t.match(/^[A-Z0-9#]/)) return false;
        if (/^[a-z]+ [a-z]+="[^"]/.test(t)) return false;
        if (t.startsWith("updated=") || t.startsWith("removed=")) return false;
        return false;
      })
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  function stripHashNoise(text: string): string {
    return text
      .split("\n")
      .filter(l => {
        const t = l.trim();
        if (!t) return false;
        if (/^[0-9a-f]{20,}$/.test(t)) return false;
        if (t.includes("/root/.local/share/opencode/snapshot/")) return false;
        if (t.includes("73b976bfb76d8f75a5b24372db5108dd1a3d1d91")) return false;
        if (t.match(/^[a-z]+[.=]ses_/)) return false;
        if (t.includes("small=false agent=")) return false;
        return true;
      })
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  function pollPlannerOutput(tmuxSessionName: string, windowName: string, timeoutMs: number): string | null {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const out = execSync(
          `tmux capture-pane -t "${tmuxSessionName}:${windowName}" -p -S -1000 2>/dev/null || true`,
          { encoding: "utf-8", timeout: 5000, maxBuffer: 2 * 1024 * 1024 }
        ).trim();
        // tmux wraps at 80 cols; check for unique prefix across line breaks
        const flat = out.replace(/\n/g, "");
        if (flat.includes("exiti") && flat.includes("disposing instance")) {
          return extractCleanOutput(out);
        }
      } catch { /* retry */ }
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      const sleepMs = Math.min(2000, remaining);
      execSync(`sleep ${(sleepMs / 1000).toFixed(1)}`, { timeout: sleepMs + 2000 });
    }
    return null;
  }

  function pollAgentOutput(logFile: string, timeoutMs: number): string | null {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const out = execSync(`cat ${logFile} 2>/dev/null || true`, {
          encoding: "utf-8", timeout: 5000, maxBuffer: 2 * 1024 * 1024,
        }).trim();
        if (out.includes("disposing instance")) return out;
      } catch { }
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      execSync("sleep 2", { timeout: 4000 });
    }
    return null;
  }

  async function pollAgentLog(logFile: string, timeoutMs: number): Promise<string | null> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const output = await readFile(logFile, "utf-8");
        if (output.includes("disposing instance")) return output;
      } catch { /* log is created by the agent after startup */ }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    return null;
  }

  async function runIsolatedAgent(
    actor: UserSummary,
    session: { id: string },
    agent: AgentManifest,
    role: "planner" | "research" | "runner" | "safety" | "verifier",
    prompt: string,
    windowSuffix: string,
    timeoutMs: number,
    model = config.opencodeModel,
  ): Promise<string> {
    if (config.agentBrokerSocket) {
      return await runBrokerAgent(config.agentBrokerSocket, role, buildBrokerAgentPrompt(agent, prompt));
    }
    executeAgentPlan(createAgentPlan(actor, agent, session.id, prompt, 30_000), actor, agent, windowSuffix, model);
    const logFile = `/tmp/opencode-${session.id.substring(0,8)}-${agent.id}${windowSuffix}.log`;
    const output = await pollAgentLog(logFile, timeoutMs);
    if (!output) throw new Error(`${role} did not finish within the execution timeout`);
    return output;
  }

  async function runIndependentVerification(
    actor: UserSummary,
    session: { id: string },
    planner: AgentManifest,
    intent: string,
    reviewedPlan: string,
    runnerResult: string,
  ): Promise<string> {
    const verifierPrompt = buildAgentTask(
      `You are the verifier-agent. Independently verify the requested target state for this intent using read-only commands only. Do not trust the runner's success claim. End with exactly VERIFICATION_STATUS: passed or VERIFICATION_STATUS: failed, followed by EVIDENCE: and REASON:. Intent: ${intent}`,
      [{ source: "reviewed-plan", content: reviewedPlan }, { source: "runner-handoff", content: runnerResult }],
    );
    const verifierRaw = await runIsolatedAgent(actor, session, planner, "verifier", verifierPrompt, "-verifier", 5 * 60_000, config.safetyOpencodeModel);
    return verifierRaw
      ? filterSensitiveContent(extractCleanOutput(verifierRaw) || extractAnswer(verifierRaw))
      : "VERIFICATION_STATUS: failed\nREASON: verifier timeout";
  }

  function isolatedRunnerPrompt(proposalPath: string, planText: string): string {
    return [
      buildRunnerPrompt(proposalPath),
      "",
      "The control plane supplied the exact HMAC-bound reviewed plan below because the isolated agent cannot access control-plane storage.",
      "Execute only this content; do not read a replacement plan from another location.",
      "## REVIEWED PLAN CONTENT",
      planText,
    ].join("\n");
  }

  async function executeTypedCapabilities(planText: string, envelope: ExecutionEnvelope, manifest?: CapabilityManifest | null): Promise<string | null> {
    if (manifest) {
      if (!config.executorBrokerSocket || !config.executorBrokerSecret) throw new Error("sandbox executor broker is not configured");
      const output = await runDynamicCapability(config.executorBrokerSocket, config.executorBrokerSecret, {
        action: "capability.execute", manifest, envelope, expiresAt: envelope.expiresAt, envelopeDigest: envelope.digest,
      });
      return `## EXECUTION RESULT\nSTATUS: success\nEXIT_CODE: 0\nWHAT_RAN: ${manifest.name}\nOUTPUT: ${filterSensitiveContent(output).slice(-30000)}\nNOTES: executed from a signed, agent-authored capability manifest in the host-effect sandbox`;
    }
    if (!envelope.capabilities.includes("service.manage")) return null;
    if (!config.executorBrokerSocket || !config.executorBrokerSecret) {
      throw new Error("typed executor broker is not configured");
    }
    const script = planText.match(/```(?:bash|sh)\s*\n([\s\S]*?)```/i)?.[1] || "";
    const actions = script.split("\n").flatMap((line) => {
      const match = line.trim().match(/^(?:sudo\s+)?(?:\/usr\/bin\/)?systemctl\s+(restart|status)\s+([a-zA-Z0-9@_.-]+)$/);
      return match ? [{ action: `service.${match[1]}` as "service.restart" | "service.status", target: match[2] }] : [];
    });
    if (actions.length === 0) throw new Error("service.manage plan contains no typed service action");
    const outputs: string[] = [];
    for (const action of actions) {
      outputs.push(await runExecutorAction(config.executorBrokerSocket, config.executorBrokerSecret, {
        ...action, expiresAt: envelope.expiresAt, envelopeDigest: envelope.digest,
      }));
    }
    return `## EXECUTION RESULT\nSTATUS: success\nEXIT_CODE: 0\nWHAT_RAN: typed executor service actions\nOUTPUT: ${outputs.join("\n").slice(-10000)}\nNOTES: executed by isolated capability broker`;
  }

  function explanation(input: Partial<HermesExplanation> & Pick<HermesExplanation, "phase" | "intent" | "reason">): HermesExplanation {
    return {
      phase: input.phase,
      intent: input.intent,
      completed: input.completed || [],
      reason: input.reason,
      evidence: input.evidence || [],
      neededToContinue: input.neededToContinue || [],
      recommendedAction: input.recommendedAction || "Continue monitoring this job.",
      rollbackAvailable: input.rollbackAvailable || false,
    };
  }

  function updateHermesJob(jobId: string, status: JobRecord["status"], detail: HermesExplanation, extra: Record<string, unknown> = {}): JobRecord {
    const updated = database.updateJob(jobId, {
      status,
      output: { ...extra, explanation: detail },
      completedAt: ["running", "pending"].includes(status) ? null : new Date().toISOString(),
    });
    if (
      (status === "failed_execution" || status === "failed_verification") &&
      updated.subjectId === "hermes-change"
    ) {
      database.createAudit({
        actorId: null,
        action: "hermes.change.failed",
        targetType: "job",
        targetId: jobId,
        details: { status, reason: detail.reason, runtimeFingerprint: changeRuntimeFingerprint },
      });
    }
    return updated;
  }

  async function retainValidatedCapability(jobId: string, manifest: CapabilityManifest | null | undefined): Promise<string | null> {
    if (!manifest) return null;
    const digest = capabilityManifestHash(manifest);
    const capabilityDir = path.join(path.dirname(config.dbPath), "capabilities");
    await mkdir(capabilityDir, { recursive: true, mode: 0o700 });
    const capabilityPath = path.join(capabilityDir, `${digest}.json`);
    await writeFile(capabilityPath, JSON.stringify({ digest, validatedByJob: jobId, validatedAt: new Date().toISOString(), manifest }, null, 2), { encoding: "utf-8", mode: 0o600 });
    return capabilityPath;
  }

  async function waitForHermesJob(jobId: string, actorId: string, waitMs: number): Promise<JobRecord | null> {
    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline) {
      const job = database.getJobForActor(jobId, actorId);
      if (!job || !["pending", "running"].includes(job.status)) return job;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    return database.getJobForActor(jobId, actorId);
  }

  function stopEphemeralSession(tmuxSessionName: string, createdSession: boolean): void {
    if (!createdSession) return;
    if (!/^cockpit-hermes-(?:rb-)?[a-z0-9]+$/i.test(tmuxSessionName)) return;
    spawnSync("tmux", ["kill-session", "-t", tmuxSessionName], { timeout: 5000, encoding: "utf8" });
  }

  app.post("/api/hermes/research", async (request, reply) => {
    const actor = await requireActor(request, reply, database);
    if (!actor) return;

    const body = (request.body || {}) as { prompt?: string; intent?: string; evidence?: unknown; sessionId?: string; timeoutMs?: number };
    const requestedIntent = (body.intent || body.prompt || "").trim();
    if (requestedIntent.length < 5) {
      return reply.code(400).send({ message: "intent or prompt is required (min 5 chars)" });
    }

    const agent = findAgent("planner-agent", "opencode");
    if (!agent) return reply.code(500).send({ message: "planner not available" });

    const waitMs = Math.min(Math.max(body.timeoutMs ?? 45_000, 0), 55_000);

    // Create or reuse session
    let createdSession = false;
    let session = body.sessionId ? database.getSessionRuntimeTargetForActor(body.sessionId, actor.id) : null;
    if (!session) {
      createdSession = true;
      const sessionName = `hermes-${Date.now().toString(36)}`;
      const ensured = tmux.ensureSession(`cockpit-${sessionName}`);
      const created = database.upsertSession({
        name: sessionName,
        ownerId: actor.id,
        tmuxSessionName: ensured.name,
        tmuxBackend: ensured.backend,
        terminalUrl: null,
      });
      session = {
        id: created.id,
        name: created.name,
        tmuxSessionName: created.tmuxSessionName,
        tmuxBackend: created.tmuxBackend,
      };
    }

    const intent = requestedIntent;
    const untrustedEvidence = normalizeEvidence(body.evidence);
    const agentTask = `${buildAgentTask(intent, untrustedEvidence)}\n\nREAD_ONLY_RESEARCH_CONTRACT:\nInvestigate and report the current state. Never return an executable plan.`;
    const job = database.createJob({
      sessionId: session.id,
      kind: "agent",
      subjectId: "hermes-research",
      status: "running",
      requiresApproval: false,
      output: { explanation: explanation({ phase: "queued", intent, reason: "Research job accepted." }) },
    });

    void (async () => {
      const startedAt = Date.now();
      try {
        if (session.tmuxBackend === "disabled") {
          updateHermesJob(job.id, "blocked_prerequisite", explanation({
            phase: "finished", intent, reason: "tmux is unavailable in this runtime.",
            neededToContinue: ["Enable the tmux backend."], recommendedAction: "Restore the tmux runtime and retry.",
          }));
          return;
        }
        updateHermesJob(job.id, "running", explanation({ phase: "planning", intent, reason: "Planner is performing read-only research." }));
        const raw = await runIsolatedAgent(actor, session, agent, "research", agentTask, "", 2 * 60_000);
        const answer = filterSensitiveContent(extractCleanOutput(raw) || extractAnswer(raw));
        if (!answer || answer.length < 20 || /^>\s*build\b/i.test(answer.trim())) {
          updateHermesJob(job.id, "failed_verification", explanation({
            phase: "finished", intent,
            reason: "Planner process exited, but produced no meaningful research result.",
            completed: ["Planner process", "Sensitive-output filtering"],
            evidence: [`elapsedMs=${Date.now() - startedAt}`],
            neededToContinue: ["Inspect planner/provider health; do not treat this job as a successful answer."],
            recommendedAction: "Retry only after confirming the model provider returns content.",
          }));
          return;
        }
        updateHermesJob(job.id, "completed", explanation({
          phase: "finished", intent, reason: "Research completed successfully.",
          completed: ["Planner research", "Sensitive-output filtering"], evidence: [`elapsedMs=${Date.now() - startedAt}`],
          recommendedAction: "Use the findings to decide whether a change job is needed.",
        }), { answer, elapsedMs: Date.now() - startedAt });
      } catch (error) {
        updateHermesJob(job.id, "failed_execution", explanation({
          phase: "finished", intent, reason: error instanceof Error ? error.message : "Research failed.",
          neededToContinue: ["Inspect the job evidence and planner runtime."], recommendedAction: "Correct the prerequisite and retry.",
        }));
      } finally {
        stopEphemeralSession(session.tmuxSessionName, createdSession);
      }
    })();

    const current = await waitForHermesJob(job.id, actor.id, waitMs);
    if (current && !["pending", "running"].includes(current.status)) return current;
    return reply.code(202).send({
      jobId: job.id, sessionId: session.id, status: current?.status || "running", partial: true,
      message: "Research continues. Poll GET /api/hermes/jobs/:jobId.",
      explanation: current?.output?.explanation,
    });
  });

  app.get("/api/hermes/jobs/:jobId", async (request, reply) => {
    const actor = await requireActor(request, reply, database);
    if (!actor) return;
    const { jobId } = request.params as { jobId: string };
    const job = database.getJobForActor(jobId, actor.id);
    if (!job) return reply.code(404).send({ message: "job not found" });
    return { job };
  });

  app.post("/api/hermes/jobs/:jobId/approval", async (request, reply) => {
    const actor = await requireActor(request, reply, database);
    if (!actor) return;
    const { jobId } = request.params as { jobId: string };
    const body = (request.body || {}) as { decision?: "approved" | "rejected"; reason?: string };
    const job = database.getJobForActor(jobId, actor.id);
    if (!job) return reply.code(404).send({ message: "job not found" });
    if (job.subjectId !== "hermes-change" || job.status !== "blocked_user_approval") {
      return reply.code(409).send({ message: "job is not awaiting operator approval" });
    }
    if (!body.decision || !["approved", "rejected"].includes(body.decision)) {
      return reply.code(400).send({ message: "decision must be approved or rejected" });
    }
    const intent = typeof job.output?.explanation === "object" && job.output.explanation
      ? String((job.output.explanation as Record<string, unknown>).intent || "Approved Hermes change")
      : "Approved Hermes change";
    if (body.decision === "approved") {
      const envelope = job.output?.envelope as ExecutionEnvelope | undefined;
      const plan = job.output?.plan;
      const safety = job.output?.safety;
      const policy = job.output?.policy;
      const capabilities = job.output?.capabilities;
      const manifest = job.output?.manifest as CapabilityManifest | null | undefined;
      const envelopeErrors: string[] = [];
      if (!envelope || typeof envelope !== "object") {
        envelopeErrors.push("execution envelope missing");
      } else {
        if (!verifyExecutionEnvelopeSignature(envelope, config.executionEnvelopeSecret)) envelopeErrors.push("execution envelope signature mismatch");
        if (Date.now() > Date.parse(envelope.expiresAt)) envelopeErrors.push("execution envelope expired");
        if (envelope.jobId !== job.id || envelope.actorId !== actor.id || envelope.sessionId !== job.sessionId) envelopeErrors.push("execution envelope binding mismatch");
        if (envelope.intentHash !== hashCanonical(intent)) envelopeErrors.push("trusted intent drift");
        if (envelope.planHash !== hashCanonical(plan)) envelopeErrors.push("reviewed plan drift");
        if (envelope.safetyHash !== hashCanonical(safety)) envelopeErrors.push("safety review drift");
        if (envelope.policyHash !== hashCanonical(policy)) envelopeErrors.push("policy decision drift");
        if (JSON.stringify(envelope.capabilities) !== JSON.stringify(capabilities)) envelopeErrors.push("capability drift");
        if (envelope.manifestHash !== (manifest ? capabilityManifestHash(manifest) : undefined)) envelopeErrors.push("capability manifest drift");
      }
      if (envelopeErrors.length > 0) {
        const blocked = updateHermesJob(job.id, "blocked_policy", explanation({
          phase: "finished", intent, reason: "The approved execution envelope is expired or no longer matches the reviewed action.",
          evidence: envelopeErrors, neededToContinue: ["Create a fresh plan and review; do not reuse this approval."],
          recommendedAction: "Submit a new change job for the same trusted intent.",
        }), { ...job.output, envelopeErrors });
        database.createAudit({ actorId: actor.id, action: "hermes.change.approval_invalid", targetType: "job", targetId: job.id, details: { envelopeErrors } });
        return reply.code(409).send({ message: "execution envelope validation failed", job: blocked });
      }
    }
    database.createAudit({
      actorId: actor.id, action: `hermes.change.${body.decision}`, targetType: "job", targetId: job.id,
      details: { reason: body.reason?.trim() || null },
    });
    if (body.decision === "rejected") {
      const rejected = updateHermesJob(job.id, "rejected", explanation({
        phase: "finished", intent, reason: body.reason?.trim() || "Operator rejected the proposed change.",
        completed: ["Planner proposal", "Safety review", "Policy evaluation", "Operator decision"],
        recommendedAction: "Narrow or revise the intent before submitting a new change job.",
        rollbackAvailable: Boolean((job.output?.policy as Record<string, unknown> | undefined)?.rollbackAvailable),
      }), { ...job.output, approval: { decision: "rejected", reason: body.reason?.trim() || null, actorId: actor.id } });
      return { job: rejected };
    }

    const proposalPath = typeof job.output?.proposalPath === "string" ? path.resolve(job.output.proposalPath) : "";
    const proposalRoot = path.resolve(path.join(path.dirname(config.dbPath), "proposals"));
    if (!proposalPath.startsWith(`${proposalRoot}${path.sep}`)) {
      return reply.code(409).send({ message: "stored proposal path is outside the protected proposal directory" });
    }
    const session = job.sessionId ? database.getSessionRuntimeTargetForActor(job.sessionId, actor.id) : null;
    const planner = findAgent("planner-agent", "opencode");
    if (!session || session.tmuxBackend === "disabled" || !planner) {
      const blocked = updateHermesJob(job.id, "blocked_prerequisite", explanation({
        phase: "finished", intent, reason: "Approval was recorded, but the executor runtime is unavailable.",
        neededToContinue: ["Restore the tmux and planner runtime."],
        recommendedAction: "Restore the prerequisite and submit a new change job.",
      }), { ...job.output, approval: { decision: "approved", reason: body.reason?.trim() || null, actorId: actor.id } });
      return { job: blocked };
    }
    try {
      await readFile(proposalPath, "utf-8");
    } catch {
      return reply.code(409).send({ message: "stored proposal is no longer available" });
    }

    const running = updateHermesJob(job.id, "running", explanation({
      phase: "executing", intent, reason: "Operator approval recorded; the reviewed proposal is executing with the service account's bounded permissions.",
      completed: ["Planner proposal", "Safety review", "Policy evaluation", "Operator approval"],
      recommendedAction: "Poll this job until execution and verification finish.",
      rollbackAvailable: Boolean((job.output?.policy as Record<string, unknown> | undefined)?.rollbackAvailable),
    }), {
      ...job.output,
      envelope: approveExecutionEnvelope(job.output?.envelope as ExecutionEnvelope, config.executionEnvelopeSecret, config.approvalTtlMinutes),
      approval: { decision: "approved", reason: body.reason?.trim() || null, actorId: actor.id },
    });

    void (async () => {
      try {
        const reviewedPlan = typeof job.output?.plan === "string" ? job.output.plan : "";
        const envelope = running.output?.envelope as ExecutionEnvelope;
        const manifest = running.output?.manifest as CapabilityManifest | null | undefined;
        const typedResult = await executeTypedCapabilities(reviewedPlan, envelope, manifest);
        const raw = typedResult || await runIsolatedAgent(actor, session, planner, "runner", isolatedRunnerPrompt(proposalPath, reviewedPlan), "-runner", 10 * 60_000);
        const result = typedResult || filterSensitiveContent(extractRunnerHandoff(raw));
        const runnerSuccess = /STATUS:\s*success/i.test(result);
        const verification = runnerSuccess
          ? await runIndependentVerification(actor, session, planner, intent, reviewedPlan, result)
          : "VERIFICATION_STATUS: failed\nREASON: runner did not report success";
        const success = runnerSuccess && /VERIFICATION_STATUS:\s*passed/i.test(verification);
        const retainedCapability = success ? await retainValidatedCapability(job.id, manifest) : null;
        updateHermesJob(job.id, success ? "completed" : "failed_verification", explanation({
          phase: "finished", intent,
          reason: success ? "Approved execution and verification completed." : "Approved execution did not report verified success.",
          completed: ["Planner proposal", "Safety review", "Policy evaluation", "Operator approval", "Runner execution", "Independent verification", "Result collection"],
          neededToContinue: success ? [] : ["Inspect the structured runner result and complete verification or rollback."],
          recommendedAction: success ? "No further action is required." : "Resolve the reported verification issue.",
          rollbackAvailable: Boolean((job.output?.policy as Record<string, unknown> | undefined)?.rollbackAvailable),
        }), { ...running.output, retainedCapability, result, verification });
      } catch (error) {
        updateHermesJob(job.id, "failed_execution", explanation({
          phase: "finished", intent, reason: error instanceof Error ? error.message : "Approved execution failed.",
          neededToContinue: ["Inspect the preserved proposal and execution session."],
          recommendedAction: "Correct the reported prerequisite or perform the documented rollback.",
        }), { ...running.output });
      }
    })();
    return reply.code(202).send({ job: running, message: "Approval recorded; execution started. Poll the job endpoint." });
  });

  app.get("/api/pipeline/health", async (request, reply) => {
    const actor = await requireActor(request, reply, database);
    if (!actor) return;

    const runs = database.getLatestPipelineRuns();
    return {
      status: runs.lastRunner ? "healthy" : "initializing",
      lastPlannerRun: runs.lastPlanner,
      lastRunnerRun: runs.lastRunner,
      activeSessions: runs.activeSessions,
      activeOrders: activeOrders.size,
      dynamicRunbooks: listDynamicRunbooks().length,
      builtinRunbooks: RUNBOOKS.length,
    };
  });

  app.post("/api/auth/login", async (request, reply) => {
    const body = (request.body || {}) as { username?: string; password?: string };
    if (!body.username || !body.password) {
      return reply.code(400).send({ message: "username and password are required" });
    }

    const loginKey = `${request.ip}:${body.username.toLowerCase()}`;
    const existingAttempt = loginAttempts.get(loginKey);
    const currentTime = Date.now();
    if (existingAttempt && existingAttempt.blockedUntil > currentTime) {
      return reply.code(429).send({ message: "too many login attempts, try again later" });
    }

    const actor = database.authenticateUser(body.username, body.password);
    if (!actor) {
      const nextAttempt =
        existingAttempt && currentTime - existingAttempt.windowStartedAt <= LOGIN_WINDOW_MS
          ? { ...existingAttempt, count: existingAttempt.count + 1 }
          : { count: 1, windowStartedAt: currentTime, blockedUntil: 0 };

      if (nextAttempt.count >= MAX_LOGIN_ATTEMPTS) {
        nextAttempt.blockedUntil = currentTime + LOGIN_BLOCK_MS;
      }

      loginAttempts.set(loginKey, nextAttempt);
      database.createAudit({
        actorId: null,
        action: "auth.login_failed",
        targetType: "user",
        targetId: null,
        details: {
          username: body.username,
          sourceIp: request.ip,
          blockedUntil: nextAttempt.blockedUntil || null
        }
      });
      return reply.code(401).send({ message: "invalid credentials" });
    }

    if (actor.role !== "admin") {
      database.createAudit({ actorId: actor.id, action: "auth.login_forbidden", targetType: "user", targetId: actor.id, details: { username: actor.username } });
      return reply.code(403).send({ message: "interactive login is not available for this account" });
    }

    loginAttempts.delete(loginKey);
    const token = database.issueAuthSession(actor.id, config.sessionTtlHours);
    database.createAudit({
      actorId: actor.id,
      action: "auth.login",
      targetType: "user",
      targetId: actor.id,
      details: { username: actor.username }
    });

    reply.header(
      "set-cookie",
      serializeAuthCookie(token, config.sessionTtlHours * 60 * 60, config.cookieSecure)
    );

    return { user: actor };
  });

  app.post("/api/auth/logout", async (request, reply) => {
    const token = parseCookies(request.headers.cookie)[AUTH_COOKIE];
    if (token) {
      const actor = database.findUserByAuthToken(token);
      database.revokeAuthToken(token);
      if (actor) {
        database.createAudit({
          actorId: actor.id,
          action: "auth.logout",
          targetType: "user",
          targetId: actor.id,
          details: { username: actor.username }
        });
      }
    }

    reply.header("set-cookie", clearAuthCookie(config.cookieSecure));
    return { ok: true };
  });

  app.get("/api/me", async (request, reply) => {
    const actor = await requireActor(request, reply, database);
    if (!actor) {
      return;
    }

    return { user: actor };
  });

  app.get("/api/sessions", async (request, reply) => {
    const actor = await requireActor(request, reply, database);
    if (!actor) {
      return;
    }

    return { sessions: database.listSessionsForActor(actor.id) };
  });

  app.post("/api/sessions", async (request, reply) => {
    const actor = await requireActor(request, reply, database);
    if (!actor) {
      return;
    }

    const body = (request.body || {}) as { name?: string };
    const sessionSlug = slugify(body.name || "");
    if (!sessionSlug) {
      return reply.code(400).send({ message: "session name must include letters or numbers" });
    }

    const tmuxSessionName = `cockpit-${sessionSlug}`;
    const ensured = tmux.ensureSession(tmuxSessionName);
    let session;
    try {
      session = database.upsertSession({
        name: sessionSlug,
        ownerId: actor.id,
        tmuxSessionName,
        tmuxBackend: ensured.backend,
        terminalUrl: null
      });
    } catch (error) {
      if (error instanceof Error && error.message.includes("another operator")) {
        return reply.code(409).send({ message: "session name already belongs to another operator" });
      }

      throw error;
    }
    session = database.updateSessionTerminalUrl(
      session.id,
      terminalUrl(config.ttydBaseUrl, session.id, terminalSigningSecret)
    );
    database.recordSessionActivity(session.id);

    const job = database.createJob({
      sessionId: session.id,
      kind: "session.ensure",
      subjectId: session.id,
      status: "completed",
      requiresApproval: false,
      output: {
        summary: "Cockpit session ensured.",
        backend: ensured.backend,
        sessionId: session.id,
        requestedBy: actor.username
      },
      completedAt: new Date().toISOString()
    });

    database.createAudit({
      actorId: actor.id,
      action: "session.ensure",
      targetType: "cockpit-session",
      targetId: session.id,
      details: {
        sessionName: session.name,
        tmuxBackend: session.tmuxBackend
      }
    });

    return reply.code(201).send({ session, job });
  });

  app.get("/api/sessions/:sessionId", async (request, reply) => {
    const actor = await requireActor(request, reply, database);
    if (!actor) {
      return;
    }

    const { sessionId } = request.params as { sessionId: string };
    const session = database.getSessionByIdForActor(sessionId, actor.id);
    if (!session) {
      return reply.code(404).send({ message: "session not found" });
    }

    const plansList = database.listExecutionPlansForSession(sessionId);
    const lastPlan = plansList[0];
    const elapsed = lastPlan ? Math.floor((Date.now() - new Date(lastPlan.createdAt).getTime()) / 1000) : 0;
    const isRunning = elapsed > 0 && elapsed < 60; // Planner takes ~45s

    return {
      session,
      plans: plansList,
      jobs: database.listJobsForSession(sessionId),
      progress: {
        status: isRunning ? "running" : plansList.length > 0 ? "completed" : "idle",
        elapsedSeconds: elapsed,
        hint: isRunning ? `Still working (${elapsed}s elapsed). Poll again in ${60 - elapsed}s.` : plansList.length > 0 ? "Output available at /api/sessions/:id/output" : "No activity yet"
      },
      runnerResults: database.getRunbookResultsForSession(sessionId) || [],
    };
  });

  app.get("/api/sessions/:sessionId/output", async (request, reply) => {
    const actor = await requireActor(request, reply, database);
    if (!actor) return;

    const { sessionId } = request.params as { sessionId: string };
    const session = database.getSessionByIdForActor(sessionId, actor.id);
    if (!session) return reply.code(404).send({ message: "session not found" });

    try {
      const { execSync } = await import("node:child_process");
      const outputs: Record<string, string> = {};

      // Primary: capture all windows in the session (deep scrollback)
      const windowsRaw = execSync(
        `tmux list-windows -t "${session.tmuxSessionName}" -F '#{window_name}' 2>/dev/null || true`,
        { encoding: "utf-8", timeout: 3000 }
      ).trim();
      const windows = windowsRaw ? windowsRaw.split("\n") : ["main"];

      for (const w of windows) {
        const out = execSync(
          `tmux capture-pane -t "${session.tmuxSessionName}:${w}" -p -S -2000 2>/dev/null || true`,
          { encoding: "utf-8", timeout: 5000, maxBuffer: 2 * 1024 * 1024 }
        ).trim();
        if (out) outputs[w] = out;
      }
      return { outputs };
    } catch {
      return { outputs: { error: "capture failed" } };
    }
  });

  app.get("/api/runbooks", async (request, reply) => {
    const actor = await requireActor(request, reply, database);
    if (!actor) {
      return;
    }

    return { runbooks: [...RUNBOOKS, ...listDynamicRunbooks()] };
  });

  app.post("/api/runbooks", async (request, reply) => {
    const actor = await requireActor(request, reply, database);
    if (!actor) {
      return;
    }
    if (config.agentBrokerSocket) {
      return reply.code(410).send({
        message: "legacy dynamic runbook generation is disabled under identity isolation; use /api/hermes/runbook",
      });
    }

    const body = (request.body || {}) as {
      prompt?: string;
      sessionId?: string;
    };

    if (!body.prompt || !body.sessionId) {
      return reply.code(400).send({
        message: "prompt and sessionId are required. Describe what the runbook should do."
      });
    }

    if (body.prompt.length < 10 || body.prompt.length > 2000) {
      return reply.code(400).send({ message: "prompt must be 10-2000 characters" });
    }

    const session = database.getSessionByIdForActor(body.sessionId, actor.id);
    if (!session) {
      return reply.code(404).send({ message: "session not found" });
    }

    // Launch the planner agent to generate the runbook
    // Rate limiting: max 1 order per session
    if (activeOrders.has(session.id)) {
      return reply.code(429).send({ message: "Another runbook order is already in progress for this session. Wait 60s and retry." });
    }
    activeOrders.add(session.id);

    const plannerAgent = findAgent("planner-agent", "opencode");
    if (!plannerAgent) {
      return reply.code(500).send({ message: "planner agent not available" });
    }

    const enhancedPrompt = `Create a new Cockpit runbook. ${body.prompt}

Follow these rules:
1. Write the shell script to /opt/wireguard-ops-cockpit/bin/<slug>.sh
2. The script must be idempotent and safe to re-run
3. No destructive operations (rm -rf, dd, etc.) unless explicitly requested
4. Output the runbook definition as JSON with fields: id, name, summary, requiresApproval, privilegedHelperRequested
5. Use a descriptive kebab-case id based on the task`;

    const plan = createAgentPlan(actor, plannerAgent, session.id, enhancedPrompt);

    database.createAudit({
      actorId: actor.id,
      action: "runbook.dynamic.ordered",
      targetType: "execution-plan",
      targetId: plan.id,
      details: {
        prompt: body.prompt.slice(0, 240),
        sessionId: session.id,
      },
    });

    if (plannerAgent.requiresApproval) {
      return reply.code(202).send({
        message: "runbook order submitted for approval",
        planId: plan.id,
        ...createPendingApprovalForPlan(plan, actor, "Planner agent requires approval before generating the runbook script."),
      });
    }

    const executed = executeAgentPlan(plan, actor, plannerAgent);
    const orderPrompt = body.prompt!; // Validated non-null above

    // Auto-register pipeline: plan → save → execute → notify → cleanup
    const autoRegister = async () => {
      try {
        // Wait for planner to finish producing output
        await new Promise(r => setTimeout(r, 45000));
        activeOrders.delete(session.id);
        const { execSync } = await import("node:child_process");

        // Read planner output (log file first, tmux fallback)
        let raw = "";
        try { raw = execSync("cat /tmp/opencode-last.log 2>/dev/null || true", { encoding: "utf-8", timeout: 3000, maxBuffer: 2 * 1024 * 1024 }).trim(); } catch { }
        if (raw.length < 100) {
          try { raw = execSync(`tmux capture-pane -t "${session.tmuxSessionName}:${slugify(`agent-${plannerAgent.id}`)}" -p -S -300 2>/dev/null || true`, { encoding: "utf-8", timeout: 5000, maxBuffer: 2 * 1024 * 1024 }).trim(); } catch { }
        }
        if (!raw || raw.length < 20) return;

        // Create runbook
        const name = orderPrompt.slice(0, 60).replace(/[^a-zA-Z0-9 ]/g, "").trim() || "Generated Runbook";
        const rbId = "gen-" + name.toLowerCase().replace(/\s+/g, "-").slice(0, 50);
        const scriptName = `${rbId}.md`;
        const scriptPath = `/opt/wireguard-ops-cockpit/bin/${scriptName}`;
        const mdContent = [`# ${name}`,`> Generated ${new Date().toISOString()}`,"","## Prompt",orderPrompt,"","## Planner Output","```",raw.replace(/```/g, "'''"),"```"].join("\n");
        execSync(`mkdir -p /opt/wireguard-ops-cockpit/bin && cat > ${scriptPath} && chmod 644 ${scriptPath}`, { input: mdContent, encoding: "utf-8" });

        const runbook: RunbookDefinition = {
          id: rbId, name, summary: orderPrompt.slice(0, 200), requiresSession: true, requiresApproval: false,
          integration: "host-tmux", privilegedHelperRequested: false, reviewStatus: "allowlisted",
          scriptIds: [scriptName], workflowSteps: [{ id: "analyze-and-execute", label: `OpenCode: ${scriptName}`, description: orderPrompt.slice(0, 200), kind: "runbook" }],
        };
        registerDynamicRunbook(runbook);
        database.createDynamicRunbook({ id: rbId, name, summary: orderPrompt.slice(0, 200), requiresApproval: false, privilegedHelper: false, scriptId: scriptName, createdBy: actor.id });

        // Save planner result
        const resultId = `res-${rbId}`;
        database.saveRunbookResult({ id: resultId, runbookId: rbId, sessionId: session.id, status: "planned", exitCode: 0, outputText: raw.substring(0, 10000), outputPath: scriptPath });
        database.createAudit({ actorId: actor.id, action: "runbook.dynamic.created", targetType: "runbook", targetId: rbId, details: { name, script: scriptName } });

        // Launch runner with runner-specific prompt
        const runnerAgent = findAgent("planner-agent", "opencode");
        if (runnerAgent) {
          const runnerPrompt = buildRunnerPrompt(scriptPath);
          const runnerPlan = createAgentPlan(actor, runnerAgent, session.id, runnerPrompt);
          executeAgentPlan(runnerPlan, actor, runnerAgent);

          // Wait for runner, save results
          setTimeout(async () => {
            await new Promise(r => setTimeout(r, 30000));
            let runnerOutput = "";
            try { runnerOutput = execSync("cat /tmp/opencode-last.log 2>/dev/null || true", { encoding: "utf-8", timeout: 3000, maxBuffer: 2 * 1024 * 1024 }).trim(); } catch { }
            database.saveRunbookResult({
              id: `res-${rbId}-run`, runbookId: rbId, sessionId: session.id,
              status: "executed", exitCode: 0,
              outputText: runnerOutput.substring(0, 5000),
              outputPath: `/tmp/opencode-last.log`,
            });
            database.createAudit({ actorId: actor.id, action: "runbook.runner.completed", targetType: "runbook", targetId: rbId, details: { outputLength: runnerOutput.length } });
          }, 0);
        }
      } catch { /* fire-and-forget — best effort */ }
    };
    autoRegister();

    return reply.code(201).send({
      message: "runbook generation started",
      planId: executed.plan?.id ?? plan.id,
      sessionId: session.id,
      note: "The planner agent is generating the runbook script. Poll GET /api/sessions/:id/output for results.",
    });
  });

  // ── Hermes durable runbook adapter ─────────────────────────────────────

  app.post("/api/hermes/runbook", async (request, reply) => {
    const actor = await requireActor(request, reply, database);
    if (!actor) return;
    const body = (request.body || {}) as { prompt?: string; intent?: string; evidence?: unknown; allowedCapabilities?: unknown; sessionId?: string; timeoutMs?: number; execute?: boolean };
    const requestedIntent = (body.intent || body.prompt || "").trim();
    if (requestedIntent.length < 10) {
      return reply.code(400).send({ message: "intent or prompt is required (min 10 chars)" });
    }
    const waitMs = Math.min(Math.max(body.timeoutMs ?? 50_000, 0), 55_000);
    const shouldExecute = body.execute !== false;
    let createdSession = false;
    let session = body.sessionId ? database.getSessionRuntimeTargetForActor(body.sessionId, actor.id) : null;
    if (!session) {
      createdSession = true;
      const sessionName = `hermes-rb-${Date.now().toString(36)}`;
      const ensured = tmux.ensureSession(`cockpit-${sessionName}`);
      const created = database.upsertSession({
        name: sessionName, ownerId: actor.id, tmuxSessionName: ensured.name,
        tmuxBackend: ensured.backend, terminalUrl: null,
      });
      session = { id: created.id, name: created.name, tmuxSessionName: created.tmuxSessionName, tmuxBackend: created.tmuxBackend };
    }

    const intent = requestedIntent;
    const untrustedEvidence = normalizeEvidence(body.evidence);
    const allowedCapabilities = normalizeAllowedCapabilities(body.allowedCapabilities);
    const agentTask = `${buildAgentTask(intent, untrustedEvidence)}\n\nDYNAMIC CAPABILITY CONTRACT:\n${capabilityPlannerContract()}`;
    const job = database.createJob({
      sessionId: session.id, kind: "runbook", subjectId: "hermes-change",
      status: "running", requiresApproval: false,
      output: { explanation: explanation({ phase: "queued", intent, reason: "Change job accepted." }) },
    });

    void (async () => {
      const startedAt = Date.now();
      try {
        const failureWindowStart = new Date(Date.now() - 60 * 60_000).toISOString();
        const recentFailures = database.countAuditsSinceForRuntime("hermes.change.failed", failureWindowStart, changeRuntimeFingerprint);
        if (recentFailures >= config.maxFailedChangesPerHour) {
          updateHermesJob(job.id, "blocked_prerequisite", explanation({
            phase: "finished", intent,
            reason: `Circuit breaker is open after ${recentFailures} failed change jobs in the last hour.`,
            evidence: [`failureCount=${recentFailures}`, `windowStart=${failureWindowStart}`, `runtimeFingerprint=${changeRuntimeFingerprint}`],
            neededToContinue: ["Wait for the failure window to clear or have an operator diagnose the repeated failures."],
            recommendedAction: "Do not retry automatically; inspect recent failed jobs first.",
          }));
          return;
        }
        if (session.tmuxBackend === "disabled") {
          updateHermesJob(job.id, "blocked_prerequisite", explanation({
            phase: "finished", intent, reason: "tmux is unavailable in this runtime.",
            neededToContinue: ["Enable the tmux backend."], recommendedAction: "Restore the executor runtime and retry.",
          }));
          return;
        }
        const planner = findAgent("planner-agent", "opencode");
        if (!planner) throw new Error("planner not available");
        updateHermesJob(job.id, "running", explanation({ phase: "planning", intent, reason: "Planner is producing a structured change plan." }));
        const plannerRaw = await runIsolatedAgent(actor, session, planner, "planner", agentTask, "", 5 * 60_000);
        const planText = filterSensitiveContent(extractCleanOutput(plannerRaw));
        if (!planText || planText.length < 20) throw new Error("planner produced no reviewable plan");

        const proposalDir = path.join(path.dirname(config.dbPath), "proposals");
        await mkdir(proposalDir, { recursive: true, mode: 0o700 });
        const proposalPath = path.join(proposalDir, `${job.id}.md`);
        await writeFile(proposalPath, planText, { encoding: "utf-8", mode: 0o600 });
        const proposal: RunbookDefinition = {
          id: `proposal-${job.id}`, name: intent.slice(0, 60), summary: intent,
          requiresSession: true, requiresApproval: false, integration: "host-tmux",
          privilegedHelperRequested: false, reviewStatus: "allowlisted", scriptIds: [proposalPath],
          workflowSteps: [{ id: "execute", label: "Execute reviewed proposal", description: intent, kind: "runbook" }],
        };

        updateHermesJob(job.id, "running", explanation({
          phase: "reviewing", intent, reason: "Independent safety review and hard-boundary policy are evaluating the proposal.",
          completed: ["Structured planner proposal"], evidence: [proposalPath],
        }), { plan: planText, proposalPath });
        const review = await safetyReviewRunner({
          runbook: proposal, runbookVersionHash: computeRunbookVersionHash(proposal), riskClass: "moderate",
          sessionId: session.id, trigger: "manual", scheduleId: null,
        }, { ...config, opencodeModel: config.safetyOpencodeModel });
        let policy = evaluatePlanPolicy(planText, review.verdict);
        const manifest = parseCapabilityManifest(planText);
        const manifestHash = manifest ? capabilityManifestHash(manifest) : undefined;
        const nextcloudMutationModes = new Set(["php-install", "php-enable", "exapp-catalog-refresh", "exapp-register"]);
        const semanticMutation = manifest?.steps.some((step) => step.argv[0] === "/usr/local/sbin/cockpit-nextcloud-app-action" && nextcloudMutationModes.has(step.argv[1] || "")) ?? false;
        const capabilities: CapabilityId[] = manifest ? [manifest.writablePaths.length > 0 || semanticMutation ? "filesystem.write" : "read.host"] : classifyCapabilities(planText);
        const capabilityEscalation = capabilities.filter((capability) => !allowedCapabilities.includes(capability));
        if (!manifest && policy.allowed && capabilityEscalation.length > 0) {
          policy = {
            ...policy,
            zone: "red",
            allowed: false,
            status: "blocked_user_approval",
            reason: "The proposed plan exceeds the capabilities authorized by the trusted request.",
            evidence: [...policy.evidence, ...capabilityEscalation.map((capability) => `unauthorized capability: ${capability}`)],
            neededToContinue: ["Authorize the exact capability from trusted operator intent or narrow the plan."],
          };
        }
        if (!manifest && policy.allowed && capabilities.includes("shell.exception")) {
          policy = {
            ...policy,
            zone: "red",
            allowed: false,
            status: "blocked_user_approval",
            reason: "The plan requires unrestricted shell semantics outside the typed capability contract.",
            evidence: [...policy.evidence, "capability: shell.exception"],
            neededToContinue: ["Explicit operator approval or rewrite the plan using typed capabilities."],
          };
        }
        const unsupportedAutonomousCapabilities = capabilities.filter((capability) =>
          capability !== "read.host" && capability !== "service.manage" && capability !== "shell.exception"
        );
        if (!manifest && policy.allowed && unsupportedAutonomousCapabilities.length > 0) {
          policy = {
            ...policy,
            allowed: false,
            status: "blocked_prerequisite",
            reason: "The requested capability does not yet have a typed executor helper.",
            evidence: unsupportedAutonomousCapabilities.map((capability) => `missing typed helper: ${capability}`),
            neededToContinue: ["Install and review a narrow typed helper; do not fall back to agent shell execution."],
          };
        }
        if (manifest && policy.allowed && capabilityNeedsOperatorApproval(manifest)) {
          policy = {
            ...policy, zone: "red", allowed: false, status: "blocked_user_approval",
            reason: "The dynamic capability can expose a service, lose existing data, or cross an identity/secret boundary.",
            evidence: [...policy.evidence, ...manifest.risk.map((risk) => `declared risk: ${risk}`), `network: ${manifest.network}`],
            neededToContinue: ["Confirm this exact signed capability manifest."],
          };
        }
        const envelope = createExecutionEnvelope({
          jobId: job.id, actorId: actor.id, sessionId: session.id, intent,
          evidence: untrustedEvidence, plan: planText, safety: review, policy, capabilities,
          manifestHash, ttlMinutes: config.approvalTtlMinutes, signingSecret: config.executionEnvelopeSecret,
        });
        const provenance = {
          trustedIntentHash: hashCanonical(intent),
          untrustedEvidence: envelope.evidence,
          allowedCapabilities,
          injectionBoundary: "trusted-intent/untrusted-evidence-v1",
        };
        if (!policy.allowed) {
          updateHermesJob(job.id, policy.status === "ready" ? "failed_execution" : policy.status, explanation({
            phase: "finished", intent, reason: policy.reason,
            completed: ["Planner proposal", "Safety review", "Policy evaluation"],
            evidence: [review.summary, ...policy.evidence], neededToContinue: policy.neededToContinue,
            recommendedAction: policy.status === "blocked_user_approval" ? "Ask the operator to approve or narrow the plan." : "Revise the plan as indicated.",
            rollbackAvailable: policy.rollbackAvailable,
          }), { plan: planText, safety: review, policy, capabilities, manifest, envelope, provenance, proposalPath });
          return;
        }
        if (!shouldExecute) {
          updateHermesJob(job.id, "completed", explanation({
            phase: "finished", intent, reason: "Plan-only request completed without execution.",
            completed: ["Planner proposal", "Safety review", "Policy evaluation"],
            evidence: [review.summary, ...policy.evidence], recommendedAction: "Submit an execution request if this plan should run.",
            rollbackAvailable: policy.rollbackAvailable,
          }), { plan: planText, safety: review, policy, capabilities, manifest, envelope, provenance, proposalPath, result: "" });
          return;
        }

        updateHermesJob(job.id, "running", explanation({
          phase: "executing", intent, reason: policy.reason,
          completed: ["Planner proposal", "Safety review", "Policy evaluation"],
          evidence: [review.summary, ...policy.evidence], rollbackAvailable: policy.rollbackAvailable,
        }), { plan: planText, safety: review, policy, capabilities, manifest, envelope, provenance, proposalPath });
        const typedResult = await executeTypedCapabilities(planText, envelope, manifest);
        const runnerRaw = typedResult || await runIsolatedAgent(actor, session, planner, "runner", isolatedRunnerPrompt(proposalPath, planText), "-runner", 10 * 60_000);
        const result = typedResult || filterSensitiveContent(extractRunnerHandoff(runnerRaw));
        if (!result) throw new Error("runner produced no structured execution result");
        const runnerSuccess = /STATUS:\s*success/i.test(result);
        let verification = "VERIFICATION_STATUS: failed\nREASON: runner did not report success";
        if (runnerSuccess) {
          const verifierPrompt = buildAgentTask(
            `You are the verifier-agent. Independently verify the requested target state for this intent. Do not trust the runner's STATUS claim. First evaluate the supplied signed runner handoff's raw command output; when it directly proves every requested condition, do not call redundant tools. Otherwise use focused read-only commands only. Do not repair anything. Your final response is mandatory and must end with exactly VERIFICATION_STATUS: passed or VERIFICATION_STATUS: failed, followed by EVIDENCE: and REASON:. Never stop after announcing an intended check. Intent: ${intent}`,
            [{ source: "reviewed-plan", content: planText }, { source: "runner-handoff", content: result }],
          );
          const verifierRaw = await runIsolatedAgent(actor, session, planner, "verifier", verifierPrompt, "-verifier", 5 * 60_000, config.safetyOpencodeModel);
          verification = filterSensitiveContent(extractCleanOutput(verifierRaw) || extractAnswer(verifierRaw));
        }
        const success = runnerSuccess && /VERIFICATION_STATUS:\s*passed/i.test(verification);
        const retainedCapability = success ? await retainValidatedCapability(job.id, manifest) : null;
        updateHermesJob(job.id, success ? "completed" : "failed_verification", explanation({
          phase: "finished", intent,
          reason: success ? "Execution and runner verification completed." : "Execution finished but did not report a verified success.",
          completed: ["Planner proposal", "Safety review", "Policy evaluation", "Runner execution", "Independent verification", "Result collection"],
          evidence: [review.summary, ...policy.evidence, ...(retainedCapability ? [`validated capability: ${retainedCapability}`] : []), `elapsedMs=${Date.now() - startedAt}`],
          neededToContinue: success ? [] : ["Inspect the structured runner result and complete the failed verification."],
          recommendedAction: success ? "No further action is required." : "Correct the reported issue or perform rollback.",
          rollbackAvailable: policy.rollbackAvailable,
        }), { plan: planText, safety: review, policy, capabilities, manifest, envelope, provenance, proposalPath, retainedCapability, result, verification, elapsedMs: Date.now() - startedAt });
      } catch (error) {
        const preservedOutput = database.getJobForActor(job.id, actor.id)?.output || {};
        updateHermesJob(job.id, "failed_execution", explanation({
          phase: "finished", intent, reason: error instanceof Error ? error.message : "Change job failed.",
          neededToContinue: ["Inspect the preserved proposal, session, and job evidence."],
          recommendedAction: "Resolve the reported prerequisite before retrying.",
        }), preservedOutput);
      } finally {
        stopEphemeralSession(session.tmuxSessionName, createdSession);
      }
    })();

    const current = await waitForHermesJob(job.id, actor.id, waitMs);
    if (current && !["pending", "running"].includes(current.status)) return current;
    return reply.code(202).send({
      jobId: job.id, sessionId: session.id, status: current?.status || "running", partial: true,
      message: "Change job continues. Poll GET /api/hermes/jobs/:jobId.", explanation: current?.output?.explanation,
    });
  });

  // Historical adapter kept temporarily for response-shape comparison only.
  // It is unreachable from the documented Hermes route and never used by the skill.

  app.post("/api/internal/legacy-hermes-runbook", async (request, reply) => {
    return reply.code(410).send({ message: "legacy Hermes runbook adapter is disabled" });
    /* Legacy blocking implementation retained temporarily for migration notes.
    const actor = await requireActor(request, reply, database);
    if (!actor) return;

    const body = (request.body || {}) as { prompt?: string; sessionId?: string; timeoutMs?: number; execute?: boolean };
    if (!body.prompt || body.prompt.length < 10) {
      return reply.code(400).send({ message: "prompt is required (min 10 chars)" });
    }
    const shouldExecute = body.execute !== false;

    const startTime = Date.now();
    const totalTimeout = Math.min(body.timeoutMs || 50_000, 600_000); // default 50s, max 10min

    // 1. Create or reuse session
    let createdSession = false;
    let session = body.sessionId ? database.getSessionRuntimeTargetForActor(body.sessionId, actor.id) : null;
    if (!session) {
      createdSession = true;
      const sessionName = `hermes-rb-${Date.now().toString(36)}`;
      const ensured = tmux.ensureSession(`cockpit-${sessionName}`);
      const created = database.upsertSession({
        name: sessionName,
        ownerId: actor.id,
        tmuxSessionName: ensured.name,
        tmuxBackend: ensured.backend,
        terminalUrl: null,
      });
      session = {
        id: created.id,
        name: created.name,
        tmuxSessionName: created.tmuxSessionName,
        tmuxBackend: created.tmuxBackend,
      };
    }

    const cleanup = () => {
      if (createdSession) {
        try { execSync(`tmux kill-session -t "${session.tmuxSessionName}" 2>/dev/null || true`, { timeout: 5000 }); } catch {}
      }
    };

    // 2. Order the runbook (planner + autoRegister pipeline)
    const plannerAgent = findAgent("planner-agent", "opencode");
    if (!plannerAgent) return reply.code(500).send({ message: "planner not available" });

    const orderPlan = createAgentPlan(actor, plannerAgent, session.id, body.prompt);
    executeAgentPlan(orderPlan, actor, plannerAgent);

    const plannerWindow = slugify(`agent-${plannerAgent.id}`);

    // 3. Wait for planner to finish, then autoRegister
    const plannerOutput = session.tmuxBackend === "disabled"
      ? null
      : pollAgentOutput(`/tmp/opencode-${session.id.substring(0,8)}-${plannerAgent.id}.log`, Math.max(5000, totalTimeout - (Date.now() - startTime)));
    const cleanedPlanner = plannerOutput ? extractCleanOutput(plannerOutput) : "";

    activeOrders.delete(session.id);

    // 4. autoRegister: create dynamic runbook + launch runner
    let genRbId = "";
    let genName = "";
    if (cleanedPlanner && cleanedPlanner.length > 20) {
      genName = body.prompt.slice(0, 60).replace(/[^a-zA-Z0-9 ]/g, "").trim() || "Generated Runbook";
      genRbId = "gen-" + genName.toLowerCase().replace(/\s+/g, "-").slice(0, 50);
      const scriptName = `${genRbId}.md`;
      const scriptPath = `/opt/wireguard-ops-cockpit/bin/${scriptName}`;
      const mdContent = [`# ${genName}`,`> Generated ${new Date().toISOString()}`,"","## Prompt",body.prompt,"","## Planner Output","```",cleanedPlanner.replace(/```/g, "'''"),"```"].join("\n");
      execSync(`mkdir -p /opt/wireguard-ops-cockpit/bin && cat > ${scriptPath} && chmod 644 ${scriptPath}`, { input: mdContent, encoding: "utf-8" });

      const runbook: RunbookDefinition = {
        id: genRbId, name: genName, summary: body.prompt.slice(0, 200), requiresSession: true, requiresApproval: false,
        integration: "host-tmux", privilegedHelperRequested: false, reviewStatus: "allowlisted",
        scriptIds: [scriptName], workflowSteps: [{ id: "execute", label: `OpenCode: ${scriptName}`, description: body.prompt.slice(0, 200), kind: "runbook" }],
      };

      // Register (idempotent: delete stale entry then create fresh one)
      try { database.deleteDynamicRunbook(genRbId, actor.id); } catch { }
      database.createDynamicRunbook({ id: genRbId, name: genName, summary: body.prompt.slice(0, 200), requiresApproval: false, privilegedHelper: false, scriptId: scriptName, createdBy: actor.id });
      registerDynamicRunbook(runbook);

      // Safety review before execution — NEVER skip
      const safetyPlan = await createRunbookPlan(actor, runbook, session);
      const safetyVerdict = safetyPlan.status;

      // "ready" = allowlisted / pre-reviewed → safe to proceed
      // "executed" = full safety review passed
      // "blocked" = dangerous → STOP
      // "not_run" = safety review failed → STOP (better safe than sorry)
      // "requiresApproval" → return for manual approval
      if (safetyVerdict === "blocked") {
        cleanup();
        return reply.code(409).send({
          message: "blocked",
          runbookId: genRbId,
          runbookName: genName,
          plan: filterSensitiveContent(stripHashNoise(cleanedPlanner)).substring(0, 5000),
          safety: "blocked",
          result: "",
          elapsedMs: Date.now() - startTime,
        });
      }

      if (safetyPlan.requiresApproval) {
        cleanup();
        return reply.code(202).send({
          message: "approval_required",
          runbookId: genRbId,
          runbookName: genName,
          plan: filterSensitiveContent(stripHashNoise(cleanedPlanner)).substring(0, 5000),
          safety: "approval_required",
          result: "",
          elapsedMs: Date.now() - startTime,
        });
      }

      if (safetyVerdict !== "ready" && safetyVerdict !== "executed") {
        cleanup();
        return reply.code(202).send({
          message: "unclear-verdict",
          runbookId: genRbId,
          plan: filterSensitiveContent(cleanedPlanner).substring(0, 2000),
          safety: safetyVerdict,
          elapsedMs: Date.now() - startTime,
        });
      }

      // Launch runner agent (only if execute !== false)
      if (shouldExecute) {
        const runnerPrompt = buildRunnerPrompt(scriptPath);
        const runnerPlan = createAgentPlan(actor, plannerAgent, session.id, runnerPrompt);
        executeAgentPlan(runnerPlan, actor, plannerAgent, "-runner");
      }
    }

    // 5. If no runbook generated, return partial
    if (!genRbId) {
      cleanup();
      return reply.code(202).send({
        partial: true,
        message: "Planner didn't produce a runbook. Try a more specific prompt.",
        sessionId: session.id,
        plannerOutput: filterSensitiveContent(cleanedPlanner).substring(0, 2000),
        elapsedMs: Date.now() - startTime,
      });
    }

    // 6. Wait for runner to complete (different window: agent-planner-agent-runner)
    const runnerWindow = slugify(`agent-${plannerAgent.id}-runner`);
    let runnerRaw = session.tmuxBackend === "disabled" ? null
      : pollAgentOutput(`/tmp/opencode-${session.id.substring(0,8)}-${plannerAgent.id}-runner.log`, Math.max(5000, totalTimeout - (Date.now() - startTime)));
    let runnerOutput = runnerRaw ? extractRunnerHandoff(runnerRaw) : "";
    if (!runnerOutput) {
      // Try the other agent window
      const windows = execSync(
        `tmux list-windows -t "${session.tmuxSessionName}" -F '#{window_name}' 2>/dev/null || true`,
        { encoding: "utf-8", timeout: 3000 }
      ).trim().split("\n");
      for (const w of windows) {
        if (w.includes("agent")) {
          const raw = execSync(
            `tmux capture-pane -t "${session.tmuxSessionName}:${w}" -p -S -2000 2>/dev/null || true`,
            { encoding: "utf-8", timeout: 5000, maxBuffer: 2 * 1024 * 1024 }
          ).trim();
          if (raw.replace(/\n/g, "").includes("exiti")) {
            runnerOutput = extractRunnerHandoff(raw);
            break;
          }
        }
      }
    }

    cleanup();
    return {
      message: shouldExecute ? "ok" : "plan-only",
      sessionId: session.id,
      runbookId: genRbId,
      runbookName: genName,
      plan: filterSensitiveContent(stripHashNoise(cleanedPlanner)).substring(0, 5000),
      result: shouldExecute ? filterSensitiveContent(stripHashNoise(runnerOutput)).substring(0, 5000) : "",
      elapsedMs: Date.now() - startTime,
    };
  });

    */
  });
  app.delete("/api/runbooks/:runbookId", async (request, reply) => {
    const actor = await requireActor(request, reply, database);
    if (!actor) return;

    const { runbookId } = request.params as { runbookId: string };
    if (RUNBOOKS.some((r) => r.id === runbookId)) {
      return reply.code(403).send({ message: "built-in runbooks cannot be deleted" });
    }

    const deleted = database.deleteDynamicRunbook(runbookId, actor.id);
    if (!deleted) {
      return reply.code(404).send({ message: "runbook not found or not authorized" });
    }

    unregisterDynamicRunbook(runbookId);
    database.createAudit({
      actorId: actor.id,
      action: "runbook.dynamic.deleted",
      targetType: "runbook",
      targetId: runbookId,
      details: {},
    });

    return { message: "deleted" };
  });

  app.get("/api/schedules", async (request, reply) => {
    const actor = await requireActor(request, reply, database);
    if (!actor) {
      return;
    }

    return { schedules: database.listScheduledRunbooksForActor(actor.id) };
  });

  app.post("/api/schedules", async (request, reply) => {
    const actor = await requireActor(request, reply, database);
    if (!actor) {
      return;
    }

    const body = (request.body || {}) as {
      runbookId?: string;
      sessionId?: string;
      weekday?: number;
      timeUtc?: string;
      mode?: ScheduledRunbookMode;
    };

    if (!body.runbookId || !body.sessionId || !validateWeekday(body.weekday) || !validateTimeUtc(body.timeUtc)) {
      return reply.code(400).send({ message: "runbookId, sessionId, weekday, and timeUtc are required" });
    }

    const requestedMode = body.mode || "scheduled-plan-only";
    if (requestedMode !== "scheduled-plan-only" && requestedMode !== "scheduled-auto") {
      return reply.code(400).send({ message: "mode must be scheduled-plan-only or scheduled-auto" });
    }

    const runbook = findRunbook(body.runbookId);
    if (!runbook) {
      return reply.code(404).send({ message: "runbook not found" });
    }

    if (requestedMode === "scheduled-auto" && isHighRiskRunbook(runbook)) {
      return reply.code(400).send({ message: "high-risk runbooks can only use scheduled-plan-only" });
    }

    const session = database.getSessionByIdForActor(body.sessionId, actor.id);
    if (!session) {
      return reply.code(404).send({ message: "session not found" });
    }

    const schedule = database.createScheduledRunbook({
      ownerId: actor.id,
      runbookId: runbook.id,
      sessionId: session.id,
      weekday: body.weekday,
      timeUtc: body.timeUtc,
      timezone: "UTC",
      requestedMode,
      effectiveMode: requestedMode,
      status: "draft",
      runbookVersionHash: computeRunbookVersionHash(runbook),
      nextRunAt: computeNextWeeklyRunAt(body.weekday, body.timeUtc)
    });

    database.createAudit({
      actorId: actor.id,
      action: "schedule.created",
      targetType: "scheduled-runbook",
      targetId: schedule.id,
      details: {
        runbookId: schedule.runbookId,
        sessionId: schedule.sessionId,
        requestedMode: schedule.requestedMode,
        nextRunAt: schedule.nextRunAt
      }
    });

    return reply.code(201).send({ schedule });
  });

  app.post("/api/schedules/:scheduleId/activate", async (request, reply) => {
    const actor = await requireActor(request, reply, database);
    if (!actor) {
      return;
    }

    const { scheduleId } = request.params as { scheduleId: string };
    const schedule = database.getScheduledRunbookForActor(scheduleId, actor.id);
    if (!schedule) {
      return reply.code(404).send({ message: "schedule not found" });
    }

    const runbook = findRunbook(schedule.runbookId);
    const session = database.getSessionByIdForActor(schedule.sessionId, actor.id);
    if (!runbook || !session) {
      return reply.code(409).send({ message: "schedule target no longer resolves" });
    }

    const runbookVersionHash = computeRunbookVersionHash(runbook);
    const activated = database.updateScheduledRunbook(schedule.id, {
      status: "active",
      runbookVersionHash,
      nextRunAt: computeNextWeeklyRunAt(schedule.weekday, schedule.timeUtc)
    });

    database.createAudit({
      actorId: actor.id,
      action: "schedule.activated",
      targetType: "scheduled-runbook",
      targetId: activated.id,
      details: {
        effectiveMode: activated.effectiveMode,
        nextRunAt: activated.nextRunAt,
        runbookVersionHash: activated.runbookVersionHash
      }
    });

    return { schedule: activated };
  });

  app.post("/api/schedules/:scheduleId/pause", async (request, reply) => {
    const actor = await requireActor(request, reply, database);
    if (!actor) {
      return;
    }

    const { scheduleId } = request.params as { scheduleId: string };
    const schedule = database.getScheduledRunbookForActor(scheduleId, actor.id);
    if (!schedule) {
      return reply.code(404).send({ message: "schedule not found" });
    }

    const paused = database.updateScheduledRunbook(schedule.id, {
      status: "paused"
    });

    database.createAudit({
      actorId: actor.id,
      action: "schedule.paused",
      targetType: "scheduled-runbook",
      targetId: paused.id,
      details: {
        effectiveMode: paused.effectiveMode
      }
    });

    return { schedule: paused };
  });

  app.get("/api/scripts", async (request, reply) => {
    const actor = await requireActor(request, reply, database);
    if (!actor) {
      return;
    }

    return { scripts };
  });

  app.post("/api/runbooks/:runbookId/execute", async (request, reply) => {
    const actor = await requireActor(request, reply, database);
    if (!actor) {
      return;
    }

    const { runbookId } = request.params as { runbookId: string };
    const runbook = findRunbook(runbookId);
    if (!runbook) {
      return reply.code(404).send({ message: "runbook not found" });
    }

    const body = (request.body || {}) as { sessionId?: string };
    if (!body.sessionId) {
      return reply.code(400).send({ message: "sessionId is required" });
    }
    const session = body.sessionId ? database.getSessionByIdForActor(body.sessionId, actor.id) : null;

    if (!session) {
      return reply.code(404).send({ message: "session not found" });
    }

    const plan = await createRunbookPlan(actor, runbook, session);

    database.createAudit({
      actorId: actor.id,
      action: "execution.plan.created",
      targetType: "execution-plan",
      targetId: plan.id,
      details: {
        targetType: plan.targetType,
        targetId: plan.targetId,
        sessionId: session?.id || null,
        riskClass: plan.riskClass,
        runbookVersionHash: plan.normalizedInput.runbookVersionHash
      }
    });

    if (plan.status === "blocked") {
      const blocked = createBlockedPlanRecord(
        plan,
        actor,
        `${runbook.name} was blocked by the safety review before the bounded host helper could run.`
      );
      return reply.code(409).send({
        message: "safety review blocked runbook dispatch",
        ...blocked
      });
    }

    if (plan.requiresApproval) {
      return reply.code(202).send(
        createPendingApprovalForPlan(
          plan,
          actor,
          createRunbookApprovalReason(plan, runbook)
        )
      );
    }

    const executed = executeRunbookPlan(plan, actor, runbook);
    return reply.code(201).send(executed);
  });

  app.get("/api/approvals", async (request, reply) => {
    const actor = await requireActor(request, reply, database);
    if (!actor) {
      return;
    }

    const { status } = (request.query || {}) as { status?: "pending" | "approved" | "rejected" };
    return { approvals: database.listApprovalsForActor(actor.id, status) };
  });

  app.post("/api/approvals/:approvalId/decision", async (request, reply) => {
    const actor = await requireActor(request, reply, database);
    if (!actor) {
      return;
    }

    const { approvalId } = request.params as { approvalId: string };
    const approval = database.getApproval(approvalId);
    if (!approval) {
      return reply.code(404).send({ message: "approval not found" });
    }

    if (approval.requestedBy !== actor.id) {
      return reply.code(404).send({ message: "approval not found" });
    }

    if (approval.status !== "pending") {
      return reply.code(409).send({ message: "approval already decided" });
    }

    const body = (request.body || {}) as { decision?: "approved" | "rejected"; reason?: string };
    if (body.decision !== "approved" && body.decision !== "rejected") {
      return reply.code(400).send({ message: "decision must be approved or rejected" });
    }

    if (
      body.decision === "approved" &&
      Date.now() > Date.parse(approval.createdAt) + config.approvalTtlMinutes * 60_000
    ) {
      database.createAudit({
        actorId: actor.id,
        action: "approval.expired",
        targetType: "approval",
        targetId: approval.id,
        details: { createdAt: approval.createdAt, ttlMinutes: config.approvalTtlMinutes },
      });
      return reply.code(409).send({
        message: "approval expired; create and review a fresh execution plan",
        expiresAt: new Date(Date.parse(approval.createdAt) + config.approvalTtlMinutes * 60_000).toISOString(),
      });
    }

    const updatedApproval = database.decideApproval(approvalId, {
      status: body.decision,
      decidedBy: actor.id,
      reason: body.reason || null
    });

    const job = database.getJob(approval.jobId);
    if (!job) {
      return reply.code(500).send({ message: "approval job not found" });
    }

    database.createAudit({
      actorId: actor.id,
      action: "approval.decided",
      targetType: "approval",
      targetId: updatedApproval.id,
      details: {
        decision: updatedApproval.status,
        jobId: updatedApproval.jobId,
        planHash: job.subjectId && job.kind === "execution.plan" ? database.getExecutionPlan(job.subjectId)?.planHash || null : null
      }
    });

    if (job.kind === "execution.plan") {
      const plan = job.subjectId ? database.getExecutionPlan(job.subjectId) : null;
      if (!plan) {
        return reply.code(500).send({ message: "execution plan not found" });
      }

      if (body.decision === "approved") {
        const recomputedHash = recomputePlanHash(plan);
        if (recomputedHash !== plan.planHash) {
          const blockedPlan = database.updateExecutionPlan(plan.id, {
            status: "blocked",
            preExecutionHook: review(
              null,
              "blocked",
              "Pre-exec hook detected a plan hash mismatch and refused to dispatch the approved action.",
              {
                expectedPlanHash: recomputedHash,
                planHash: plan.planHash
              }
            )
          });
          const blockedJob = database.updateJob(job.id, {
            status: "failed",
            approvalId: updatedApproval.id,
            completedAt: new Date().toISOString(),
            output: {
              ...planJobOutput(blockedPlan, "Execution plan integrity check failed before dispatch."),
              approvalDecision: "approved",
              integrityError: "plan hash mismatch"
            }
          });

          return reply.code(409).send({
            message: "plan integrity check failed",
            approval: updatedApproval,
            plan: blockedPlan,
            job: blockedJob
          });
        }

        if (plan.targetType === "runbook") {
          const runbook = findRunbook(plan.targetId);
          if (!runbook) {
            return reply.code(500).send({ message: "runbook not found for approved plan" });
          }

          const approvedRunbookVersionHash =
            typeof plan.normalizedInput.runbookVersionHash === "string" ? plan.normalizedInput.runbookVersionHash : null;
          const currentRunbookVersionHash = computeRunbookVersionHash(runbook);
          if (!approvedRunbookVersionHash || approvedRunbookVersionHash !== currentRunbookVersionHash) {
            const blockedPlan = database.updateExecutionPlan(plan.id, {
              status: "blocked",
              preExecutionHook: review(
                null,
                "blocked",
                "Pre-exec hook detected a reviewed runbook version mismatch and refused to dispatch the approved action.",
                {
                  approvedRunbookVersionHash,
                  currentRunbookVersionHash
                }
              )
            });
            const blockedJob = database.updateJob(job.id, {
              status: "failed",
              approvalId: updatedApproval.id,
              completedAt: new Date().toISOString(),
              output: {
                ...planJobOutput(blockedPlan, "Execution plan runbook integrity check failed before dispatch."),
                approvalDecision: "approved",
                integrityError: "runbook version hash mismatch",
                approvedRunbookVersionHash,
                currentRunbookVersionHash
              }
            });

            return reply.code(409).send({
              message: "runbook integrity check failed",
              approval: updatedApproval,
              plan: blockedPlan,
              job: blockedJob
            });
          }

          const executed = executeRunbookPlan(
            database.updateExecutionPlan(plan.id, {
              approvalId: updatedApproval.id,
              preExecutionHook: review(
                null,
                "passed",
                "Pre-exec hook revalidated the exact approved plan hash immediately before dispatch.",
                { planHash: plan.planHash }
              )
            }),
            actor,
            runbook
          );
          const planJob = database.updateJob(job.id, {
            status: "completed",
            approvalId: updatedApproval.id,
            completedAt: new Date().toISOString(),
            output: {
              ...planJobOutput(executed.plan, "Execution plan approved and dispatched into the host tmux executor."),
              approvalDecision: "approved",
              executedJobId: executed.job.id
            }
          });

          return { approval: updatedApproval, plan: executed.plan, job: executed.job, planJob };
        }

        const agent = findAgent(plan.targetId, config.plannerRuntime);
        if (!agent) {
          return reply.code(500).send({ message: "agent not found for approved plan" });
        }

        const approvedAgentManifestDigest =
          typeof plan.normalizedInput.agentManifestDigest === "string" ? plan.normalizedInput.agentManifestDigest : null;
        const currentAgentManifestDigest = computeAgentManifestDigest(agent);
        if (!approvedAgentManifestDigest || approvedAgentManifestDigest !== currentAgentManifestDigest) {
          const blockedPlan = database.updateExecutionPlan(plan.id, {
            status: "blocked",
            preExecutionHook: review(
              null,
              "blocked",
              "Pre-exec hook detected an agent manifest mismatch and refused to dispatch the approved launch.",
              {
                approvedAgentManifestDigest,
                currentAgentManifestDigest
              }
            )
          });
          const blockedJob = database.updateJob(job.id, {
            status: "failed",
            approvalId: updatedApproval.id,
            completedAt: new Date().toISOString(),
            output: {
              ...planJobOutput(blockedPlan, "Execution plan agent integrity check failed before dispatch."),
              approvalDecision: "approved",
              integrityError: "agent manifest digest mismatch",
              approvedAgentManifestDigest,
              currentAgentManifestDigest
            }
          });

          return reply.code(409).send({
            message: "agent integrity check failed",
            approval: updatedApproval,
            plan: blockedPlan,
            job: blockedJob
          });
        }

        const executed = executeAgentPlan(
          database.updateExecutionPlan(plan.id, {
            approvalId: updatedApproval.id,
            preExecutionHook: review(
              null,
              "passed",
              "Pre-exec hook revalidated the exact approved plan hash immediately before dispatch.",
              { planHash: plan.planHash }
            )
          }),
          actor,
          agent
        );
        const planJob = database.updateJob(job.id, {
          status: "completed",
          approvalId: updatedApproval.id,
          completedAt: new Date().toISOString(),
          output: {
            ...planJobOutput(executed.plan, "Execution plan approved and dispatched."),
            approvalDecision: "approved",
            executedJobId: executed.job.id
          }
        });

        return { approval: updatedApproval, plan: executed.plan, job: executed.job, planJob };
      }

      const rejectedPlan = database.updateExecutionPlan(plan.id, {
        status: "rejected",
        approvalId: updatedApproval.id,
        postExecutionHook: review(
          null,
          "blocked",
          "Post-exec hook recorded a human rejection before any bounded executor was allowed to run.",
          { approvalId: updatedApproval.id }
        )
      });
      const rejectedJob = database.updateJob(job.id, {
        status: "rejected",
        approvalId: updatedApproval.id,
        completedAt: new Date().toISOString(),
        output: {
          ...planJobOutput(rejectedPlan, "Execution plan rejected before dispatch."),
          approvalDecision: "rejected"
        }
      });

      return { approval: updatedApproval, plan: rejectedPlan, job: rejectedJob };
    }

    let updatedJob;
    if (body.decision === "approved") {
      updatedJob = database.updateJob(job.id, {
        status: "completed",
        approvalId: updatedApproval.id,
        completedAt: new Date().toISOString(),
        output: {
          ...(job.output || {}),
          summary: "Execution was approved and dispatched.",
          approvalDecision: "approved"
        }
      });
    } else {
      updatedJob = database.updateJob(job.id, {
        status: "rejected",
        approvalId: updatedApproval.id,
        completedAt: new Date().toISOString(),
        output: {
          ...(job.output || {}),
          approvalDecision: "rejected",
          summary: "Execution was rejected before any host-facing action could run."
        }
      });
    }

    if (updatedJob.sessionId) {
      database.recordSessionActivity(updatedJob.sessionId);
    }

    return { approval: updatedApproval, job: updatedJob };
  });

  app.get("/api/agents", async (request, reply) => {
    const actor = await requireActor(request, reply, database);
    if (!actor) {
      return;
    }

    return { agents };
  });

  app.post("/api/agents/:agentId/launch", async (request, reply) => {
    const actor = await requireActor(request, reply, database);
    if (!actor) {
      return;
    }
    if (config.agentBrokerSocket) {
      return reply.code(410).send({
        message: "legacy local agent launch is disabled under identity isolation; use the durable Hermes endpoints",
      });
    }

    const { agentId } = request.params as { agentId: string };
    const agent = findAgent(agentId, config.plannerRuntime);
    if (!agent) {
      return reply.code(404).send({ message: "agent not found" });
    }

    const body = (request.body || {}) as { sessionId?: string; prompt?: string };
    if (!body.sessionId) {
      return reply.code(400).send({ message: "sessionId is required" });
    }

    const session = database.getSessionRuntimeTargetForActor(body.sessionId, actor.id);
    if (!session) {
      return reply.code(404).send({ message: "session not found" });
    }

    const plan = createAgentPlan(actor, agent, session.id, body.prompt);

    database.createAudit({
      actorId: actor.id,
      action: "execution.plan.created",
      targetType: "execution-plan",
      targetId: plan.id,
      details: {
        targetType: plan.targetType,
        targetId: plan.targetId,
        sessionId: session.id,
        riskClass: plan.riskClass,
        checkpointContractDigest:
          typeof plan.normalizedInput.checkpointContractDigest === "string"
            ? plan.normalizedInput.checkpointContractDigest
            : null,
        checkpointCount: parseCheckpointContractValue(plan.normalizedInput.checkpointContract).length
      }
    });

    if (agent.requiresApproval) {
      return reply.code(202).send(createPendingApprovalForPlan(plan, actor, createAgentApprovalReason(agent)));
    }

    const executed = executeAgentPlan(plan, actor, agent);
    return reply.code(201).send(executed);
  });

  app.post("/api/jobs/:jobId/checkpoints/:checkpointId/advance", async (request, reply) => {
    const actor = await requireActor(request, reply, database);
    if (!actor) {
      return;
    }

    const { jobId, checkpointId } = request.params as { jobId: string; checkpointId: string };
    const job = database.getJob(jobId);
    if (!job || !job.sessionId) {
      return reply.code(404).send({ message: "job not found" });
    }

    const session = database.getSessionByIdForActor(job.sessionId, actor.id);
    if (!session) {
      return reply.code(404).send({ message: "job not found" });
    }

    if (job.kind !== "agent") {
      return reply.code(400).send({ message: "checkpoint advancement is only available for agent jobs" });
    }

    const checkpoints = parseCheckpointStateValue(job.output?.checkpoints);
    if (checkpoints.length === 0) {
      return reply.code(400).send({ message: "job does not expose structured checkpoints" });
    }

    const activeCheckpointId = typeof job.output?.activeCheckpointId === "string" ? job.output.activeCheckpointId : null;
    if (activeCheckpointId !== checkpointId) {
      return reply.code(409).send({ message: "checkpoint is not awaiting operator review" });
    }

    const advancedCheckpointState = advanceCheckpointState(checkpoints, checkpointId);
    if (!advancedCheckpointState) {
      return reply.code(409).send({ message: "checkpoint is not awaiting operator review" });
    }

    const agentName =
      (job.subjectId ? findAgent(job.subjectId, config.plannerRuntime)?.name : null) || "Agent";
    const nextCheckpoint = advancedCheckpointState.checkpoints.find(
      (checkpoint) => checkpoint.id === advancedCheckpointState.activeCheckpointId
    );

    const updatedJob = database.updateJob(job.id, {
      status: job.status,
      output: {
        ...(job.output || {}),
        summary: nextCheckpoint
          ? `${agentName} is waiting at checkpoint ${nextCheckpoint.label}.`
          : `${agentName} completed all structured checkpoints and is waiting for a bounded follow-up or session closeout.`,
        checkpoints: advancedCheckpointState.checkpoints,
        activeCheckpointId: advancedCheckpointState.activeCheckpointId,
        lastCompletedCheckpointId: checkpointId,
        lastCompletedCheckpointLabel: advancedCheckpointState.completedCheckpointLabel
      },
      completedAt: job.completedAt
    });

    database.recordSessionActivity(session.id);
    database.createAudit({
      actorId: actor.id,
      action: "agent.checkpoint.advanced",
      targetType: "job",
      targetId: job.id,
      details: {
        jobId: job.id,
        planId: typeof job.output?.planId === "string" ? job.output.planId : null,
        checkpointId,
        completedCheckpointLabel: advancedCheckpointState.completedCheckpointLabel,
        nextCheckpointId: advancedCheckpointState.activeCheckpointId,
        checkpointContractDigest:
          typeof job.output?.checkpointContractDigest === "string" ? job.output.checkpointContractDigest : null
      }
    });

    return { job: updatedJob };
  });

  app.get("/api/audits", async (request, reply) => {
    const actor = await requireActor(request, reply, database);
    if (!actor) {
      return;
    }

    const { limit } = (request.query || {}) as { limit?: string };
    return { audits: database.listAuditsForActor(actor.id, Number(limit || "50")) };
  });

  app.get("/api/dashboard", async (request, reply) => {
    const actor = await requireActor(request, reply, database);
    if (!actor) {
      return;
    }

    return {
      user: actor,
      sessions: database.listSessionsForActor(actor.id),
      runbooks: RUNBOOKS,
      schedules: database.listScheduledRunbooksForActor(actor.id),
      scripts,
      agents,
      approvals: database.listApprovalsForActor(actor.id, "pending"),
      audits: database.listAuditsForActor(actor.id, 20)
    };
  });

  return app;
}
