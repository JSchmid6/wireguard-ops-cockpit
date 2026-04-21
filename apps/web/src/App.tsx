import { useEffect, useMemo, useState } from "react";
import { formatOutput, request } from "./lib";

interface UserSummary {
  id: string;
  username: string;
  role: string;
}

interface TerminalBridge {
  terminalUrl: string | null;
  status: string;
  note: string;
}

interface CockpitSession {
  id: string;
  name: string;
  tmuxSessionName: string;
  tmuxBackend: string;
  terminal: TerminalBridge;
  lastActivityAt: string;
}

interface JobRecord {
  id: string;
  kind: string;
  status: string;
  subjectId: string | null;
  output: Record<string, unknown> | null;
  createdAt: string;
}

interface ExecutionReview {
  actorId: string | null;
  verdict: string;
  summary: string;
  details: Record<string, unknown>;
}

interface ExecutionPlan {
  id: string;
  targetType: string;
  targetId: string;
  status: string;
  riskClass: string;
  planHash: string;
  planSummary: string;
  plannerReview: ExecutionReview;
  safetyReview: ExecutionReview;
  policyReview: ExecutionReview;
  preExecutionHook: ExecutionReview;
  postExecutionHook: ExecutionReview;
}

interface ApprovalRecord {
  id: string;
  jobId: string;
  status: string;
  reason: string | null;
  createdAt: string;
}

interface AuditRecord {
  id: string;
  action: string;
  targetType: string;
  targetId: string | null;
  createdAt: string;
}

interface RunbookDefinition {
  id: string;
  name: string;
  summary: string;
  requiresSession: boolean;
  requiresApproval: boolean;
  integration: string;
  privilegedHelperRequested: boolean;
  reviewStatus: string;
  scriptIds: string[];
}

interface ScriptDefinition {
  id: string;
  name: string;
  summary: string;
  integration: string;
  privilegedHelperRequested: boolean;
  reviewStatus: string;
  sourcePath: string;
}

interface ScheduledRunbook {
  id: string;
  ownerId: string;
  runbookId: string;
  sessionId: string;
  scheduleType: string;
  weekday: number;
  timeUtc: string;
  timezone: string;
  requestedMode: "scheduled-plan-only" | "scheduled-auto";
  effectiveMode: "scheduled-plan-only" | "scheduled-auto";
  status: "draft" | "active" | "paused";
  runbookVersionHash: string;
  lastPlannedAt: string | null;
  lastRunAt: string | null;
  nextRunAt: string;
}

interface AgentManifest {
  id: string;
  name: string;
  description: string;
}

interface SessionDetail {
  session: CockpitSession;
  plans: ExecutionPlan[];
  jobs: JobRecord[];
}

