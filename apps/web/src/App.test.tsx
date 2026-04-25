import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import App from "./App";

function makeSession(id: string, name: string) {
  return {
    id,
    name,
    tmuxSessionName: `cockpit-${name}`,
    tmuxBackend: "disabled",
    terminal: {
      terminalUrl: `https://ttyd.example/${id}`,
      status: "configured",
      note: `Bridge ready for ${name}.`
    },
    lastActivityAt: "2026-04-19T12:00:00.000Z"
  };
}

function makeCheckpointContract() {
  return [
    {
      id: "checkpoint-review-scope",
      label: "Review current bounded scope",
      description: "Summarize the currently observed issue boundaries before any follow-up runbook is selected.",
      kind: "operator-checkpoint"
    },
    {
      id: "checkpoint-choose-follow-up",
      label: "Choose the next bounded follow-up",
      description: "Map the next action to an already reviewed runbook instead of free-form shell recovery.",
      kind: "runbook"
    },
    {
      id: "checkpoint-verify-outcome",
      label: "Verify outcome and rollback notes",
      description: "Confirm expected impact, rollback notes, and operator review state before the session moves on.",
      kind: "verify"
    }
  ];
}

function makeCheckpointState(activeCheckpointId = "checkpoint-review-scope") {
  const checkpointContract = makeCheckpointContract();
  const activeIndex = checkpointContract.findIndex((checkpoint) => checkpoint.id === activeCheckpointId);

  return checkpointContract.map((checkpoint, index) => ({
    ...checkpoint,
    status: index < activeIndex ? "completed" : index === activeIndex ? "awaiting_operator" : "planned"
  }));
}

function makeCheckpointJob(id: string, prompt: string, activeCheckpointId = "checkpoint-review-scope") {
  return {
    id,
    kind: "agent",
    status: "completed",
    subjectId: "supervised-repair-agent",
    output: {
      summary:
        activeCheckpointId === "checkpoint-review-scope"
          ? "Supervised repair agent started through the control plane."
          : "Supervised repair agent is waiting at checkpoint Choose the next bounded follow-up.",
      prompt,
      checkpointContractId: "supervised-repair-checkpoints-v1",
      checkpointContractDigest: `${id}-checkpoint-digest`,
      activeCheckpointId,
      checkpoints: makeCheckpointState(activeCheckpointId)
    },
    createdAt: "2026-04-19T12:15:00.000Z"
  };
}

function makePlan(
  id: string,
  sessionId: string,
  targetType: "runbook" | "agent",
  targetId: string,
  status: "executed" | "pending_approval" | "rejected",
  riskClass: "low" | "moderate" | "high"
) {
  return {
    id,
    sessionId,
    targetType,
    targetId,
    status,
    riskClass,
    planHash: `${id}-hash`,
    planSummary: `${targetType} request routed through the execution pipeline.`,
    normalizedInput:
      targetType === "agent"
        ? {
            promptContractId: targetId === "supervised-repair-agent" ? "supervised-repair-v1" : "planner-v1",
            checkpointContractId:
              targetId === "supervised-repair-agent" ? "supervised-repair-checkpoints-v1" : null,
            checkpointContractDigest:
              targetId === "supervised-repair-agent" ? `${id}-checkpoint-digest` : null,
            checkpointContract: targetId === "supervised-repair-agent" ? makeCheckpointContract() : [],
            supervisionMode: targetId === "supervised-repair-agent" ? "session-observed" : "none",
            agentManifestDigest: `${id}-digest`
          }
        : {},
    plannerReview: {
      actorId: "planner-agent",
      verdict: "passed",
      summary: "Planner normalized the request.",
      details: {}
    },
    safetyReview: {
      actorId: "safety-agent",
      verdict: status === "pending_approval" ? "approval_required" : "passed",
      summary: "Safety reviewed the request.",
      details: {
        source: "copilot-cli",
        parseStatus: "ok",
        hazards: ["Filesystem pressure may affect backups."],
        blastRadius: "single host",
        expectedImpact: "bounded diagnostics inside the selected task session",
        rollbackHint: "No rollback required for read-only diagnostics.",
        operatorChecks: ["Review the disk usage snapshot before continuing."],
        runbookVersionHash: `${id}-version`
      }
    },
    policyReview: {
      actorId: null,
      verdict: "passed",
      summary: "Policy gate passed.",
      details: {}
    },
    preExecutionHook: {
      actorId: null,
      verdict: "passed",
      summary: "Pre-exec hook passed.",
      details: {}
    },
    runtimeHook: {
      actorId: null,
      verdict: status === "executed" ? "passed" : "not_run",
      summary: status === "executed" ? "Runtime observed." : "Runtime not run.",
      details: {}
    },
    postExecutionHook: {
      actorId: null,
      verdict: status === "executed" ? "passed" : status === "rejected" ? "blocked" : "not_run",
      summary: status === "executed" ? "Post-exec passed." : "Post-exec pending.",
      details: {}
    },
    createdAt: "2026-04-19T12:00:00.000Z",
    updatedAt: "2026-04-19T12:00:00.000Z"
  };
}

