# Fix HaRP dockerenginebackend routing Edit appapiharp hap
> Generated 2026-07-12T12:03:59.477Z

## Prompt
Fix HaRP docker_engine_backend routing. Edit appapi-harp haproxy.cfg: change 'server frp_server 127.0.0.1' to 'server frp_server 127.0.0.1:8782'. Then restart the container and verify: docker exec appapi-harp grep 'server frp_server' /run/harp/haproxy.cfg. Output before and after.

## Planner Output
```
## Required Permissions
/usr/bin/docker
/usr/bin/sed
/usr/bin/grep
/usr/bin/sleep
'''bash
#!/usr/bin/env bash
CURRENT=$(/usr/bin/docker exec "$CONTAINER" /usr/bin/sed -n '/server frp_
    echo "ERROR: Target line '$TARGET' not found in $CONFIG" >&2
    echo "Already configured: $EXPECTED"
echo "Current line: $CURRENT"
echo "Updating to: $EXPECTED"
/usr/bin/docker exec "$CONTAINER" /usr/bin/sed -i \
    's/server frp_server 127\.0\.0\.1$/server frp_server 127.0.0.1:8782/'
echo "Restarting container..."
/usr/bin/docker restart "$CONTAINER"
echo "Waiting for container to be healthy..."
    STATUS=$(/usr/bin/docker inspect --format='{{.State.Health.Status}}'
        echo "Container is healthy."
    /usr/bin/sleep 2
    echo "WARNING: Container health check did not report healthy (status:
echo "Verifying config..."
VERIFY=$(/usr/bin/docker exec "$CONTAINER" /usr/bin/grep 'server frp_serv
echo "$VERIFY"
    echo "Verified: $EXPECTED is present."
    echo "ERROR: Verification failed. Expected line not found." >&2
'''
'''
```