"""
Persistent agent registry.

Registry is keyed by agent UUID (stable across respawns). Each record:
  {id, label, cwd, pid, control_port, control_bind, dtach_socket,
   registered_at, last_seen, state}

Persistence: atomic write to a JSON file under ~/.local/share/agent-discovery/.
State (ONLINE/CONTROLLABLE/DISCONNECTED) is computed on read, not stored.

Dead records are NEVER auto-deleted (D7). They remain DISCONNECTED.
Pruning is explicit: unregister endpoint or direct call to remove().
"""

import json
import os
import time
import threading
import uuid

from . import proc
from .control import assess_controllable

_lock = threading.Lock()
_registry: dict[str, dict] = {}

DEFAULT_REGISTRY_PATH = os.path.join(
    os.path.expanduser("~"),
    ".local", "share", "agent-discovery", "registry.json",
)

REGISTRY_PATH = os.environ.get("REGISTRY_PATH", DEFAULT_REGISTRY_PATH)


def _ensure_dir(path: str) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)


def _load_raw() -> dict:
    try:
        with open(REGISTRY_PATH) as f:
            data = json.load(f)
        if isinstance(data, dict):
            return data
    except (OSError, json.JSONDecodeError):
        pass
    return {}


def _save_raw(reg: dict) -> None:
    _ensure_dir(REGISTRY_PATH)
    tmp = REGISTRY_PATH + ".tmp"
    try:
        with open(tmp, "w") as f:
            json.dump(reg, f, indent=2)
        os.replace(tmp, REGISTRY_PATH)
    except OSError:
        pass


def load_from_disk() -> None:
    """Load registry from disk on daemon start. Thread-safe."""
    with _lock:
        data = _load_raw()
        _registry.clear()
        _registry.update(data)


def _compute_state(record: dict) -> str:
    """Compute current liveness state for a record. No lock needed (read-only).

    A record with a live reverse-connect channel shim (keyed by session_id) is
    ONLINE even when no pid is resolved — the shim IS the live write path. If a
    pid is also live and exposes a control port, CONTROLLABLE wins.
    """
    pid = record.get("pid", 0)
    sid = record.get("session_id", "")
    # Lazy import to avoid an import cycle at daemon startup
    # (daemon -> registry -> channel would bind a partially-initialized module).
    from . import channel
    channel_live = bool(sid) and channel.has_connection(sid)

    if pid and proc.is_claude_pid(pid):
        controllable, _, _ = assess_controllable(pid)
        if controllable:
            return "CONTROLLABLE"
        return "ONLINE"

    if channel_live:
        return "ONLINE"
    return "DISCONNECTED"


def snapshot() -> list[dict]:
    """Return all records with freshly computed state. Thread-safe."""
    with _lock:
        records = list(_registry.values())
    out = []
    for r in records:
        rec = dict(r)
        rec["state"] = _compute_state(r)
        out.append(rec)
    return out


def get_record(agent_id: str) -> dict | None:
    """Return a single record with fresh state, or None if not found."""
    with _lock:
        r = _registry.get(agent_id)
        if r is None:
            return None
        rec = dict(r)
    rec["state"] = _compute_state(rec)
    return rec


