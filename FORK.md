# FORK.md — MyMu: the maintained feature set on top of upstream claudecodeui

MyMu = **current upstream claudecodeui + the five feature areas below**. This
file is the maintenance contract: these features are what we defend on every
upstream pull — nothing more. Everything else in the tree is upstream's and
gets replaced wholesale by pulls.

Decided by Manar, 2026-07-31, after the re-fork onto upstream `c2408f0`
(v1.37.0). Upstream independently converged on most of our old fork's chat
features (standard protocol, asset attachments, activity indicator, token UI,
realtime deltas), so those are **inherited, not maintained** anymore.

## The maintained features

### F1 — Live agents (the relay layer)
Attach to running `claude --remote-control` sessions org-wide via the
Anthropic relay: roster, liveliness, transcripts, drive, files.
- **MyMu-owned files** (merge-clean): `server/remote-control/rc-client.js`,
  `server/rc-channel.js`, `server/services/rc.service.ts`,
  `server/services/local-sessions.ts`, `server/routes/remote-files.js`,
  `server/routes/agent-hosts.js`.
- **Marked touchpoints in upstream files**: chat gateway
  (`chat-websocket.service.ts` — relay branches via `setRelayDependencies`
  injection), `projects.routes.ts` (agent-status, hidden-agents filter),
  `projects-with-sessions-fetch.service.ts` (remote leaves as projects with
  their live session as a session row), `provider.routes.ts` (running feed +
  relay startedAt), `sessions.service.ts` (remote history branch),
  `sessions-watcher.service.ts` (scoped deltas), `server/index.ts` (wiring),
  `shared/types.ts` (fields), `useSessionStore.ts` (realtime upsert-by-id —
  relay re-delivers frames by design).
- Env: `RC_ACCOUNTS`, `RC_AGENT_ALLOW`, `RC_AGENT_DENY`, `RC_IDLE_SYNC_MS`,
  `RC_STALL_QUIET_MS`, `RC_TURNOPEN_TRUST_MAX_MS`.

### F2 — Multi-host accounts
One client logged into several MyMu hosts; every resource served by its
owning host; deployment-global agent→host pinning.
- Server: `server/routes/agent-hosts.js` + `agent_host_assignments` table
  (schema/repository marked in database module).
- Web UI: Hosts dialog (sidebar footer), per-host WebSocket pool with queued
  sends + loud failure (`WebSocketContext` marked hunks, frames tagged
  `__hostUrl` through the dispatch pipeline), multi-host project fetch union +
  cross-account dedupe + host-pin routing (`useProjectsState` marked hunks),
  host-aware api layer (`api.js`).

### F3 — Multi-user model (linux-user mapping)
Accounts map to linux users; visibility and process identity follow the
mapping; first registered user is the operator (`account_owner`).
- **MyMu-owned**: `server/modules/mymu/user-context.ts`, `user-fs.ts` (+
  forwarding shims in `server/services/`).
- **Marked touchpoints**: auth middleware + `auth.module.ts` (context on every
  request/socket path, owner stamp), `users.ts` repository + migrations +
  `schema.ts` (columns/tables), `project-management.service.ts` (owner-aware),
  `claude-runtime.provider.js` (spawn-as-owner sudo wrapper + scope gate),
  `user.routes.ts` (hidden-agents endpoints).
- Host setup: `mymu-users` group + sudoers (README runbook).

### F4 — File flows
Agents deliver files to users (SendUserFile), cross-host federation for
remote agents' files, sudo-aware cross-user reads, 200MB attachment caps.
- **MyMu-owned**: `server/routes/remote-files.js`,
  `server/services/federation.ts`, `server/services/incoming-files.ts`.
- **Marked touchpoints**: `assets.routes.ts` (cap override via
  `MYMU_MAX_ASSET_MB`), `rc-channel.js` (attachment landing + token frames).
- Web delivered-file renderer: `FileDeliveryContent` wired via ToolRenderer.
- File-tree binary layer (MyMu): download buttons + PDF open + `VideoViewer`/
  `AudioViewer` (ours-only files) + binary/Range reads; remote agents' files
  serve through the stock file-tree paths via gated aliases in
  `server/routes/remote-files.js` (tree, file, files/content).

### F5 — Operations & identity
- Deployment lockdown (`CCUI_LOCKDOWN`) — `server/modules/mymu/
  deployment-policy.ts` + marked call sites in projects/provider routes.
- `/api/version` (name MyMu, builtAt, bundle) — `server/modules/mymu/`.
- **Branding**: `public/` + `index.html` are wholesale MyMu-owned (icons,
  manifest, shapes, loaders, title); pitch-black dark theme block in
  `src/index.css`; all user-visible strings renamed by
  `scripts/mymu-rebrand.mjs` (idempotent — see runbook).

