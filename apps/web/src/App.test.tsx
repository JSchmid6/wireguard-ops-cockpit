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
      details: {}
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
    sessions: initiallyAuthenticated ? [alphaSession, betaSession] : [alphaSession],
    runbooks: [
      {
        id: "disk-health-check",
        name: "Disk health check",
        summary: "Validates disk pressure via the bounded placeholder contract.",
        requiresApproval: true
      }
    ],
    agents: [
      {
        id: "demo-context-agent",
        name: "Demo context agent",
        description: "Summarizes the current maintenance context."
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

    if (url === "/api/agents") {
      return okResponse({ agents: state.agents });
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
      state.sessionDetails[alphaSession.id].plans.unshift(
        makePlan(`plan-approval-${approvalId}`, alphaSession.id, "runbook", "nextcloud-update-plan", "executed", "high")
      );
      return okResponse({ ok: true });
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
    expect(screen.getByText("Disk health check")).toBeTruthy();
    expect(screen.getByText("Demo context agent")).toBeTruthy();
    expect(screen.getByText("Execution plans")).toBeTruthy();
    expect(await screen.findByText("Open terminal bridge")).toBeTruthy();
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

    await user.click(screen.getByRole("button", { name: /Plan and queue approval|Plan and execute/ }));
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
            String(url) === "/api/agents/demo-context-agent/launch" &&
            String((init as RequestInit | undefined)?.body).includes("Investigate recent job history.")
        )
      ).toBe(true);
    });
    expect(await screen.findByText(/Agent launched\./)).toBeTruthy();
    expect(screen.getByText(/agent · executed · moderate/)).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Approve" }));
    expect(await screen.findByText("No pending approvals.")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Sign out" }));
    expect(await screen.findByRole("button", { name: "Sign in" })).toBeTruthy();
  });
});