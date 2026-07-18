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

Only the bounded executor may mutate the host, through either a narrow legacy helper or a signed agent-authored capability manifest.

## Dynamic agent-centric capabilities

`cockpit-capability/v1` is an execution handoff, not an application-specific policy schema. The planner discovers installed versions and current tool help, then declares direct absolute argv steps, exact writable paths, network need, expected effects, verification, rollback, and effect risk. Tool names, subcommands, flags, and changing application APIs remain agent-owned.

The stable deterministic boundary is deliberately lower. It verifies the HMAC-bound manifest digest, actor/session/intent/review binding and expiry, then constrains real process effects with systemd isolation, exact-file write scopes, pre-change snapshots, network isolation, timeouts, and a small protected-effect boundary. Realistic new external exposure, loss of existing data, and identity/credential/secret access require a separate operator decision. Contained reversible changes do not.

Lifecycle:

1. Planner creates a manifest from trusted intent while treating mail, web, logs, and documents as untrusted evidence.
2. An independent safety agent reviews intent fit, possible effects, rollback, and injection attempts.
3. Control signs the exact manifest. Protected effects wait for approval; contained effects proceed autonomously.
4. The root sandbox helper independently verifies the signature, snapshots writable files, and executes direct argv without shell evaluation.
5. A separate read-only verifier checks target state. Only a verified manifest is retained by digest under Control state for reuse and audit.

This lifecycle replaces the assumption that every future application command needs a prewritten helper. Kernel privilege, filesystem scope, networking, protected effects, and signatures remain deterministic because an LLM must never be its own privilege boundary.

Hermes authenticates as an `automation` identity using a random bearer token stored hashed in Control. Its route scopes cover Hermes research/change/job polling and selected bounded discovery/runbook calls only. It cannot use approval or audit endpoints and cannot perform interactive password login. Rotating an administrator password revokes all existing administrator sessions.

Research and change planning use distinct prompt contracts. Research agents perform a bounded number of focused read-only inspections and must return factual evidence rather than a runbook or capability manifest. Access denials are reported instead of being bypassed, and research may not create temporary files or probe unrelated network endpoints. Change planners return a reviewable dynamic capability manifest; only the separately bounded executor may mutate host state.

Research is also a distinct broker role. It maps to OpenCode's non-mutating `plan` agent but receives its own root-controlled role file, a six-tool budget, and a 120-second child-process hard limit. Change planning, safety, and verification retain their separate five-minute limits; runner execution retains ten minutes. A research timeout is a preserved diagnostic failure, never authority to broaden inspection or fall back to shell execution.

Planner and safety model selection is configuration, not policy. The current deployment deliberately uses `opencode/big-pickle` for planning/research and `deepseek/deepseek-v4-pro` for safety review so correlated single-model failures are visible. Operators may replace either model without changing the execution contracts or deterministic effect boundary.

The isolated broker maps non-executing roles (`planner`, research through planner, `safety`, and `verifier`) to OpenCode's `plan` agent. Only the bounded `runner` role uses the `build` agent. Broker invocations use `--pure` so external OpenCode plugins cannot silently expand a role's tools or instructions.

Each broker invocation receives a new mode-`0700` session workspace below `/var/lib/wireguard-ops-agent/sessions`. The broker copies a root-controlled common contract plus the selected role contract into that workspace as `AGENTS.md`, launches OpenCode there, and removes only that exact prefixed directory when the child exits. No Cockpit source checkout is the default agent workspace. On broker startup, prefixed session directories older than 24 hours are treated as crash remnants and removed; unrelated entries are preserved.

The common contract describes the actual execution topology: Nextcloud and its primary database are host services; the agent is a sandboxed systemd identity; and signed mutations use a separate bubblewrap helper. A distinct mount namespace is therefore not evidence that the target runs in Docker. Research must not promote unrelated containers or processes into a root-cause hypothesis without target-specific invocation or cgroup evidence.

Hermes API calls that create their own tmux session also own its lifecycle. A terminal cleanup path kills the exact generated `cockpit-hermes-*` session after completion, rejection, failure, or timeout. A session supplied by the caller is persistent and is never killed by this mechanism. Job output, proposals, safety evidence, envelopes, and audit records are stored outside both ephemeral resources before cleanup.

### Cockpit break-glass recovery

Cockpit cannot be its own only recovery dependency. Normal host administration remains Cockpit-only, but a root operator may use `deploy/recovery/cockpit-break-glass` when Cockpit itself cannot safely dispatch its repair. This is not a second general administration channel.

