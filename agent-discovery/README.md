# agent-discovery

See and drive your Claude Code agents from the claudeui web UI.

Run `agent-discovery register` from inside any Claude Code session — it appears in the
claudeui sidebar within seconds. Read its live transcript, browse its working directory, and
send it prompts from the browser (if launched with a control port). Reconnect after a restart
and it resumes as the same entry, not a duplicate.

---

## Requirements

- Linux (uses `/proc` for process introspection)
- Python 3.10+
- `pipx` (recommended) or `uv` for installation
- Claude Code (`claude` binary on PATH)
- claudeui running locally
- `dtach` — optional; only needed for terminal detach/reattach

---

## Install

```bash
# Install daemon + CLI tools
pipx install ./agent-discovery

# Verify
agent-discovery --help
claudeui-register --help
```

---

## Configure

### 1. Start the daemon

Generate a token and start:

```bash
export AGENT_DISCOVERY_TOKEN=$(openssl rand -hex 32)
agent-discovery serve
```

Or as a persistent systemd user service:

```bash
agent-discovery install-service
# Edit ~/.config/agent-discovery/env and set AGENT_DISCOVERY_TOKEN=<your-token>
systemctl --user daemon-reload
systemctl --user enable --now agent-discovery
systemctl --user status agent-discovery
```

### 2. Tell claudeui about the daemon

Add to your claudeui environment (`.env` file or shell before starting claudeui):

```bash
AGENT_DISCOVERY_URL=http://127.0.0.1:9301
AGENT_DISCOVERY_TOKEN=<same token as the daemon>
```

Then start (or restart) claudeui:

```bash
npm run server        # production build
# or
npm run dev           # dev mode with hot reload
```

---

## Usage

### Register an agent

Open any Claude Code session and tell it:

> "Register yourself with the discovery daemon."

Claude runs `agent-discovery register` via its Bash tool. Within 10 seconds the agent
appears in the claudeui sidebar.

To give it a name:

> "Register yourself as my-research-agent."

Claude runs `agent-discovery register --name my-research-agent`.

A `.claudeui-agent.json` marker file is written in the agent's working directory. This file
is what gives the agent its stable identity across restarts (see Reconnect below).

### What you see in claudeui

| Badge | Meaning |
|---|---|
| CONTROLLABLE | Agent is running and its control port is responding — full interactive mode, composer enabled |
| ONLINE | Agent is running but has no control port — transcript readable, composer disabled |
| DISCONNECTED | Agent has a registry record but its process has exited — record persists, transcript still readable |

### Enable full interactive control (CONTROLLABLE state)

By default a registered agent is read-only: you can read its transcript but not send it
prompts from the UI. To enable the composer, launch Claude Code with a control port:

```bash
CONTROL_PORT=9100 CONTROL_BIND=127.0.0.1 claude --remote-control 9100
```

The daemon reads `CONTROL_PORT` and `CONTROL_BIND` from `/proc/<pid>/environ` automatically.
No extra flags needed at registration time.

### Spawn a fully-managed agent (optional)

The included launcher handles dtach + claude + auto-register in one command:

```bash
spawn-agent.sh --name my-agent --workdir ~/projects/research --control-port 9100
```

It creates a dtach socket, launches claude in the working directory, waits for the process
to start, and calls `agent-discovery register`. The agent appears in claudeui within one
scan cycle (~10 seconds).

Attach to the session later:

```bash
dtach -a /run/user/$UID/my-agent.sock
```

---

## Reconnect after restart

When a dtach window closes and claude exits, the sidebar shows the agent as DISCONNECTED.
The record is kept — transcript still readable, last-seen timestamp shown.

To reconnect:

1. Relaunch claude in the same working directory (same cwd as before).
2. Tell it "Register yourself" (or run `claudeui-register`).
3. The CLI reads `.claudeui-agent.json`, finds the existing ID, and POSTs it to the daemon.
4. The daemon matches by ID and updates the record with the new PID.
5. The sidebar entry transitions DISCONNECTED → ONLINE or CONTROLLABLE.

The user sees the same entry throughout — not a new duplicate.

---

## Unregister

From inside the agent:

> "Unregister yourself from the discovery daemon."

Claude runs `agent-discovery unregister`. The entry is removed from the sidebar immediately.

Or by ID from any shell:

```bash
agent-discovery unregister --id <uuid>
```

---

## CLI reference

```
agent-discovery serve                     Start the HTTP daemon
agent-discovery register                  Register this claude process
agent-discovery register --name LABEL     Register with a human-readable label
agent-discovery unregister                Unregister by current process (reads marker file)
agent-discovery unregister --id UUID      Unregister by stable ID
agent-discovery install-service           Write systemd user unit and env file

claudeui-register [--name LABEL]          Short alias for agent-discovery register
claudeui-unregister [--id UUID]           Short alias for agent-discovery unregister
```