function makeServer(initiallyAuthenticated: boolean) {
  const defaultUser = { id: "user-1", username: "admin", role: "admin" };
  const alphaSession = makeSession("session-alpha", "incident-debug");
  const betaSession = makeSession("session-beta", "maintenance-window");

  const state = {
    user: initiallyAuthenticated ? { ...defaultUser } : null,
    nextSessionNumber: 3,
    nextScheduleNumber: 2,
    lastSupervisedPrompt: "Review the current Nextcloud maintenance blockers.",
    lastSupervisedSessionId: alphaSession.id,
    sessions: initiallyAuthenticated ? [alphaSession, betaSession] : [alphaSession],
    schedules: [
      {
        id: "schedule-1",
        ownerId: defaultUser.id,
        runbookId: "disk-health-check",
        sessionId: alphaSession.id,
        scheduleType: "weekly",
        weekday: 5,
        timeUtc: "18:00",
        timezone: "UTC",
        requestedMode: "scheduled-plan-only",
        effectiveMode: "scheduled-plan-only",
        status: "draft",
        runbookVersionHash: "versionhash-1",
        lastPlannedAt: null,
        lastRunAt: null,
        nextRunAt: "2026-04-24T18:00:00.000Z"
      }
    ],
    runbooks: [
      {
        id: "disk-health-check",
        name: "Disk health check",
        summary: "Validates disk pressure via the bounded placeholder contract.",
        requiresSession: true,
        requiresApproval: false,
        integration: "host-tmux",
        privilegedHelperRequested: false,
        reviewStatus: "allowlisted",
        scriptIds: ["script-disk-health-check"],
        workflowSteps: [
          {
            id: "collect-diagnostics",
            label: "Collect bounded diagnostics",
            description: "Run the allowlisted disk helper inside the selected task session.",
            kind: "runbook",
            runbookId: "disk-health-check"
          },
          {
            id: "review-output",
            label: "Review diagnostic output",
            description: "Operator reviews the session output before selecting a follow-up path.",
            kind: "operator-checkpoint"
          }
        ]
      },
      {
        id: "nextcloud-update-plan",
        name: "Nextcloud update preflight",
        summary: "Collects reviewed Nextcloud maintenance context before the bounded Nextcloud phase runbooks continue.",
        requiresSession: true,
        requiresApproval: true,
        integration: "host-tmux",
        privilegedHelperRequested: true,
        reviewStatus: "allowlisted",
        scriptIds: ["script-nextcloud-update-plan"],
        workflowSteps: [
          {
            id: "collect-maintenance-context",
            label: "Collect maintenance context",
            description: "Run the bounded inspection helper for the current Nextcloud maintenance state.",
            kind: "runbook",
            runbookId: "nextcloud-update-plan"
          },
          {
            id: "enable-maintenance-mode",
            label: "Enable maintenance mode",
            description: "Move into a bounded maintenance window once the reviewed preflight state is accepted.",
            kind: "runbook",
            runbookId: "nextcloud-enable-maintenance"
          },
          {
            id: "run-occ-upgrade",
            label: "Run occ upgrade",
            description: "Dispatch the bounded occ upgrade helper instead of bundling the full flow into one shell path.",
            kind: "runbook",
            runbookId: "nextcloud-occ-upgrade"
          },
          {
            id: "disable-maintenance-mode",
            label: "Disable maintenance mode",
            description: "Clear maintenance mode through the reviewed helper after the upgrade phase completes.",
            kind: "runbook",
            runbookId: "nextcloud-disable-maintenance"
          },
          {
            id: "verify-post-update-state",
            label: "Verify post-update state",
            description: "Run the bounded verification helper to confirm Nextcloud and the web stack recovered cleanly.",
            kind: "runbook",
            runbookId: "nextcloud-post-update-verify"
          },
          {
            id: "supervised-checkpoint",
            label: "Run supervised repair checkpoint",
            description: "Launch the supervised repair agent if the findings need staged remediation guidance.",
            kind: "agent",
            agentId: "supervised-repair-agent",
            approvalHint: "The supervised repair agent needs explicit operator approval before it starts."
          },
          {
            id: "optional-reviewed-rollback",
            label: "Optional reviewed rollback",
            description: "If the reviewed maintenance path still fails, dispatch the bounded rollback restore helper instead of improvised recovery.",
            kind: "runbook",
            runbookId: "nextcloud-rollback-restore"
          }
        ]
      },
      {
        id: "nextcloud-enable-maintenance",
        name: "Nextcloud maintenance mode on",
        summary: "Enables Nextcloud maintenance mode through the bounded occ helper.",
        requiresSession: true,
        requiresApproval: true,
        integration: "host-tmux",
        privilegedHelperRequested: true,
        reviewStatus: "allowlisted",
        scriptIds: ["script-nextcloud-enable-maintenance"],
        workflowSteps: []
      },
      {
        id: "nextcloud-occ-upgrade",
        name: "Nextcloud occ upgrade",
        summary: "Runs the bounded occ upgrade step for the active Nextcloud maintenance flow.",
        requiresSession: true,
        requiresApproval: true,
        integration: "host-tmux",
        privilegedHelperRequested: true,
        reviewStatus: "allowlisted",
        scriptIds: ["script-nextcloud-occ-upgrade"],
        workflowSteps: []
      },
      {
        id: "nextcloud-disable-maintenance",
        name: "Nextcloud maintenance mode off",
        summary: "Disables Nextcloud maintenance mode after the bounded upgrade completes.",
        requiresSession: true,
        requiresApproval: true,
        integration: "host-tmux",
        privilegedHelperRequested: true,
        reviewStatus: "allowlisted",
        scriptIds: ["script-nextcloud-disable-maintenance"],
        workflowSteps: []
      },
      {
        id: "nextcloud-post-update-verify",
        name: "Nextcloud post-update verification",
        summary: "Runs the bounded post-update verification helper for the active Nextcloud maintenance flow.",
        requiresSession: true,
        requiresApproval: true,
        integration: "host-tmux",
        privilegedHelperRequested: true,
        reviewStatus: "allowlisted",
        scriptIds: ["script-nextcloud-post-update-verify"],
        workflowSteps: [
          {
            id: "rollback-if-verification-fails",
            label: "Rollback with reviewed backup set if needed",
            description: "If post-update verification still fails, dispatch the bounded rollback restore helper tied to the approved rollback manifest.",
            kind: "runbook",
            runbookId: "nextcloud-rollback-restore"
          }
        ]
      },
      {
        id: "nextcloud-rollback-restore",
        name: "Nextcloud rollback restore",
        summary: "Restores the approved Nextcloud rollback backup set through a fixed manifest under the bounded backup root.",
        requiresSession: true,
        requiresApproval: true,
        integration: "host-tmux",
        privilegedHelperRequested: true,
        reviewStatus: "allowlisted",
        scriptIds: ["script-nextcloud-rollback-restore"],
        workflowSteps: [
          {
            id: "confirm-reviewed-rollback-scope",
            label: "Confirm reviewed rollback scope",
            description: "Operator confirms the rollback still matches the approved backup set and declared restore scope before any restore begins.",
            kind: "approval",
            approvalHint: "Rollback restore stays behind explicit approval and a reviewed manifest."
          },
          {
            id: "verify-rollback-state",
            label: "Verify rollback state",
            description: "Run the dedicated rollback verification helper before leaving the maintenance window.",
            kind: "runbook",
            runbookId: "nextcloud-rollback-verify"
          }
        ]
      },
      {
        id: "nextcloud-rollback-verify",
        name: "Nextcloud rollback verification",
        summary: "Verifies the restored Nextcloud rollback state while the service remains in a controlled maintenance window.",
        requiresSession: true,
        requiresApproval: true,
        integration: "host-tmux",
        privilegedHelperRequested: true,
        reviewStatus: "allowlisted",
        scriptIds: ["script-nextcloud-rollback-verify"],
        workflowSteps: []
      }
    ],
    scripts: [
      {
        id: "script-disk-health-check",
        name: "Disk health helper",
        summary: "Collects disk, filesystem, and backup visibility inside the task tmux session.",
        integration: "host-tmux",
        privilegedHelperRequested: false,
        reviewStatus: "allowlisted",
        sourcePath: "bin/disk-health-check.sh"
      },
      {
        id: "script-nextcloud-update-plan",
        name: "Nextcloud preflight helper",
        summary: "Builds a bounded Nextcloud maintenance context and opens a reviewed maintenance operation.",
        integration: "host-tmux",
        privilegedHelperRequested: true,
        reviewStatus: "allowlisted",
        sourcePath: "bin/nextcloud-update-plan.sh"
      },
      {
        id: "script-nextcloud-enable-maintenance",
        name: "Nextcloud maintenance-mode enable helper",
        summary: "Enables Nextcloud maintenance mode through a bounded occ helper.",
        integration: "host-tmux",
        privilegedHelperRequested: true,
        reviewStatus: "allowlisted",
        sourcePath: "bin/nextcloud-enable-maintenance.sh"
      },
      {
        id: "script-nextcloud-occ-upgrade",
        name: "Nextcloud occ upgrade helper",
        summary: "Runs the bounded occ upgrade step for the active maintenance flow.",
        integration: "host-tmux",
        privilegedHelperRequested: true,
        reviewStatus: "allowlisted",
        sourcePath: "bin/nextcloud-occ-upgrade.sh"
      },
      {
        id: "script-nextcloud-disable-maintenance",
        name: "Nextcloud maintenance-mode disable helper",
        summary: "Disables Nextcloud maintenance mode after the reviewed upgrade phase completes.",
        integration: "host-tmux",
        privilegedHelperRequested: true,
        reviewStatus: "allowlisted",
        sourcePath: "bin/nextcloud-disable-maintenance.sh"
      },
      {
        id: "script-nextcloud-post-update-verify",
        name: "Nextcloud post-update verification helper",
        summary: "Verifies Nextcloud and service status after maintenance mode has been cleared.",
        integration: "host-tmux",
        privilegedHelperRequested: true,
        reviewStatus: "allowlisted",
        sourcePath: "bin/nextcloud-post-update-verify.sh"
      },
      {
        id: "script-nextcloud-rollback-restore",
        name: "Nextcloud rollback restore helper",
        summary: "Restores the reviewed Nextcloud rollback backup set through a fixed manifest under the bounded backup root.",
        integration: "host-tmux",
        privilegedHelperRequested: true,
        reviewStatus: "allowlisted",
        sourcePath: "bin/nextcloud-rollback-restore.sh"
      },
      {
        id: "script-nextcloud-rollback-verify",
        name: "Nextcloud rollback verification helper",
        summary: "Verifies the restored Nextcloud rollback state while the service remains in a controlled maintenance window.",
        integration: "host-tmux",
        privilegedHelperRequested: true,
        reviewStatus: "allowlisted",
        sourcePath: "bin/nextcloud-rollback-verify.sh"
      }
    ],
    agents: [
      {
        id: "planner-agent",
        name: "Planner agent",
        description: "Produces a structured repair or maintenance plan for the current task session.",
        requiresApproval: false,
        supervisionMode: "none",
        executionAuthority: "advisory-only",
        promptContractId: "planner-v1",
        checkpointContractId: null,
        checkpointTemplate: []
      },
      {
        id: "supervised-repair-agent",
        name: "Supervised repair agent",
        description: "Presents staged remediation checkpoints inside the same task session and pauses for review.",
        requiresApproval: true,
        supervisionMode: "session-observed",
        executionAuthority: "advisory-only",
        promptContractId: "supervised-repair-v1",
        checkpointContractId: "supervised-repair-checkpoints-v1",
        checkpointTemplate: makeCheckpointContract()
      }
    ],
    approvals: [
      {
        id: "approval-1",
        jobId: "job-approval-1",
        status: "pending",
        reason: "Human review required",
        createdAt: "2026-04-19T12:00:00.000Z"
      }
    ],
    audits: [
      {
        id: "audit-1",
        action: "session.ensure",
        targetType: "cockpit-session",
        targetId: alphaSession.id,
        createdAt: "2026-04-19T12:00:00.000Z"
      }
    ],
    sessionDetails: {
      [alphaSession.id]: {
        session: alphaSession,
        plans: [makePlan("plan-initial", alphaSession.id, "runbook", "disk-health-check", "executed", "low")],
        jobs: [
          {
            id: "job-1",
            kind: "session.ensure",
            status: "completed",
            subjectId: alphaSession.id,
            output: { summary: "Session ensured." },
            createdAt: "2026-04-19T12:00:00.000Z"
          }
        ]
      },
      [betaSession.id]: {
        session: betaSession,
        plans: [],
        jobs: []
      }
    } as Record<string, { session: ReturnType<typeof makeSession>; plans: Array<Record<string, unknown>>; jobs: Array<Record<string, unknown>> }>
  };

  const okResponse = (body: unknown, status = 200) => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body
  });

  const errorResponse = (message: string, status: number) => ({
    ok: false,
    status,
    json: async () => ({ message })
  });

  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method || "GET";

    if (url === "/api/auth/login" && method === "POST") {
      state.user = { ...defaultUser };
      return okResponse({ user: state.user });
    }

    if (url === "/api/auth/logout" && method === "POST") {
      state.user = null;
      return okResponse({ ok: true });
    }

    if (!state.user) {
      return errorResponse("authentication required", 401);
    }

    if (url === "/api/me") {
      return okResponse({ user: state.user });
    }

    if (url === "/api/sessions" && method === "GET") {
      return okResponse({ sessions: state.sessions });
    }

    if (url === "/api/sessions" && method === "POST") {
      const body = JSON.parse(String(init?.body || "{}")) as { name?: string };
      const sessionId = `session-${state.nextSessionNumber++}`;
      const session = makeSession(sessionId, body.name || "unnamed");
      state.sessions = [...state.sessions, session];
      state.sessionDetails[sessionId] = {
        session,
        plans: [],
        jobs: []
      };
      return okResponse({ session }, 201);
    }

    if (url.startsWith("/api/sessions/") && method === "GET") {
      const sessionId = url.replace("/api/sessions/", "");
      return okResponse(state.sessionDetails[sessionId]);
    }

    if (url === "/api/runbooks") {
      return okResponse({ runbooks: state.runbooks });
    }

    if (url === "/api/schedules") {
      if (method === "GET") {
        return okResponse({ schedules: state.schedules });
      }

      const body = JSON.parse(String(init?.body || "{}")) as {
        runbookId: string;
        sessionId: string;
        weekday: number;
        timeUtc: string;
        mode: "scheduled-plan-only" | "scheduled-auto";
      };
      const schedule = {
        id: `schedule-${state.nextScheduleNumber++}`,
        ownerId: defaultUser.id,
        runbookId: body.runbookId,
        sessionId: body.sessionId,
        scheduleType: "weekly",
        weekday: body.weekday,
        timeUtc: body.timeUtc,
        timezone: "UTC",
        requestedMode: body.mode,
        effectiveMode: body.mode,
        status: "draft",
        runbookVersionHash: `versionhash-${state.nextScheduleNumber}`,
        lastPlannedAt: null,
        lastRunAt: null,
        nextRunAt: "2026-04-24T18:00:00.000Z"
      };
      state.schedules = [schedule, ...state.schedules];
      return okResponse({ schedule }, 201);
    }

    if (url === "/api/agents") {
      return okResponse({ agents: state.agents });
    }

    if (url === "/api/scripts") {
      return okResponse({ scripts: state.scripts });
    }

    if (url === "/api/approvals?status=pending") {
      return okResponse({ approvals: state.approvals });
    }

    if (url === "/api/audits?limit=12") {
      return okResponse({ audits: state.audits });
    }

    if (url.startsWith("/api/runbooks/") && method === "POST") {
      const runbookId = url.split("/")[3];
      const body = JSON.parse(String(init?.body || "{}")) as { sessionId?: string };
      const sessionId = body.sessionId || state.sessions[0]?.id;
      state.sessionDetails[sessionId].plans.unshift(
        makePlan(`plan-runbook-${runbookId}`, sessionId, "runbook", runbookId, "executed", "low")
      );
      state.sessionDetails[sessionId].jobs.unshift({
        id: `job-runbook-${runbookId}`,
        kind: "runbook",
        status: "completed",
        subjectId: runbookId,
        output: { summary: "Runbook queued." },
        createdAt: "2026-04-19T12:10:00.000Z"
      });
      return okResponse({ ok: true });
    }

    if (url.startsWith("/api/agents/") && method === "POST") {
      const agentId = url.split("/")[3];
      const body = JSON.parse(String(init?.body || "{}")) as { sessionId: string; prompt: string };
      if (agentId === "supervised-repair-agent") {
        state.lastSupervisedPrompt = body.prompt;
        state.lastSupervisedSessionId = body.sessionId;
        state.approvals = [
          {
            id: "approval-supervised-agent",
            jobId: "job-approval-supervised-agent",
            status: "pending",
            reason: "Supervised repair agent requires operator approval before it starts.",
            createdAt: "2026-04-19T12:20:00.000Z"
          },
          ...state.approvals
        ];
        state.sessionDetails[body.sessionId].plans.unshift(
          makePlan(`plan-agent-${agentId}`, body.sessionId, "agent", agentId, "pending_approval", "high")
        );
        return okResponse({ ok: true });
      }
      state.sessionDetails[body.sessionId].plans.unshift(
        makePlan(`plan-agent-${agentId}`, body.sessionId, "agent", agentId, "executed", "moderate")
      );
      state.sessionDetails[body.sessionId].jobs.unshift({
        id: `job-agent-${agentId}`,
        kind: "agent",
        status: "completed",
        subjectId: agentId,
        output: { summary: "Agent launched.", prompt: body.prompt },
        createdAt: "2026-04-19T12:15:00.000Z"
      });
      return okResponse({ ok: true });
    }

    if (url.startsWith("/api/approvals/") && method === "POST") {
      const approvalId = url.split("/")[3];
      state.approvals = state.approvals.filter((approval) => approval.id !== approvalId);
      if (approvalId === "approval-supervised-agent") {
        state.sessionDetails[state.lastSupervisedSessionId].plans.unshift(
          makePlan(
            `plan-approval-${approvalId}`,
            state.lastSupervisedSessionId,
            "agent",
            "supervised-repair-agent",
            "executed",
            "high"
          )
        );
        state.sessionDetails[state.lastSupervisedSessionId].jobs.unshift(
          makeCheckpointJob("job-agent-supervised-repair-agent", state.lastSupervisedPrompt)
        );
        return okResponse({ ok: true });
      }
      state.sessionDetails[alphaSession.id].plans.unshift(
        makePlan(`plan-approval-${approvalId}`, alphaSession.id, "runbook", "nextcloud-update-plan", "executed", "high")
      );
      return okResponse({ ok: true });
    }

    if (url.includes("/checkpoints/") && method === "POST") {
      const [, , jobId, , checkpointId] = url.split("/").slice(1);
      for (const detail of Object.values(state.sessionDetails)) {
        const job = detail.jobs.find((entry) => entry.id === jobId);
        if (!job || !job.output || !Array.isArray(job.output.checkpoints)) {
          continue;
        }

        const checkpoints = job.output.checkpoints as Array<Record<string, unknown>>;
        const currentIndex = checkpoints.findIndex((checkpoint) => checkpoint.id === checkpointId);
        const updatedCheckpoints = checkpoints.map((checkpoint, index) => ({
          ...checkpoint,
          status:
            index < currentIndex
              ? "completed"
              : index === currentIndex
                ? "completed"
                : index === currentIndex + 1
                  ? "awaiting_operator"
                  : "planned"
        }));
        const nextCheckpoint = updatedCheckpoints.find((checkpoint) => checkpoint.status === "awaiting_operator") || null;
        job.output = {
          ...job.output,
          summary: nextCheckpoint
            ? `Supervised repair agent is waiting at checkpoint ${String(nextCheckpoint.label)}.`
            : "Supervised repair agent completed all structured checkpoints.",
          checkpoints: updatedCheckpoints,
          activeCheckpointId: nextCheckpoint ? nextCheckpoint.id : null,
          lastCompletedCheckpointId: checkpointId,
          lastCompletedCheckpointLabel: String(checkpoints[currentIndex]?.label || "")
        };
        return okResponse({ job });
      }
      return errorResponse("job not found", 404);
    }

    if (url.startsWith("/api/schedules/") && method === "POST") {
      const [, , scheduleId, action] = url.split("/").slice(1);
      state.schedules = state.schedules.map((schedule) =>
        schedule.id === scheduleId
          ? {
              ...schedule,
              status: action === "activate" ? "active" : "paused"
            }
          : schedule
      );
      return okResponse({ schedule: state.schedules.find((schedule) => schedule.id === scheduleId) });
    }

    return errorResponse(`Unhandled request: ${method} ${url}`, 500);
  });

  vi.stubGlobal("fetch", fetchMock);
  return { fetchMock };
}

