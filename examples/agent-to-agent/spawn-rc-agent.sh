#!/usr/bin/env bash
# spawn-rc-agent.sh — spawn a `claude --remote-control` agent that appears in the
# CCUI Agents tab. Launches an interactive Remote Control worker under dtach, in a
# trusted cwd.
#
# Usage:  spawn-rc-agent.sh <name> [work_dir]
#   name      label for the dtach socket + log (e.g. "worker1")
#   work_dir  cwd for the agent (default: /tmp/rc-<name>). Auto-trusted.
#
# Plain `claude --remote-control` (interactive flag) — NO internal flags needed: the
# agent is attachable+writable in the terminal AND drivable from the GUI over the
# relay. Requires `claude` logged into the same account CCUI consumes. The trust edit
# backs up ~/.claude.json first.
set -euo pipefail

NAME="${1:?usage: spawn-rc-agent.sh <name> [work_dir]}"
WORKDIR="${2:-/tmp/rc-$NAME}"

mkdir -p "$WORKDIR"
WORKDIR="$(cd "$WORKDIR" && pwd)"   # absolutise — trust keys + cwd must be absolute

SOCK="/run/user/$(id -u)/rc-$NAME.sock"
LOG="$WORKDIR/worker.log"

# --- Ensure the cwd is trusted (claude --remote-control refuses an untrusted dir).
#     Back up ~/.claude.json first (many live agents may write it concurrently).
CJ="$HOME/.claude.json"
if [ -f "$CJ" ]; then
  cp -a "$CJ" "$CJ.bak.rc-spawn.$(date +%s)"
  CJ="$CJ" WORKDIR="$WORKDIR" node -e '
    const fs=require("fs"); const p=process.env.CJ; const dir=process.env.WORKDIR;
    const j=JSON.parse(fs.readFileSync(p,"utf8"));
    j.projects=j.projects||{};
    j.projects[dir]=j.projects[dir]||{};
    j.projects[dir].hasTrustDialogAccepted=true;
    j.projects[dir].hasCompletedProjectOnboarding=true;
    fs.writeFileSync(p, JSON.stringify(j));
    console.log("trusted:", dir);
  '
fi

# --- Launch the worker under dtach.
rm -f "$SOCK"
cat > "$WORKDIR/launch.sh" <<LAUNCH
#!/usr/bin/env bash
cd "$WORKDIR" || exit 1
# --remote-control FLAG = an INTERACTIVE session with Remote Control enabled: the
# terminal stays writable (attach + type), AND it connects to the relay so the GUI
# can drive it natively (stream + stop). NOT the 'remote-control' subcommand, which
# is a headless worker that locks the local TUI.
exec claude --remote-control "$NAME"
LAUNCH
chmod +x "$WORKDIR/launch.sh"

dtach -n "$SOCK" script -qfc "$WORKDIR/launch.sh" "$LOG"
echo "spawned remote-control agent '$NAME'"
echo "  dtach socket : $SOCK   (attach: dtach -a $SOCK ; detach: Ctrl-\\)"
echo "  log          : $LOG"
echo "  -> appears in the CCUI Agents tab within a few seconds."
