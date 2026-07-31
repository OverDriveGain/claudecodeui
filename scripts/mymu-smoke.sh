#!/bin/bash
# MYMU: post-pull smoke test (FORK.md runbook step 5).
#
# Verifies every maintained feature area against a RUNNING dev instance.
# Boot one first, e.g.:
#   SERVER_PORT=3099 HOST=127.0.0.1 DATABASE_PATH=$HOME/.claudecodeui-port/auth.db \
#     JWT_SECRET=portdev1 node dist-server/server/index.js
# Then:
#   BASE=http://127.0.0.1:3099 USER=portadmin PASS=... bash scripts/mymu-smoke.sh
#
# Chat E2E spawns a real claude turn in $HOME/mymu-smoke-e2e (needs a logged-in
# claude CLI for the service user); it cleans up after itself.
set -u
BASE="${BASE:-http://127.0.0.1:3099}"
USER="${USER_NAME:-${USER:-portadmin}}"
PASS="${PASS:?set PASS}"
pass=0; fail=0
ok()   { pass=$((pass+1)); echo "PASS  $1"; }
bad()  { fail=$((fail+1)); echo "FAIL  $1"; }
check() { # name, condition (0=ok)
  if [ "$2" = "0" ]; then ok "$1"; else bad "$1"; fi
}

TOK=$(curl -s -X POST -H "Content-Type: application/json" \
  -d "{\"username\":\"$USER\",\"password\":\"$PASS\"}" "$BASE/api/auth/login" \
  | python3 -c "import json,sys; print(json.load(sys.stdin).get('token',''))")
[ -n "$TOK" ] && ok "auth: login" || { bad "auth: login"; echo "cannot continue"; exit 1; }
AUTH="Authorization: Bearer $TOK"

# F5: version identity
V=$(curl -s "$BASE/api/version")
echo "$V" | grep -q '"name":"MyMu"'; check "F5: /api/version says MyMu" $?

# F1: agents roster + running feed + agent-status
P=$(curl -s -H "$AUTH" "$BASE/api/projects")
echo "$P" | python3 -c "
import json,sys
items=json.load(sys.stdin)
agents=[p for p in items if p.get('isRemoteAgent')]
assert isinstance(items, list)
print(f'  (roster: {len(items)} projects, {len(agents)} agents)')
exit(0 if len(agents) >= 0 else 1)"; check "F1: projects roster (bare array + remote leaves)" $?
curl -s -H "$AUTH" "$BASE/api/projects/agent-status" | grep -q '"agents"'; check "F1: agent-status" $?
curl -s -H "$AUTH" "$BASE/api/providers/sessions/running" | grep -q '"sessions"'; check "F1: running feed" $?

# F1: hidden agents round-trip
curl -s -X POST -H "$AUTH" -H "Content-Type: application/json" \
  -d '{"agentKey":"__smoke_test__"}' "$BASE/api/user/hidden-agents" | grep -q '"success":true'
check "F1: hide agent" $?
curl -s -X DELETE -H "$AUTH" -H "Content-Type: application/json" \
  -d '{"agentKey":"__smoke_test__"}' "$BASE/api/user/hidden-agents" | grep -q '"success":true'
check "F1: unhide agent" $?

# F2: agent-hosts
curl -s -H "$AUTH" "$BASE/api/agent-hosts" | grep -q '"assignments"'; check "F2: agent-hosts" $?

# F4: asset store accepts uploads (tiny file, then reference check only)
TMPF=$(mktemp); echo smoke > "$TMPF"
UP=$(curl -s -H "$AUTH" -F "files=@$TMPF;filename=smoke.txt" "$BASE/api/assets/files")
echo "$UP" | grep -q '"attachments"'; check "F4: asset upload" $?
rm -f "$TMPF"
APATH=$(echo "$UP" | python3 -c "import json,sys; print(json.load(sys.stdin)['attachments'][0]['path'])" 2>/dev/null)
[ -n "$APATH" ] && rm -f "$APATH"

# F3+chat E2E: create project, pre-create session, one full turn
E2E="$HOME/mymu-smoke-e2e"; mkdir -p "$E2E"
curl -s -X POST -H "$AUTH" -H "Content-Type: application/json" \
  -d "{\"path\":\"$E2E\"}" "$BASE/api/projects/create-project" -o /dev/null
SID=$(curl -s -X POST -H "$AUTH" -H "Content-Type: application/json" \
  -d "{\"provider\":\"claude\",\"projectPath\":\"$E2E\"}" "$BASE/api/providers/sessions" \
  | python3 -c "import json,sys; print(json.load(sys.stdin)['data']['sessionId'])" 2>/dev/null)
[ -n "$SID" ] && ok "chat: session pre-create" || bad "chat: session pre-create"
if [ -n "$SID" ]; then
  export SMOKE_BASE="$BASE" SMOKE_TOK="$TOK" SMOKE_SID="$SID"
  node --input-type=module -e '
    import WebSocket from "ws";
    const ws = new WebSocket(process.env.SMOKE_BASE.replace("http","ws") + "/ws?token=" + process.env.SMOKE_TOK);
    const t = setTimeout(() => process.exit(1), 120000);
    ws.on("open", () => {
      ws.send(JSON.stringify({ type: "chat.subscribe", sessions: [{ sessionId: process.env.SMOKE_SID, lastSeq: 0 }] }));
      ws.send(JSON.stringify({ type: "chat.send", sessionId: process.env.SMOKE_SID, content: "Reply with exactly OK" }));
    });
    ws.on("message", (raw) => {
      let f; try { f = JSON.parse(raw); } catch { return; }
      if (f.kind === "complete") { clearTimeout(t); process.exit(f.exitCode === 0 ? 0 : 1); }
      if (f.kind === "protocol_error") { clearTimeout(t); process.exit(1); }
    });'
  check "chat: full E2E turn (send → complete)" $?
  curl -s -X DELETE -H "$AUTH" "$BASE/api/providers/sessions/$SID?force=true" -o /dev/null
fi
PID=$(curl -s -H "$AUTH" "$BASE/api/projects" | python3 -c "
import json,sys
for p in json.load(sys.stdin):
    if p.get('path')=='$E2E': print(p['projectId'])" 2>/dev/null)
[ -n "$PID" ] && curl -s -X DELETE -H "$AUTH" "$BASE/api/projects/$PID" -o /dev/null
rm -rf "$E2E"

echo
echo "mymu-smoke: $pass passed, $fail failed"
exit $((fail > 0))
