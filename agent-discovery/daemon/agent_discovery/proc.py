"""
/proc introspection helpers — pure Linux, no dependencies.

All functions are side-effect-free reads. They never raise; they return
empty/zero values on permission errors or vanished processes.
"""

import os
import time

CLK_TCK = os.sysconf("SC_CLK_TCK")


def read_file(path: str, max_bytes: int = 65536) -> bytes:
    try:
        with open(path, "rb") as f:
            return f.read(max_bytes)
    except OSError:
        return b""


def read_cmdline(pid) -> list[str]:
    raw = read_file(f"/proc/{pid}/cmdline")
    if not raw:
        return []
    parts = raw.split(b"\x00")
    if parts and parts[-1] == b"":
        parts.pop()
    return [p.decode("utf-8", errors="replace") for p in parts]


def read_status(pid) -> dict[str, str]:
    raw = read_file(f"/proc/{pid}/status").decode("utf-8", errors="replace")
    out: dict[str, str] = {}
    for line in raw.splitlines():
        if ":" in line:
            k, v = line.split(":", 1)
            out[k.strip()] = v.strip()
    return out


def read_environ(pid) -> dict[str, str]:
    """Read /proc/<pid>/environ (NUL-separated KEY=VALUE). Returns {} on error."""
    raw = read_file(f"/proc/{pid}/environ")
    if not raw:
        return {}
    env: dict[str, str] = {}
    for part in raw.split(b"\x00"):
        if b"=" not in part:
            continue
        k, v = part.split(b"=", 1)
        try:
            env[k.decode("utf-8", errors="replace")] = v.decode("utf-8", errors="replace")
        except Exception:
            pass
    return env


def rss_bytes(pid) -> int:
    s = read_status(pid)
    v = s.get("VmRSS", "")
    if not v:
        return 0
    parts = v.split()
    if len(parts) >= 1 and parts[0].isdigit():
        return int(parts[0]) * 1024
    return 0


def process_uptime(pid) -> float:
    try:
        with open("/proc/uptime") as f:
            system_up = float(f.read().split()[0])
        with open(f"/proc/{pid}/stat") as f:
            stat = f.read()
        after_comm = stat[stat.rfind(")") + 2:].split()
        starttime_ticks = int(after_comm[19])
        return max(0.0, system_up - starttime_ticks / CLK_TCK)
    except Exception:
        return 0.0


def list_pids() -> list[str]:
    try:
        return [e for e in os.listdir("/proc") if e.isdigit()]
    except OSError:
        return []


def ppid(pid) -> int:
    s = read_status(pid)
    try:
        return int(s.get("PPid", "0"))
    except ValueError:
        return 0


def children_of(pid) -> list[str]:
    p = str(pid)
    out = []
    for q in list_pids():
        if ppid(q) == int(p):
            out.append(q)
    return out


def cwd_of(pid) -> str:
    try:
        return os.readlink(f"/proc/{pid}/cwd")
    except OSError:
        return ""


def is_claude_pid(pid) -> bool:
    """Return True if pid is alive and its argv[0] is the claude binary."""
    argv = read_cmdline(str(pid))
    if not argv:
        return False
    prog = os.path.basename(argv[0])
    return prog == "claude" or argv[0].endswith("/claude")


def find_claude_ancestor() -> int | None:
    """Walk /proc/self ppid chain upward to find the nearest claude ancestor.

    When a running claude invokes this script via its Bash tool, the process
    tree is: claude -> shell -> python3 -m agent_discovery register
    Returns the pid (int) or None if not found.
    """
    visited: set[int] = set()
    current = os.getpid()
    for _ in range(20):
        parent = ppid(str(current))
        if parent <= 1 or parent in visited:
            break
        visited.add(parent)
        argv = read_cmdline(str(parent))
        if argv:
            prog = os.path.basename(argv[0])
            if prog == "claude" or argv[0].endswith("/claude"):
                return parent
        current = parent
    return None


def dtach_socket_of_ancestor(pid) -> str | None:
    """Walk ancestors of pid upward; return the dtach socket path if found."""
    visited: set[int] = set()
    current = int(pid)
    for _ in range(10):
        if current <= 1 or current in visited:
            break
        visited.add(current)
        argv = read_cmdline(str(current))
        if argv and ("dtach" in os.path.basename(argv[0]) or any("dtach" in a for a in argv[:3])):
            for arg in argv:
                if arg.endswith(".sock") or arg.endswith(".socket"):
                    return arg
        current = ppid(str(current))
    return None
