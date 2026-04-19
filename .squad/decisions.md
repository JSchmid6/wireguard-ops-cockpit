# Team decisions

## Decision 001 - Cloud agents build the repository, not the live VPS

### Context

The project will eventually interact with a real VPS and privileged operations such as upgrades and maintenance tasks.

### Decision

Cloud-side agents and Squad are allowed to design, scaffold, test, and review repository code. Live host operations stay behind later local runbook execution and human approval.

### Consequence

The first implementation pass must expose integration seams, not fake privileged automation.

## Decision 002 - Security review defaults to GPT-5.4

### Context

The project blends web UI, terminal bridging, automation, and future privileged operations. Security review quality matters, but cost and availability also matter for day-to-day use.

### Decision

Whenever model selection is available, route the `security-champion` role to GPT-5.4 by default. Use a stronger specialized model only if it is actually available and the extra cost is justified.

### Consequence

Routine implementation may use cheaper models, but security review should default to GPT-5.4 unless there is a clear reason to escalate.

## Decision 003 - MCP is default deny

### Context

MCP expands autonomous tool access. In cloud-agent workflows, tools may be used without an extra approval prompt.

### Decision

Only explicitly justified MCP servers and tools may be enabled. Prefer read-only, repository-scoped capabilities first.

### Consequence

Any request for live infrastructure control via MCP should be rejected or deferred to the local control plane.

## Decision 004 - Host execution uses multi-agent planning with deterministic gates

### Context

The platform needs to support agent-assisted repair and maintenance on the target VPS without turning a single agent into an unrestricted host administrator.

### Decision

Host-affecting execution will follow a layered model:

- a `planner-agent` proposes a structured action plan
- a `safety-agent` reviews the plan for policy and damage risk
- a deterministic policy gate performs the authoritative allow or deny decision
- hard hooks run before, during, and after execution
- only a bounded executor may mutate the host through activated runbooks or helpers

Agent-generated runbooks may be proposed later, but activation must stay a separate reviewed and approved lifecycle.

### Consequence

The repository should document the execution-control model explicitly, keep runbook activation separate from incident execution, and bind approvals and audit records to exact plans rather than free-form prompts.
