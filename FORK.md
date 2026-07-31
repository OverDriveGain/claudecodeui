# FORK.md — MyMu's complete delta vs upstream claudecodeui

This file is the **authoritative inventory of everything MyMu adds or changes**
relative to upstream (`siteboon/claudecodeui`). It exists so that:

1. **No feature is ever silently lost** when rebasing onto a newer upstream —
   porting is done feature-by-feature against this list, and a port is complete
   only when every entry is checked off.
2. **Future upstream pulls stay cheap** — every deviation follows the rules in
   *Deviation policy* below, so upstream files stay as close to pristine as
   possible and conflicts concentrate in MyMu-owned files.

Baseline at the time of writing: forked from upstream `6a53c31` (2026-06-09),
current upstream `c2408f0` (v1.37.0+). Our delta: 354 files.

## Deviation policy (the rules that keep pulls cheap)

- **Additive code lives in MyMu-owned files/modules** (new files, new modules,
  new routes). Upstream never touches these; they merge clean.
- **Edits inside upstream files are minimal and marked** with a `MYMU:` comment
  at the insertion point, so a conflicted hunk is self-explanatory.
- **Behavioral switches are env-driven, not code-forked**: anything that
  disables/hides upstream behavior must be a runtime flag (documented in
  README's env table), never a deleted code path.
- **Every deviation is listed here.** A PR that adds a deviation without a
  FORK.md entry is incomplete.

## Feature inventory

### S1. Live relay agents ("Agents" view)
Drive and observe running `claude --remote-control` sessions org-wide via the
Anthropic relay. Entirely MyMu; upstream has no equivalent.
- Own files: `server/remote-control/rc-client.js` (relay reader/driver: attach,
  replay, stall watchdog, idle sync, event cache with id-dedupe, bounded
  turnOpen trust), `server/rc-channel.js` (WS dispatch glue),
  `server/services/rc.service.ts` (roster, capture checks, remote project
  mapping).
- Upstream-file edits: `server/index.js` (wiring), projects routes
  (`agent-status`, remote projects in the listing), chat WS gateway (remote
  dispatch), `server/shared/types.ts` (frame fields).
- Env: `RC_ACCOUNTS`, `RC_AGENT_ALLOW`, `RC_AGENT_DENY`, `RC_IDLE_SYNC_MS`,
  `RC_STALL_QUIET_MS`, `RC_TURNOPEN_TRUST_MAX_MS`.
- Web UI: Agents sidebar view, per-user "Remove from view" (`user_hidden_agents`
  table + `/api/user/hidden-agents`), "Show online" reveal, account-error
  banner (`agentHealthStore`), session running-state store.

### S2. Multi-user model (linux-user mapping)
One MyMu per host; each account maps to a linux user; visibility and process
identity follow the mapping.
- DB: `users.linux_user`, `users.account_owner` columns (+ migrations).
- Own files: `server/services/user-context.js|ts` (effective allow derivation,
  runWithUserContext), `server/services/user-fs.ts` (sudo seam: readdir/stat/
  read/mkdir/resolve as owner), spawn wrapper generation
  (`~/.claudecodeui/bin/mymu-spawn-as-user.sh`).
- Upstream-file edits: `server/middleware/auth.js` + `server/routes/auth.js`
  (context fields on both WS auth paths — **landmine: every hand-built user
  object must carry linux_user/account_owner**), `server/claude-sdk.js`
  (spawn-as-owner + scope gate), project-management/clone services (owner-aware
  mkdir/validate), sessions watcher (foreign-session registration).
- Host setup: `mymu-users` group + sudoers (documented in README).

### S3. Chat robustness + turn telemetry (server)
- fetchHistory response extras: `context{usedTokens,windowTokens}`,
  `turnStartedAt`, `turnStartContextTokens`; `contextTokens` on live frames.
- Injected-content classification: `isInjected` on user rows
  (isSynthetic/origin.kind), `normalizeUserTextRow` (command/stdout/
  task-notification parsing for string AND array content).
- Stable creation-time conversation ordering; 200MB upload caps.
- Mostly edits inside `claude-sessions.provider.ts`, `sessions.service.ts`,
  `server/index.js` — port carefully, these are behavior patches.

### S4. Stock-protocol compliance layer (2026-07-31)
Bridges the pre-rewrite chat engine to the current stock client contract. On a
current-upstream base, MOST OF THIS DISSOLVES — upstream already speaks chat.*;
keep only the deltas: relay dispatch inside the chat gateway (`cse_` routing),
attachment materialization for relay sessions, 200MB asset caps.
- Own files: `server/modules/assets/` (asset store — upstream has its own on
  current main; ours exists only because the old base lacked it. On port:
  adopt upstream's, keep the cap override + relay materialization).
- Edits: chat WS gateway aliases, `POST /api/providers/sessions` (upstream has
  it), messages envelope (upstream has it).

### S5. File flows
- Attachments landing on the agent's host (`server/services/incoming-files.ts`,
  local-host landing; referral text to the agent).
- Delivered files FROM agents: `delivered-file` endpoint on remote projects +
  warm-cache rule; federation read path (`CCUI_FILE_PEERS`, federation token).
- Web: FileDeliveryContent, `openDataUrlAttachment`.

### S6. Deployment policy
- `CCUI_LOCKDOWN` (view+converse only, archive-only deletes,
  `server/services/deployment-policy.js`).
- `/api/version` (name/version/builtAt/bundle — also the fleet-sync check).
- `server/routes/user.js` additions (hidden agents, user management edits).

### S7. Web client features (rebuild on upstream's current UI during port)
- Agents view + sidebar integration, hosts dialog (multi-host accounts:
  `src/utils/remoteHosts.ts`, per-host WS, merged projects, cross-account
  dedupe), agent→host pinning (`/api/agent-hosts`).
- Loader telemetry (elapsed + tokens-this-turn + live activity label in
  `ClaudeStatus`), total-tokens pill (`TokenUsageSummary`).
- Injected-context rows (`InjectedContextRow`, collapsed chip), sent-image
  lightbox behavior, dedicated STOP button in the composer.
- Scroll robustness (no reset on projects_updated, windowed refresh, smooth
  send glide), session running-state single source of truth.
- Pitch-black dark theme (iOS `Theme.swift` palette in `index.css` +
  `ThemeContext`), MyMu branding (`public/`, `public/shapes/`, loaders).
- i18n additions across all 9 locales.

### S8. iOS app (`ios-native/`) — entirely ours
Pure stock-ccui client (chat.*, pre-create, asset-store attachments, envelope
tolerance), Gmail-style multi-account, agent pinning, non-lazy transcript,
demo mode for App Store review. Ships from this repo; xcodegen project.

### S9. Auxiliary (ours, low-touch)
- `tools/demo-server/` (App Store review demo backend), `examples/
  agent-to-agent/`, `android/` + `ios/` Capacitor shells, `src/mobile/`,
  loaders/tooling under `tools/`.

### S7-branding (systematic — survives upstream pulls)
- `public/` + `index.html` are wholesale MyMu-owned (icons, manifest, shapes,
  loaders, title/fonts) — upstream versions are fully replaced, no merging.
- All user-visible "CloudCLI" strings (locale values + code literals) are
  renamed by `scripts/mymu-rebrand.mjs` — **run it once after every upstream
  pull**; it is idempotent and never touches identifiers, key names, npm
  scope, or runtime paths (`~/.cloudcli` store stays upstream-named).
- Dark theme: MyMu pitch-black scale in `src/index.css` `.dark` block (mirrors
  iOS Theme.swift); light theme stays upstream.

## Port checklist (vanilla-port branch)

- [x] S1 relay layer (2026-07-31: DI-injected gateway branches; 267 agents live-verified)
- [x] S2 multi-user (2026-07-31: schema+auth+context+spawn-as-owner+owner-aware projects)
- [x] S3 telemetry + injected classification (2026-07-31: normalizer + windowed fetchHistory merged)
- [x] S4 residue (2026-07-31: 200MB caps env-tunable; relay attachment materialization via rc-channel)
- [x] S5 file flows (2026-07-31: federation + delivered-file + remote/local file routes; remote browse live-verified)
- [x] S6 lockdown + version (2026-07-31: mymu module, verified on :3099)
- [ ] S7 web features onto upstream's current UI
- [ ] S8 verify iOS app against ported server (contract should already hold)
- [ ] S9 carry-over dirs
- [ ] Full parity test vs this branch on a dedicated port (never live hosts)
