import { useEffect, useMemo, useState } from "react";

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
  requiresApproval: boolean;
}

interface AgentManifest {
  id: string;
  name: string;
  description: string;
}

interface SessionDetail {
  session: CockpitSession;
  jobs: JobRecord[];
}

const apiBase = import.meta.env.VITE_API_BASE || "/api";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${apiBase}${path}`, {
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers || {})
    },
    ...init
  });

  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { message?: string };
    throw new Error(body.message || `Request failed with status ${response.status}`);
  }

  return (await response.json()) as T;
}

function formatOutput(output: Record<string, unknown> | null): string {
  if (!output) {
    return "No structured output recorded yet.";
  }

  const lines = Object.entries(output).map(([key, value]) =>
    `${key}: ${typeof value === "string" ? value : JSON.stringify(value)}`
  );
  return lines.join("\n");
}

export default function App() {
  const [user, setUser] = useState<UserSummary | null>(null);
  const [sessions, setSessions] = useState<CockpitSession[]>([]);
  const [runbooks, setRunbooks] = useState<RunbookDefinition[]>([]);
  const [agents, setAgents] = useState<AgentManifest[]>([]);
  const [approvals, setApprovals] = useState<ApprovalRecord[]>([]);
  const [audits, setAudits] = useState<AuditRecord[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState("");
  const [sessionDetail, setSessionDetail] = useState<SessionDetail | null>(null);
  const [sessionName, setSessionName] = useState("");
  const [prompt, setPrompt] = useState("Summarize the current maintenance context.");
  const [credentials, setCredentials] = useState({ username: "admin", password: "change-me-now" });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const selectedSession = useMemo(
    () => sessions.find((session) => session.id === selectedSessionId) || null,
    [sessions, selectedSessionId]
  );

  async function refreshDashboard() {
    try {
      const [me, sessionsResponse, runbooksResponse, agentsResponse, approvalsResponse, auditsResponse] =
        await Promise.all([
          request<{ user: UserSummary }>("/me"),
          request<{ sessions: CockpitSession[] }>("/sessions"),
          request<{ runbooks: RunbookDefinition[] }>("/runbooks"),
          request<{ agents: AgentManifest[] }>("/agents"),
          request<{ approvals: ApprovalRecord[] }>("/approvals?status=pending"),
          request<{ audits: AuditRecord[] }>("/audits?limit=12")
        ]);

      setUser(me.user);
      setSessions(sessionsResponse.sessions);
      setRunbooks(runbooksResponse.runbooks);
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
        </article>

        <article className="panel">
          <h2>Session detail</h2>
          {sessionDetail ? (
            <div className="stack">
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
          <h2>Runbooks</h2>
          <p>Bounded placeholders keep privileged execution behind future local helpers.</p>
          <ul className="list">
            {runbooks.map((runbook) => (
              <li key={runbook.id}>
                <strong>{runbook.name}</strong>
                <p>{runbook.summary}</p>
                <button disabled={busy} onClick={() => executeRunbook(runbook.id)}>
                  {runbook.requiresApproval ? "Queue for approval" : "Execute placeholder"}
                </button>
              </li>
            ))}
          </ul>
        </article>

        <article className="panel">
          <h2>Agents</h2>
          <label className="stack">
            Prompt
            <textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} rows={4} />
          </label>
          <ul className="list">
            {agents.map((agent) => (
              <li key={agent.id}>
                <strong>{agent.name}</strong>
                <p>{agent.description}</p>
                <button disabled={busy || !selectedSession} onClick={() => launchAgent(agent.id)}>
                  Launch in selected session
                </button>
              </li>
            ))}
          </ul>
        </article>

        <article className="panel">
          <h2>Approvals</h2>
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
        </article>
      </section>

      <section className="panel">
        <h2>Recent audit trail</h2>
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
      </section>
    </main>
  );
}

