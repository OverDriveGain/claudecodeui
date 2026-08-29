#!/bin/bash
# cx-agent-launch.sh — launch a Codex agent so MyMu can live-attach to it.
#
# The Codex analog of oc-agent-launch.sh: starts the stock
# `codex app-server --listen ws://127.0.0.1:PORT` and drops a registration
# file into the shared registry dir MyMu reads (CX_REGISTRY_DIR, default
# ~/.cloudcli/codex-agents). Nothing is added to codex or the tenant — a
# codex started any other way is simply not attachable.
#
# Usage:  cx-agent-launch.sh <name> <cwd> [port]
#   name  registration name (shows as the agent title in MyMu)
#   cwd   the agent's working directory
#   port  optional fixed port; default: ask the kernel for a free one
#
# Env:    CX_REGISTRY_DIR  override the registry directory
#         CODEX_BIN        override the codex binary (default: codex on PATH,
#                          falling back to the copy bundled with MyMu)
set -euo pipefail

NAME="${1:?usage: cx-agent-launch.sh <name> <cwd> [port]}"
CWD="${2:?usage: cx-agent-launch.sh <name> <cwd> [port]}"
PORT="${3:-}"
REG_DIR="${CX_REGISTRY_DIR:-$HOME/.cloudcli/codex-agents}"

# Resolve the codex binary: PATH first, then the npm-bundled build.
CODEX="${CODEX_BIN:-}"
if [ -z "$CODEX" ]; then
  if command -v codex >/dev/null 2>&1; then
    CODEX=codex
  else
    for base in "$(cd "$(dirname "$0")/.." && pwd)" "$HOME/Projects/claudecodeui"; do
      cand="$base/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex"
      [ -x "$cand" ] && { CODEX="$cand"; break; }
    done
  fi
fi
[ -n "$CODEX" ] || { echo "codex binary not found (set CODEX_BIN)" >&2; exit 1; }
# Absolutize — we `cd` into the agent's cwd before spawning, so a relative
# CODEX_BIN (or relative fallback path) would break under nohup.
case "$CODEX" in
  /*) : ;;
  */*) CODEX="$(cd "$(dirname "$CODEX")" && pwd)/$(basename "$CODEX")" ;;
esac

[ -d "$CWD" ] || { echo "cwd not found: $CWD" >&2; exit 1; }
# Registration must carry an absolute path — MyMu resolves the agent's file
# browser and attachment root from it.
CWD="$(cd "$CWD" && pwd)"
mkdir -p "$REG_DIR"

if [ -z "$PORT" ]; then
  PORT=$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1]); s.close()')
fi

LOG_DIR="$HOME/.cloudcli/logs"
mkdir -p "$LOG_DIR"
cd "$CWD"
nohup "$CODEX" app-server --listen "ws://127.0.0.1:$PORT" \
  >"$LOG_DIR/codex-$NAME.log" 2>&1 &
PID=$!

# Wait for the server's readiness probe before registering.
for _ in $(seq 1 30); do
  if curl -sf "http://127.0.0.1:$PORT/readyz" >/dev/null 2>&1; then break; fi
  sleep 0.5
done
curl -sf "http://127.0.0.1:$PORT/readyz" >/dev/null 2>&1 || {
  echo "codex app-server did not come up on :$PORT (see $LOG_DIR/codex-$NAME.log)" >&2
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
echo "registered codex agent '$NAME' on 127.0.0.1:$PORT (pid $PID, cwd $CWD)"
