"""
Reverse-connect channel hub for agent-discovery.

Each agent loads a tiny stdio channel shim at launch (plugin:channel@agentchan)
that dials OUT to this daemon:

    GET /channel/connect?session=<sid>&label=<label>&cwd=<cwd>

The daemon holds that HTTP response open as a Server-Sent-Events stream and
parks it here, keyed by the agent's Claude session id. When claudeui (or any
client) POSTs a prompt for that agent, the daemon writes one SSE `data:` event
to the parked stream; the shim relays it into the live session as a
notifications/claude/channel message. No per-agent inbound port; no cloud.

This module is stdlib-only and thread-safe. Each held-open SSE handler runs in
its own thread (the daemon uses ThreadingHTTPServer), so the hub just needs to
hand connections their queued events and signal close.
"""

import json
import queue
import threading
import time

_LOCK = threading.RLock()

# session_id -> Connection
_BY_SESSION: dict[str, "Connection"] = {}


class Connection:
    """One live shim SSE stream, identified by Claude session id."""

    def __init__(self, session_id: str, label: str | None, cwd: str | None):
        self.session_id = session_id
        self.label = label or ""
        self.cwd = cwd or ""
        self.connected_at = time.time()
        # Bounded queue of already-serialized SSE payload dicts to deliver.
        self.q: "queue.Queue[dict | None]" = queue.Queue(maxsize=256)
        self.closed = False

    def push(self, payload: dict) -> bool:
        """Enqueue a payload for delivery. Returns False if the queue is full
        or the connection is closed."""
        if self.closed:
            return False
        try:
            self.q.put_nowait(payload)
            return True
        except queue.Full:
            return False

    def close(self) -> None:
        self.closed = True
        try:
            self.q.put_nowait(None)  # sentinel to wake the writer
        except queue.Full:
            pass


def register_connection(session_id: str, label: str | None, cwd: str | None) -> Connection:
    """Park a new connection for a session. Replaces any prior one (a fresh
    shim for the same session wins; the old stream is closed)."""
    conn = Connection(session_id, label, cwd)
    with _LOCK:
        old = _BY_SESSION.get(session_id)
        if old is not None:
            old.close()
        _BY_SESSION[session_id] = conn
    return conn


def drop_connection(session_id: str, conn: Connection) -> None:
    """Remove a connection (on disconnect) only if it is still the current one."""
    with _LOCK:
        if _BY_SESSION.get(session_id) is conn:
            del _BY_SESSION[session_id]
    conn.close()


def get_connection(session_id: str) -> Connection | None:
    with _LOCK:
        return _BY_SESSION.get(session_id)


def has_connection(session_id: str) -> bool:
    with _LOCK:
        conn = _BY_SESSION.get(session_id)
        return conn is not None and not conn.closed


def connected_sessions() -> list[str]:
    with _LOCK:
        return [sid for sid, c in _BY_SESSION.items() if not c.closed]


def deliver(session_id: str, content: str, meta: dict | None = None) -> bool:
    """Push a prompt to the shim for this session. Returns True if a live
    connection accepted it."""
    with _LOCK:
        conn = _BY_SESSION.get(session_id)
    if conn is None or conn.closed:
        return False
    return conn.push({"content": content, "meta": meta or {}})


def sse_bytes(payload: dict) -> bytes:
    return ("data: " + json.dumps(payload, default=str) + "\n\n").encode("utf-8")