---

## Configuration

All configuration is via environment variables.

| Variable | Default | Description |
|---|---|---|
| `AGENT_DISCOVERY_TOKEN` | (required) | Bearer token — same value set on daemon and claudeui |
| `PORT` | `9301` | Daemon listen port |
| `BIND` | `127.0.0.1` | Daemon bind address |
| `SCAN_INTERVAL_SECONDS` | `10` | How often the daemon re-probes agent states |
| `REGISTRY_PATH` | `~/.local/share/agent-discovery/registry.json` | Registry persistence path |
| `AGENT_DISCOVERY_URL` | `http://127.0.0.1:9301` | claudeui: where to reach the daemon |
| `AGENT_DISCOVERY_CONTROL_ENV` | (unset) | Path to an env file that provides `CONTROL_TOKEN` for prompt injection |
| `AGENT_DISCOVERY_PEERS` | (unset) | Comma-separated peer daemon URLs for multi-host aggregation (advanced) |
| `AGENT_DISCOVERY_PEER_DOMAINS` | (unset) | Comma-separated allowlist of agent `domain` tags to surface FROM PEERS. Unset = include all peer agents. Local agents are never filtered. (advanced) |
| `AGENT_DOMAIN` | (unset) | Set in the agent's launch environment. `agent-discovery register` includes it as the agent's `domain` tag so a peer can be allowlisted. |

---

## How it works

The daemon is a single-file, stdlib-only Python HTTP server. It exposes a REST API on
loopback (default `127.0.0.1:9301`). All gated endpoints require a Bearer token.

**Registration-only:** on a fresh daemon start the registry is empty. No processes are
surfaced automatically. An agent appears only after it calls `agent-discovery register`.
This is intentional — a user might run claude constantly for personal work; only sessions
that explicitly opt in are visible in the UI.

**Stable identity:** the first `register` call generates a UUID and returns it to the CLI,
which writes `.claudeui-agent.json` in the agent's working directory. On all subsequent
registrations from the same directory the CLI reads the UUID from that file and sends it in
the request body. The daemon matches on UUID and updates the existing record rather than
creating a duplicate.

**State computation:** `ONLINE` / `CONTROLLABLE` / `DISCONNECTED` is computed live on
every API response by checking `/proc/<pid>` (is the process still alive?) and attempting
a TCP connect to `CONTROL_BIND:CONTROL_PORT` (is the control port responding?). Nothing is
stored — stale state cannot accumulate.

**Dead records:** a DISCONNECTED record is never auto-deleted. It remains visible in the
sidebar until the agent re-registers (→ reconnect) or calls unregister (→ removal).

---

## Daemon HTTP API

Base URL: `http://127.0.0.1:9301` (configurable via `PORT` / `BIND`).

All endpoints except `GET /health` require `Authorization: Bearer <token>`.

| Method | Path | Description |
|---|---|---|
| `GET` | `/health` | Liveness check — no auth |
| `GET` | `/agents` | List all registered agents |
| `POST` | `/agents/register` | Register an agent |
| `POST` | `/agents/unregister` | Unregister by id / label / pid |
| `GET` | `/agents/<id>/transcript` | Agent's live session JSONL |
| `POST` | `/agents/<id>/prompt` | Inject a prompt (CONTROLLABLE only) |
| `GET` | `/agents/<id>/health` | Single-agent liveness |
| `GET` | `/agents/<id>/files` | Directory listing (cwd-jailed) |
| `GET` | `/agents/<id>/file` | Single file read (cwd-jailed) |

Agents are addressed by stable UUID in all paths. See [SPEC.md](./SPEC.md) for full request
and response shapes.

---

## Multi-host (advanced)

To aggregate agents across multiple machines, set:

```bash
AGENT_DISCOVERY_PEERS=http://host-b:9301,http://host-c:9301
```

The primary daemon fans out `GET /agents` to each peer and merges results. Each peer is
called with `?local=true` to prevent recursion. claudeui points at the primary daemon only.
Each host runs its own daemon with the same token.

### Surfacing only some peer agents (domain allowlist)

By default the fan-out merges *all* of a peer's agents. To surface only agents tagged
with a specific owner/tenant, launch those agents with `AGENT_DOMAIN=<tag>` in their
environment (so `register` records the tag) and set on the aggregating daemon:

```bash
AGENT_DISCOVERY_PEERS=http://host-b:9301
AGENT_DISCOVERY_PEER_DOMAINS=acme
```

Now `GET /agents` returns all LOCAL agents (never filtered) plus only the peer agents
whose `domain` is `acme`. Transcript and prompt proxying follow the same filter — a peer
agent that is hidden is also not proxyable. An agent with no domain tag is excluded
whenever an allowlist is set.

---

## See also

- [SPEC.md](./SPEC.md) — full product specification, design decisions, and API shapes
