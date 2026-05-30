# agent-discovery — Product Specification

**Status:** Draft — pre-implementation  
**Date:** 2026-05-30  
**Scope:** General-purpose local agent registry + claudeui integration. No fleet-specific code.

---

## 1. Product framing

agent-discovery is a small, self-contained daemon that lets anyone run Claude Code agents and
see, read, and optionally drive them from a local web UI (claudeui) — with zero configuration
beyond starting the daemon.

The product has three pieces:

1. **The daemon** (`agent-discovery serve`) — a Python stdlib HTTP server that maintains a
   registry of Claude Code agents that have explicitly registered themselves. Exposes a REST
   API over loopback (default) or a configurable bind address.

2. **The register CLI** (`agent-discovery register`, invoked by the agent itself) — a single
   command that an agent runs once to appear in the UI. No env changes, no naming conventions,
   no special spawn flags required.

3. **The claudeui integration** — the server-side TypeScript services + frontend components
   that read the daemon API and surface registered agents as interactive sessions.

### What this is not

- Not Manar's fleet. No domain, customer, roster, kaxtus, wael, special-agent, or
  fleet-roster.json concepts exist in this product.
- Not multi-user. Single UNIX user per daemon instance. Multi-host is an advanced
  configuration (see Section 9).
- Not tmux or zellij. dtach is the only supported terminal substrate for the
  window-detach/reattach affordance. It is optional even then — a bare claude process can
  register and appear read-only.

### Vocabulary (neutral, no fleet terms)

| Term | Meaning |
|---|---|
| agent | A running Claude Code process that has registered with the daemon |
| label | Human-readable name the agent gave itself at registration |
| agent ID | Stable UUID generated at first registration; persisted across respawns |
| session | A Claude Code JSONL conversation file |
| registry | The daemon's in-memory + on-disk store of registered agent records |
| marker file | `.claudeui-agent.json` in the agent's working directory; persists label + ID |
| control port | TCP port the agent's `--remote-control` plugin is listening on |
| ONLINE | Agent is registered and its process is alive |
| CONTROLLABLE | Agent is ONLINE and its control port is responding |
| DISCONNECTED | Agent has a registry record but no live process |

---

## 2. Registration-only model

On a fresh daemon start, the registry is empty. The claudeui sidebar shows zero agents.

An agent appears **only** after it calls `agent-discovery register`.

The daemon does NOT surface agents based on:
- Socket filename scanning or naming conventions
- Process name heuristics applied to all running claude processes
- Any roster, inventory, or config file listing expected agents

The daemon MAY scan running claude processes internally (via `/proc`) to correlate a
`register` call to a PID and resolve metadata (cwd, uptime, RSS). That internal scan is
implementation detail; it is never exposed as auto-discovery.

### Why registration-only

A user opens claude for personal work constantly. The UI must not silently surface those
sessions as "agents". Explicit registration is the consent signal. An agent that has not
registered is invisible to the UI regardless of how long it has been running.

### Implications for claudeui

- `listAgents()` returns only registered agents. No `domain` filter parameter, no roster.
- An agent with `state: DISCONNECTED` is still shown (record exists) but marked clearly.
- No amber badge for "agent exists but unregistered" — unregistered agents simply do not exist
  in the UI.

---

## 3. Persistent agent identity

### The problem

When a dtach window closes and the agent is re-launched in the same working directory, the
daemon's registry has a dead-pid entry. Without persistent identity, the re-registered agent
appears as a new duplicate.

### Solution: marker file + stable ID

**At first registration**, the daemon generates a random UUID (the agent ID) and writes it
back to the agent via the HTTP response. The register CLI writes a marker file in the agent's
working directory:

```
<cwd>/.claudeui-agent.json
```

Contents:

```json
{
  "id": "a3f2b1c0-...",
  "label": "my-research-agent",
  "registered_at": 1748563200
}
```

