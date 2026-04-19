import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import BetterSqlite3 from "better-sqlite3";
import type {
  ApprovalRecord,
  ApprovalStatus,
  AuditRecord,
  CockpitSession,
  JobRecord,
  JobStatus,
  TerminalBridge,
  TmuxBackend,
  UserSummary
} from "@wireguard-ops-cockpit/domain";
import { createAuthToken, hashPassword, hashAuthToken, verifyPassword } from "./auth.js";

type SqliteValue = string | number | null;

interface SessionRow {
  id: string;
  name: string;
  status: string;
  tmux_session_name: string;
  tmux_backend: TmuxBackend;
  terminal_url: string | null;
  created_at: string;
  updated_at: string;
  last_activity_at: string;
}

interface JobRow {
  id: string;
  session_id: string | null;
  kind: string;
  subject_id: string | null;
  status: JobStatus;
  requires_approval: number;
  approval_id: string | null;
  output_json: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

interface ApprovalRow {
  id: string;
  job_id: string;
  status: ApprovalStatus;
  requested_by: string;
  decided_by: string | null;
  reason: string | null;
  created_at: string;
  decided_at: string | null;
}

interface AuditRow {
  id: string;
  actor_id: string | null;
  action: string;
  target_type: string;
  target_id: string | null;
  details_json: string;
  created_at: string;
}

interface UserRow extends UserSummary {
  password_hash: string;
}

interface SessionRuntimeTarget {
  id: string;
  name: string;
  tmuxSessionName: string;
  tmuxBackend: TmuxBackend;
}

function now(): string {
  return new Date().toISOString();
}

function ensureParentDirectory(filePath: string): void {
  const parent = path.dirname(filePath);
  fs.mkdirSync(parent, { recursive: true });
}

function parseJsonValue(value: string | null): Record<string, unknown> | null {
  if (!value) {
    return null;
  }

  return JSON.parse(value) as Record<string, unknown>;
}

function stringifyJsonValue(value: Record<string, unknown> | null | undefined): string | null {
  if (!value) {
    return null;
  }

  return JSON.stringify(value);
}

function terminalBridge(terminalUrl: string | null, tmuxBackend: TmuxBackend): TerminalBridge {
  if (terminalUrl) {
    return {
      terminalUrl,
      status: "configured",
      note: "Browser terminal attachment is delegated to an external ttyd-compatible bridge."
    };
  }

  return {
    terminalUrl: null,
    status: "pending_integration",
    note:
      tmuxBackend === "tmux"
        ? "The tmux session exists, but no ttyd base URL is configured yet."
        : "The session model is active, but tmux integration is disabled in this runtime."
  };
}

export class CockpitDatabase {
  private readonly database: BetterSqlite3.Database;

  constructor(filePath: string) {
    if (filePath !== ":memory:") {
      ensureParentDirectory(filePath);
    }

    this.database = new BetterSqlite3(filePath);
    this.database.pragma("journal_mode = WAL");
  }

  initialize(): void {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS auth_sessions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        token_hash TEXT NOT NULL UNIQUE,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (user_id) REFERENCES users(id)
      );

      CREATE TABLE IF NOT EXISTS cockpit_sessions (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL,
        tmux_session_name TEXT NOT NULL,
        tmux_backend TEXT NOT NULL,
        terminal_url TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_activity_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY,
        session_id TEXT,
        kind TEXT NOT NULL,
        subject_id TEXT,
        status TEXT NOT NULL,
        requires_approval INTEGER NOT NULL,
        approval_id TEXT,
        output_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT,
        FOREIGN KEY (session_id) REFERENCES cockpit_sessions(id)
      );

      CREATE TABLE IF NOT EXISTS approvals (
        id TEXT PRIMARY KEY,
        job_id TEXT NOT NULL,
        status TEXT NOT NULL,
        requested_by TEXT NOT NULL,
        decided_by TEXT,
        reason TEXT,
        created_at TEXT NOT NULL,
        decided_at TEXT,
        FOREIGN KEY (job_id) REFERENCES jobs(id),
        FOREIGN KEY (requested_by) REFERENCES users(id),
        FOREIGN KEY (decided_by) REFERENCES users(id)
      );