def register(
    pid: int,
    label: str | None = None,
    agent_id: str | None = None,
    cwd: str | None = None,
    control_port: int | None = None,
    control_bind: str | None = None,
    dtach_socket: str | None = None,
) -> dict:
    """Register or reconnect an agent. Returns the final record with state.

    If agent_id is given and exists → update (reconnect). pid, last_seen, cwd,
    control_port, control_bind are refreshed.

    If no match by id → create new record with generated UUID.

    Label collision (different ID, same label) → append (2), (3), ... suffix.
    """
    now = int(time.time())

    if cwd is None:
        cwd = proc.cwd_of(pid)

    if control_port is None:
        env = proc.read_environ(pid)
        port_str = env.get("CONTROL_PORT", "").strip()
        if port_str.isdigit():
            control_port = int(port_str)
        if control_bind is None:
            control_bind = env.get("CONTROL_BIND", "127.0.0.1").strip() or "127.0.0.1"

    if control_bind is None:
        control_bind = "127.0.0.1"

    if dtach_socket is None:
        dtach_socket = proc.dtach_socket_of_ancestor(pid) or ""

    with _lock:
        if agent_id and agent_id in _registry:
            rec = dict(_registry[agent_id])
            rec["pid"] = pid
            rec["last_seen"] = now
            rec["cwd"] = cwd or rec.get("cwd", "")
            if control_port:
                rec["control_port"] = control_port
            if control_bind:
                rec["control_bind"] = control_bind
            if dtach_socket:
                rec["dtach_socket"] = dtach_socket
            if label and label != rec.get("label"):
                rec["label"] = label
            _registry[agent_id] = rec
            _save_raw(dict(_registry))
            result = dict(rec)
        else:
            effective_label = label or "unnamed"
            existing_labels = {v["label"] for v in _registry.values()}
            if effective_label in existing_labels:
                suffix = 2
                candidate = f"{effective_label} ({suffix})"
                while candidate in existing_labels:
                    suffix += 1
                    candidate = f"{effective_label} ({suffix})"
                effective_label = candidate

            new_id = agent_id or str(uuid.uuid4())
            rec = {
                "id": new_id,
                "label": effective_label,
                "cwd": cwd or "",
                "pid": pid,
                "control_port": control_port or 0,
                "control_bind": control_bind,
                "dtach_socket": dtach_socket,
                "registered_at": now,
                "last_seen": now,
            }
            _registry[new_id] = rec
            _save_raw(dict(_registry))
            result = dict(rec)

    result["state"] = _compute_state(result)
    return result


def register_channel_session(
    session_id: str,
    label: str | None = None,
    cwd: str | None = None,
) -> dict:
    """Register/refresh an agent identified by its Claude session id, WITHOUT a
    resolved pid. Used by the reverse-connect channel shim's /channel/connect:
    the shim knows its session id but the daemon may not yet be able to map it to
    a live claude pid. The record is matched by stored session_id (so a reconnect
    updates the same record). pid stays 0 until a pid-bearing register() arrives;
    liveness/state is then driven by the live channel connection (see
    _compute_state in this module + channel.has_connection in daemon.py).
    """
    now = int(time.time())
    with _lock:
        # match an existing record by session_id, else by cwd, else create.
        match_id = None
        for k, v in _registry.items():
            if v.get("session_id") and v["session_id"] == session_id:
                match_id = k
                break
        if match_id is None and cwd:
            for k, v in _registry.items():
                if v.get("cwd") and v["cwd"] == cwd:
                    match_id = k
                    break

        if match_id is not None:
            rec = dict(_registry[match_id])
            rec["session_id"] = session_id
            rec["last_seen"] = now
            if cwd:
                rec["cwd"] = cwd
            if label and label != rec.get("label"):
                rec["label"] = label
            _registry[match_id] = rec
            _save_raw(dict(_registry))
            result = dict(rec)
        else:
            effective_label = label or "unnamed"
            existing_labels = {v["label"] for v in _registry.values()}
            if effective_label in existing_labels:
                suffix = 2
                candidate = f"{effective_label} ({suffix})"
                while candidate in existing_labels:
                    suffix += 1
                    candidate = f"{effective_label} ({suffix})"
                effective_label = candidate
            new_id = str(uuid.uuid4())
            rec = {
                "id": new_id,
                "label": effective_label,
                "cwd": cwd or "",
                "pid": 0,
                "session_id": session_id,
                "control_port": 0,
                "control_bind": "127.0.0.1",
                "dtach_socket": "",
                "registered_at": now,
                "last_seen": now,
            }
            _registry[new_id] = rec
            _save_raw(dict(_registry))
            result = dict(rec)

    result["state"] = _compute_state(result)
    return result


def remove(agent_id: str | None = None, label: str | None = None, pid: int | None = None) -> bool:
    """Remove a record by id, label, or pid. Returns True if removed."""
    with _lock:
        if agent_id and agent_id in _registry:
            del _registry[agent_id]
            _save_raw(dict(_registry))
            return True
        if label:
            for k, v in list(_registry.items()):
                if v.get("label") == label:
                    del _registry[k]
                    _save_raw(dict(_registry))
                    return True
        if pid:
            for k, v in list(_registry.items()):
                if v.get("pid") == pid:
                    del _registry[k]
                    _save_raw(dict(_registry))
                    return True
    return False
