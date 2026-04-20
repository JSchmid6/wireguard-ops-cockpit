#!/usr/bin/env bash
set -euo pipefail

SESSION_ID="${1:-}"
TOKEN="${2:-}"
DB_PATH="${COCKPIT_DB_PATH:-/var/lib/wireguard-ops-cockpit/cockpit.sqlite}"
SIGNING_SECRET="${COCKPIT_TERMINAL_SIGNING_SECRET:-}"

if [[ -z "$SESSION_ID" ]]; then
  echo "session id is required"
  exit 1
fi

if [[ ! "$SESSION_ID" =~ ^[0-9a-fA-F-]{36}$ ]]; then
  echo "invalid session id"
  exit 1
fi

if [[ -z "$SIGNING_SECRET" ]]; then
  echo "terminal signing secret is not configured"
  exit 1
fi

if [[ -z "$TOKEN" ]]; then
  echo "terminal token is missing"
  exit 1
fi

EXPECTED_TOKEN="$(python3 - "$SESSION_ID" "$SIGNING_SECRET" <<'PY'
import hmac
import hashlib
import sys

session_id = sys.argv[1]
secret = sys.argv[2].encode()
print(hmac.new(secret, session_id.encode(), hashlib.sha256).hexdigest())
PY
)"

if [[ "$TOKEN" != "$EXPECTED_TOKEN" ]]; then
  echo "terminal token verification failed"
  exit 1
fi

TMUX_SESSION_NAME="$(python3 - "$DB_PATH" "$SESSION_ID" <<'PY'
import sqlite3
import sys

db_path = sys.argv[1]
session_id = sys.argv[2]
with sqlite3.connect(db_path) as conn:
    row = conn.execute(
        "SELECT tmux_session_name FROM cockpit_sessions WHERE id = ?",
        (session_id,)
    ).fetchone()
print("" if row is None else row[0])
PY
)"

if [[ -z "$TMUX_SESSION_NAME" ]]; then
  echo "terminal session not found"
  exit 1
fi

if [[ ! "$TMUX_SESSION_NAME" =~ ^[A-Za-z0-9][A-Za-z0-9_-]{1,63}$ ]]; then
  echo "invalid tmux session name"
  exit 1
fi

exec tmux attach -t "$TMUX_SESSION_NAME"