### F6 — Error feedback (cross-cutting)
Every MyMu feature surfaces a specific failure reason — never "[object Object]",
never a blank, never a silent drop. Decided by Manar 2026-08-12.
- **MyMu-owned** (merge-clean): `src/utils/readError.ts` (`errorText` /
  `pickErrorMessage` / `readErrorResponse` — normalize ANY backend shape, the
  structured envelope `{ error:{ message } }` OR flat `{ error }` OR a dead
  network, into a guaranteed non-empty string) + `src/utils/readError.test.ts`;
  `src/shared/view/ui/ErrorText.tsx` (render chokepoint that cannot print an
  object). New client failure paths route through these two.
- **Marked touchpoints (`MYMU:`)**: `remoteHosts.ts` (connect surfaces the real
  login error + dead-host reason — fixes the `[object Object]` on a
  not-configured user), `HostsDialog.tsx` (renders via `ErrorText`),
  `useChatComposerState.ts` (upload + command errors via `pickErrorMessage`),
  `FileDeliveryContent.tsx` (surfaces the host's real reason on a failed fetch),
  `rc-channel.js` (LOUD error when stored-asset attachments can't land on a
  cross-host agent — they used to vanish while the loader showed success),
  `assets.routes.ts` (`uploadErrorMessage` — names the MB cap on oversize).

### F7 — Live OpenCode agents (added 2026-08-15, shipped in 1.37.7)
The second live harness beside the claude relay: attach to registered
tenant-local `opencode serve` servers with the SAME frontend contract —
stream, send, abort, permission prompts, slash commands, attachments,
offline history. Zero changes inside the tenant or opencode itself; the only
requirement is launch-time registration (analog of `--remote-control`).
- **MyMu-owned files** (merge-clean): `server/remote-control/oc-client.js`
  (engine: registry, SSE attach + reconnect, prompt_async send, abort,
  permission reply, slash commands via `POST /session/:id/command`,
  MyMu-side offline event cache `~/.cache/ccui-oc-events`, replay buffer,
  fan-out deduped by underlying socket), `server/oc-channel.js` (adapter),
  `scripts/oc-agent-launch.sh` (launch + registration).
- **Marked touchpoints in upstream files**: `server/index.ts` (relay-deps mux
  on the `ocs_` prefix), `chat-websocket.service.ts` (`ocs_` in
  isRelaySession), `rc.service.ts` (roster/capture/cwd merge),
  `sessions.service.ts` (ocs history branch),
  `opencode-sessions.provider.ts` (`normalizeApiMessages` — API-row
  normalizer shared by live + history), `provider.routes.ts` (running feed),
  `incoming-files.ts` (ocs attachment landing from the registration file),
  `remote-files.js` (delivered-path guard), `ChatMessagesPane.tsx` (no
  provider picker on empty live-agent chats).
- **Registration**: `OC_REGISTRY_DIR` (default `~/.cloudcli/opencode-agents`),
  one JSON per agent `{name, port, host, cwd, user}`; session ids
  `ocs_<agent>_<ses_…>`. Env: `OC_REGISTRY_DIR`, `OC_EVENTS_CACHE_DIR`.

## Conversation send/receive: what we touch (and nothing else)
1. Relay detour in the chat gateway for `cse_` sessions (F1).
2. Transcript normalizer merge in `claude-sessions.provider.ts` (injected/
   command/stdout classification + windowed tail reads + telemetry fields).
3. Realtime upsert-by-id in `useSessionStore.ts` (F1 re-delivery).
Everything else in the chat pipeline is upstream's, untouched.

## Deviation policy
- Additive code lives in MyMu-owned files/modules; upstream never touches
  them, so they merge clean.
- Edits inside upstream files are minimal and carry a `MYMU:` marker (hunk
  comment, or a file-header marker for patch-applied files).
- Behavioral switches are env-driven, never deleted upstream code paths.
- Every deviation is listed in this file; a change without a FORK.md entry is
  incomplete.

## Upstream pull runbook
1. `git fetch origin && git merge origin/main` on the MyMu branch.
2. Conflicts concentrate in the marked touchpoint files listed per feature
   above; MyMu-owned files merge clean. Resolve keeping both sides' intent —
   the marker comments say what each MyMu hunk does.
3. `node scripts/mymu-rebrand.mjs` (re-applies branding; idempotent).
4. `npm run typecheck && npx eslint server/ src/ && npm run build`.
5. `bash scripts/mymu-smoke.sh` against a dev instance (see script header for
   env) — verifies version, lockdown, chat E2E, agents roster, running feed,
   hidden-agents, assets caps.
6. Update this file if the pull moved any touchpoint.

## Open items (not yet on this branch)
- "Show online" reveal toggle UI for hidden agents (server supports
  includeHidden=1); relay statusText into the activity indicator.
- `ios-native/` + `tools/demo-server/` live on the old branch until the swap.
- Full parity pass, then the three live hosts swap to this lineage.
