"""
agent-discovery CLI entry points.

Commands:
  agent-discovery serve               Start the HTTP daemon
  agent-discovery register            Register this claude process
  agent-discovery register --name X   Register with a label
  agent-discovery unregister          Unregister by current process
  agent-discovery unregister --id X   Unregister by stable UUID
  agent-discovery install-service     Write systemd user unit
"""

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request

from . import proc

DEFAULT_PORT = 9301
MARKER_FILE = ".claudeui-agent.json"


def _read_token() -> str:
    """Read AGENT_DISCOVERY_TOKEN from environment."""
    return os.environ.get("AGENT_DISCOVERY_TOKEN", "").strip()


def _read_marker(cwd: str) -> dict | None:
    """Read .claudeui-agent.json from cwd. Returns dict or None."""
    path = os.path.join(cwd, MARKER_FILE)
    try:
        with open(path) as f:
            data = json.load(f)
        if isinstance(data, dict) and "id" in data:
            return data
    except (OSError, json.JSONDecodeError):
        pass
    return None


def _write_marker(cwd: str, agent_id: str, label: str) -> None:
    """Write .claudeui-agent.json to cwd."""
    path = os.path.join(cwd, MARKER_FILE)
    data = {
        "id": agent_id,
        "label": label,
        "registered_at": int(time.time()),
    }
    try:
        with open(path, "w") as f:
            json.dump(data, f, indent=2)
        print(f"  marker written: {path}")
    except OSError as e:
        print(f"  warning: could not write marker file: {e}")


def _post(url: str, token: str, payload: dict) -> dict:
    body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(url, data=body, method="POST")
    req.add_header("Content-Type", "application/json")
    req.add_header("Content-Length", str(len(body)))
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    with urllib.request.urlopen(req, timeout=10) as resp:
        return json.loads(resp.read().decode("utf-8"))


def cmd_register(args) -> int:
    port = getattr(args, "port", DEFAULT_PORT)
    url_base = (args.url.rstrip("/") if args.url else f"http://127.0.0.1:{port}")
    token = _read_token()
    if not token:
        print("ERROR: AGENT_DISCOVERY_TOKEN not set in environment.")
        return 1

    claude_pid = proc.find_claude_ancestor()
    if claude_pid is None:
        print(
            "ERROR: no claude ancestor found in the process tree. "
            "This command must be run from within a Claude Code session (via the Bash tool)."
        )
        return 1

    cwd = proc.cwd_of(claude_pid)
    marker = _read_marker(cwd) if cwd else None

    payload: dict = {"pid": claude_pid}

    is_reconnect = False
    if marker:
        payload["id"] = marker["id"]
        payload["label"] = args.name or marker.get("label") or "unnamed"
        is_reconnect = True
    else:
        if args.name:
            payload["label"] = args.name

    if cwd:
        payload["cwd"] = cwd

    env = proc.read_environ(claude_pid)
    ctrl_port = env.get("CONTROL_PORT", "").strip()
    ctrl_bind = env.get("CONTROL_BIND", "").strip()
    if ctrl_port.isdigit():
        payload["control_port"] = int(ctrl_port)
    if ctrl_bind:
        payload["control_bind"] = ctrl_bind

    dtach_sock = proc.dtach_socket_of_ancestor(claude_pid)
    if dtach_sock:
        payload["dtach_socket"] = dtach_sock

    try:
        result = _post(f"{url_base}/agents/register", token, payload)
    except urllib.error.HTTPError as e:
        err_body = b""
        try:
            err_body = e.read(512)
        except Exception:
            pass
        print(f"ERROR: HTTP {e.code}: {err_body.decode('utf-8', errors='replace')}")
        return 1
    except Exception as e:
        print(f"ERROR: {e}")
        return 1

    agent_id = result.get("id", "")
    label = result.get("label", "unnamed")
    state = result.get("state", "UNKNOWN")

    if is_reconnect:
        print(f"RECONNECT: {label!r} (id={agent_id}) — state={state}")
    else:
        print(f"REGISTERED: {label!r} (id={agent_id}) — state={state}")
        if cwd and agent_id:
            _write_marker(cwd, agent_id, label)

    return 0


def cmd_unregister(args) -> int:
    port = getattr(args, "port", DEFAULT_PORT)
    url_base = (args.url.rstrip("/") if args.url else f"http://127.0.0.1:{port}")
    token = _read_token()
    if not token:
        print("ERROR: AGENT_DISCOVERY_TOKEN not set in environment.")
        return 1

    payload: dict = {}

    if getattr(args, "id", None):
        payload["id"] = args.id
    elif getattr(args, "name", None):
        payload["label"] = args.name
    else:
        claude_pid = proc.find_claude_ancestor()
        if claude_pid is None:
            print("ERROR: no claude ancestor found; provide --id or --name.")
            return 1
        cwd = proc.cwd_of(claude_pid)
        marker = _read_marker(cwd) if cwd else None
        if marker:
            payload["id"] = marker["id"]
        else:
            payload["pid"] = claude_pid

    try:
        result = _post(f"{url_base}/agents/unregister", token, payload)
    except urllib.error.HTTPError as e:
        err_body = b""
        try:
            err_body = e.read(512)
        except Exception:
            pass
        print(f"ERROR: HTTP {e.code}: {err_body.decode('utf-8', errors='replace')}")
        return 1
    except Exception as e:
        print(f"ERROR: {e}")
        return 1

    removed = result.get("removed", False)
    if removed:
        print("Unregistered successfully.")
    else:
        print("Nothing found to unregister (not in registry).")
    return 0


