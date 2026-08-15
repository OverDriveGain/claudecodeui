#!/bin/bash
# oc-agent-launch.sh — launch an OpenCode agent so MyMu can live-attach to it.
#
# The OpenCode analog of launching claude with --remote-control: starts the
# stock `opencode serve` on a localhost port and drops a registration file into
# the shared registry dir MyMu reads (OC_REGISTRY_DIR, default
# ~/.cloudcli/opencode-agents). Nothing is added to opencode or the tenant —
# an agent launched any other way is simply not attachable.
#
# Usage:  oc-agent-launch.sh <name> <cwd> [port]
#   name  registration name (shows as the agent title in MyMu)
#   cwd   the agent's working directory
#   port  optional fixed port; default: ask the kernel for a free one
#
# Env:    OC_REGISTRY_DIR  override the registry directory
set -euo pipefail

NAME="${1:?usage: oc-agent-launch.sh <name> <cwd> [port]}"
CWD="${2:?usage: oc-agent-launch.sh <name> <cwd> [port]}"
PORT="${3:-}"
REG_DIR="${OC_REGISTRY_DIR:-$HOME/.cloudcli/opencode-agents}"

[ -d "$CWD" ] || { echo "cwd not found: $CWD" >&2; exit 1; }
mkdir -p "$REG_DIR"

if [ -z "$PORT" ]; then
  PORT=$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1]); s.close()')
fi

LOG_DIR="$HOME/.cloudcli/logs"
mkdir -p "$LOG_DIR"
cd "$CWD"
nohup opencode serve --port "$PORT" --hostname 127.0.0.1 \
  >"$LOG_DIR/opencode-$NAME.log" 2>&1 &
PID=$!

# Wait for the server to answer before registering.
for _ in $(seq 1 30); do
  if curl -sf "http://127.0.0.1:$PORT/session" >/dev/null 2>&1; then break; fi
  sleep 0.5
done
curl -sf "http://127.0.0.1:$PORT/session" >/dev/null 2>&1 || {
  echo "opencode serve did not come up on :$PORT (see $LOG_DIR/opencode-$NAME.log)" >&2
  exit 1
}

cat > "$REG_DIR/$NAME.json" <<EOF
{
  "name": "$NAME",
  "port": $PORT,
  "host": "127.0.0.1",
  "cwd": "$CWD",
  "user": "$(id -un)",
  "pid": $PID,
  "startedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
EOF
chmod 644 "$REG_DIR/$NAME.json"
echo "registered opencode agent '$NAME' on 127.0.0.1:$PORT (pid $PID, cwd $CWD)"
