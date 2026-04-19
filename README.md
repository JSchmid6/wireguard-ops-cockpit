# wireguard-ops-cockpit

WireGuard-only operations cockpit for VPS administration with persistent `tmux` sessions, browser access, controlled runbooks, and agent orchestration for tools such as GitHub Copilot and custom agents.

This repository is intentionally documentation-first. It captures the target architecture, security boundaries, rollout plan, Copilot cloud agent setup, and Squad preparation before implementation starts on a local machine and is later deployed to the VPS.

## Goals

- Provide a browser-accessible operator cockpit reachable only through WireGuard.
- Let an operator attach to long-lived `tmux` sessions, observe agent activity, and take over when needed.
- Support safe automation for recurring admin actions such as Nextcloud updates and system upgrades.
- Allow custom agents and GitHub Copilot-based workflows, including future use with GitHub Copilot Squad.
- Preserve strong security boundaries between web access, orchestration, and privileged host actions.

## Planned repository structure

- `doc/setup/` - scope, assumptions, and initial setup notes
- `doc/services/` - service architecture, trust boundaries, runtime topology
- `doc/migration/` - phased implementation plan and rollout notes
- `.github/workflows/` - Copilot cloud agent setup and future CI workflows
- `.github/agents/` - project-specific custom Copilot agents
- `.github/skills/` - reusable skills for architecture, security, and MCP governance
- `.devcontainer/` - reproducible Codespaces and local container development environment
- `.squad/` - repository-native Squad memory and bootstrap decisions
- `config/` - templates such as example MCP configuration for Copilot cloud agent

## Source of truth

Start with these documents:

1. `doc/setup/project-charter.md`
2. `doc/services/target-architecture.md`
3. `doc/migration/implementation-plan.md`
4. `doc/setup/copilot-squad-adoption.md`
5. `doc/migration/copilot-cloud-agent-brief.md`
6. `doc/setup/agent-stack.md`

## Cloud build readiness

The repository includes both:

- `.github/workflows/copilot-setup-steps.yml` for **GitHub Copilot cloud agent**
- `.devcontainer/` for **Codespaces** and reproducible local container development
- `.github/agents/`, `.github/skills/`, and `.squad/` for **agent and Squad bootstrap**

Use the workflow to prepare Copilot's GitHub-hosted environment, and the devcontainer when you or a contributor want the same toolchain in a development workspace.

For Squad, the repository now includes a local `squad` coordinator stub, but you should still run `squad init` once in a real development environment so the tool can generate and validate its expected files.

## Repository bootstrap

Create a new public GitHub repository named `wireguard-ops-cockpit`, then push this scaffold:

```bash
git init
git branch -M main
git add .
git commit -m "Initial planning scaffold"
git remote add origin git@github.com:<your-account>/wireguard-ops-cockpit.git
git push -u origin main
```
