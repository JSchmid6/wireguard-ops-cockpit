# Install gh CLI on this host using apt Run aptget update
> Generated 2026-07-12T12:41:18.078Z

## Prompt
Install gh CLI on this host using apt. Run: apt-get update -qq && apt-get install -y -qq gh 2>&1. After installation verify: which gh && gh --version.

## Planner Output
```
## Required Permissions
/usr/bin/apt-get
/usr/bin/which
/usr/bin/gh
'''bash
#!/usr/bin/env bash
/usr/bin/apt-get update -qq 2>&1
/usr/bin/apt-get install -y -qq gh 2>&1
/usr/bin/which gh
/usr/bin/gh --version
'''
'''
```