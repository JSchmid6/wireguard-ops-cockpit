# MCP allowlist policy

## Allowed by default

- built-in GitHub read-only tooling
- built-in Playwright tooling for localhost UI testing

## Consider with justification

- read-only observability or error-tracking tools
- documentation retrieval from bounded internal systems
- narrowly scoped issue or project-management tools

## Not allowed in the first implementation pass

- direct VPS administration tools
- remote shell or terminal MCP servers
- wide deployment or infrastructure mutation tools
- tools that expose unrestricted secret material
- anything that bypasses the repository's approval and audit model