def cmd_serve(args) -> int:
    from . import daemon
    from .control import load_control_env

    bind = getattr(args, "bind", None) or os.environ.get("BIND", "127.0.0.1")
    port = getattr(args, "port", None) or int(os.environ.get("PORT", str(DEFAULT_PORT)))
    token = getattr(args, "token", None)
    if token:
        os.environ["AGENT_DISCOVERY_TOKEN"] = token

    control_env = os.environ.get("AGENT_DISCOVERY_CONTROL_ENV", "")
    if control_env:
        load_control_env(control_env)

    daemon.serve(bind=bind, port=port)
    return 0


def cmd_install_service(args) -> int:
    """Write a systemd user unit for the daemon."""
    import shutil

    agent_discovery_bin = shutil.which("agent-discovery")
    if not agent_discovery_bin:
        agent_discovery_bin = "agent-discovery"

    unit_dir = os.path.expanduser("~/.config/systemd/user")
    os.makedirs(unit_dir, exist_ok=True)
    unit_path = os.path.join(unit_dir, "agent-discovery.service")

    unit_content = f"""\
[Unit]
Description=agent-discovery daemon
After=network.target

[Service]
Type=simple
ExecStart={agent_discovery_bin} serve
Restart=on-failure
RestartSec=5
Environment=PORT=9301
Environment=BIND=127.0.0.1
EnvironmentFile=%h/.config/agent-discovery/env

[Install]
WantedBy=default.target
"""
    env_dir = os.path.expanduser("~/.config/agent-discovery")
    os.makedirs(env_dir, exist_ok=True)
    env_path = os.path.join(env_dir, "env")

    with open(unit_path, "w") as f:
        f.write(unit_content)
    print(f"Written: {unit_path}")

    if not os.path.exists(env_path):
        with open(env_path, "w") as f:
            f.write("# Set AGENT_DISCOVERY_TOKEN here\nAGENT_DISCOVERY_TOKEN=\n")
        print(f"Written: {env_path}  (set AGENT_DISCOVERY_TOKEN before starting)")
    else:
        print(f"Exists:  {env_path}  (not overwritten)")

    print("")
    print("Next steps:")
    print("  1. Edit ~/.config/agent-discovery/env and set AGENT_DISCOVERY_TOKEN")
    print("  2. systemctl --user daemon-reload")
    print("  3. systemctl --user enable --now agent-discovery")
    return 0


def main() -> None:
    parser = argparse.ArgumentParser(
        prog="agent-discovery",
        description="agent-discovery: local agent registry daemon + CLI",
    )
    subparsers = parser.add_subparsers(dest="subcommand")

    p_serve = subparsers.add_parser("serve", help="Start the HTTP daemon")
    p_serve.add_argument("--bind", default="", help="Bind address (default 127.0.0.1)")
    p_serve.add_argument("--port", type=int, default=0, help="Port (default 9301)")
    p_serve.add_argument("--token", default="", help="Override AGENT_DISCOVERY_TOKEN")

    p_reg = subparsers.add_parser("register", help="Register this claude process with the daemon")
    p_reg.add_argument("--name", default="", help="Label for this agent")
    p_reg.add_argument("--url", default="", help="Daemon base URL (default http://127.0.0.1:9301)")
    p_reg.add_argument("--port", type=int, default=DEFAULT_PORT, help="Daemon port")

    p_unreg = subparsers.add_parser("unregister", help="Unregister this agent from the daemon")
    p_unreg.add_argument("--id", default="", help="Stable agent UUID")
    p_unreg.add_argument("--name", default="", help="Agent label")
    p_unreg.add_argument("--url", default="", help="Daemon base URL")
    p_unreg.add_argument("--port", type=int, default=DEFAULT_PORT, help="Daemon port")

    subparsers.add_parser("install-service", help="Write systemd user unit")

    args = parser.parse_args()

    if args.subcommand == "serve":
        sys.exit(cmd_serve(args))
    elif args.subcommand == "register":
        sys.exit(cmd_register(args))
    elif args.subcommand == "unregister":
        sys.exit(cmd_unregister(args))
    elif args.subcommand == "install-service":
        sys.exit(cmd_install_service(args))
    else:
        parser.print_help()
        sys.exit(0)


def _claudeui_register() -> None:
    """console_script: claudeui-register [--name LABEL] [--url URL]"""
    parser = argparse.ArgumentParser(prog="claudeui-register")
    parser.add_argument("--name", default="", help="Label for this agent")
    parser.add_argument("--url", default="", help="Daemon base URL")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT, help="Daemon port")
    args = parser.parse_args()
    sys.exit(cmd_register(args))


def _claudeui_unregister() -> None:
    """console_script: claudeui-unregister [--id ID] [--name LABEL] [--url URL]"""
    parser = argparse.ArgumentParser(prog="claudeui-unregister")
    parser.add_argument("--id", default="", help="Stable agent UUID")
    parser.add_argument("--name", default="", help="Agent label")
    parser.add_argument("--url", default="", help="Daemon base URL")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT, help="Daemon port")
    args = parser.parse_args()
    sys.exit(cmd_unregister(args))


if __name__ == "__main__":
    main()
