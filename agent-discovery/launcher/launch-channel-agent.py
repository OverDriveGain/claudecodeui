#!/usr/bin/env python3
"""Launch a Claude Code agent with the reverse-connect channel shim under dtach.

The channel shim (plugin:channel@agentchan) is NOT on Claude's approved-channels
allowlist, so it must be loaded with --dangerously-load-development-channels,
which shows a blocking confirmation dialog at startup. A fresh/untrusted working
dir also shows the workspace-trust dialog first. A plain `dtach -n` launch can't
answer either dialog, so the session hangs before the channel plugin loads.

The dance:
  1. Start claude under `dtach -n` (detached) so it persists independently. The
     shim's daemon URL/token/label come from env (passed through to the plugin).
  2. Transiently attach through a real pty and send a few blind Enters to clear
     the workspace-trust dialog and the dev-channels confirmation.
  3. Detach (Ctrl-^ for `dtach -e ^^`) and exit, leaving claude running.

Prereqs (do once):
  claude plugin marketplace add <repo>/agent-discovery
  claude plugin install channel@agentchan

Env passed to the shim (set before invoking, or via --env KEY=VAL):
  AGENT_DISCOVERY_URL    (default http://127.0.0.1:9301)
  AGENT_DISCOVERY_TOKEN  (required for the shim to authenticate)
  AGENT_CHANNEL_LABEL    (optional display label)

Usage:
  launch-channel-agent.py <work-dir> [--sock /path.sock] [--env KEY=VAL ...]
"""
import os
import sys
import pty
import time
import struct
import fcntl
import termios
import subprocess

def main():
    args = sys.argv[1:]
    if not args:
        print(__doc__)
        sys.exit(2)

    work_dir = os.path.abspath(args[0])
    sock = None
    extra_env = {}
    i = 1
    while i < len(args):
        a = args[i]
        if a == "--sock":
            sock = args[i + 1]; i += 2
        elif a == "--env":
            k, _, v = args[i + 1].partition("="); extra_env[k] = v; i += 2
        else:
            print(f"unknown arg: {a}"); sys.exit(2)
    if sock is None:
        sock = f"/tmp/agentchan-{os.path.basename(work_dir) or 'agent'}.sock"

    os.makedirs(work_dir, exist_ok=True)
    os.chdir(work_dir)

    env = dict(os.environ)
    env.update(extra_env)
    env.setdefault("AGENT_DISCOVERY_URL", "http://127.0.0.1:9301")

    subprocess.run(["/bin/rm", "-f", sock])
    subprocess.Popen(
        [
            "dtach", "-n", sock, "-e", "^^",
            "claude", "--remote-control",
            "--dangerously-skip-permissions",
            "--dangerously-load-development-channels", "plugin:channel@agentchan",
        ],
        env=env,
    )
    time.sleep(3)

    # Transiently attach and clear the startup dialog(s) with blind Enters.
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 50, 200, 0, 0))
    pid = os.fork()
    if pid == 0:
        os.setsid()
        fcntl.ioctl(slave, termios.TIOCSCTTY, 0)
        os.dup2(slave, 0); os.dup2(slave, 1); os.dup2(slave, 2)
        os.execvp("dtach", ["dtach", "-a", sock, "-e", "^^"])
        os._exit(1)
    os.close(slave)
    for delay in (1, 3, 3, 3, 3):
        time.sleep(delay)
        try:
            os.write(master, b"\r")
        except OSError:
            break

    # Detach (Ctrl-^), leave claude running.
    time.sleep(1)
    try:
        os.write(master, b"\x1e")
    except OSError:
        pass
    time.sleep(0.5)
    try:
        os.kill(pid, 9); os.waitpid(pid, 0)
    except Exception:
        pass
    print(f"launched channel agent under dtach (sock={sock}, dir={work_dir})")

if __name__ == "__main__":
    main()
