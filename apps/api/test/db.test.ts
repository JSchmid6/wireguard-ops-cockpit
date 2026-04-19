import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CockpitDatabase } from "../src/db.js";

describe("CockpitDatabase", () => {
  let database: CockpitDatabase;

  beforeEach(() => {
    database = new CockpitDatabase(":memory:");
    database.initialize();
    database.seedAdmin("admin", "test-password");
  });

  afterEach(() => {
    database.close();
  });

  it("authenticates seeded users and manages auth sessions", () => {
    const actor = database.authenticateUser("admin", "test-password");

    expect(actor).toMatchObject({ username: "admin", role: "admin" });
    expect(database.authenticateUser("admin", "wrong-password")).toBeNull();

    const token = database.issueAuthSession(actor!.id, 1);
    expect(database.findUserByAuthToken(token)).toEqual(actor);

    database.revokeAuthToken(token);
    expect(database.findUserByAuthToken(token)).toBeNull();
  });

  it("upserts sessions and updates terminal bridge metadata", () => {
    const created = database.upsertSession({
      name: "incident-debug",
      tmuxSessionName: "cockpit-incident-debug",
      tmuxBackend: "disabled",
      terminalUrl: null
    });

    expect(created.name).toBe("incident-debug");
    expect(created.terminal.status).toBe("pending_integration");

    const updated = database.updateSessionTerminalUrl(created.id, "https://ttyd.example/attach/session");
    expect(updated.terminal.status).toBe("configured");
    expect(updated.terminal.terminalUrl).toBe("https://ttyd.example/attach/session");

    const runtimeTarget = database.getSessionRuntimeTarget(created.id);
    expect(runtimeTarget).toEqual({
      id: created.id,
      name: "incident-debug",
      tmuxSessionName: "cockpit-incident-debug",
      tmuxBackend: "disabled"
    });
  });

  it("tracks jobs, approvals, audits and session activity", () => {
    const actor = database.authenticateUser("admin", "test-password");
    const session = database.upsertSession({
      name: "maintenance-window",
      tmuxSessionName: "cockpit-maintenance-window",
      tmuxBackend: "tmux",
      terminalUrl: null
    });

    const job = database.createJob({
      sessionId: session.id,
      kind: "runbook",
      subjectId: "nextcloud-update-plan",
      status: "pending_approval",
      requiresApproval: true,
      output: { summary: "queued" }
    });
    const approval = database.createApproval({
      jobId: job.id,
      requestedBy: actor!.id,
      reason: "Needs a human gate"
    });
    const decided = database.decideApproval(approval.id, {
      status: "approved",
      decidedBy: actor!.id,
      reason: "Reviewed"
    });
    const completed = database.updateJob(job.id, {
      status: "completed",
      approvalId: decided.id,
      output: { summary: "completed", approvalDecision: "approved" },
      completedAt: new Date().toISOString()
    });
    database.recordSessionActivity(session.id);
    const audit = database.createAudit({
      actorId: actor!.id,
      action: "runbook.executed",
      targetType: "runbook",
      targetId: job.subjectId,
      details: { sessionId: session.id }
    });

    expect(database.getJob(job.id)).toMatchObject({ id: job.id, status: "completed" });
    expect(database.listJobsForSession(session.id)[0]).toMatchObject({ id: job.id, status: "completed" });
    expect(database.listApprovals("approved")).toEqual([decided]);
    expect(database.getApproval(approval.id)).toMatchObject({ status: "approved", decidedBy: actor!.id });
    expect(database.listAudits(1)).toEqual([audit]);
  });

  it("stores execution plans and updates them after dispatch", () => {
    const actor = database.authenticateUser("admin", "test-password");
    const session = database.upsertSession({
      name: "website-recovery",
      tmuxSessionName: "cockpit-website-recovery",
      tmuxBackend: "disabled",
      terminalUrl: null
    });

    const plan = database.createExecutionPlan({
      sessionId: session.id,
      targetType: "runbook",
      targetId: "disk-health-check",
      requestedBy: actor!.id,
      status: "pending_approval",
      riskClass: "high",
      requiresApproval: true,
      planHash: "plan-hash-1",
      planSummary: "Planner and safety review completed.",
      normalizedInput: { sessionId: session.id },
      plannerReview: {
        actorId: "planner-agent",
        verdict: "passed",
        summary: "Planner normalized the request.",
        details: {}
      },
      safetyReview: {
        actorId: "safety-agent",
        verdict: "approval_required",
        summary: "Safety review requires approval.",
        details: {}
      },
      policyReview: {
        actorId: null,
        verdict: "passed",
        summary: "Policy passed.",
        details: {}
      },
      preExecutionHook: {
        actorId: null,
        verdict: "passed",
        summary: "Pre hook passed.",
        details: {}
      },
      runtimeHook: {
        actorId: null,
        verdict: "not_run",
        summary: "Runtime not run.",
        details: {}
      },
      postExecutionHook: {
        actorId: null,
        verdict: "not_run",
        summary: "Post hook not run.",
        details: {}
      }
    });

    expect(database.getExecutionPlan(plan.id)).toMatchObject({
      id: plan.id,
      status: "pending_approval",
      planHash: "plan-hash-1"
    });
    expect(database.listExecutionPlansForSession(session.id)[0]).toMatchObject({ id: plan.id });

    const gatingJob = database.createJob({
      sessionId: session.id,
      kind: "execution.plan",
      subjectId: plan.id,
      status: "pending_approval",
      requiresApproval: true,
      output: { summary: "approval required" }
    });
    const approval = database.createApproval({
      jobId: gatingJob.id,
      requestedBy: actor!.id,
      reason: "reviewed"
    });
    const executedJob = database.createJob({
      sessionId: session.id,
      kind: "runbook",
      subjectId: "disk-health-check",
      status: "completed",
      requiresApproval: false,
      output: { summary: "completed" },
      completedAt: new Date().toISOString()
    });

    const updated = database.updateExecutionPlan(plan.id, {
      status: "executed",
      approvalId: approval.id,
      executedJobId: executedJob.id,
      runtimeHook: {
        actorId: null,
        verdict: "passed",
        summary: "Runtime observed.",
        details: { jobId: executedJob.id }
      },
      postExecutionHook: {
        actorId: null,
        verdict: "passed",
        summary: "Post hook observed.",
        details: { jobId: executedJob.id }
      }
    });

    expect(updated).toMatchObject({
      status: "executed",
      approvalId: approval.id,
      executedJobId: executedJob.id
    });
    expect(updated.runtimeHook).toMatchObject({ verdict: "passed" });
  });
});