The recovery tool accepts only `status`, 30-minute `logs`, and a reason-bearing `restart` for `wireguard-ops-cockpit-api.service`, `wireguard-ops-cockpit-agent.service`, `wireguard-ops-cockpit-executor.service`, or `wireguard-ops-cockpit-ttyd.service`. It provides no shell, file, network, database, application-service, or arbitrary-systemd target. A restart must run as root, must pass the service-specific active/socket/API health verification, and appends timestamp, UID, action, target, result, and base64-encoded reason to root-only `/var/log/wireguard-ops-cockpit-recovery/actions.tsv` and the system journal under `cockpit-break-glass`.

Source/configuration repairs remain normal reviewed repository changes; the break-glass tool only restores the known Cockpit runtime after such a repair. After recovery, perform the failed operation through Cockpit and retain its ordinary job evidence.

OpenCode's `plan` profile allows `external_directory` inspection because the broker's systemd service already enforces a read-only host view, blocks privilege gain, protects home directories, and denies writes. Secret-like `.env` reads retain OpenCode's separate restriction. This avoids unattended jobs hanging on redundant interactive read prompts without expanding mutation authority.

The broker passes the root-controlled config through `OPENCODE_CONFIG=/var/lib/wireguard-ops-agent/.config/opencode/opencode.jsonc` instead of relying on implicit global-file discovery. Its `external_directory=allow` is global for the sandbox identity because OpenCode's built-in `plan` agent delegates filesystem discovery to `explore`, which does not inherit a plan-only override. This is required operationally: `--auto` does not resolve repeated external-directory asks in this non-interactive runtime, and either an undiscovered or plan-only override consumes the full broker timeout. The OS view remains read-only and secret reads retain their separate denial.

The repeated-change circuit breaker counts failures per runtime fingerprint (planner model, safety model, capability contract, and broker role contract). A verified runtime repair therefore starts a fresh failure audit without erasing history; repeated failures under the unchanged runtime still stop autonomous retries.

If a later execution or verification stage fails, the terminal job preserves the already reviewed plan, safety result, policy decision, capability manifest, signed envelope, and proposal path. Failure reporting must add its explanation rather than erase the evidence needed to diagnose or safely continue.

Dynamic capabilities may declare minimal `readablePaths` and a non-root `runAsUser` per step. The executor performs the identity drop and read-only bind itself; manifests must not use `sudo`, `su`, or `runuser`. Container CLIs are evaluated by operation: read-only `ps`, `inspect`, `version`, and `info` are contained, while unknown or mutating subcommands require operator approval.

Network scope distinguishes `none`, `local`, `outbound`, and `host`. `local` permits connections only to host loopback/Unix services and denies all socket binding, so internal Redis or database-backed administration does not masquerade as public exposure. `host` remains operator-gated because it can listen or reach arbitrary host networks.

When the capability helper exits nonzero, the executor broker preserves both stderr and its structured stdout result. Control stores that diagnostic together with the reviewed plan and envelope so a failed sandbox prerequisite is explainable instead of collapsing to a generic executor error.

Planner-output extraction recognizes a capability by its semantic `cockpit-capability/v1` version inside either a `capability` or ordinary `json` fence. It does not depend on optional Markdown headings and must preserve JSON braces verbatim.

An unlabeled Markdown fence containing the same semantic version is also valid. OpenCode models may omit the requested fence label while returning otherwise valid JSON; treating that response as generic prose destroys braces and arrays, falsely classifies the plan as `shell.exception`, and forces unnecessary approval.

The planner contract requires the manifest JSON on one physical line. This is an output-transport constraint, not an application capability schema: OpenCode's formatted unattended console output was observed dropping brace-only and array-only lines from pretty-printed model output. Compact JSON preserves the complete agent-authored contract through that transport.

Control also accepts a standalone JSON object with semantic version `cockpit-capability/v1` when the planner omits the fence entirely. It does not scan arbitrary surrounding prose for loose braces; the unfenced form must be the complete trimmed output.

Independent verification distinguishes a runner claim from raw runner evidence. The verifier never trusts `STATUS: success`, but it may evaluate exact command output carried inside the signed handoff when that output directly proves every requested condition. It launches additional read-only observations only when the evidence is insufficient, and it must always return the terminal `VERIFICATION_STATUS`, `EVIDENCE`, and `REASON` schema.

### Nextcloud CLI inside the capability sandbox