describe("App", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("renders the login screen on the initial render and can log into the dashboard", async () => {
    makeServer(false);
    const user = userEvent.setup();

    render(<App />);

    expect(await screen.findByText("Local admin login stays separate from WireGuard reachability.")).toBeTruthy();
    expect(screen.getByText("authentication required")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Sign in" }));

    expect(await screen.findByText("Recent audit trail")).toBeTruthy();
    expect(screen.getByText(/Signed in as/)).toBeTruthy();
    expect(screen.queryByText("authentication required")).toBeNull();
    expect(screen.getAllByText("Disk health check").length).toBeGreaterThan(0);
    expect(screen.getByText("Schedules")).toBeTruthy();
    expect(screen.getByText("Scripts")).toBeTruthy();
    expect(screen.getByText("Planner agent")).toBeTruthy();
    expect(screen.getByText("Supervised repair agent")).toBeTruthy();
    expect(screen.getByText("Execution plans")).toBeTruthy();
    expect(await screen.findByText("Open terminal bridge")).toBeTruthy();
    expect(screen.getByText(/Safety report/)).toBeTruthy();
    expect(screen.getByText(/Filesystem pressure may affect backups/)).toBeTruthy();
    expect(screen.getByText(/Run supervised repair checkpoint/)).toBeTruthy();
    expect(screen.getByText(/Optional reviewed rollback/)).toBeTruthy();
    expect(screen.getByText(/Enable maintenance mode/)).toBeTruthy();
    expect(screen.getAllByText(/Nextcloud rollback restore/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Nextcloud maintenance mode on/).length).toBeGreaterThan(0);
    expect(screen.getByText(/approval required · supervision session-observed · authority advisory-only/)).toBeTruthy();
  });

  it("handles session creation, runbook execution, approvals, agent launch and logout", async () => {
    const { fetchMock } = makeServer(true);
    const user = userEvent.setup();

    render(<App />);

    expect(await screen.findByText("Open terminal bridge")).toBeTruthy();

    const sessionInput = screen.getByPlaceholderText("incident-debug");
    const initialCallCount = fetchMock.mock.calls.length;
    await user.clear(sessionInput);
    await user.type(sessionInput, "   ");
    await user.click(screen.getByRole("button", { name: "Create or resume" }));
    expect(fetchMock.mock.calls.length).toBe(initialCallCount);

    await user.clear(sessionInput);
    await user.type(sessionInput, "nightly-maintenance");
    await user.click(screen.getByRole("button", { name: "Create or resume" }));

    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(
          ([url, init]) => String(url) === "/api/sessions" && (init as RequestInit | undefined)?.method === "POST"
        )
      ).toBe(true);
    });
    await waitFor(() => {
      expect(document.body.textContent).toContain("cockpit-nightly-maintenance");
    });

    expect(screen.getAllByText(/includes 1 script/i).length).toBeGreaterThan(0);
    expect(screen.getByText(/source bin\/disk-health-check.sh/i)).toBeTruthy();
    expect(screen.getByText(/high-risk runbooks stay on scheduled-plan-only/i)).toBeTruthy();
    expect(screen.getByText(/Collect maintenance context/)).toBeTruthy();
    expect(screen.getByText(/Run occ upgrade/)).toBeTruthy();
    expect(screen.getByText(/Rollback with reviewed backup set if needed/)).toBeTruthy();

    await user.selectOptions(screen.getByLabelText("Weekday"), "1");
    await user.clear(screen.getByLabelText("Time UTC"));
    await user.type(screen.getByLabelText("Time UTC"), "07:30");
    await user.selectOptions(screen.getByLabelText("Mode"), "scheduled-auto");
    await user.click(screen.getByRole("button", { name: "Create weekly schedule" }));

    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(
          ([url, init]) =>
            String(url) === "/api/schedules" &&
            (init as RequestInit | undefined)?.method === "POST" &&
            String((init as RequestInit | undefined)?.body).includes("scheduled-auto")
        )
      ).toBe(true);
    });

    await user.click(screen.getAllByRole("button", { name: "Activate" })[0]);
    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(
          ([url, init]) =>
            String(url).includes("/api/schedules/") && String(url).endsWith("/activate") && (init as RequestInit | undefined)?.method === "POST"
        )
      ).toBe(true);
    });

    await user.click(screen.getByRole("button", { name: "Plan and execute" }));
    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(
          ([url, init]) =>
            String(url) === "/api/runbooks/disk-health-check/execute" &&
            (init as RequestInit | undefined)?.method === "POST"
        )
      ).toBe(true);
    });
    expect(await screen.findByText(/runbook · executed · low/)).toBeTruthy();

    const promptInput = screen.getByLabelText("Prompt");
    await user.clear(promptInput);
    await user.type(promptInput, "Investigate recent job history.");
    await user.click(screen.getByRole("button", { name: "Plan and launch in selected session" }));
    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(
          ([url, init]) =>
            String(url) === "/api/agents/planner-agent/launch" &&
            String((init as RequestInit | undefined)?.body).includes("Investigate recent job history.")
        )
      ).toBe(true);
    });
    expect(await screen.findByText(/Agent launched\./)).toBeTruthy();
    expect(screen.getByText(/agent · executed · moderate/)).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Request supervised launch in selected session" }));
    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(
          ([url, init]) =>
            String(url) === "/api/agents/supervised-repair-agent/launch" &&
            (init as RequestInit | undefined)?.method === "POST"
        )
      ).toBe(true);
    });
    expect(await screen.findByText(/agent · pending_approval · high/)).toBeTruthy();

    await user.click(screen.getAllByRole("button", { name: "Approve" })[0]);
    expect((await screen.findAllByText(/Checkpoint contract/)).length).toBeGreaterThan(0);
    const checkpointButtons = await screen.findAllByRole("button", { name: "Mark checkpoint reviewed" });
    await user.click(checkpointButtons[0]);
    expect(await screen.findByText(/waiting at checkpoint Choose the next bounded follow-up/i)).toBeTruthy();

    await user.click((await screen.findAllByRole("button", { name: "Approve" }))[0]);
    expect(await screen.findByText("No pending approvals.")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Sign out" }));
    expect(await screen.findByRole("button", { name: "Sign in" })).toBeTruthy();
  });
});
