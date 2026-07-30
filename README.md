# MyMu

A multi-user web UI (plus a native iOS client) for seeing and driving [Claude Code](https://docs.anthropic.com/en/docs/claude-code) agents — local conversations and live remote-control agents — with real per-OS-user isolation on shared hosts.

Forked from [siteboon/claudecodeui](https://github.com/siteboon/claudecodeui) and substantially extended. Upstream docs still apply to the basics; this README documents how **this** fork is built, configured, operated, and deployed.

---

## What it does

- **Projects & conversations** — browse projects, read transcripts, start new Claude Code conversations from the browser or the iOS app. Local conversations are spawned through the Claude Agent SDK.
- **Live agents** — mirrors running `claude --remote-control` sessions (the claude.ai/code relay): live streaming transcript, send/abort, working status, token/turn telemetry.
- **Multi-user, one backend per host** — one MyMu instance serves many accounts; each account maps to a linux user and is confined to that user's world (see *Multi-user model*).
- **Multi-host client** — the web client can log into additional MyMu hosts (Hosts dialog); every resource is served by the host that owns it. No backend federation, no host-to-host trust.
- **File sharing** — attach files to conversations; attachments to agents land on the agent's host disk and the agent is referred to the path. Delivered files stream back inline.
- **iOS app** — native SwiftUI client (`ios-native/`), multi-account (Gmail-style switcher), agent→host routing. See `ios-native/README.md`.

## Architecture

```
Browser / iOS app
   │  HTTPS + WebSocket (/ws?token=…)
   ▼
Node backend (Express + ws)  ──  dist-server/, one instance PER HOST
   ├─ SQLite auth.db          users, sessions index, projects, agent-host pins
   ├─ Claude Agent SDK        local conversation spawns (per-user, see below)
   ├─ Relay reader            lists/streams remote-control agents (claude.ai relay)
   └─ sudo seam (user-fs)     cross-user reads/writes/spawns for mapped users
React SPA (dist/)             served statically by the same backend
```

The backend process runs as one **service user**. Everything done on behalf of a *mapped* account (file reads, project creation, conversation spawns) is brokered through narrow `sudo -n -u <user>` calls, so the work is genuinely performed *as* that user.

## Build & run

```bash
npm install
npm run typecheck        # tsc, both tsconfigs
npm run build            # SPA → dist/, server → dist-server/
node dist-server/server/index.js
```

Dev mode: `npm run dev` (Vite + tsx, hot reload).

Verify a running instance: `GET /api/version` → `{name, version, builtAt, bundle}`.

### Configuration (env)

| Variable | Meaning |
|---|---|
| `SERVER_PORT` | HTTP/WS listen port |
| `DATABASE_PATH` | SQLite auth.db location (default `~/.claudecodeui/auth.db`) |
| `JWT_SECRET` | token signing secret — set it, or sessions die on restart |
| `WORKSPACES_ROOT` | root for service-user project creation (default: service user's home) |
| `CLAUDE_CLI_PATH` | explicit claude executable for service-user spawns |
| `RC_ACCOUNTS` | optional list of relay reader credentials files; default: service user's `~/.claude/.credentials.json` |
| `RC_AGENT_ALLOW` / `RC_AGENT_DENY` | deployment-wide agent title globs (server-enforced capture policy) |
| `CCUI_LOCKDOWN` | view+converse lockdown: blocks project add/remove and permanent deletes |

First registered account becomes `account_owner` (admin).

## Multi-user model

One backend per host; accounts are separated by **linux user**, not by app-level conventions.

- `users.linux_user` maps a MyMu account to an OS user (aliases allowed — several accounts may map to the service user). `users.account_owner = 1` marks admins who see everything the deployment surfaces.
- **Visibility is path ownership**: a local project belongs to whoever's `/home/<linux_user>` contains it. Scoped accounts see (and can only touch) their own tree. Agent visibility uses title globs derived from the mapping, overridable per user (`agent_allow`) and per deployment (`RC_AGENT_ALLOW/DENY`).
- **Reads** (file trees, transcripts, session registries) of a mapped user's home run via `sudo -u <user>` helpers (`server/services/user-fs.ts`).
- **Writes & spawns**: project creation `mkdir`s as the owner; local conversations exec the claude CLI **as the owner** through a generated wrapper (`~/.claudecodeui/bin/mymu-spawn-as-user.sh`) — the process runs with the owner's uid, HOME, and their own `~/.claude` login, and session files land in their home. Scoped accounts cannot create projects or spawn outside their own home (server-enforced).
- Foreign-user sessions are registered in the DB at creation time (the filesystem watcher cannot read other homes).

### Host setup for multi-user

1. Create the whitelist group and grant the service user brokered access:
   ```
   groupadd mymu-users
   echo '<service-user> ALL=(%mymu-users) NOPASSWD: ALL' > /etc/sudoers.d/mymu-users
   chmod 440 /etc/sudoers.d/mymu-users && visudo -c
   ```
   **Always a group whitelist — never a runas blacklist** like `(ALL,!root)`: any member user with sudo rights would make the backend root-equivalent transitively.
2. Onboard a user:
   ```
   useradd -m <name>            # home must be owned by the user (chown <name>: /home/<name>)
   usermod -aG mymu-users <name>
   ```
   Then create their MyMu account with `linux_user = <name>`, and log them into Claude Code once as that OS user (their own `~/.claude` credentials — conversations bill/run on *their* login).
3. The `claude` CLI must be resolvable in the mapped user's login shell (a host-wide install such as `/usr/local/bin/claude` works; `~/.local/bin` and nvm paths are probed as fallbacks).

Backend discovery is automatic: any account whose `linux_user` has an existing `/home/<user>` participates within ~30 s — no restart, no config.

## Deployment & upgrades

Build once, ship artifacts; hosts never build:

```bash
npm run typecheck && npm run build
rsync -az --delete dist dist-server <host>:<install-dir>/
ssh <host> 'systemctl --user restart <mymu-unit>'
curl -s https://<host>/api/version     # builtAt must match everywhere
```

Example systemd user unit:

```ini
[Unit]
Description=MyMu
[Service]
Environment=SERVER_PORT=10099
EnvironmentFile=%h/.config/mymu/secret.env
WorkingDirectory=<install-dir>
ExecStart=/usr/bin/node dist-server/server/index.js
Restart=always
[Install]
WantedBy=default.target
```

Run it behind a reverse proxy that forwards **everything** (SPA + `/api` + `/ws` WebSocket upgrade) to the backend port. Serving a static SPA copy separately from the API is a known footgun (stale frontend vs live backend) — full proxy only.

Multi-host fleets: deploy the same `dist`/`dist-server` to every host and compare `/api/version` for fleet-in-sync. Clients add peer hosts by logging in with that host's own account (web Hosts dialog; iOS account switcher).

## Live agents (remote control)

The backend lists and mirrors `claude --remote-control` sessions via the claude.ai relay using the reader credentials (`RC_ACCOUNTS` or the service user's login). Notes:

- The relay roster is **org-wide** for the logged-in account; scope what a deployment shows with `RC_AGENT_ALLOW`/`RC_AGENT_DENY`, and per user via account mapping / `agent_allow`.
- Controllability requires the agent to have been **launched** with `--remote-control`; it cannot be injected into a running session.
- Admins can pin an agent to a specific host (Agents view → server icon); clients then route sends and file landings to the pinned host.

## Troubleshooting

- **Spawn error "exited with code 86"** — the per-user wrapper could not `cd` into the project dir (dir missing, or the mapped user lacks access to their own tree — check home ownership). **Code 87** — no `claude` CLI found for that user.
- **"native binary exists but failed to launch"** — the SDK prints this for *any* spawn failure incl. EACCES/ENOENT on cwd; check the server log's `SDK query error:` for the real code.
- **Empty agents roster** — almost always dead reader credentials (`~/.claude/.credentials.json` blank/expired) → re-login; check `/api/projects/agent-status` `accountErrors`.
- **WS auth failures loop** — server logs rejected tokens' unverified claims (`[ws-auth] rejected token claims`); stale tokens after moving/merging instances (different `JWT_SECRET`) → users just re-login.
- **Scoped user sees empty lists** — verify `users.linux_user`, group membership, and that `/home/<user>` exists and is owned by them.

## Repo layout

- `server/` — backend (Express, WS, providers, sudo seam in `services/user-fs.ts`)
- `src/` — React SPA
- `ios-native/` — SwiftUI iOS app (own README)
- `tools/demo-server/` — standalone demo backend with sample data (App Store review / demos)