The host Nextcloud 34 CLI initializes its database successfully when the capability binds `/run/mysqld`, uses `network: local` for Redis/Unix connectivity, and invokes PHP with `mysqli.default_socket=/run/mysqld/mysqld.sock` plus `pdo_mysql.default_socket=/run/mysqld/mysqld.sock`. The empty sandbox root does not reproduce the host's `/var/run -> /run` alias.

Normal `occ` commands then call `OC_Util::checkServer()`, which creates, writes, and unlinks a random `data_dir_writability_test_*` file in the configured data directory and may open the Nextcloud log. Consequently, `occ status` is not filesystem-read-only despite its semantic purpose. Do not expose the complete protected data directory as writable merely for health checking. The TLS-verified loopback `https://nextcloud.wejos.de/status.php` capability is the contained health path. Mutating `occ` jobs must declare their real effect and receive only the authority justified by trusted intent.

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

The policy gate is the authoritative allow or deny layer. It keeps only stable hard boundaries deterministic; contextual classification and changing tool interfaces remain with the agents.

It validates:

- runbook allowlist membership
- manifest version or digest
- parameter schema and bounds
- target scope
- privilege class
- approval requirements
- concurrency and lock conditions
- plan hash equality between approved and executed action

Legacy runbooks retain their allowlists. New tasks should be represented as dynamic capability manifests and stop only when the requested real effects cannot be safely contained by an installed sandbox profile.

For Hermes-generated change proposals the implemented zones are:

- green: contextual review passes and execution may continue autonomously
- yellow: autonomous execution is allowed only with an explicit rollback in the plan
- red: realistic public exposure, loss of existing data, or identity/credential/secret access requires an operator decision
- policy/prerequisite block: the response identifies the failed boundary and what must change before a new attempt

Approval never grants new operating-system privilege. Even an approved red proposal executes as `wgops` and can use only pre-installed static helpers.

## Prompt-injection and autonomous execution boundary

Hermes requests carry authenticated `intent` separately from `evidence`. Mail, web, log, and document content is serialized as `untrusted-data` with source and digest. Instructions inside evidence do not expand intent or capability authority. Callers explicitly provide `allowedCapabilities`; omission defaults to `read.host`.

Planner output remains untrusted. Cockpit derives capabilities from the executable block and compares them with the trusted request. Capability escalation and unrestricted shell semantics stop for an operator decision. Intent, evidence digests, plan, safety result, policy result, capabilities, actor, session, and expiry are bound into an HMAC-SHA-256 execution envelope. The signing secret is stripped from agent child environments. Approval fails on signature mismatch, drift, or expiry.

Runner success alone cannot close a mutation. A separate verifier receives plan and runner handoff as untrusted evidence, performs read-only checks, and must confirm the target state. Repeated execution or verification failures open a persisted one-hour circuit breaker.

## Unix identity separation

Production separates three kernel-level identities:

- `wgops` runs Control and owns SQLite, audits, approval state, and envelope secrets. It has no sudo and no provider key.
- `cockpit-agent` runs the local Agent Broker and owns only its model configuration and provider key. It cannot read Control state or the Executor socket.
- `cockpit-executor` runs the typed Executor Broker. It cannot read Control state, provider credentials, or the Agent socket. Its only sudo entry invokes a root-owned validating helper.

The Agent and Executor sockets use distinct Unix groups. When `COCKPIT_AGENT_BROKER_SOCKET` is configured, Control refuses all legacy same-process agent launches. Legacy typed service actions remain available; new autonomous work uses signed dynamic manifests and never falls back to unrestricted Agent shell execution.

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

Every Hermes request is persisted before planner work begins. `GET /api/hermes/jobs/:jobId` is the stable status interface; a short POST wait may return `202`, but that never cancels the planner or destroys its session. Terminal jobs expose a structured explanation containing the original intent, phase, completed stages, evidence, reason, prerequisites to continue, recommended action, and rollback availability. Red proposals use `POST /api/hermes/jobs/:jobId/approval`; approval and rejection are audited.

## Website recovery example

For a `website-down` incident, the preferred path is:

1. `planner-agent` proposes `website-health-check`, `collect-web-logs`, and `restart-web-service`.
2. `safety-agent` checks whether the restart is minimal and whether rollback or escalation is needed.
3. The policy gate confirms that `restart-web-service` is an allowlisted runbook for the affected target.
4. Pre-exec hooks reject unrelated service restarts or package operations.
5. The executor restarts only the allowlisted service.
6. Post-exec hooks confirm the site is healthy again before closing the incident.

## Historical runbook extension lifecycle

The staged permanent-runbook model below remains relevant for reusable privileged helpers, but is superseded for ordinary contained changes by the dynamic signed-manifest lifecycle above.

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
