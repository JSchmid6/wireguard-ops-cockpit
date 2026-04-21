# Deep Interview Playbook

Use this before implementation whenever a request is still ambiguous in ways that could change scope, UX, architecture, or trust boundaries.

## Goal

Turn a vague request into a small, testable, product-correct implementation slice.

## Owner

- Primary: Compass
- Support: Architect for structure, Guide for UX, Shield for boundary risk, Builder for implementation feasibility

## Interview Shape

Keep it short and concrete. The point is not to ask everything. The point is to remove the ambiguity that would change the implementation.

## Core Questions

1. What operator problem are we actually solving?
2. What should be possible afterward that is not possible now?
3. What must stay out of scope for this slice?
4. What constraints already exist: security, approvals, sessions, data model, deployment, or UI?
5. What would count as a correct first version?

## Output Template

Capture the result in this form before implementation:

- Problem:
- Desired outcome:
- Constraints:
- Non-goals:
- Acceptance criteria:
- Smallest next slice:

## Stop Rule

Do not start implementation until the smallest next slice is clear enough that a reviewer could say whether it is correct or not.