**At subsequent registrations** (agent respawned in the same workdir), the register CLI reads
the marker file, extracts `{id, label}`, and sends them in the register POST body. The daemon
matches on agent ID and updates the existing record rather than creating a duplicate.

**The label**, if not explicitly given, is read from the marker file. An agent that never
names itself gets the label `"unnamed"` at first registration; the marker file preserves that
so subsequent registrations are consistently unnamed (not re-prompted).

### Daemon-side identity persistence

The daemon persists its registry to a JSON file (default `~/.local/share/agent-discovery/registry.json`).

Each record is keyed by agent ID (not PID). Shape:

```json
{
  "a3f2b1c0-...": {
    "id": "a3f2b1c0-...",
    "label": "my-research-agent",
    "cwd": "/home/alice/projects/research",
    "pid": 12345,
    "registered_at": 1748563200,
    "last_seen": 1748566800,
    "control_port": 9100,
    "control_bind": "127.0.0.1",
    "dtach_socket": "/run/user/1000/my-research-agent.sock"
  }
}
```

On every register call:
1. If `id` matches an existing record → update pid, last_seen, control_port, dtach_socket.
2. If no match by `id` but label collision exists (different ID, same label) → accept
   registration, append `(2)` suffix to the new record's label to avoid confusion.
3. If no `id` in request body (first registration) → generate UUID, write new record.

On daemon start: load registry from disk. Records whose `pid` is no longer a live claude
process are marked DISCONNECTED (not deleted — the record persists for the UI to show).

Dead-record pruning is explicit only: an agent calls `unregister` or the user removes it
from the UI. A record with no live PID is never auto-deleted.

---

## 4. Connection states and the respawn/reconnect UX

### States

| State | Condition | claudeui behaviour |
|---|---|---|
| ONLINE | Record exists + process alive | Shows in sidebar, transcript readable |
| CONTROLLABLE | ONLINE + control port responding | Full interactive mode, composer enabled |
| DISCONNECTED | Record exists + no live process | Shows in sidebar, dimmed, respawn button |

`CONTROLLABLE` is determined by a TCP liveness probe (`connect()` with 0.1 s timeout) on
every daemon scan cycle (default 10 s). An agent with `--remote-control` in its cmdline but
no listening port is ONLINE, not CONTROLLABLE. No false positives.

### Disconnected UX

When the sidebar shows a DISCONNECTED agent, claudeui renders:

- The agent label + last_seen timestamp ("Last seen 3 hours ago").
- The last session transcript (readable, if the JSONL file still exists).
- A "Respawn" button.

**Respawn semantics:** clicking Respawn opens an instruction panel (not an automatic action)
telling the user:

> This agent was last running in `<cwd>`. To reconnect it, launch Claude Code in that
> directory. The agent will re-register automatically if it finds its `.claudeui-agent.json`
> marker file, or you can tell it: "Register yourself as <label>."

There is no live connection until the agent re-registers. The daemon has no authority to
launch processes on the user's machine; that remains the user's action.

