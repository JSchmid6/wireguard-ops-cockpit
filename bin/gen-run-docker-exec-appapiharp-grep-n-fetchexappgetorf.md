# Run docker exec appapiharp grep n fetchexappgetorfet
> Generated 2026-07-12T11:46:56.295Z

## Prompt
Run: docker exec appapi-harp grep -n fetch_exapp|_get_or_fetch_exapp|EX_APP_URL|NC_REQ_URL|exapp_url /usr/local/bin/haproxy_agent.py. Output the matching lines with line numbers so I can understand how HaRP discovers registered ExApps.

## Planner Output
```
## Required Permissions
/usr/bin/docker
'''bash
#!/usr/bin/env bash
/usr/bin/docker exec appapi-harp grep -n 'fetch_exapp\|_get_or_fetch_exap
p\|EX_APP_URL\|NC_REQ_URL\|exapp_url' /usr/local/bin/haproxy_agent.py
'''
```