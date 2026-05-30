# agent-discovery

A small local daemon that lets you see and drive your Claude Code agents from claudeui.

Register any running claude session — it appears in the claudeui sidebar within seconds.
Read its transcript, inject prompts (if launched with `--remote-control`), and browse its
working directory — all from a browser tab.

---

## Requirements

- Linux (uses `/proc` for process introspection)
- Python 3.10+
- `pipx` or `uv` (for installation)
- `dtach` (optional; only needed for terminal detach/reattach)
- Claude Code installed (`claude` binary on PATH)
- claudeui running locally

---

## Install

```bash
# Install the daemon
pipx install agent-discovery

# Generate a shared token
export AGENT_DISCOVERY_TOKEN=$(openssl rand -hex 32)

# Install and start the systemd user service
agent-discovery install-service
systemctl --user start agent-discovery
systemctl --user status agent-discovery
```

---

## Configure claudeui

Add to your claudeui environment (`.env` or shell):

```bash
AGENT_DISCOVERY_URL=http://127.0.0.1:9301
AGENT_DISCOVERY_TOKEN=<same token as above>
```

Then restart claudeui.

---

## Register an agent

Open any Claude Code session and tell it:

> "Register yourself with the discovery daemon."

The agent runs `agent-discovery register` via its Bash tool. It appears in the claudeui
sidebar within 10 seconds.

To give the agent a name:

> "Register yourself as my-research-agent."

The agent runs `agent-discovery register --name my-research-agent`.

A `.claudeui-agent.json` marker file is written in the agent's working directory. When the
agent is respawned in the same directory, it re-registers under the same name and ID
automatically — no duplicate entries.

---

## Full interactive control (optional)

By default, a registered agent is read-only: you can read its transcript but not send
messages from claudeui. To enable full control, launch Claude Code with:

```bash
claude --remote-control 9100
```

The daemon detects the control port automatically. The claudeui composer is enabled.

---

## Spawn a fully-managed agent (optional)

The included launcher script handles dtach + claude + auto-register in one command:

```bash
spawn-agent.sh --name my-agent --workdir ~/projects/research --control-port 9100
```

---

## CLI reference

```
agent-discovery serve               Start the HTTP daemon
agent-discovery register            Register this claude process
agent-discovery register --name X   Register with a label
agent-discovery unregister          Unregister by current process
agent-discovery install-service     Write systemd user unit and enable it
```

---

## Configuration (environment variables)

| Variable | Default | Description |
|---|---|---|
| `PORT` | `9301` | Daemon listen port |
| `BIND` | `127.0.0.1` | Daemon bind address |
| `AGENT_DISCOVERY_TOKEN` | (required) | Bearer token for API auth |
| `SCAN_INTERVAL_SECONDS` | `10` | How often to re-probe agent states |
| `REGISTRY_PATH` | `~/.local/share/agent-discovery/registry.json` | Registry persistence path |
| `AGENT_DISCOVERY_CONTROL_ENV` | (unset) | Path to env file containing CONTROL_TOKEN for prompt injection |
| `AGENT_DISCOVERY_PEERS` | (unset) | Comma-separated peer daemon URLs for multi-host aggregation |

---

## See also

- [SPEC.md](./SPEC.md) — full product specification and design decisions
