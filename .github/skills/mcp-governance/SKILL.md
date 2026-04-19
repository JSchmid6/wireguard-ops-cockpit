---
name: mcp-governance
description: MCP design and review guidance for this repository. Use this when adding, reviewing, or limiting MCP servers or tools for Copilot cloud agent and related workflows.
user-invocable: false
---

# MCP Governance

Use this skill when a task mentions MCP servers, tool expansion, external service integration, or Copilot cloud agent capabilities.

## Required approach

1. Start from [the MCP allowlist policy](./mcp-allowlist.md).
2. Prefer built-in capabilities before adding third-party MCP servers.
3. Enable only the exact tools needed.
4. Keep secrets in GitHub Copilot environment configuration, never in tracked files.
5. Reject proposals that grant cloud-side agents live VPS administration.

## Review questions

- Is this MCP capability needed for repository work, or only for host operations?
- Can the same goal be achieved with existing built-in tools?
- Are the requested tools read-only, bounded-action, or high-risk?
- Does the configuration rely on unsupported auth assumptions?

If the task expands MCP surface area significantly, use the `mcp-governor` agent.
