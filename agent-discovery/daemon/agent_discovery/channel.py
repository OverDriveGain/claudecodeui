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

# session_id -> pending interactive ask, e.g.
#   {"request_id": "...", "questions": [...], "ts": 169...}
# Set when the agent's channel plugin calls its `ask` tool (POST /channel/ask)
# and cleared when answered (POST /agents/<id>/answer) or superseded. Read by
# claudeui to render an answerable prompt. Only one outstanding ask per session
# (a second ask replaces the first — matches the plugin which blocks per-call).
_PENDING_ASKS: dict[str, dict] = {}


class Connection:
    """One live shim SSE stream, identified by Claude session id."""

    def __init__(self, session_id: str, label: str | None, cwd: str | None,
                 client_pid: int = 0):
        self.session_id = session_id
        self.label = label or ""
        self.cwd = cwd or ""
        # pid of the shim (channel-plugin server.mjs) that opened this SSE — a
        # direct child of the claude agent. Used to detect a zombie connection
        # (shim outlived its agent). 0 if it couldn't be resolved at connect.
        self.client_pid = int(client_pid or 0)
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


def register_connection(session_id: str, label: str | None, cwd: str | None,
                        client_pid: int = 0) -> Connection:
    """Park a new connection for a session. Replaces any prior one (a fresh
    shim for the same session wins; the old stream is closed)."""
    conn = Connection(session_id, label, cwd, client_pid=client_pid)
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
            # A dropped stream means the agent is gone/rotating — a question it
            # left pending can never be answered into it, so don't strand it.
            _PENDING_ASKS.pop(session_id, None)
    conn.close()


def get_connection(session_id: str) -> Connection | None:
    with _LOCK:
        return _BY_SESSION.get(session_id)


def has_connection(session_id: str) -> bool:
    with _LOCK:
        conn = _BY_SESSION.get(session_id)
        return conn is not None and not conn.closed


def agent_alive(session_id: str) -> bool:
    """True if a live claude agent is actually behind this session's shim.

    Verifies the shim (server.mjs) process — a direct child of the claude agent —
    still has a live claude parent. Detects a ZOMBIE connection: an orphaned shim
    that outlived its agent (claude crashed/killed; shim reparented to init) but
    still holds the SSE open, which would otherwise accept injects into the void.
    If the shim pid wasn't captured at connect (client_pid==0), returns True so we
    don't regress to false-negatives — worst case we miss a zombie, as before."""
    with _LOCK:
        conn = _BY_SESSION.get(session_id)
        if conn is None or conn.closed:
            return False
        client_pid = conn.client_pid
    if not client_pid:
        return True
    from . import proc  # lazy import to avoid an import cycle at startup
    return proc.agent_alive_via_shim(client_pid)


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


def deliver_raw(session_id: str, payload: dict) -> bool:
    """Push an arbitrary control payload (e.g. an interactive-ask answer) down
    the shim's SSE stream verbatim. The shim dispatches on payload["type"].
    Returns True if a live connection accepted it."""
    with _LOCK:
        conn = _BY_SESSION.get(session_id)
    if conn is None or conn.closed:
        return False
    return conn.push(payload)


# --------------------------------------------------------------------------
# Interactive ask state (agent -> operator question, answered from claudeui)
# --------------------------------------------------------------------------

def set_pending_ask(session_id: str, ask: dict) -> None:
    """Record an outstanding interactive ask for a session (replaces any prior)."""
    with _LOCK:
        _PENDING_ASKS[session_id] = ask


def get_pending_ask(session_id: str) -> dict | None:
    with _LOCK:
        return _PENDING_ASKS.get(session_id)


def clear_pending_ask(session_id: str, request_id: str | None = None) -> None:
    """Clear the pending ask. If request_id is given, only clear when it matches
    (avoids a late answer wiping a newer question)."""
    with _LOCK:
        cur = _PENDING_ASKS.get(session_id)
        if cur is None:
            return
        if request_id is None or cur.get("request_id") == request_id:
            _PENDING_ASKS.pop(session_id, None)


def sse_bytes(payload: dict) -> bytes:
    return ("data: " + json.dumps(payload, default=str) + "\n\n").encode("utf-8")
