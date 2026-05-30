"""
Control-plane helpers: TCP liveness probe + controllability assessment.
"""

import os
import socket

from . import proc


def tcp_listening(port: int, host: str = "127.0.0.1") -> bool:
    """Return True if something is accepting TCP connections on host:port."""
    if port <= 0:
        return False
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        s.settimeout(0.1)
        s.connect((host, port))
        s.close()
        return True
    except OSError:
        return False


def assess_controllable(claude_pid) -> tuple[bool, str, int]:
    """Determine if this claude process has a live control endpoint.

    Returns (controllable, bind_host, port).

    Resolution:
      1. Read /proc/<pid>/environ for CONTROL_PORT + CONTROL_BIND.
      2. Probe CONTROL_BIND:CONTROL_PORT via TCP connect (0.1s timeout).
         controllable = True ONLY if the port is actually accepting connections.

    No static port map — this is a general implementation.
    """
    if not claude_pid:
        return (False, "", 0)

    env = proc.read_environ(claude_pid)
    bind_host = env.get("CONTROL_BIND", "127.0.0.1").strip() or "127.0.0.1"
    port_str = env.get("CONTROL_PORT", "").strip()
    port = 0
    if port_str.isdigit():
        port = int(port_str)

    if not port:
        return (False, "", 0)

    if tcp_listening(port, bind_host):
        return (True, bind_host, port)

    return (False, "", 0)


def load_control_env(path: str) -> None:
    """Load a shell key=value env file into os.environ (only unset keys).

    Used to populate CONTROL_TOKEN from a file pointed to by
    AGENT_DISCOVERY_CONTROL_ENV without baking any hardcoded paths.
    """
    if not path:
        return
    try:
        with open(path) as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                k, v = line.split("=", 1)
                k = k.strip()
                v = v.strip().strip('"').strip("'")
                if k and k not in os.environ:
                    os.environ[k] = v
    except OSError:
        pass