      CREATE TABLE IF NOT EXISTS audits (
        id TEXT PRIMARY KEY,
        actor_id TEXT,
        action TEXT NOT NULL,
        target_type TEXT NOT NULL,
        target_id TEXT,
        details_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (actor_id) REFERENCES users(id)
      );
    `);
  }

  seedAdmin(username: string, password: string): void {
    const userCount = this.database.prepare("SELECT COUNT(*) as count FROM users").get() as { count: number };
    if (userCount.count > 0) {
      return;
    }

    const passwordHash = hashPassword(password);
    this.database
      .prepare(
        "INSERT INTO users (id, username, password_hash, role, created_at) VALUES (?, ?, ?, 'admin', ?)"
      )
      .run(randomUUID(), username, passwordHash, now());
  }

  createUser(username: string, password: string, role: UserSummary["role"] = "admin"): UserSummary {
    const existing = this.database
      .prepare("SELECT id, username, role FROM users WHERE username = ?")
      .get(username) as UserSummary | undefined;
    if (existing) {
      return existing;
    }

    const id = randomUUID();
    this.database
      .prepare(
        "INSERT INTO users (id, username, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?)"
      )
      .run(id, username, hashPassword(password), role, now());

    return { id, username, role };
  }

  authenticateUser(username: string, password: string): UserSummary | null {
    const row = this.database
      .prepare("SELECT id, username, role, password_hash FROM users WHERE username = ?")
      .get(username) as UserRow | undefined;

    if (!row || !verifyPassword(password, row.password_hash)) {
      return null;
    }

    return { id: row.id, username: row.username, role: row.role };
  }

  issueAuthSession(userId: string, ttlHours: number): string {
    this.pruneExpiredSessions();
    const token = createAuthToken();
    const expiresAt = new Date(Date.now() + ttlHours * 60 * 60 * 1000).toISOString();

    this.database
      .prepare(
        "INSERT INTO auth_sessions (id, user_id, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?)"
      )
      .run(randomUUID(), userId, token.hash, expiresAt, now());

    return token.raw;
  }

  findUserByAuthToken(rawToken: string): UserSummary | null {
    this.pruneExpiredSessions();

    const row = this.database
      .prepare(
        `SELECT users.id, users.username, users.role
         FROM auth_sessions
         JOIN users ON users.id = auth_sessions.user_id
         WHERE auth_sessions.token_hash = ?`
      )
      .get(hashAuthToken(rawToken)) as UserSummary | undefined;

    return row || null;
  }

  revokeAuthToken(rawToken: string): void {
    this.database.prepare("DELETE FROM auth_sessions WHERE token_hash = ?").run(hashAuthToken(rawToken));
  }

  private pruneExpiredSessions(): void {
    this.database.prepare("DELETE FROM auth_sessions WHERE expires_at <= ?").run(now());
  }

  listSessions(): CockpitSession[] {
    const rows = this.database
      .prepare(
        "SELECT * FROM cockpit_sessions ORDER BY datetime(last_activity_at) DESC, datetime(created_at) DESC"
      )
      .all() as SessionRow[];

    return rows.map((row) => this.mapSession(row));
  }

  getSessionById(id: string): CockpitSession | null {
    const row = this.database.prepare("SELECT * FROM cockpit_sessions WHERE id = ?").get(id) as
      | SessionRow
      | undefined;

    return row ? this.mapSession(row) : null;
  }

  getSessionRuntimeTarget(id: string): SessionRuntimeTarget | null {
    const row = this.database.prepare("SELECT * FROM cockpit_sessions WHERE id = ?").get(id) as
      | SessionRow
      | undefined;

    if (!row) {
      return null;
    }

    return {
      id: row.id,
      name: row.name,
      tmuxSessionName: row.tmux_session_name,
      tmuxBackend: row.tmux_backend
    };
  }

  upsertSession(input: {
    name: string;
    tmuxSessionName: string;
    tmuxBackend: TmuxBackend;
    terminalUrl: string | null;
  }): CockpitSession {
    const existing = this.database
      .prepare("SELECT * FROM cockpit_sessions WHERE name = ?")
      .get(input.name) as SessionRow | undefined;
    const timestamp = now();

    if (existing) {
      this.database
        .prepare(
          `UPDATE cockpit_sessions
           SET tmux_session_name = ?, tmux_backend = ?, terminal_url = ?, updated_at = ?, last_activity_at = ?
           WHERE id = ?`
        )
        .run(
          input.tmuxSessionName,
          input.tmuxBackend,
          input.terminalUrl,
          timestamp,
          timestamp,
          existing.id
        );
      return this.getSessionById(existing.id)!;
    }

    const id = randomUUID();
    this.database
      .prepare(
        `INSERT INTO cockpit_sessions
         (id, name, status, tmux_session_name, tmux_backend, terminal_url, created_at, updated_at, last_activity_at)
         VALUES (?, ?, 'active', ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        input.name,
        input.tmuxSessionName,
        input.tmuxBackend,
        input.terminalUrl,
        timestamp,
        timestamp,
        timestamp
      );

