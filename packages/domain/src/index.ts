export type UserRole = "admin";
export type TmuxBackend = "tmux" | "disabled";
export type SessionStatus = "active";
export type JobKind = "session.ensure" | "execution.plan" | "runbook" | "agent";
export type JobStatus =
  | "pending"
  | "pending_approval"
  | "running"
  | "completed"
  | "rejected"
  | "failed";
export type ApprovalStatus = "pending" | "approved" | "rejected";
export type PlanTargetType = "runbook" | "agent";
export type PlanStatus = "blocked" | "pending_approval" | "ready" | "executed" | "rejected";
export type ExecutionRiskClass = "low" | "moderate" | "high";
export type PlanReviewVerdict = "pending" | "passed" | "blocked" | "approval_required" | "not_run";

export interface UserSummary {
  id: string;
  username: string;
  role: UserRole;
}

export interface TerminalBridge {
  terminalUrl: string | null;
  status: "configured" | "pending_integration";
  note: string;
}

export interface CockpitSession {
  id: string;
  name: string;
  status: SessionStatus;
  tmuxBackend: TmuxBackend;
  createdAt: string;
  updatedAt: string;
  lastActivityAt: string;
  terminal: TerminalBridge;
}

export interface JobRecord {
  id: string;
  sessionId: string | null;
  kind: JobKind;
  subjectId: string | null;
  status: JobStatus;
  requiresApproval: boolean;
  approvalId: string | null;
  output: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface ApprovalRecord {
  id: string;
  jobId: string;
  status: ApprovalStatus;
  requestedBy: string;
  decidedBy: string | null;
  reason: string | null;
  createdAt: string;
  decidedAt: string | null;
}

export interface AuditRecord {
  id: string;
  actorId: string | null;
  action: string;
  targetType: string;
  targetId: string | null;
  details: Record<string, unknown>;
  createdAt: string;
}

export interface ExecutionReview {
  actorId: string | null;
  verdict: PlanReviewVerdict;
  summary: string;
  details: Record<string, unknown>;
}

export interface ExecutionPlan {
  id: string;
  sessionId: string | null;
  targetType: PlanTargetType;
  targetId: string;
  requestedBy: string;
  status: PlanStatus;
  riskClass: ExecutionRiskClass;
  requiresApproval: boolean;
  approvalId: string | null;
  executedJobId: string | null;
  planHash: string;
  planSummary: string;
  normalizedInput: Record<string, unknown>;
  plannerReview: ExecutionReview;
  safetyReview: ExecutionReview;
  policyReview: ExecutionReview;
  preExecutionHook: ExecutionReview;
  runtimeHook: ExecutionReview;
  postExecutionHook: ExecutionReview;
  createdAt: string;
  updatedAt: string;
}

export interface RunbookDefinition {
  id: string;
  name: string;
  summary: string;
  requiresApproval: boolean;
  integration: "placeholder";
  privilegedHelperRequested: boolean;
}

export interface AgentManifest {
  id: string;
  name: string;
  description: string;
  requiresApproval: boolean;
  privilegedHelperRequested: boolean;
  integration: "demo-local";
}

export interface SessionDetail {
  session: CockpitSession;
  plans: ExecutionPlan[];
  jobs: JobRecord[];
}
