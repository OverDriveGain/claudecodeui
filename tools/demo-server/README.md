# MyMu demo server

A **fake** claudecodeui-compatible backend for the MyMu App Store review. It
accepts **any** username/password and returns canned sample data, so an Apple
reviewer can log in and see a fully populated app **without ever touching the
real code.kaxtus.com fleet**. No real agents, no shell execution, no Anthropic
calls, no secrets.

## Run
```bash
npm install          # one dep: ws
PORT=8099 npm start  # default PORT=8080
```
Health check: `GET /` or `/healthz` → `MyMu demo server: ok`.

## What it serves
REST: `/api/auth/login` (any creds), `/api/auth/status`, `/api/projects`,
`/api/projects/archived`, `/api/projects/agent-status`,
`/api/providers/sessions/:id/messages`, `/api/projects/:id/files|file`.
WS `/ws`: on `claude-command` it streams a short canned assistant reply.

## Deploy target (for environment)
- Subdomain: **demo.proagenten.com** (confirm .com vs .de is the controlled domain).
- Reverse proxy (nginx): TLS via Let's Encrypt; proxy `/` **and** `/ws`
  (WebSocket upgrade headers `Upgrade`/`Connection`) to `127.0.0.1:<PORT>`.
- Run as a small systemd service (`node server.js`, `PORT=` in the unit env).
- No auth, no persistence, no outbound network needed. Safe to expose publicly 
  it only ever returns static fake data.
- Node 18+ (uses global `URL`, `WebSocketServer`).