    return this.getSessionById(id)!;
  }

  recordSessionActivity(sessionId: string): void {
    const timestamp = now();
    this.database
      .prepare("UPDATE cockpit_sessions SET updated_at = ?, last_activity_at = ? WHERE id = ?")
      .run(timestamp, timestamp, sessionId);
  }

  updateSessionTerminalUrl(sessionId: string, terminalUrl: string | null): CockpitSession {
    this.database
      .prepare("UPDATE cockpit_sessions SET terminal_url = ?, updated_at = ? WHERE id = ?")
      .run(terminalUrl, now(), sessionId);

    return this.getSessionById(sessionId)!;
  }

  createJob(input: {
    sessionId: string | null;
    kind: string;
    subjectId: string | null;
    status: JobStatus;
    requiresApproval: boolean;
    approvalId?: string | null;
    output?: Record<string, unknown> | null;
    completedAt?: string | null;
  }): JobRecord {
    const id = randomUUID();
    const timestamp = now();

    this.database
      .prepare(
        `INSERT INTO jobs
         (id, session_id, kind, subject_id, status, requires_approval, approval_id, output_json, created_at, updated_at, completed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        input.sessionId,
        input.kind,
        input.subjectId,
        input.status,
        input.requiresApproval ? 1 : 0,
        input.approvalId || null,
        stringifyJsonValue(input.output),
        timestamp,
        timestamp,
        input.completedAt || null
      );

    return this.getJob(id)!;
  }

  getJob(id: string): JobRecord | null {
    const row = this.database.prepare("SELECT * FROM jobs WHERE id = ?").get(id) as JobRow | undefined;
    return row ? this.mapJob(row) : null;
  }

  listJobsForSession(sessionId: string): JobRecord[] {
    const rows = this.database
      .prepare("SELECT * FROM jobs WHERE session_id = ? ORDER BY datetime(created_at) DESC")
      .all(sessionId) as JobRow[];
    return rows.map((row) => this.mapJob(row));
  }

  updateJob(
    jobId: string,
    input: {
      status: JobStatus;
      approvalId?: string | null;
      output?: Record<string, unknown> | null;
      completedAt?: string | null;
    }
  ): JobRecord {
    const current = this.getJob(jobId);
    if (!current) {
      throw new Error("job not found");
    }

    this.database
      .prepare(
        `UPDATE jobs
         SET status = ?, approval_id = ?, output_json = ?, updated_at = ?, completed_at = ?
         WHERE id = ?`
      )
      .run(
        input.status,
        input.approvalId ?? current.approvalId,
        stringifyJsonValue(input.output ?? current.output),
        now(),
        input.completedAt ?? current.completedAt,
        jobId
      );

    return this.getJob(jobId)!;
  }

  listApprovals(status?: ApprovalStatus): ApprovalRecord[] {
    const statement = status
      ? this.database.prepare("SELECT * FROM approvals WHERE status = ? ORDER BY datetime(created_at) DESC")
      : this.database.prepare("SELECT * FROM approvals ORDER BY datetime(created_at) DESC");
    const rows = (status ? statement.all(status) : statement.all()) as ApprovalRow[];
    return rows.map((row) => this.mapApproval(row));
  }

  createApproval(input: {
    jobId: string;
    requestedBy: string;
    reason: string | null;
  }): ApprovalRecord {
    const id = randomUUID();
    const timestamp = now();
    this.database
      .prepare(
        `INSERT INTO approvals
         (id, job_id, status, requested_by, reason, created_at)
         VALUES (?, ?, 'pending', ?, ?, ?)`
      )
      .run(id, input.jobId, input.requestedBy, input.reason, timestamp);

    return this.getApproval(id)!;
  }

  getApproval(id: string): ApprovalRecord | null {
    const row = this.database.prepare("SELECT * FROM approvals WHERE id = ?").get(id) as
      | ApprovalRow
      | undefined;
    return row ? this.mapApproval(row) : null;
  }

  decideApproval(
    id: string,
    input: { status: Exclude<ApprovalStatus, "pending">; decidedBy: string; reason: string | null }
  ): ApprovalRecord {
    this.database
      .prepare(
        "UPDATE approvals SET status = ?, decided_by = ?, reason = ?, decided_at = ? WHERE id = ?"
      )
      .run(input.status, input.decidedBy, input.reason, now(), id);
    return this.getApproval(id)!;
  }

  createAudit(input: {
    actorId: string | null;
    action: string;
    targetType: string;
    targetId: string | null;
    details: Record<string, unknown>;
  }): AuditRecord {
    const id = randomUUID();
    const timestamp = now();
    this.database
      .prepare(
        "INSERT INTO audits (id, actor_id, action, target_type, target_id, details_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
      )
      .run(
        id,
        input.actorId,
        input.action,
        input.targetType,
        input.targetId,
        JSON.stringify(input.details),
        timestamp
      );

    return this.getAudit(id)!;
  }

  listAudits(limit = 50): AuditRecord[] {
    const rows = this.database
      .prepare("SELECT * FROM audits ORDER BY datetime(created_at) DESC LIMIT ?")
      .all(limit) as AuditRow[];
    return rows.map((row) => this.mapAudit(row));
  }

  getAudit(id: string): AuditRecord | null {
    const row = this.database.prepare("SELECT * FROM audits WHERE id = ?").get(id) as AuditRow | undefined;
    return row ? this.mapAudit(row) : null;
  }

  close(): void {
    this.database.close();
  }

  private mapSession(row: SessionRow): CockpitSession {
    return {
      id: row.id,
      name: row.name,
      status: "active",
      tmuxBackend: row.tmux_backend,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      lastActivityAt: row.last_activity_at,
      terminal: terminalBridge(row.terminal_url, row.tmux_backend)
    };
  }

  private mapJob(row: JobRow): JobRecord {
    return {
      id: row.id,
      sessionId: row.session_id,
      kind: row.kind as JobRecord["kind"],
      subjectId: row.subject_id,
      status: row.status,
      requiresApproval: row.requires_approval === 1,
      approvalId: row.approval_id,
      output: parseJsonValue(row.output_json),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      completedAt: row.completed_at
    };
  }

  private mapApproval(row: ApprovalRow): ApprovalRecord {
    return {
      id: row.id,
      jobId: row.job_id,
      status: row.status,
      requestedBy: row.requested_by,
      decidedBy: row.decided_by,
      reason: row.reason,
      createdAt: row.created_at,
      decidedAt: row.decided_at
    };
  }

  private mapAudit(row: AuditRow): AuditRecord {
    return {
      id: row.id,
      actorId: row.actor_id,
      action: row.action,
      targetType: row.target_type,
      targetId: row.target_id,
      details: parseJsonValue(row.details_json) || {},
      createdAt: row.created_at
    };
  }
}