export default function App() {
  const weekdayLabels = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const [user, setUser] = useState<UserSummary | null>(null);
  const [sessions, setSessions] = useState<CockpitSession[]>([]);
  const [runbooks, setRunbooks] = useState<RunbookDefinition[]>([]);
  const [schedules, setSchedules] = useState<ScheduledRunbook[]>([]);
  const [scripts, setScripts] = useState<ScriptDefinition[]>([]);
  const [agents, setAgents] = useState<AgentManifest[]>([]);
  const [approvals, setApprovals] = useState<ApprovalRecord[]>([]);
  const [audits, setAudits] = useState<AuditRecord[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState("");
  const [sessionDetail, setSessionDetail] = useState<SessionDetail | null>(null);
  const [sessionName, setSessionName] = useState("");
  const [prompt, setPrompt] = useState("Summarize the current maintenance context.");
  const [scheduleDraft, setScheduleDraft] = useState<{
    runbookId: string;
    sessionId: string;
    weekday: string;
    timeUtc: string;
    mode: "scheduled-plan-only" | "scheduled-auto";
  }>({
    runbookId: "",
    sessionId: "",
    weekday: "5",
    timeUtc: "18:00",
    mode: "scheduled-plan-only"
  });
  const [credentials, setCredentials] = useState({ username: "admin", password: "change-me-now" });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const selectedSession = useMemo(
    () => sessions.find((session) => session.id === selectedSessionId) || null,
    [sessions, selectedSessionId]
  );

  const scriptsById = useMemo(
    () => Object.fromEntries(scripts.map((script) => [script.id, script])),
    [scripts]
  );

  const sessionsById = useMemo(
    () => Object.fromEntries(sessions.map((session) => [session.id, session])),
    [sessions]
  );

  const selectedScheduleRunbook = useMemo(
    () => runbooks.find((runbook) => runbook.id === scheduleDraft.runbookId) || null,
    [runbooks, scheduleDraft.runbookId]
  );

  async function refreshDashboard() {
    try {
      const [me, sessionsResponse, runbooksResponse, schedulesResponse, scriptsResponse, agentsResponse, approvalsResponse, auditsResponse] =
        await Promise.all([
          request<{ user: UserSummary }>("/me"),
          request<{ sessions: CockpitSession[] }>("/sessions"),
          request<{ runbooks: RunbookDefinition[] }>("/runbooks"),
          request<{ schedules: ScheduledRunbook[] }>("/schedules"),
          request<{ scripts: ScriptDefinition[] }>("/scripts"),
          request<{ agents: AgentManifest[] }>("/agents"),
          request<{ approvals: ApprovalRecord[] }>("/approvals?status=pending"),
          request<{ audits: AuditRecord[] }>("/audits?limit=12")
        ]);

      setUser(me.user);
      setSessions(sessionsResponse.sessions);
      setRunbooks(runbooksResponse.runbooks);
      setSchedules(schedulesResponse.schedules);
      setScripts(scriptsResponse.scripts);
      setAgents(agentsResponse.agents);
      setApprovals(approvalsResponse.approvals);
      setAudits(auditsResponse.audits);
      setError("");

      if (!selectedSessionId && sessionsResponse.sessions[0]) {
        setSelectedSessionId(sessionsResponse.sessions[0].id);
      }
    } catch (nextError) {
      setUser(null);
      setSessionDetail(null);
      setError(nextError instanceof Error ? nextError.message : "Unable to load dashboard");
    }
  }

  async function refreshSession(sessionId: string) {
    if (!sessionId) {
      setSessionDetail(null);
      return;
    }

    try {
      const response = await request<SessionDetail>(`/sessions/${sessionId}`);
      setSessionDetail(response);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Unable to load session detail");
    }
  }

  useEffect(() => {
    refreshDashboard();
  }, []);

  useEffect(() => {
    if (selectedSessionId) {
      refreshSession(selectedSessionId);
    }
  }, [selectedSessionId]);

  useEffect(() => {
    if (!scheduleDraft.runbookId && runbooks[0]) {
      setScheduleDraft((current) => ({ ...current, runbookId: runbooks[0].id }));
    }
  }, [runbooks, scheduleDraft.runbookId]);

  useEffect(() => {
    if (!scheduleDraft.sessionId) {
      const defaultSessionId = selectedSessionId || sessions[0]?.id || "";
      if (defaultSessionId) {
        setScheduleDraft((current) => ({ ...current, sessionId: defaultSessionId }));
      }
    }
  }, [sessions, selectedSessionId, scheduleDraft.sessionId]);

  useEffect(() => {
    if (
      selectedScheduleRunbook &&
      (selectedScheduleRunbook.requiresApproval || selectedScheduleRunbook.privilegedHelperRequested) &&
      scheduleDraft.mode === "scheduled-auto"
    ) {
      setScheduleDraft((current) => ({ ...current, mode: "scheduled-plan-only" }));
    }
  }, [selectedScheduleRunbook, scheduleDraft.mode]);

  async function handleLogin(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      await request<{ user: UserSummary }>("/auth/login", {
        method: "POST",
        body: JSON.stringify(credentials)
      });
      await refreshDashboard();
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Login failed");
    } finally {
      setBusy(false);
    }
  }

  async function handleLogout() {
    setBusy(true);
    try {
      await request("/auth/logout", { method: "POST" });
      setUser(null);
      setSessions([]);
      setSchedules([]);
      setScripts([]);
      setApprovals([]);
      setAudits([]);
      setSessionDetail(null);
      setSelectedSessionId("");
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Logout failed");
    } finally {
      setBusy(false);
    }
  }

  async function createSession(event: React.FormEvent) {
    event.preventDefault();
    if (!sessionName.trim()) {
      return;
    }

    setBusy(true);
    try {
      const response = await request<{ session: CockpitSession }>("/sessions", {
        method: "POST",
        body: JSON.stringify({ name: sessionName })
      });
      setSessionName("");
      await refreshDashboard();
      setSelectedSessionId(response.session.id);
      await refreshSession(response.session.id);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Unable to create session");
    } finally {
      setBusy(false);
    }
  }

  async function executeRunbook(runbookId: string) {
    setBusy(true);
    try {
      await request(`/runbooks/${runbookId}/execute`, {
        method: "POST",
        body: JSON.stringify({ sessionId: selectedSessionId || undefined })
      });
      await refreshDashboard();
      if (selectedSessionId) {
        await refreshSession(selectedSessionId);
      }
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Unable to execute runbook");
    } finally {
      setBusy(false);
    }
  }

  async function launchAgent(agentId: string) {
    if (!selectedSessionId) {
      setError("Select a session before launching an agent.");
      return;
    }

    setBusy(true);
    try {
      await request(`/agents/${agentId}/launch`, {
        method: "POST",
        body: JSON.stringify({
          sessionId: selectedSessionId,
          prompt
        })
      });
      await refreshDashboard();
      await refreshSession(selectedSessionId);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Unable to launch agent");
    } finally {
      setBusy(false);
    }
  }

  async function decideApproval(approvalId: string, decision: "approved" | "rejected") {
    setBusy(true);
    try {
      await request(`/approvals/${approvalId}/decision`, {
        method: "POST",
        body: JSON.stringify({ decision })
      });
      await refreshDashboard();
      if (selectedSessionId) {
        await refreshSession(selectedSessionId);
      }
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Unable to decide approval");
    } finally {
      setBusy(false);
    }
  }

  async function createSchedule(event: React.FormEvent) {
    event.preventDefault();
    if (!scheduleDraft.runbookId || !scheduleDraft.sessionId || !scheduleDraft.timeUtc) {
      return;
    }

    setBusy(true);
    try {
      await request<{ schedule: ScheduledRunbook }>("/schedules", {
        method: "POST",
        body: JSON.stringify({
          runbookId: scheduleDraft.runbookId,
          sessionId: scheduleDraft.sessionId,
          weekday: Number(scheduleDraft.weekday),
          timeUtc: scheduleDraft.timeUtc,
          mode: scheduleDraft.mode
        })
      });
      await refreshDashboard();
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Unable to create schedule");
    } finally {
      setBusy(false);
    }
  }

  async function changeScheduleState(scheduleId: string, action: "activate" | "pause") {
    setBusy(true);
    try {
      await request(`/schedules/${scheduleId}/${action}`, { method: "POST" });
      await refreshDashboard();
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : `Unable to ${action} schedule`);
    } finally {
      setBusy(false);
    }
  }

  if (!user) {
    return (
      <main className="app-shell">
        <section className="panel login-panel">
          <h1>WireGuard Ops Cockpit</h1>
          <p>Local admin login stays separate from WireGuard reachability.</p>
          <form onSubmit={handleLogin} className="stack">
            <label>
              Username
              <input
                value={credentials.username}
                onChange={(event) => setCredentials((current) => ({ ...current, username: event.target.value }))}
              />
            </label>
            <label>
              Password
              <input
                type="password"
                value={credentials.password}
                onChange={(event) => setCredentials((current) => ({ ...current, password: event.target.value }))}
              />
            </label>
            <button disabled={busy} type="submit">
              {busy ? "Signing in..." : "Sign in"}
            </button>
          </form>
          {error ? <p className="error">{error}</p> : null}
        </section>
      </main>
    );
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <div>
          <h1>WireGuard Ops Cockpit</h1>
          <p>
            Signed in as <strong>{user.username}</strong> ({user.role})
          </p>
        </div>
        <button onClick={handleLogout} disabled={busy}>
          Sign out
        </button>
      </header>

      {error ? <p className="error">{error}</p> : null}

      <section className="panel info-panel">
        <strong>Execution model</strong>
        <p>
          Copilot plans the change and the local bounded executor dispatches allowlisted runbooks and linked scripts.
          The GUI reviews definitions and execution state, but it does not become the privilege boundary.
        </p>
      </section>

      <section className="grid two-column">
        <article className="panel">
          <h2>Sessions</h2>
          <form onSubmit={createSession} className="inline-form">
            <input
              value={sessionName}
              placeholder="incident-debug"
              onChange={(event) => setSessionName(event.target.value)}
            />
            <button disabled={busy} type="submit">
              Create or resume
            </button>
          </form>
          <div className="panel-scroll">
            <ul className="list">
              {sessions.map((session) => (
                <li key={session.id}>
                  <button
                    className={selectedSessionId === session.id ? "selected" : ""}
                    onClick={() => setSelectedSessionId(session.id)}
                  >
                    {session.name}
                  </button>
                  <small>
                    {session.tmuxBackend} · {new Date(session.lastActivityAt).toLocaleString()}
                  </small>
                </li>
              ))}
              {sessions.length === 0 ? <li>No sessions yet.</li> : null}
            </ul>
          </div>
        </article>

        <article className="panel">
          <h2>Session detail</h2>
          {sessionDetail ? (
            <div className="stack panel-scroll">
              <p>
                <strong>{sessionDetail.session.name}</strong> → {sessionDetail.session.tmuxSessionName}
              </p>
              <p>{sessionDetail.session.terminal.note}</p>
              {sessionDetail.session.terminal.terminalUrl ? (
                <p>
                  <a href={sessionDetail.session.terminal.terminalUrl} target="_blank" rel="noreferrer">
                    Open terminal bridge
                  </a>
                </p>
              ) : null}
              <h3>Execution plans</h3>
              <ul className="list">
                {sessionDetail.plans.map((plan) => (
                  <li key={plan.id}>
                    <strong>
                      {plan.targetType} · {plan.status} · {plan.riskClass}
                    </strong>
                    <p>{plan.planSummary}</p>
                    <small>hash {plan.planHash.slice(0, 12)}</small>
                    <p>
                      Planner {plan.plannerReview.verdict} · Safety {plan.safetyReview.verdict} · Policy {plan.policyReview.verdict}
                    </p>
                    <p>
                      Pre-hook {plan.preExecutionHook.verdict} · Post-hook {plan.postExecutionHook.verdict}
                    </p>
                  </li>
                ))}
                {sessionDetail.plans.length === 0 ? <li>No execution plans recorded yet.</li> : null}
              </ul>
              <h3>Job timeline</h3>
              <ul className="list">
                {sessionDetail.jobs.map((job) => (
                  <li key={job.id}>
                    <strong>{job.kind}</strong> · {job.status}
                    <pre>{formatOutput(job.output)}</pre>
                  </li>
                ))}
                {sessionDetail.jobs.length === 0 ? <li>No jobs recorded yet.</li> : null}
              </ul>
            </div>
          ) : (
            <p>Select a session to inspect jobs and terminal metadata.</p>
          )}
        </article>
      </section>

      <section className="grid three-column">
        <article className="panel">
          <h2>Schedules</h2>
          <p>Bind reviewed runbook versions to a weekly schedule. High-risk runbooks stay on scheduled-plan-only in this slice.</p>
          <form onSubmit={createSchedule} className="stack schedule-form">
            <label>
              Runbook
              <select
                value={scheduleDraft.runbookId}
                onChange={(event) => setScheduleDraft((current) => ({ ...current, runbookId: event.target.value }))}
              >
                {runbooks.map((runbook) => (
                  <option key={runbook.id} value={runbook.id}>
                    {runbook.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Session
              <select
                value={scheduleDraft.sessionId}
                onChange={(event) => setScheduleDraft((current) => ({ ...current, sessionId: event.target.value }))}
              >
                {sessions.map((session) => (
                  <option key={session.id} value={session.id}>
                    {session.name}
                  </option>
                ))}
              </select>
            </label>
            <div className="split-fields">
              <label>
                Weekday
                <select
                  value={scheduleDraft.weekday}
                  onChange={(event) => setScheduleDraft((current) => ({ ...current, weekday: event.target.value }))}
                >
                  {weekdayLabels.map((label, index) => (
                    <option key={label} value={String(index)}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Time UTC
                <input
                  type="time"
                  value={scheduleDraft.timeUtc}
                  onChange={(event) => setScheduleDraft((current) => ({ ...current, timeUtc: event.target.value }))}
                />
              </label>
            </div>
            <label>
              Mode
              <select
                value={scheduleDraft.mode}
                onChange={(event) =>
                  setScheduleDraft((current) => ({
                    ...current,
                    mode: event.target.value as "scheduled-plan-only" | "scheduled-auto"
                  }))
                }
              >
                <option value="scheduled-plan-only">scheduled-plan-only</option>
                <option
                  value="scheduled-auto"
                  disabled={Boolean(
                    selectedScheduleRunbook &&
                      (selectedScheduleRunbook.requiresApproval || selectedScheduleRunbook.privilegedHelperRequested)
                  )}
                >
                  scheduled-auto
                </option>
              </select>
            </label>
            <button disabled={busy || !scheduleDraft.runbookId || !scheduleDraft.sessionId} type="submit">
              Create weekly schedule
            </button>
          </form>
          <div className="panel-scroll">
            <ul className="list">
              {schedules.map((schedule) => (
                <li key={schedule.id}>
                  <strong>{runbooks.find((runbook) => runbook.id === schedule.runbookId)?.name || schedule.runbookId}</strong>
                  <p>
                    {weekdayLabels[schedule.weekday]} at {schedule.timeUtc} {schedule.timezone} → {sessionsById[schedule.sessionId]?.name || schedule.sessionId}
                  </p>
                  <small>
                    {schedule.status} · {schedule.effectiveMode} · next {new Date(schedule.nextRunAt).toLocaleString()}
                  </small>
                  <small>version {schedule.runbookVersionHash.slice(0, 12)}</small>
                  <div className="actions">
                    <button disabled={busy || schedule.status === "active"} onClick={() => changeScheduleState(schedule.id, "activate")}>
                      Activate
                    </button>
                    <button disabled={busy || schedule.status === "paused"} onClick={() => changeScheduleState(schedule.id, "pause")}>
                      Pause
                    </button>
                  </div>
                </li>
              ))}
              {schedules.length === 0 ? <li>No weekly schedules yet.</li> : null}
            </ul>
          </div>
        </article>

        <article className="panel">
          <h2>Runbooks</h2>
          <p>Review allowlisted runbook definitions before you dispatch them into the local executor.</p>
          <div className="panel-scroll">
            <ul className="list">
              {runbooks.map((runbook) => (
                <li key={runbook.id}>
                  <strong>{runbook.name}</strong>
                  <p>{runbook.summary}</p>
                  <small>
                    review {runbook.reviewStatus} · {runbook.integration} · approval {runbook.requiresApproval ? "required" : "not required"}
                  </small>
                  <small>
                    includes {runbook.scriptIds.length} script{runbook.scriptIds.length === 1 ? "" : "s"}: {runbook.scriptIds
                      .map((scriptId) => scriptsById[scriptId]?.name || scriptId)
                      .join(", ")}
                  </small>
                  <button disabled={busy || !selectedSession} onClick={() => executeRunbook(runbook.id)}>
                    {runbook.requiresApproval ? "Plan and queue approval" : "Plan and execute"}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </article>

        <article className="panel">
          <h2>Scripts</h2>
          <p>Scripts are reusable allowlisted building blocks that can be attached to one or more runbooks.</p>
          <div className="panel-scroll">
            <ul className="list">
              {scripts.map((script) => (
                <li key={script.id}>
                  <strong>{script.name}</strong>
                  <p>{script.summary}</p>
                  <small>
                    review {script.reviewStatus} · {script.integration} · privileged helper {script.privilegedHelperRequested ? "requested" : "not requested"}
                  </small>
                  <small>source {script.sourcePath}</small>
                </li>
              ))}
              {scripts.length === 0 ? <li>No scripts defined yet.</li> : null}
            </ul>
          </div>
        </article>

        <article className="panel">
          <h2>Agents</h2>
          <p>Agent launches use the same plan, safety, and hook pipeline before the bounded executor runs.</p>
          <label className="stack">
            Prompt
            <textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} rows={4} />
          </label>
          <div className="panel-scroll">
            <ul className="list">
              {agents.map((agent) => (
                <li key={agent.id}>
                  <strong>{agent.name}</strong>
                  <p>{agent.description}</p>
                  <button disabled={busy || !selectedSession} onClick={() => launchAgent(agent.id)}>
                    Plan and launch in selected session
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </article>

        <article className="panel">
          <h2>Approvals</h2>
          <div className="panel-scroll">
            <ul className="list">
              {approvals.map((approval) => (
                <li key={approval.id}>
                  <strong>{approval.status}</strong>
                  <p>{approval.reason || "No reason recorded."}</p>
                  <div className="actions">
                    <button disabled={busy} onClick={() => decideApproval(approval.id, "approved")}>
                      Approve
                    </button>
                    <button disabled={busy} onClick={() => decideApproval(approval.id, "rejected")}>
                      Reject
                    </button>
                  </div>
                </li>
              ))}
              {approvals.length === 0 ? <li>No pending approvals.</li> : null}
            </ul>
          </div>
        </article>
      </section>

      <section className="panel">
        <h2>Recent audit trail</h2>
        <div className="panel-scroll">
          <ul className="audit-list">
            {audits.map((audit) => (
              <li key={audit.id}>
                <strong>{audit.action}</strong> → {audit.targetType}
                {audit.targetId ? ` (${audit.targetId})` : ""}
                <small>{new Date(audit.createdAt).toLocaleString()}</small>
              </li>
            ))}
            {audits.length === 0 ? <li>No audit entries yet.</li> : null}
          </ul>
        </div>
      </section>
    </main>
  );
}

