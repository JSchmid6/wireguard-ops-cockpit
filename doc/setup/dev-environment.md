# Development environment notes

## Why the repository includes both setup mechanisms

This repository now contains **two different environment-preparation layers**:

1. `.github/workflows/copilot-setup-steps.yml` for GitHub Copilot cloud agent
2. `.devcontainer/` for GitHub Codespaces and local container-based development

They solve related but different problems.

## Copilot cloud agent

The Copilot cloud agent runs in a GitHub Actions-backed ephemeral environment. The supported and documented way to prepare that environment is the `copilot-setup-steps.yml` workflow. That is the primary mechanism for making cloud-side implementation reliable.

## Codespaces and devcontainer

Codespaces and local devcontainer users need a reproducible workspace with the same baseline tools:

- Node.js and npm
- Python
- `tmux`
- `jq`
- `ripgrep`
- Squad CLI
- Semgrep

The devcontainer provides exactly that. It is not a replacement for Copilot cloud agent setup, but it keeps human and Codespaces work close to the same baseline.

## Recommendation

- **For GitHub Copilot cloud agent:** rely on `.github/workflows/copilot-setup-steps.yml`
- **For interactive browser development or manual implementation:** use the devcontainer
- **For the first implementation pass:** keep both, because they reduce drift between human and agent environments

## Important limitation

Neither the devcontainer nor the Copilot cloud agent environment should be treated as the future production privilege boundary for VPS administration. They are only build and development environments for the repository code.