Design rationale: a fully automated respawn (daemon exec'ing dtach + claude) is a security
and UX risk on a general-purpose product. The user controls what processes run. The UI guides,
not automates.

**Reconnect flow when the agent re-launches:**

1. Agent starts in the same cwd.
2. register CLI runs (either manually or via the agent's system prompt).
3. CLI reads `.claudeui-agent.json` → finds existing `{id, label}`.
4. CLI POSTs `{id, label, pid}` to daemon.
5. Daemon matches by ID → updates existing record with new PID.
6. Agent transitions DISCONNECTED → ONLINE (or CONTROLLABLE) within one scan cycle.
7. claudeui poll picks up the state change; sidebar updates; last session transcript
   resumes.

The user sees the same sidebar entry throughout — not a new duplicate.

---

## 5. Components and repo layout

```
~/Projects/claudecodeui/
├── agent-discovery/
│   ├── SPEC.md                    (this file)
│   ├── README.md                  (user-facing install + usage story)
│   ├── daemon/
│   │   ├── agent_discovery.py     (the daemon — stdlib-only Python)
│   │   └── pyproject.toml         (pipx/uv packaging metadata)
│   └── launcher/
│       └── spawn-agent.sh         (optional: dtach + claude + auto-register in one command)
├── server/
│   ├── services/
│   │   └── agent-discovery.service.ts   (replaces fleet.service.ts; clean, no domain param)
│   ├── agent-discovery-channel.js       (replaces fleet-channel.js)
│   └── agent-discovery-files.js         (replaces fleet-files.js)
└── src/
    └── components/
        └── sidebar/
            └── view/subcomponents/
                └── AgentSidebarItem.tsx  (replaces fleet-specific parts of SidebarProjectItem)
```

The existing `fleet.service.ts`, `fleet-channel.js`, `fleet-files.js` files remain
untouched during this build phase. The new `agent-discovery.*` files are additive. They
share the same HTTP API shape so migration is a config-level swap (change the env var
the service reads).

### The daemon file (`agent_discovery.py`)

Single-file, zero dependencies beyond stdlib. Entry points exposed via `pyproject.toml`:

```
agent-discovery serve          — start the HTTP daemon
agent-discovery register       — register this claude process (ancestor-walk)
agent-discovery unregister     — remove from registry
agent-discovery install-service — write systemd user unit and enable it
```

### The launcher script (`spawn-agent.sh`)

Optional convenience wrapper. Usage:

```bash
spawn-agent.sh --name "my-agent" --workdir /path/to/project [--control-port 9100]
```

It does:
1. `dtach -n /run/user/$UID/<name>.sock claude --remote-control <port> <workdir>`
2. Waits up to 5 s for the claude process to start.
3. Calls `agent-discovery register --name <name>` as the spawned process.

This is strictly optional. A user who spawns agents any other way can still register manually.

---

## 6. HTTP API (clean, general)

Base URL: `http://127.0.0.1:9301` (default port; configurable via `PORT` env var).

All endpoints except `GET /health` require `Authorization: Bearer <token>`. Token is set by
`AGENT_DISCOVERY_TOKEN` env var on the daemon side; the same token is passed to claudeui as
`AGENT_DISCOVERY_TOKEN`. Fail-closed: if the token is unset, all gated endpoints return 503.

Port `9301` is chosen to avoid collision with the existing Manar fleet daemon at `9201`.

### Endpoints

#### `GET /health`

No auth. Liveness check.

Response `200`:
```json
{ "ok": true, "version": "0.1.0" }
```

---

#### `POST /agents/register`

Register an agent. Called by the `agent-discovery register` CLI or directly by a spawn script.

Request body:
```json
{
  "pid": 12345,
  "label": "my-research-agent",
  "id": "a3f2b1c0-...",
  "cwd": "/home/alice/projects/research",
  "control_port": 9100,
  "control_bind": "127.0.0.1",
  "dtach_socket": "/run/user/1000/my-research-agent.sock"
}
```

Fields:
- `pid` (int, required) — the claude process PID.
- `label` (string, optional) — human name; defaults to `"unnamed"`.
- `id` (string, optional) — stable UUID from `.claudeui-agent.json`; if absent, daemon
  generates one and the CLI writes the marker file.
- `cwd` (string, optional) — if absent, daemon reads from `/proc/<pid>/cwd`.
- `control_port` (int, optional) — if absent, daemon probes `/proc/<pid>/environ` for
  `CONTROL_PORT`.
- `control_bind` (string, optional) — default `"127.0.0.1"`.
- `dtach_socket` (string, optional) — path to the dtach socket if the agent runs under dtach.

Response `200`:
```json
{
  "id": "a3f2b1c0-...",
  "label": "my-research-agent",
  "state": "ONLINE",
  "registered_at": 1748563200
}
```

The `id` in the response is what the CLI writes to `.claudeui-agent.json`.

Response `409` — if the PID is not a live claude process.

---

#### `POST /agents/unregister`

Request body (one of):
```json
{ "id": "a3f2b1c0-..." }
{ "label": "my-research-agent" }
{ "pid": 12345 }
```

Response `200`: `{ "removed": true }` or `{ "removed": false }`.

---

#### `GET /agents`

List all registered agents (ONLINE, CONTROLLABLE, and DISCONNECTED).

No query parameters. No domain/customer filter.

Response `200` — array of agent records:
```json
[
  {
    "id": "a3f2b1c0-...",
    "label": "my-research-agent",
    "state": "CONTROLLABLE",
    "alive": true,
    "controllable": true,
    "pid": 12345,
    "cwd": "/home/alice/projects/research",
    "session_id": "abc123",
    "transcript": "/home/alice/.claude/projects/-home-alice-projects-research/abc123.jsonl",
    "last_activity": 1748566800,
    "last_seen": 1748566800,
    "registered_at": 1748563200,
    "uptime_seconds": 3600,
    "rss_bytes": 204800,
    "control_url": "http://127.0.0.1:9301/agents/a3f2b1c0-.../prompt",
    "dtach_socket": "/run/user/1000/my-research-agent.sock"
  }
]
```

`control_url` is null/absent when `state != CONTROLLABLE`.  
`transcript` is the absolute path used by the daemon to serve the transcript endpoint.  
`session_id` is the JSONL filename stem (the UUID Claude Code uses).

---

#### `GET /agents/<id>/transcript`

Get the agent's live session transcript (NDJSON).

Query params:
- `lines=N` — return last N lines (max 10000)
- `since_byte=N` — return bytes from offset N onward (for streaming tail)

Response headers:
```
Content-Type: application/x-ndjson; charset=utf-8
X-Transcript-Size: <total file size in bytes>
X-Transcript-Mtime: <unix timestamp>
X-Session-Id: <session UUID>
```

Body: raw JSONL content (one JSON record per line).

Response `404` if agent has no active session JSONL.

---

#### `POST /agents/<id>/prompt`

Inject a prompt into the agent's control plane (only valid when `state = CONTROLLABLE`).

Request body:
```json
{
  "prompt": "What is the status of task X?",
  "images": [
    { "name": "screenshot.png", "mimeType": "image/png", "data": "<base64>" }
  ]
}
```

The daemon proxies this to the agent's `CONTROL_BIND:CONTROL_PORT` control plane using the
`CONTROL_TOKEN` read from the agent process's `/proc/<pid>/environ`. The caller never needs
the CONTROL_TOKEN; the daemon holds it server-side.

Response `200` — proxied response from the control plane.  
Response `409` — agent is not controllable or process has exited.  
Response `503` — control plane probe failed (port not listening).

---

#### `GET /agents/<id>/health`

Liveness check for a single agent.

Response `200`:
```json
{
  "id": "a3f2b1c0-...",
  "label": "my-research-agent",
  "state": "ONLINE",
  "alive": true,
  "pid": 12345,
  "uptime_seconds": 3600
}
```

---

#### `GET /agents/<id>/files`

File listing, cwd-jailed (one level).

Query params: `path=<rel>` (optional; default is cwd root).

Response `200`:
```json
{
  "id": "a3f2b1c0-...",
  "cwd": "/home/alice/projects/research",
  "path_rel": "src",
  "entries": [
    { "name": "main.py", "type": "file", "size": 4096, "mtime": 1748563200, "path_rel": "src/main.py" }
  ]
}
```

---

#### `GET /agents/<id>/file`

Read a single file, cwd-jailed. Query param: `path=<rel>` (required).

Response `200` — raw file content (text or base64-encoded binary).  
Response headers include `Content-Type`, `X-Encoding: base64` when binary.

---

### Note on agent addressing

Endpoints use the stable agent **ID** (UUID) in the path, not the label. Labels can change
(user renames an agent); IDs never change. The claudeui service resolves label → ID
internally; the daemon API is always ID-addressed.

This is a departure from the fleet design (which uses the agent name in paths like
`/agents/special-agent/transcript`). The ID-based path prevents collisions and is
unambiguous.

---

### Multi-host (optional, advanced)

`AGENT_DISCOVERY_PEERS=http://other-host:9301,http://third-host:9301` triggers the same
fan-out aggregation pattern as the fleet daemon. Each peer is called with `?local=true` to
prevent recursion. The main daemon merges results.

This is not part of the base install story. Document as advanced configuration only.

---

## 7. Register CLI — invocation surface

The register CLI is the mechanism by which an agent opts in. It is designed to be spoken to
the agent as a single instruction:

> "Register yourself with the discovery daemon."

The agent runs `agent-discovery register` via its Bash tool. The CLI:

1. Ancestor-walks `/proc/self` ppid chain to find the nearest claude process.
2. Reads `.claudeui-agent.json` from that process's cwd if it exists.
3. POSTs to `http://127.0.0.1:9301/agents/register` with the resolved `{id, label, pid}`.
4. If the response contains a new ID (first registration), writes `.claudeui-agent.json`.

CLI options:

```
agent-discovery register [--name LABEL] [--url URL] [--port PORT]
agent-discovery unregister [--id ID] [--name LABEL] [--url URL]
agent-discovery serve [--bind ADDR] [--port PORT] [--token TOKEN]
agent-discovery install-service
```

`--name` is optional. If absent and no marker file exists, label defaults to `"unnamed"`.

The `AGENT_DISCOVERY_TOKEN` env var is read automatically (no `--token` needed if the env
is set, which it will be in the typical install where the daemon's systemd unit exports it).

---

## 8. claudeui server changes

### `agent-discovery.service.ts`

Replaces `fleet.service.ts`. Key differences from the fleet version:

- `cfg()` reads `AGENT_DISCOVERY_URL` (default `http://127.0.0.1:9301`) and
  `AGENT_DISCOVERY_TOKEN`. No `FLEET_DOMAIN`, no `domain` query param.
- `listAgents()` calls `GET /agents` with no filter. Returns all registered agents regardless
  of state (ONLINE, CONTROLLABLE, DISCONNECTED).
- Registry keyed by agent ID (not session_id), though session_id lookup still works for
  history dispatch.
- `FleetAgent` type renamed to `RegisteredAgent`. Fields: `id`, `label`, `state`,
  `alive`, `controllable`, `session_id`, `last_activity`, `cwd`, `control_url`.
- No `domain`, `host`, `bot_alive`, `mnemos_mcp_alive` fields in the public type (those are
  Manar-fleet concepts).

### `agent-discovery-channel.js`

Replaces `fleet-channel.js`. Same prompt-injection + transcript-tail logic. Differences:

- Addresses agents by ID in paths (`/agents/<id>/prompt`, `/agents/<id>/transcript`).
- Removes the `force=true` bypass (that was a Telegram-guard workaround specific to Manar's
  fleet; not applicable here).
- Removes the in-memory block cache for telegram-guarded agents (same reason).

### `agent-discovery-files.js`

Replaces `fleet-files.js`. Same cwd-jailed file tree logic. Only change: uses agent ID
in paths instead of agent name.

### Frontend: `AgentSidebarItem.tsx`

A new sidebar component for registered agents. Differences from the current fleet rendering:

- Shows `label` (not `agent` name).
- Shows state badge: green for CONTROLLABLE, blue for ONLINE, grey for DISCONNECTED.
- DISCONNECTED state: shows "Last seen N minutes ago" + Respawn guidance panel (not a button
  that launches processes; see Section 4).
- No `domain` column, no customer grouping, no host column (single-host assumed by default).

### `projects-with-sessions-fetch.service.ts`

The `listAgents()` call appends virtual projects for all registered agents (ONLINE,
CONTROLLABLE, and DISCONNECTED). DISCONNECTED agents get `fleetAlive: false` and their
last session transcript is navigable. No change to this pattern — only the service import
and type names change.

---

## 9. Install and usage story (for the README)

Target: a person who has never heard of agent-discovery. Three prerequisites: Python 3.10+,
pipx (or uv), claudeui running locally.

```bash
# 1. Install the daemon
pipx install agent-discovery

# 2. Generate a token and start the daemon
export AGENT_DISCOVERY_TOKEN=$(openssl rand -hex 32)
agent-discovery install-service   # writes ~/.config/systemd/user/agent-discovery.service
systemctl --user start agent-discovery

# 3. Tell claudeui where the daemon is
export AGENT_DISCOVERY_URL=http://127.0.0.1:9301
export AGENT_DISCOVERY_TOKEN=<same token>

# 4. Start claudeui
npm run dev    # or docker compose up

# 5. Open a Claude Code session in any directory, then tell it:
#    "Register yourself with the discovery daemon."
#    It runs: agent-discovery register
#    The agent appears in the claudeui sidebar within 10 seconds.
```

Optional: to enable full interactive control, start claude with `--remote-control <port>`.
The daemon auto-detects the port. Without it, the agent appears read-only (transcript visible,
composer disabled).

---

## 10. Manar's fleet — migration path (out of scope for this build)

This section exists to note what does NOT change during the current build.

Manar's existing fleet continues to run via the fleet daemon (`discover.py`) with its
fleet-roster.json, kaxtus socket conventions, domain=manar filter, and the three-host
WireGuard peer mesh. The existing `fleet.service.ts`, `fleet-channel.js`, and
`fleet-files.js` files in claudeui are untouched.

When (and if) Manar migrates his fleet to this general product, the path is:

1. His spawn scripts call `agent-discovery register` instead of using roster/socket
   auto-discovery.
2. Each agent accumulates a `.claudeui-agent.json` marker in its working directory.
3. The `FLEET_DISCOVERY_URL` and `FLEET_DOMAIN` env vars in claudeui are replaced by
   `AGENT_DISCOVERY_URL` and `AGENT_DISCOVERY_TOKEN`.
4. The fleet daemon's Ansible role either points at the new daemon or continues as-is.

That migration is a separate task. The current build targets the general product only.

---

## 11. Decisions requiring Manar's confirmation

The following have been defaulted to sensible values; flag any you want changed before the
daemon implementation begins.

| # | Decision | Default chosen | Alternative |
|---|---|---|---|
| D1 | Daemon default port | 9301 (avoids 9201 used by fleet) | Any unused port |
| D2 | Registry persistence path | `~/.local/share/agent-discovery/registry.json` | `$XDG_DATA_HOME/agent-discovery/` |
| D3 | Marker file name | `.claudeui-agent.json` | `.agent-identity.json` or similar |
| D4 | Respawn UX | Guidance panel, no automatic exec | Automated dtach re-launch (higher risk) |
| D5 | Agent ID path in URLs | `/agents/<uuid>/transcript` | `/agents/<label>/transcript` (less stable) |
| D6 | Label collision handling | Append `(2)` suffix | Reject with 409 |
| D7 | Dead record pruning | Never auto-delete; user/agent must unregister | Auto-prune after N days |
| D8 | pipx vs uv as primary install | pipx (wider adoption) | uv (Manar already uses it) |
| D9 | Package name | `agent-discovery` | `agents-discover` (current daemon name) |
| D10 | Scan cycle (CACHE_TTL) | 10 seconds | Configurable via `SCAN_INTERVAL_SECONDS` env var (already the plan) |

---

## 12. Reuse vs strip catalogue (from discover.py)

### Reused verbatim or with minor adaptation

- `scan_all_claudes()` — generic /proc walk; HOME default changed to `os.path.expanduser("~")`
- `_read_cmdline()`, `_read_status()`, `_rss_bytes()`, `_process_uptime()`, `_list_pids()`,
  `_ppid()`, `_children_of()`, `_descendants()` — pure /proc introspection, no changes
- `_dtach_socket_of_ancestor()` — generic ancestor walk for dtach socket detection
- `_read_proc_environ()` — generic; used to read CONTROL_PORT/CONTROL_BIND
- `assess_controllable()` — reuse the env-read + TCP probe logic; drop the static
  `_CONTROL_PORT_MAP` fallback entirely (that was the named-agent map for Manar's fleet)
- `_tcp_listening()` — generic
- `slug_for()`, `newest_jsonl_path()`, `session_id_from_jsonl()` — generic JSONL resolution
- `_agent_name_from_jsonl()` — generic
- `_resolve_safe_path()`, `_file_listing()` — generic cwd-jailed file ops
- `registry_add()`, `registry_remove()`, `registry_snapshot()`, `registry_load_and_prune()`,
  `_load_registry()`, `_save_registry()` — reuse; change key from pid (str) to agent ID (UUID)
- The HTTP handler auth pattern (`_require_auth()`, fail-closed on unset token) — reuse
- The aggregating proxy (`DISCOVER_PEERS`, `_proxy_to_peer()`, `_fetch_peer_agents()`,
  `_update_peer_cache()`, `_peer_for_agent()`) — reuse; remove `domain_filter` param
- `register-self` ancestor-walk subcommand logic — reuse; rename to `register`
- Image validation + ingestion in POST /prompt — reuse
- File read MIME detection, text/binary branching — reuse
- Transcript endpoint (lines + since_byte paging, MAX_BODY cap) — reuse
- `_load_vault_env()` — keep but make path configurable via `AGENT_DISCOVERY_CONTROL_ENV`

### Stripped (Manar-specific, removed entirely)

- `HOME` fallback to `os.path.expanduser("~manar")` — replace with `os.path.expanduser("~")`
- `load_fleet_roster()` and all roster-based code paths — remove
- `discover_all()` roster merge (Steps 1, 2, 3) — remove; discovery is registry-only
- `list_agent_sockets()` + `agent_name_from_socket()` — remove (no socket-name scanning)
- `find_processes_for_socket()` — remove (socket scan removed)
- `detect_bot_and_mcp()` — remove (bot_alive / mnemos_mcp_alive are fleet concepts)
- `display_name()` with sa-agent normalization — remove
- `detect_customer()`, `detect_customer_tree()`, `_NON_CUSTOMER_TOPLEVELS` — remove entirely
- `_CONTROL_PORT_MAP_DEFAULT` and `_control_plugin_port()` — remove
- `resolve_home_base()` kaxtus-agents fallback heuristics — remove; home_base comes from
  `/proc/<pid>/cwd` or the register call body
- `notes_mtime()` — remove (notes.md is Manar's agent convention)
- `render_metrics()` and Prometheus gauge output — remove (fleet-specific metric names);
  replace with a minimal `GET /metrics` that returns daemon uptime and registered agent count
  if any consumer needs it, or drop entirely
- `domain` field in agent records — remove from all shapes
- `customer` field in all rows and the `agent_to_dict()` customer/domain plumbing — remove
- `_raw_name_from_row()` — remove (socket raw_name is fleet-specific)
- `PUBLIC_ADDR` defaulting to BIND (WG IP logic) — replace with `127.0.0.1` default
- `FLEET_ROSTER_PATH`, `DISCOVER_PEERS` mention in README — fleet config, out of scope
- The `?domain=<filter>` query param on `GET /agents` — remove
- `_fetch_peer_agents()` domain_filter argument — remove domain param
- `HOST` label in Prometheus metrics — remove
- `/fleet` legacy endpoint — remove
- `AGENTS_UID` env var — remove; use `os.getuid()` directly
- `_load_vault_env("~/.vault/control-plugin.env")` hardcoded path — replace with
  `AGENT_DISCOVERY_CONTROL_ENV` env var (no default path assumed)
