# Agent-to-agent over Remote Control (optional client example)

This directory is **not part of the claude-code-cli-ui web app**. It's a self-contained
demonstration that the same Anthropic *Remote Control* relay (CCR v2) the web UI consumes
can also be driven headlessly — so any script, cron job, or **another agent** can message a
live `claude --remote-control` agent with **zero infrastructure**: no CCUI server, no
daemon, no inbound port. It needs only Node.js and the operator's `claude.ai` OAuth on the
machine.

Use this as a starting point if you want to build your own agent-to-agent client on top of
the same API.

## How it works

A `claude --remote-control <name>` process registers a **connected code session** with
Anthropic under the operator's account. Both scripts here authenticate with that same
account (`~/.claude/.credentials.json` → `claudeAiOauth.accessToken`, org from
`~/.claude.json`) and talk to `api.anthropic.com` directly. A message you send lands in the
agent's **real session** — the same one a human drives from the web UI or an attached
terminal.

The visibility boundary is the **account**: every `--remote-control` agent on any machine
under one account is reachable; a different account's agents never appear.

## Files

| file | purpose |
|---|---|
| `spawn-rc-agent.sh` | Spawn a remote-control agent under `dtach` in a trusted cwd: `spawn-rc-agent.sh <name> [work_dir]`. It launches `claude --remote-control <name>` so the agent is attachable in the terminal *and* drivable over the relay. |
| `rc-send.mjs` | Send a message to a live agent by name substring, optionally wait for its reply: `node rc-send.mjs <name-substring> "<message>" [--wait <sec>]`. Pages through all sessions, so it finds idle agents too. |

## Quick start

```bash
# 1. spawn a target agent (terminal-attachable + relay-connected)
./spawn-rc-agent.sh worker1

# 2. from anything under the same account, message it and wait for the reply
node rc-send.mjs worker1 "summarize the repo in one line" --wait 30
```

## Requirements & caveats

- `claude` logged into the **same** `claude.ai` account this machine's CCUI consumes.
- Only **outbound** access to `api.anthropic.com` — no inbound port, no VPN, no daemon.
- `--remote-control` is the **interactive flag** (terminal stays writable + relay-connected),
  not a headless subcommand that locks the local TUI.
- The API used here is beta (`anthropic-beta: ccr-byoc-2025-07-29`) and may change.

For the full protocol reference, see the engine in `server/remote-control/rc-client.js`.

### Optional env overrides

`RC_OAUTH_TOKEN`, `RC_ORG_UUID`, `RC_BASE_URL` — override the auto-read credentials / API
base (same names the server uses). Unset = read from the dotfiles above.
