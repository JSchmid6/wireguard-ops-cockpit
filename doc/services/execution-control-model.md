# Execution control model

## Goal

Define how planners, safety checks, deterministic policy enforcement, hooks, and bounded execution fit together for host-affecting work.

## Design summary

The platform should support multi-agent planning and review, but no agent is the privilege boundary.

Execution authority is split into five layers:

1. `planner-agent`
2. `safety-agent`
3. deterministic policy gate
4. pre/post execution hooks
5. bounded executor

Only the bounded executor may mutate the host, and only through a registered runbook or helper path.

## Components

### `planner-agent`

- analyzes an incident or requested task
- produces a structured plan rather than free-form shell text
- may propose an existing runbook or suggest that a new runbook type is needed
- runs inside the task-scoped `tmux` session so an operator can observe or take over

Required output fields:

- plan id
- task or incident id
- proposed runbook id
- normalized parameters
- target scope
- risk class
- expected impact
- rollback hint
- plan hash

### `safety-agent`

- reviews the structured plan, not arbitrary shell access
- checks for likely system damage, policy mismatch, or oversized blast radius
- may downgrade the proposal, request approval, or veto execution
- remains advisory or fail-closed; it is not the final privilege decision

The `safety-agent` is useful for:

- contextual risk reasoning
- incident-specific sanity checks
- safer alternative suggestions
- identifying missing rollback or health checks

It must not be the only component that can authorize privileged execution.

### Deterministic policy gate

The policy gate is the authoritative allow or deny layer.

It validates:

- runbook allowlist membership
- manifest version or digest
- parameter schema and bounds
- target scope
- privilege class
- approval requirements
- concurrency and lock conditions
- plan hash equality between approved and executed action

If a request cannot be represented as an allowlisted runbook or helper, execution stops.

### Hooks

Hooks are hard guardrails around execution, not optional shell snippets.

#### Pre-plan hooks

- verify session, actor, and task context
- restrict which tools and targets are visible to the planner

#### Pre-exec hooks

- reject disallowed targets, paths, commands, or privilege classes
- enforce approval for risky actions
- re-check hash and parameter integrity

#### Runtime hooks

- abort on lock conflicts, timeouts, unstable health, or repeated restart loops
- keep runtime evidence attached to the job and session

#### Post-exec hooks

- verify recovery goals such as service health or site availability
- keep the incident open if the target state is not restored
- attach audit and rollback hints to the job record

### Bounded executor

The executor runs only predeclared runbooks or helpers.

- no arbitrary shell from the browser
- no direct UI to `sudo` path
- no unrestricted Docker or host admin shortcuts
- no implicit mutation outside an approved runbook contract

Long-running or high-risk actions should execute in the same `tmux` session or a dedicated pane or window attached to that task.

## Execution flow

1. An operator or monitor creates an incident or repair task.
2. The control plane creates a job and ensures a task-scoped `tmux` session exists.
3. The `planner-agent` produces a structured plan.
4. The `safety-agent` reviews that plan and emits advisory findings or a veto.
5. The deterministic policy gate validates the exact plan object.
6. If required, an approval record is created for the exact plan hash.
7. Pre-exec hooks revalidate the approved action immediately before dispatch.
8. The bounded executor runs the registered helper or runbook.
9. Runtime and post-exec hooks verify the outcome and keep the audit trail complete.
10. The operator can inspect or take over through the same `tmux` session.

## Website recovery example

For a `website-down` incident, the preferred path is:

1. `planner-agent` proposes `website-health-check`, `collect-web-logs`, and `restart-web-service`.
2. `safety-agent` checks whether the restart is minimal and whether rollback or escalation is needed.
3. The policy gate confirms that `restart-web-service` is an allowlisted runbook for the affected target.
4. Pre-exec hooks reject unrelated service restarts or package operations.
5. The executor restarts only the allowlisted service.
6. Post-exec hooks confirm the site is healthy again before closing the incident.

## Runbook extension lifecycle

The system should eventually be extensible through agent-generated runbook proposals, but creation and activation must stay separate from normal repair execution.

Runbook states:

1. `proposed`
2. `reviewed`
3. `approved`
4. `activated`

Rules:

- agents may propose new runbooks
- agents may not activate a new runbook during the same incident they discovered it in
- a proposed runbook must pass deterministic validation, security review, and human approval before activation
- only activated runbooks become executable by the bounded executor

This lets the platform evolve through agents without turning incident response into live self-extension of host privileges.

## Initial implementation guidance

Ship the first host-facing slice with:

- existing bounded runbooks only
- one `planner-agent`
- one `safety-agent`
- deterministic policy enforcement
- pre-exec and post-exec hooks
- audit and approval records bound to exact plans

Defer agent-driven runbook activation until the basic execution path is stable and observable.