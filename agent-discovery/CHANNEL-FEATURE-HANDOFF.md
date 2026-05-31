# Channel Feature + GUI Work — Handoff / Problem Statement

Date: 2026-05-31. Status at handoff: **backend PROVEN working; GUI is the remaining work.**

This document is the single source of truth to resume after a context reset. The next
session should **focus on the GUI** (`claudecodeui` frontend) and leave the
discovery daemon + channel backend as-is (they work).

---

## 1. What this feature is

Goal (Manar's design): the **claudecodeui web GUI** should be able to **see and drive
live `claude --remote-control` agents** — read their transcript AND write into the live
session — through **one central server** (the agent-discovery daemon), with:
- NO per-agent inbound HTTP port,
- NO cloud bridge,
- NO `claude --print --resume` respawn,
- agents just register + a small channel plugin dials OUT to the central daemon.

The GUI should ultimately **mirror the functionality of `claude --remote-control`** for
each agent (chat, files, folders-as-projects, file sharing/upload, etc.) — see §6.

## 2. Architecture (the working backend)

```
 client (GUI / curl / anything)
    │ POST /agents/<id>/prompt {"content":"..."}   (Bearer token)
    ▼
 CENTRAL DAEMON  127.0.0.1:9301   (agent_discovery serve)  — the only server / router
    │ holds an open SSE stream per agent (the shim dialed IN via GET /channel/connect)
    ▼ writes  data: {"content":"..."}
 SHIM  (agent-discovery/channel-plugin/server.mjs)  — stdio MCP plugin inside the agent
    │ emits  notifications/claude/channel {content, meta}
    ▼
 LIVE  claude --remote-control  session
    │ renders <channel source="plugin:channel:channel" ...>...</channel> as a user turn
    ▼ agent replies → written to the session transcript .jsonl (GUI/daemon tail to read)
```

Key insight: the agent exposes no inbound port; the shim **dials out** to the daemon and
holds an SSE stream, so the daemon can push prompts into any agent. The shim→Claude hop
uses Claude's native `notifications/claude/channel` MCP mechanism (same one Telegram uses).

## 3. PROVEN working (do not re-litigate)

Backend end-to-end was proven THREE times with live nonce round-trips:
- `PONG-BACKEND-9931` ✅  (agent launched with `--dangerously-load-development-channels`)
- `PONG-DANGEROUS-7777` ✅ (same)
- Earlier scratch-port nonce test ✅

Each time: `curl POST /agents/<id>/prompt` → daemon returns `{"routed":"channel-shim"}` →
the nonce appeared in the live session transcript as a `<channel ...>` user message →
the agent **replied with the exact nonce**. So: daemon → shim → live session → reply = WORKS.

### CRITICAL launch requirement (settled by experiment)
- ✅ `claude --remote-control --dangerously-load-development-channels plugin:channel@agentchan` → **delivers**
- ❌ `claude --remote-control --channels plugin:channel@agentchan` → connects but **silently DROPS** inbound
  (the custom channel is not on Claude's approved allowlist).

The `--dangerously-load-development-channels` flag is **required**. Attempt to avoid it via
the `tengu_harbor_ledger` / `allowedChannelPlugins` allowlist in `~/.claude.json` was
made (entry `{"marketplace":"agentchan","plugin":"channel"}` added) but is **NOT honored** —
plain `--channels` still drops. So either keep the dangerous flag (launcher should add it +
auto-accept the startup dialog via the pty trick in
`~/Projects/remote-control-clone/scripts/launch.py`) or investigate the ledger format later.
Backup of claude.json before the ledger edit: `~/.claude.json.harborbak`.

## 4. Current deploy state (live, on desktop)

- **Daemon 9301**: running the NEW channel build (pid was 735530; `python -m agent_discovery
  serve`, token `27503c95ca5312fa9f91aefe214315b40aba3884844fdcc48d4c3e76848cf598`).
  Has `GET /channel/connect` (SSE hub) + prompt routing to the shim. `/channel/connect?session=x`
  returns 401 without auth = endpoint present.
- **ccui 3001**: systemd `--user` `ccui.service`, serves `~/Projects/claudecodeui/dist` +
  `dist-server`. Points at `AGENT_DISCOVERY_URL=http://127.0.0.1:9301`,
  `FLEET_DISCOVERY_URL=http://127.0.0.1:9` (dead, intentional — so only the clean
  registration-only daemon feeds the UI; zero fleet agents).
  Token bridged via `/home/manar/.config/ccui/ccui-fleet.env` (AGENT_DISCOVERY_TOKEN).
- **Plugin installed**: marketplace `agentchan`, plugin `channel` (local install from
  `claude plugin marketplace add ~/Projects/claudecodeui/agent-discovery`).
- **Token in shell**: `AGENT_DISCOVERY_TOKEN` exported in `~/.zshrc` so any `claude` the
  user launches inherits it (the shim needs it to dial the daemon).

## 5. THE REMAINING PROBLEM — GUI ↔ server (the focus for next session)

Backend works via curl. The GUI does NOT yet work for the user. Distinct issues:

### 5a. Send path (GUI → server) — UNVERIFIED end-to-end
Browser types → WebSocket → bridge `server/agent-discovery-channel.js`
(`queryAgentChannel`) → should POST `/agents/<id>/prompt` to the daemon → then tail the
transcript and stream the reply back + send a `complete` message to clear the spinner.
The bridge's `if (!agent.controllable)` gate was relaxed to
`if (!(agent.controllable || agent.channel_connected || state==='CONTROLLABLE'))`
(compiled into dist-server, confirmed). But the full browser→bridge→POST→tail chain was
NEVER confirmed live. My curl tests BYPASSED the bridge. **Next step: tail the ccui server
log while sending ONE message from an incognito GUI window — confirm the WS reaches the
bridge, the POST fires, and the tail clears the spinner.**

### 5b. "Processing forever" spinner
After send, the bridge tails the transcript until an assistant record with
`stop_reason !== 'tool_use'`, then sends `complete`. With channel agents this wasn't
clearing. Likely because (a) the bridge bailed at the old `controllable` gate, or (b)
session-id churn / wrong transcript. Verify after 5a.

### 5c. Read-only badge / composer — frontend gating (FIXED in source, needs verify)
- `src/types/app.ts`: added (effectively via index signature) `agentWritable`, `agentChannelConnected`.
- `server/modules/projects/services/projects-with-sessions-fetch.service.ts`: emits
  `agentWritable: state==='CONTROLLABLE' || (state==='ONLINE' && channel_connected)` and
  `agentChannelConnected` on each agent project. CONFIRMED in deployed dist-server + via API.
- `src/components/chat/view/ChatInterface.tsx` line ~314:
  `isAgentOnlineReadOnly = isAgentProject && agentState==='ONLINE' && !selectedProject?.agentWritable`.
- `src/components/sidebar/view/subcomponents/SidebarProjectItem.tsx` lines 127-128:
  `isAgentReadOnly` / `isAgentControllable` now respect `project.agentWritable`.
- **Built into bundle** `dist/assets/index-CaeuhjuB.js` (contains `agentWritable`).
  BUT the user kept seeing read-only because of 5d (cache).

### 5d. Browser service-worker cache (FIXED, needs the user to hard-clear once)
`public/sw.js` (+ `dist/sw.js`) cached `/assets/` **cache-first** → served STALE JS forever,
defeating every rebuild. Changed to **network-first** for `/assets/`, bumped
`CACHE_NAME` to `claude-ui-v3`. The old SW is still installed in the user's browser until
they unregister it once. **Use an incognito window to localhost:3001 to bypass entirely.**

### 5e. Duplicate registration (DESIGN BUG — important GUI cleanup)
Launching a channel agent creates **TWO registry entries for the same session**:
- the SHIM auto-registers via `/channel/connect` → label `unnamed`/`unnamed (2)`, **chan=True (writable)**
- saying "register yourself" runs `claudeui-register` → a SEPARATE id, **chan=False (read-only ghost)**
The user clicks the read-only ghost. FIX: make the shim the SINGLE source of identity —
shim should write/read the `.claudeui-agent.json` marker (or daemon should merge by
session_id so one session = one agent record). Then "register yourself" is unnecessary and
should be discouraged/removed from the UX. Also: the shim agent shows label "unnamed" —
the shim should self-name (pass `AGENT_CHANNEL_LABEL` or derive from cwd).

### 5f. Marker collision (FIXED for /home/manar; keep in mind)
`/home/manar/.claudeui-agent.json` pinned ONE id (65d32fda) for every agent launched in
`/home/manar`, so sessions stomped each other. Removed it. Per-dir launch (e.g.
`/tmp/demo1`, `/home/manar/temp/test2`) gives unique identity. The duplicate-registration
fix (5e) should make identity robust regardless.

## 6. GUI FEATURE GOALS (the actual next-session build)

Treat each agent like a first-class project in the GUI and mirror `claude --remote-control`:
1. **Fix selection bug**: clicking one agent (e.g. `test2`) selects MULTIPLE sidebar entries
   at once — because of the duplicate ids (5e) and/or projectId keying. Fix so one agent =
   one selectable row.
2. **One clean entry per agent**, properly named, with the right writable badge.
3. **Folders / project tree** for agents: show the agent's cwd as a project with its file
   tree (the daemon already has cwd-jailed `/agents/<id>/files` + `/agents/<id>/file`).
4. **File sharing / upload** to the agent (images already partially supported via the
   prompt `images` field; extend to files).
5. **Mirror remote-control functionality**: anything `claude --remote-control` exposes
   (chat, file ops, etc.) should be reflected in this GUI for channel agents.
6. Composer enabled for writable (channel-connected) agents; read-only only when truly
   disconnected.

## 7. Files changed (this work, committed in the same commit as this doc)

Backend / daemon (WORKS — leave alone unless needed):
- `agent-discovery/daemon/agent_discovery/daemon.py` — ThreadingHTTPServer, `GET /channel/connect`, prompt routing to channel-shim
- `agent-discovery/daemon/agent_discovery/channel.py` — NEW, session-keyed SSE hub
- `agent-discovery/daemon/agent_discovery/proc.py` — `find_claude_by_session`
- `agent-discovery/daemon/agent_discovery/registry.py` — `register_channel_session`, `channel_connected`, lazy channel import
- `agent-discovery/channel-plugin/` — NEW: `server.mjs` (dep-free stdio MCP shim), `.claude-plugin/plugin.json`, `.mcp.json`
- `agent-discovery/.claude-plugin/marketplace.json` — NEW: local marketplace `agentchan`
- `agent-discovery/launcher/launch-channel-agent.py` — NEW: dtach launch + pty dialog-accept

Frontend / bridge (the GUI work — partially done, needs §5):
- `server/agent-discovery-channel.js` — relaxed controllable gate to allow channel_connected
- `server/modules/projects/services/projects-with-sessions-fetch.service.ts` — emit agentWritable/agentChannelConnected
- `server/services/agent-discovery.service.ts` — RegisteredAgent.channel_connected
- `src/types/app.ts` — agentWritable/agentChannelConnected
- `src/components/chat/view/ChatInterface.tsx` — composer readOnly respects agentWritable
- `src/components/sidebar/view/subcomponents/SidebarProjectItem.tsx` — badge respects agentWritable
- `public/sw.js` + `dist/sw.js` — network-first assets, cache v3

## 8. How to re-verify quickly (next session)

```bash
TOK=27503c95ca5312fa9f91aefe214315b40aba3884844fdcc48d4c3e76848cf598
# 1. backend still works?
curl -s -H "Authorization: Bearer $TOK" http://127.0.0.1:9301/agents | python3 -m json.tool
# pick a chan=True agent id, then:
curl -s -X POST -H "Authorization: Bearer $TOK" -H 'content-type: application/json' \
  -d '{"content":"Reply with exactly: PONG-X"}' http://127.0.0.1:9301/agents/<ID>/prompt
# grep its transcript (path in the /agents output) for PONG-X

# 2. launch a fresh channel agent (per-dir, with the required flag):
mkdir -p /tmp/demoX && cd /tmp/demoX
claude --remote-control --dangerously-load-development-channels plugin:channel@agentchan
#   (accept the dev-channels dialog; do NOT say "register yourself")

# 3. GUI: open localhost:3001 in INCOGNITO, click the chan=True entry, send a message,
#    tail the ccui server log to watch WS->bridge->POST->tail.
```

## 9. Memory / continuity

Full session history + decompile findings are in the project memory:
`~/.claude/projects/-home-manar-kaxtus-agents-claude-code-cli-ui/memory/remote-control-relay-clone.md`
and `~/kaxtus-agents/claude-code-cli-ui/{KNOWLEDGE.md,notes.md,incidents.md}`.
The decompiled claude strings (ephemeral) were at `/tmp/claude-strings.txt`.
