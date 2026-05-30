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
    """Compute current liveness state for a record. No lock needed (read-only)."""
    pid = record.get("pid", 0)
    if not pid or not proc.is_claude_pid(pid):
        return "DISCONNECTED"
    controllable, _, _ = assess_controllable(pid)
    if controllable:
        return "CONTROLLABLE"
    return "ONLINE"


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
