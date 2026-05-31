<div align="center">
  <img src="public/logo.svg" alt="Claude Code UI" width="64" height="64">
  <h1>Claude Code UI</h1>
  <p>A web UI to see and drive your <a href="https://docs.anthropic.com/en/docs/claude-code">Claude Code</a> (and Cursor / Codex / Gemini CLI) agents — locally or remotely, on desktop and mobile.</p>
  <p><b>This fork adds a live <a href="agent-discovery/README.md">agent-discovery channel</a>:</b> any running Claude Code agent can register itself and be read <i>and driven</i> from the browser in real time — no per-agent port, no cloud.</p>
</div>

---

## 🚀 Quick start

Requires **Node.js 20+** and **npm**. (The live-agent channel additionally needs Python 3.10+ — see [Live agents](#-live-agents-agent-discovery).)

```bash
# 1. Clone
git clone https://github.com/<your-org>/claudecodeui.git
cd claudecodeui

# 2. Install dependencies
npm install

# 3. Create your config
cp .env.example .env        # then edit ports if you like (defaults below)

# 4. Run it
npm run dev                 # dev mode with hot reload

# 5. Open the UI
#    Frontend:  http://localhost:5173
#    (the API/server runs on http://localhost:3001)
```

That's it. Log in (you'll be prompted to create an account on first run) and your Claude Code projects and sessions appear in the sidebar.

### Production

```bash
npm start                   # builds the client + server, then serves on SERVER_PORT
# open http://localhost:3001
```

---

## ✨ Features

- **See every session** — browse all your Claude Code / Cursor / Codex / Gemini projects and their conversation history.
- **Drive agents from the browser** — send prompts, stream replies, manage permissions.
- **Live agents (agent-discovery)** — a running agent registers itself and becomes a writable chat in the sidebar, in real time. See below.
- **Files & terminal** — browse the working directory and open an interactive shell.
- **Search** — across projects, conversations, archived sessions, and live agents.
- **Desktop + mobile** — responsive UI, installable as a PWA.

---

## 🤖 Live agents (agent-discovery)

The headline addition in this fork. A running `claude` session can register with a small
local daemon and then appear in the sidebar as a **live, writable** agent — you read its
transcript and send it prompts straight from the browser. Delivery uses a reverse-connect
channel (the agent dials out to the daemon), so there's **no inbound port on the agent and
no cloud round-trip**.

Full setup (daemon install, the channel plugin, launching an agent) lives in
**[`agent-discovery/README.md`](agent-discovery/README.md)**. In short:

```bash
# install + run the daemon (Python 3.10+)
cd agent-discovery && pipx install . && agent-discovery serve
# then point the UI at it via AGENT_DISCOVERY_URL / AGENT_DISCOVERY_TOKEN (see .env.example)
```

---

## ⚙️ Configuration

All settings live in `.env` (copied from `.env.example`). The common ones:

| Variable | Default | Description |
|---|---|---|
| `SERVER_PORT` | `3001` | Backend API + WebSocket server port |
| `VITE_PORT` | `5173` | Frontend dev-server port |
| `HOST` | `0.0.0.0` | Interface to bind to (`127.0.0.1` to restrict to localhost) |
| `DATABASE_PATH` | _(app data dir)_ | Location of the auth/settings SQLite DB |
| `AGENT_DISCOVERY_URL` | — | URL of the agent-discovery daemon (enables live agents) |
| `AGENT_DISCOVERY_TOKEN` | — | Bearer token the UI uses to talk to the daemon |

Run `npx cloudcli status` (or `cloudcli status` after a global install) to see where your
config and data live.

---

## 🛠️ Tech stack

React 18 + Vite + Tailwind on the front end; Node/Express + WebSocket on the back end;
SQLite for auth/settings; a dependency-free Python daemon for agent-discovery.

```bash
npm run dev         # client + server, hot reload
npm run build       # production build (client + server)
npm run typecheck   # tsc on client and server
npm run lint        # eslint
```

---

## 🙏 Credits & license

A fork of [siteboon/claudecodeui](https://github.com/siteboon/claudecodeui), extended with the
live agent-discovery channel. Licensed under **AGPL-3.0** — see [`LICENSE`](LICENSE).
