#!/usr/bin/env bash
# spawn-agent.sh — launch a claude agent under dtach and register it
#
# Usage:
#   spawn-agent.sh --name LABEL --workdir /path/to/project [--control-port PORT]
#
# Options:
#   --name LABEL         Agent label (required)
#   --workdir DIR        Working directory for claude (required)
#   --control-port PORT  Enable plugin:control on this port (optional)
#   --socket PATH        Explicit dtach socket path (default: /run/user/$UID/<label>.sock)
#   --daemon-url URL     agent-discovery base URL (default: http://127.0.0.1:9301)
#   --help               Show this help
#
# Prerequisites:
#   - dtach installed and on PATH
#   - claude installed and on PATH
#   - agent-discovery daemon running with AGENT_DISCOVERY_TOKEN set
#
# The script:
#   1. Ensures a dtach socket exists for the agent.
#   2. Launches claude in the working directory (optionally with --remote-control).
#   3. Waits up to 5 seconds for the claude process to start.
#   4. Calls agent-discovery register --name LABEL to register.
#
# To enable full interactive control from claudeui, pass --control-port.
# Without it, the agent appears read-only (transcript visible, composer disabled).

set -euo pipefail

NAME=""
WORKDIR=""
CONTROL_PORT=""
SOCKET_PATH=""
DAEMON_URL="http://127.0.0.1:9301"

usage() {
    grep '^#' "$0" | sed 's/^# \?//' | head -30
    exit 0
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --name)        NAME="$2";         shift 2 ;;
        --workdir)     WORKDIR="$2";      shift 2 ;;
        --control-port) CONTROL_PORT="$2"; shift 2 ;;
        --socket)      SOCKET_PATH="$2";  shift 2 ;;
        --daemon-url)  DAEMON_URL="$2";   shift 2 ;;
        --help|-h)     usage ;;
        *) echo "Unknown option: $1" >&2; exit 1 ;;
    esac
done

if [[ -z "$NAME" ]]; then
    echo "ERROR: --name is required" >&2
    exit 1
fi

if [[ -z "$WORKDIR" ]]; then
    echo "ERROR: --workdir is required" >&2
    exit 1
fi

if [[ ! -d "$WORKDIR" ]]; then
    echo "ERROR: workdir does not exist: $WORKDIR" >&2
    exit 1
fi

if ! command -v dtach &>/dev/null; then
    echo "ERROR: dtach not found on PATH" >&2
    exit 1
fi

if ! command -v claude &>/dev/null; then
    echo "ERROR: claude not found on PATH" >&2
    exit 1
fi

SAFE_NAME="${NAME//[^a-zA-Z0-9_-]/-}"
if [[ -z "$SOCKET_PATH" ]]; then
    SOCKET_PATH="/run/user/${UID:-$(id -u)}/${SAFE_NAME}.sock"
fi

CLAUDE_ARGS=()
if [[ -n "$CONTROL_PORT" ]]; then
    CLAUDE_ARGS+=("--remote-control" "$CONTROL_PORT")
    export CONTROL_PORT
    export CONTROL_BIND="${CONTROL_BIND:-127.0.0.1}"
fi

if [[ -S "$SOCKET_PATH" ]]; then
    echo "Socket already exists: $SOCKET_PATH"
    echo "Agent may already be running. Attempting re-registration only."
else
    echo "Spawning agent ${NAME} in ${WORKDIR} ..."
    dtach -n "$SOCKET_PATH" \
        env -C "$WORKDIR" claude "${CLAUDE_ARGS[@]+"${CLAUDE_ARGS[@]}"}"
    echo "dtach socket: $SOCKET_PATH"
fi

echo "Waiting for claude process to start..."
WAIT=0
MAX_WAIT=5
while [[ $WAIT -lt $MAX_WAIT ]]; do
    if pgrep -u "$(id -u)" -x claude &>/dev/null; then
        break
    fi
    sleep 1
    WAIT=$((WAIT + 1))
done

if [[ $WAIT -ge $MAX_WAIT ]]; then
    echo "WARNING: claude process did not start within ${MAX_WAIT}s. Proceeding anyway."
fi

if command -v agent-discovery &>/dev/null; then
    echo "Registering as ${NAME} ..."
    AGENT_DISCOVERY_TOKEN="${AGENT_DISCOVERY_TOKEN:-}" \
        agent-discovery register --name "$NAME" --url "$DAEMON_URL" || true
else
    echo "WARNING: agent-discovery not found on PATH; skipping registration."
    echo "Register manually: agent-discovery register --name $NAME --url $DAEMON_URL"
fi

echo "Done. Agent ${NAME} is running."
echo "Attach: dtach -a $SOCKET_PATH"
