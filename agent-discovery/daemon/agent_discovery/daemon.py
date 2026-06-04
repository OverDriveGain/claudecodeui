"""
agent-discovery HTTP daemon.

Single-process, stdlib-only. Serves the registration API and agent metadata.
"""

import base64
import hmac
import json
import mimetypes
import os
import re
import shutil
import subprocess
import sys
import time
import threading
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlsplit

from . import registry as reg
from . import proc
from . import channel
from .control import assess_controllable, load_control_env
from .sessions import newest_jsonl_path, session_id_from_path
from .files import resolve_safe_path, file_listing, read_file_content

VERSION = "0.1.0"

CLAUDE_BIN = os.environ.get("CLAUDE_BIN") or shutil.which("claude") or "claude"
RESUME_TIMEOUT = float(os.environ.get("AGENT_DISCOVERY_RESUME_TIMEOUT", "120"))

BIND = os.environ.get("BIND", "127.0.0.1")
PORT = int(os.environ.get("PORT", "9301"))
SCAN_INTERVAL = float(os.environ.get("SCAN_INTERVAL_SECONDS", "10.0"))

# Stale-record reaping: a DISCONNECTED agent (dead pid AND no live channel shim)
# is removed from the registry once it's been gone longer than REAP_TTL. Without
# this, every agent ever launched accumulates as a dead record forever. A
# reconnect refreshes last_seen so a restarting agent is never reaped.
# REAP_TTL <= 0 disables reaping.
REAP_TTL = float(os.environ.get("AGENT_DISCOVERY_REAP_TTL_SECONDS", "1800"))
REAP_INTERVAL = float(os.environ.get("AGENT_DISCOVERY_REAP_INTERVAL_SECONDS", "300"))

AUTH_TOKEN = os.environ.get("AGENT_DISCOVERY_TOKEN", "").strip()

PEERS: list[str] = [
    p.strip().rstrip("/")
    for p in os.environ.get("AGENT_DISCOVERY_PEERS", "").split(",")
    if p.strip()
]
PEER_TIMEOUT = float(os.environ.get("AGENT_DISCOVERY_PEER_TIMEOUT", "2.5"))

# Optional allowlist of agent `domain` tags this daemon will surface FROM PEERS.
# CSV, e.g. "wael" or "wael,acme". Empty/unset -> no filter (include all peer
# agents; current backward-compatible behavior). LOCAL agents are NEVER filtered
# by this — it only gates peer-fetched agents so a multi-tenant fan-out can show a
# specific tenant's remote agents without pulling in the whole peer fleet.
PEER_DOMAINS: set[str] = {
    d.strip()
    for d in os.environ.get("AGENT_DISCOVERY_PEER_DOMAINS", "").split(",")
    if d.strip()
}


def _peer_agent_allowed(agent: dict) -> bool:
    """True if a peer-fetched agent passes the domain allowlist. Fail-safe: a
    missing/blank/malformed domain == "no domain" -> excluded when an allowlist is
    set. No allowlist -> everything passes."""
    if not PEER_DOMAINS:
        return True
    dom = agent.get("domain")
    if not isinstance(dom, str):
        return False
    return dom.strip() in PEER_DOMAINS


_peer_agent_cache: dict[str, str] = {}
_peer_cache_lock = threading.Lock()

IMAGE_MAX_COUNT = 5
IMAGE_MAX_BYTES_EACH = 5 * 1024 * 1024
IMAGE_MAX_TOTAL_BYTES = 20 * 1024 * 1024
PROMPT_MAX_CONTENT_LENGTH = IMAGE_MAX_TOTAL_BYTES + 512 * 1024
ALLOWED_MIME_TYPES = {"image/png", "image/jpeg", "image/gif", "image/webp"}

# Subdir (under the agent's cwd) where channel-delivered attachments are written.
ATTACHMENT_DIRNAME = ".ccui-attachments"
_MIME_EXT = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/gif": ".gif",
    "image/webp": ".webp",
}


def _materialize_images(images: list, cwd: str) -> dict:
    """Write decoded image bytes into <cwd>/.ccui-attachments/ and return a meta
    dict referencing them by PATH — mirroring how claude's own channels (e.g. the
    official telegram plugin) deliver media: the binary lives on disk and the
    notification carries `image_path` / `attachment_*` in meta, not the bytes.

    Returns {} on failure (caller falls back to text-only delivery).
    """
    if not images or not cwd:
        return {}
    try:
        adir = os.path.join(cwd, ATTACHMENT_DIRNAME)
        os.makedirs(adir, exist_ok=True)
        paths = []
        for idx, img in enumerate(images):
            decoded = img.get("decoded")
            if not decoded:
                continue
            base = os.path.basename(img.get("name") or f"image{idx}") or f"image{idx}"
            ext = _MIME_EXT.get(img.get("mimeType", ""), "")
            if ext and not base.lower().endswith(ext):
                base = base + ext
            # Prefix with the unix time + index so repeated sends don't clobber.
            fname = f"{int(time.time())}-{idx}-{base}"
            fpath = os.path.join(adir, fname)
            with open(fpath, "wb") as f:
                f.write(decoded)
            paths.append({"path": fpath, "mime": img.get("mimeType", ""), "name": base})
        if not paths:
            return {}
        meta = {
            # Primary image (claude reads `image_path` like the telegram channel).
            "image_path": paths[0]["path"],
            "attachment_kind": "image",
            "attachment_mime": paths[0]["mime"],
            "attachment_name": paths[0]["name"],
            "attachment_count": str(len(paths)),
        }
        # Extra images get numbered keys so the agent can find them too.
        for i, p in enumerate(paths[1:], start=1):
            meta[f"image_path_{i}"] = p["path"]
        return meta
    except Exception as e:
        sys.stderr.write(f"[agent-discovery] _materialize_images failed: {e}\n")
        sys.stderr.flush()
        return {}


def _update_peer_cache(peer_url: str, agents: list) -> None:
    with _peer_cache_lock:
        for a in agents:
            aid = a.get("id")
            if aid:
                _peer_agent_cache[aid] = peer_url


def _peer_for_agent(agent_id: str) -> str | None:
    with _peer_cache_lock:
        return _peer_agent_cache.get(agent_id)


def _proxy_to_peer(
    peer_base: str,
    subpath: str,
    qs_raw: str,
    method: str = "GET",
    body_bytes: bytes | None = None,
    extra_headers: dict | None = None,
) -> tuple[int, dict, bytes]:
    url = f"{peer_base}{subpath}"
    if qs_raw:
        url = f"{url}?{qs_raw}"
    req = urllib.request.Request(url, method=method)
    if AUTH_TOKEN:
        req.add_header("Authorization", f"Bearer {AUTH_TOKEN}")
    if extra_headers:
        for k, v in extra_headers.items():
            req.add_header(k, v)
    if body_bytes is not None:
        req.data = body_bytes
        req.add_header("Content-Length", str(len(body_bytes)))
    try:
        with urllib.request.urlopen(req, timeout=PEER_TIMEOUT + 120) as resp:
            return resp.status, dict(resp.headers), resp.read()
    except urllib.error.HTTPError as e:
        body = b""
        try:
            body = e.read()
        except Exception:
            pass
        return e.code, {}, body


def _fetch_peer_agents(peer_url: str) -> tuple[list, str | None]:
    url = f"{peer_url}/agents?local=true"
    req = urllib.request.Request(url, method="GET")
    if AUTH_TOKEN:
        req.add_header("Authorization", f"Bearer {AUTH_TOKEN}")
    try:
        with urllib.request.urlopen(req, timeout=PEER_TIMEOUT) as resp:
            body = resp.read().decode("utf-8", errors="replace")
        agents = json.loads(body)
        if not isinstance(agents, list):
            return [], f"unexpected response type from {peer_url}"
        return agents, None
    except urllib.error.HTTPError as e:
        err_body = ""
        try:
            err_body = e.read(512).decode("utf-8", errors="replace")
        except Exception:
            pass
        return [], f"HTTP {e.code} from {peer_url}: {err_body[:200]}"
    except Exception as e:
        return [], f"{peer_url}: {e}"


def _record_to_api(record: dict) -> dict:
    """Convert a registry record (with state) to the /agents API shape."""
    pid = record.get("pid", 0)
    state = record.get("state", "DISCONNECTED")
    alive = state in ("ONLINE", "CONTROLLABLE")
    controllable = state == "CONTROLLABLE"

    stored_sid = record.get("session_id", "")

    # If this is a channel-shim record without a resolved pid, try to (re)resolve
    # the live claude pid from the stored session id so cwd/uptime/rss work.
    if not pid and stored_sid:
        resolved = proc.find_claude_by_session(stored_sid)
        if resolved:
            pid = resolved

    cwd = record.get("cwd", "")
    if pid and proc.is_claude_pid(pid):
        live_cwd = proc.cwd_of(pid)
        if live_cwd:
            cwd = live_cwd
        alive = True

    cwd_newest_path, cwd_newest_mtime = newest_jsonl_path(cwd) if cwd else ("", 0.0)
    # The stored sid is the launch-time session and stays the CHANNEL routing key.
    # The live TRANSCRIPT is resolved independently: a /clear or respawn starts a
    # NEWER jsonl in the same cwd while the channel stays keyed on the stored sid,
    # so binding the transcript to the stored sid would strand the GUI on the old
    # (pre-clear) file. We therefore report the stored sid but follow the live file.
    session_id = stored_sid or session_id_from_path(cwd_newest_path)

    # Locate the stored-sid transcript directly (it may not be the cwd's newest).
    stored_path, stored_mtime = "", 0.0
    if stored_sid:
        import glob as _glob
        import os as _os
        for _p in _glob.glob(
            _os.path.expanduser(f"~/.claude/projects/*/{stored_sid}.jsonl")
        ):
            stored_path = _p
            try:
                stored_mtime = _os.path.getmtime(_p)
            except OSError:
                stored_mtime = 0.0
            break

    # Pin to the stored-sid transcript by default; but if the agent is ALIVE and its
    # cwd holds a strictly newer transcript, the session has moved on (post-/clear) —
    # follow that, so the history load and the follow stream agree on the current
    # session. Falls back to the cwd newest when the stored-sid file is gone.
    if stored_path and not (alive and cwd_newest_path and cwd_newest_mtime > stored_mtime):
        jsonl_path, jsonl_mtime = stored_path, stored_mtime
    else:
        jsonl_path, jsonl_mtime = cwd_newest_path, cwd_newest_mtime

    # Key off the EFFECTIVE session id we report (stored, else derived) — not just
    # the stored one. A record created by a pid-bearing register() may carry the
    # live channel under its derived session even with no stored session id.
    # Gate on state so a zombie shim (parked SSE, no live agent behind it) reports
    # channel_connected=False — the GUI's send-bridge then blocks the send with a
    # clear "relaunch it" instead of injecting into the void. state is already
    # zombie-aware (registry._compute_state requires a live backing claude).
    channel_connected = (
        bool(session_id)
        and channel.has_connection(session_id)
        and state in ("ONLINE", "CONTROLLABLE")
    )

    uptime = proc.process_uptime(pid) if alive and pid else 0.0
    rss = proc.rss_bytes(pid) if alive and pid else 0

    ctrl_port = record.get("control_port") or 0
    ctrl_bind = record.get("control_bind") or "127.0.0.1"
    if alive and pid and not ctrl_port:
        _, ctrl_bind, ctrl_port = assess_controllable(pid)

    control_url = None
    if controllable:
        control_url = f"http://{BIND}:{PORT}/agents/{record['id']}/prompt"

    return {
        "id":             record["id"],
        "label":          record.get("label", "unnamed"),
        "domain":         record.get("domain", ""),
        "state":          state,
        "alive":          alive,
        "controllable":   controllable,
        "pid":            pid if alive else 0,
        "cwd":            cwd,
        "session_id":     session_id,
        "transcript":     jsonl_path,
        "last_activity":  int(jsonl_mtime),
        "last_seen":      record.get("last_seen", 0),
        "registered_at":  record.get("registered_at", 0),
        "uptime_seconds": uptime,
        "rss_bytes":      rss,
        "control_url":    control_url,
        "channel_connected": channel_connected,
        "dtach_socket":   record.get("dtach_socket", ""),
    }


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        pass

    def _send(self, status: int, body, content_type: str = "text/plain; charset=utf-8"):
        data = body.encode("utf-8") if isinstance(body, str) else body
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _json(self, status: int, payload):
        self._send(status, json.dumps(payload, default=str), "application/json")

    def _require_auth(self) -> bool:
        # Tokenless mode: when no AGENT_DISCOVERY_TOKEN is configured the daemon
        # runs open. This is the intended setup for a loopback (127.0.0.1),
        # single-user host — the clients already omit the Bearer header and
        # default the URL to localhost. Set a token only if the daemon is ever
        # bound beyond loopback.
        if not AUTH_TOKEN:
            return True
        auth = self.headers.get("Authorization", "")
        presented = auth[len("Bearer "):].strip() if auth.startswith("Bearer ") else ""
        if not presented or not hmac.compare_digest(presented, AUTH_TOKEN):
            self._json(401, {"error": "unauthorized"})
            return False
        return True

    def _serve_file_range(self, abs_path: str):
        """Stream a local file with HTTP Range support (206 partial content)."""
        try:
            file_size = os.stat(abs_path).st_size
        except OSError as e:
            self._json(500, {"error": f"stat failed: {e}"})
            return
        mime, _ = mimetypes.guess_type(abs_path)
        if not mime:
            mime = "application/octet-stream"

        start, end, is_range = 0, file_size - 1, False
        range_header = self.headers.get("Range", "")
        if range_header:
            m = re.match(r"^bytes=(\d*)-(\d*)$", range_header.strip())
            if not m:
                self.send_response(416)
                self.send_header("Content-Range", f"bytes */{file_size}")
                self.end_headers()
                return
            g1, g2 = m.group(1), m.group(2)
            if g1 == "":  # suffix range: last N bytes
                start = max(0, file_size - (int(g2) if g2 else 0))
                end = file_size - 1
            else:
                start = int(g1)
                end = int(g2) if g2 else file_size - 1
                if end >= file_size:
                    end = file_size - 1
            if start > end or start >= file_size:
                self.send_response(416)
                self.send_header("Content-Range", f"bytes */{file_size}")
                self.end_headers()
                return
            is_range = True

        length = end - start + 1
        self.send_response(206 if is_range else 200)
        self.send_header("Content-Type", mime)
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Length", str(length))
        if is_range:
            self.send_header("Content-Range", f"bytes {start}-{end}/{file_size}")
        self.end_headers()
        if self.command == "HEAD":
            return
        try:
            with open(abs_path, "rb") as fh:
                fh.seek(start)
                remaining = length
                while remaining > 0:
                    chunk = fh.read(min(65536, remaining))
                    if not chunk:
                        break
                    self.wfile.write(chunk)
                    remaining -= len(chunk)
        except (BrokenPipeError, ConnectionResetError):
            pass  # client closed (e.g. seeked away) — normal for media
        except OSError:
            pass

    def _proxy_raw_to_peer(self, peer_base: str, agent_id: str, qs_raw: str):
        """Stream-proxy a /raw (range) request to the peer that owns the agent,
        forwarding the Range header and streaming the body without buffering."""
        url = f"{peer_base}/agents/{agent_id}/raw"
        if qs_raw:
            url = f"{url}?{qs_raw}"
        req = urllib.request.Request(url, method="GET")
        if AUTH_TOKEN:
            req.add_header("Authorization", f"Bearer {AUTH_TOKEN}")
        rng = self.headers.get("Range")
        if rng:
            req.add_header("Range", rng)
        try:
            resp = urllib.request.urlopen(req, timeout=PEER_TIMEOUT + 120)
        except urllib.error.HTTPError as e:
            body = b""
            try:
                body = e.read()
            except Exception:
                pass
            self.send_response(e.code)
            self.send_header("Content-Type", (e.headers.get("Content-Type") if e.headers else None) or "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        except Exception as e:
            self._json(502, {"error": f"peer raw proxy failed: {e}"})
            return
        try:
            self.send_response(resp.status)
            for hk in ("Content-Type", "Content-Range", "Accept-Ranges", "Content-Length"):
                val = resp.headers.get(hk)
                if val:
                    self.send_header(hk, val)
            self.end_headers()
            while True:
                chunk = resp.read(65536)
                if not chunk:
                    break
                self.wfile.write(chunk)
        except (BrokenPipeError, ConnectionResetError):
            pass
        finally:
            resp.close()

    def _serve_transcript_follow(self, record: dict):
        """tail -f the agent's transcript jsonl and stream each newly appended
        line as an SSE `data:` event. Starts at the current end of file (the
        client already loaded history), so it emits only NEW output. Survives a
        session respawn (newest jsonl changes) by re-resolving and resetting."""
        cwd = record.get("cwd", "")
        api = _record_to_api(record)
        tpath = api.get("transcript", "")

        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "keep-alive")
        self.send_header("X-Accel-Buffering", "no")
        self.end_headers()

        try:
            offset = os.stat(tpath).st_size if tpath and os.path.exists(tpath) else 0
        except OSError:
            offset = 0
        buf = b""
        last_ping = time.time()
        try:
            while True:
                # Follow a session respawn: if a newer transcript appears, switch to it.
                if cwd:
                    new_tpath, _ = newest_jsonl_path(cwd)
                    if new_tpath and new_tpath != tpath:
                        tpath = new_tpath
                        offset = 0
                        buf = b""
                        self.wfile.write(
                            b"event: session\ndata: "
                            + json.dumps({"session_id": session_id_from_path(tpath)}).encode("utf-8")
                            + b"\n\n"
                        )
                        self.wfile.flush()
                try:
                    sz = os.stat(tpath).st_size if tpath else 0
                except OSError:
                    sz = 0
                if sz < offset:  # truncated/rotated — restart from top
                    offset = 0
                    buf = b""
                if sz > offset:
                    with open(tpath, "rb") as f:
                        f.seek(offset)
                        chunk = f.read(sz - offset)
                    offset = sz
                    buf += chunk
                    parts = buf.split(b"\n")
                    buf = parts.pop()  # keep trailing partial line
                    for line in parts:
                        line = line.strip()
                        if line:
                            self.wfile.write(b"data: " + line + b"\n\n")
                    self.wfile.flush()
                    last_ping = time.time()
                else:
                    time.sleep(0.3)
                    if time.time() - last_ping > 15:
                        self.wfile.write(b": ping\n\n")
                        self.wfile.flush()
                        last_ping = time.time()
        except (BrokenPipeError, ConnectionResetError, OSError):
            pass  # client closed the stream — normal

    def _proxy_sse_to_peer(self, peer_base: str, agent_id: str, qs_raw: str):
        """Stream-proxy the SSE transcript-follow to the owning peer, forwarding
        each line as it arrives (no buffering). Keepalive pings keep the urlopen
        read from idling out."""
        url = f"{peer_base}/agents/{agent_id}/transcript/follow"
        if qs_raw:
            url = f"{url}?{qs_raw}"
        req = urllib.request.Request(url, method="GET")
        if AUTH_TOKEN:
            req.add_header("Authorization", f"Bearer {AUTH_TOKEN}")
        try:
            resp = urllib.request.urlopen(req, timeout=60)
        except Exception as e:
            self._json(502, {"error": f"peer sse proxy failed: {e}"})
            return
        try:
            self.send_response(resp.status)
            self.send_header("Content-Type", "text/event-stream; charset=utf-8")
            self.send_header("Cache-Control", "no-cache")
            self.send_header("Connection", "keep-alive")
            self.send_header("X-Accel-Buffering", "no")
            self.end_headers()
            for raw in resp:  # iterates line-by-line, flushing as the peer emits
                self.wfile.write(raw)
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, OSError):
            pass
        finally:
            resp.close()

    def _handle_channel_connect(self, qs: dict):
        """Reverse-connect channel shim dials in here. We register the agent
        (connect == registration), then hold this response open as an SSE
        stream and relay any pushed prompts down it until the shim disconnects."""
        if not self._require_auth():
            return

        session_id = (qs.get("session") or [""])[0].strip()
        if not session_id:
            self._json(400, {"error": "missing required query param: session"})
            return
        label = (qs.get("label") or [""])[0].strip() or None
        cwd = (qs.get("cwd") or [""])[0].strip() or None
        domain = (qs.get("domain") or [""])[0].strip() or None

        # Resolve the shim (server.mjs) pid at the far end of this loopback
        # connection — it is a direct child of the claude agent, so it gives a
        # rotation-proof liveness signal (channel.agent_alive). Best-effort.
        shim_pid = 0
        try:
            shim_pid = proc.pid_owning_local_tcp_port(self.client_address[1])
        except Exception:
            shim_pid = 0

        # Park the SSE connection FIRST so has_connection(session) is true
        # immediately, independent of pid resolution.
        conn = channel.register_connection(session_id, label, cwd, client_pid=shim_pid)

        # Resolve the live claude pid from the session id (robust mapping via
        # /proc environ). The shim may dial in before claude has fully exported
        # its session env, so retry briefly. cwd from /proc wins over the
        # shim-reported one.
        pid = 0
        for _ in range(20):  # up to ~10s
            pid = proc.find_claude_by_session(session_id)
            if pid:
                break
            time.sleep(0.5)
        if pid:
            live_cwd = proc.cwd_of(pid)
            if live_cwd:
                cwd = live_cwd

        # connect == registration. Always upsert a registry record so the agent
        # appears in /agents and claudeui's POST /agents/<id>/prompt has an id to
        # target. register() requires a live claude pid (it validates); if we
        # could not resolve one yet, create a session-keyed record directly so
        # the agent is visible and the channel-shim deliver path works (the
        # prompt route checks channel.has_connection by session, not by pid).
        agent_id = None
        try:
            if pid and proc.is_claude_pid(pid):
                record = reg.register(
                    pid=pid, label=label, cwd=cwd, session_id=session_id, domain=domain
                )
                agent_id = record["id"]
            else:
                record = reg.register_channel_session(
                    session_id=session_id, label=label, cwd=cwd, domain=domain
                )
                agent_id = record["id"]
        except Exception:
            import traceback
            sys.stderr.write(
                "[agent-discovery] channel connect register FAILED:\n"
                + traceback.format_exc()
            )
            sys.stderr.flush()

        sys.stderr.write(
            f"[agent-discovery] /channel/connect session={session_id} "
            f"pid={pid} agent_id={agent_id} cwd={cwd}\n"
        )
        sys.stderr.flush()

        try:
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream; charset=utf-8")
            self.send_header("Cache-Control", "no-cache")
            self.send_header("Connection", "keep-alive")
            self.send_header("X-Accel-Buffering", "no")
            self.end_headers()
            self.wfile.write(channel.sse_bytes({
                "type": "hello",
                "session_id": session_id,
                "agent_id": agent_id,
            }))
            self.wfile.flush()
        except Exception:
            channel.drop_connection(session_id, conn)
            return

        # Block this handler thread, draining the connection's queue. A periodic
        # keepalive both holds the connection and detects a dead client (broken
        # pipe on write -> we exit and drop).
        try:
            while not conn.closed:
                try:
                    payload = conn.q.get(timeout=15.0)
                except Exception:
                    payload = None
                if payload is None:
                    if conn.closed:
                        break
                    # keepalive comment
                    self.wfile.write(b": ping\n\n")
                    self.wfile.flush()
                    continue
                self.wfile.write(channel.sse_bytes(payload))
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, OSError):
            pass
        finally:
            channel.drop_connection(session_id, conn)

    def do_GET(self):
        parsed = urlsplit(self.path)
        path = parsed.path
        qs = parse_qs(parsed.query)
        qs_raw = parsed.query

        try:
            if path in ("/health", "/"):
                self._json(200, {"ok": True, "version": VERSION})
                return

            if path == "/channel/connect":
                self._handle_channel_connect(qs)
                return

            if path == "/agents":
                if not self._require_auth():
                    return
                local_only = (qs.get("local") or [""])[0].lower() in ("1", "true", "yes")

                local_records = reg.snapshot()
                local_agents = [_record_to_api(r) for r in local_records]

                if local_only or not PEERS:
                    self._json(200, local_agents)
                    return

                peer_results: list[list] = [[] for _ in PEERS]
                peers_failed: list[str] = []
                lock = threading.Lock()

                def _fetch(idx, peer_url):
                    agents, err = _fetch_peer_agents(peer_url)
                    if not err:
                        # Drop non-allowlisted peer agents BEFORE both the merge and
                        # the peer cache, so /agents output and the transcript/prompt
                        # proxy target set stay consistent (a hidden agent must not be
                        # proxyable). Entries lacking an "id" (e.g. {_peers_failed})
                        # are kept so the caller still sees them.
                        agents = [
                            a for a in agents
                            if not a.get("id") or _peer_agent_allowed(a)
                        ]
                    with lock:
                        if err:
                            peers_failed.append(err)
                        else:
                            peer_results[idx] = agents
                            _update_peer_cache(peer_url, agents)

                threads = [
                    threading.Thread(target=_fetch, args=(i, p), daemon=True)
                    for i, p in enumerate(PEERS)
                ]
                for t in threads:
                    t.start()
                for t in threads:
                    t.join(timeout=PEER_TIMEOUT + 0.5)

                merged = list(local_agents)
                for pl in peer_results:
                    merged.extend(pl)
                if peers_failed:
                    merged.append({"_peers_failed": peers_failed})
                self._json(200, merged)
                return

            # Live transcript follow (tail -f over SSE) — pushes each new
            # transcript line the moment it's appended, so the UI shows agent
            # output continuously without polling or "turn done" cutoffs.
            if path.startswith("/agents/") and path.endswith("/transcript/follow"):
                if not self._require_auth():
                    return
                agent_id = path[len("/agents/"):-len("/transcript/follow")]
                record = reg.get_record(agent_id)
                if not record:
                    peer = _peer_for_agent(agent_id)
                    if peer:
                        self._proxy_sse_to_peer(peer, agent_id, qs_raw)
                        return
                    self._json(404, {"error": f"agent {agent_id!r} not found"})
                    return
                self._serve_transcript_follow(record)
                return

            if path.startswith("/agents/") and path.endswith("/transcript"):
                if not self._require_auth():
                    return
                agent_id = path[len("/agents/"):-len("/transcript")]
                record = reg.get_record(agent_id)
                if not record:
                    peer = _peer_for_agent(agent_id)
                    if peer:
                        try:
                            status, hdrs, data = _proxy_to_peer(peer, f"/agents/{agent_id}/transcript", qs_raw)
                        except Exception as e:
                            self._json(502, {"error": f"peer proxy failed: {e}"})
                            return
                        self.send_response(status)
                        for hk in ("content-type", "x-transcript-size", "x-transcript-mtime", "x-session-id"):
                            val = hdrs.get(hk) or hdrs.get(hk.title())
                            if val:
                                self.send_header(hk, val)
                        self.send_header("Content-Length", str(len(data)))
                        self.end_headers()
                        self.wfile.write(data)
                        return
                    self._json(404, {"error": f"agent {agent_id!r} not found"})
                    return

                api = _record_to_api(record)
                tpath = api.get("transcript", "")
                if not tpath:
                    self._json(404, {"error": f"no transcript found for agent {agent_id!r}"})
                    return
                try:
                    st = os.stat(tpath)
                except OSError as e:
                    self._json(500, {"error": f"transcript stat failed: {e}"})
                    return

                lines_q = (qs.get("lines") or [None])[0]
                since_q = (qs.get("since_byte") or [None])[0]
                MAX_BODY = 10 * 1024 * 1024

                try:
                    if since_q is not None:
                        try:
                            offset = max(0, int(since_q))
                        except ValueError:
                            self._json(400, {"error": "since_byte must be an integer"})
                            return
                        with open(tpath, "rb") as f:
                            f.seek(offset)
                            data = f.read(MAX_BODY)
                    elif lines_q is not None:
                        try:
                            n = max(0, min(int(lines_q), 10000))
                        except ValueError:
                            self._json(400, {"error": "lines must be an integer"})
                            return
                        with open(tpath, "rb") as f:
                            chunk = f.read(MAX_BODY)
                        data = b"" if n == 0 else b"".join(chunk.splitlines(keepends=True)[-n:])
                    else:
                        with open(tpath, "rb") as f:
                            data = f.read(MAX_BODY)
                except OSError as e:
                    self._json(500, {"error": f"transcript read failed: {e}"})
                    return

                self.send_response(200)
                self.send_header("Content-Type", "application/x-ndjson; charset=utf-8")
                self.send_header("Content-Length", str(len(data)))
                self.send_header("X-Transcript-Size", str(st.st_size))
                self.send_header("X-Transcript-Mtime", str(int(st.st_mtime)))
                self.send_header("X-Session-Id", api.get("session_id", ""))
                self.end_headers()
                self.wfile.write(data)
                return

            if path.startswith("/agents/") and path.endswith("/health"):
                if not self._require_auth():
                    return
                agent_id = path[len("/agents/"):-len("/health")]
                record = reg.get_record(agent_id)
                if not record:
                    peer = _peer_for_agent(agent_id)
                    if peer:
                        try:
                            status, hdrs, data = _proxy_to_peer(peer, f"/agents/{agent_id}/health", qs_raw)
                        except Exception as e:
                            self._json(502, {"error": f"peer proxy failed: {e}"})
                            return
                        self.send_response(status)
                        self.send_header("Content-Type", "application/json")
                        self.send_header("Content-Length", str(len(data)))
                        self.end_headers()
                        self.wfile.write(data)
                        return
                    self._json(404, {"error": f"agent {agent_id!r} not found"})
                    return
                api = _record_to_api(record)
                self._json(200, {
                    "id":             api["id"],
                    "label":          api["label"],
                    "state":          api["state"],
                    "alive":          api["alive"],
                    "pid":            api["pid"],
                    "uptime_seconds": api["uptime_seconds"],
                })
                return

            if path.startswith("/agents/") and path.endswith("/files"):
                if not self._require_auth():
                    return
                agent_id = path[len("/agents/"):-len("/files")]
                record = reg.get_record(agent_id)
                if not record:
                    self._json(404, {"error": f"agent {agent_id!r} not found"})
                    return
                cwd = record.get("cwd", "")
                if not cwd:
                    self._json(409, {"error": "agent cwd is unknown"})
                    return
                rel = (qs.get("path") or [""])[0]
                abs_target = resolve_safe_path(cwd, rel)
                if abs_target is None:
                    self._json(400, {"error": "path escapes agent cwd"})
                    return
                if not os.path.exists(abs_target):
                    self._json(404, {"error": f"path {rel!r} does not exist"})
                    return
                if not os.path.isdir(abs_target):
                    self._json(400, {"error": f"path {rel!r} is a file; use /agents/{agent_id}/file"})
                    return
                real_cwd = os.path.realpath(cwd)
                abs_real = os.path.realpath(abs_target)
                listing_path_rel = (
                    abs_real[len(real_cwd) + 1:]
                    if abs_real.startswith(real_cwd + os.sep)
                    else ""
                )
                self._json(200, {
                    "id":       agent_id,
                    "cwd":      cwd,
                    "path_rel": listing_path_rel,
                    "entries":  file_listing(abs_target, cwd),
                })
                return

            if path.startswith("/agents/") and path.endswith("/file"):
                if not self._require_auth():
                    return
                agent_id = path[len("/agents/"):-len("/file")]
                record = reg.get_record(agent_id)
                if not record:
                    self._json(404, {"error": f"agent {agent_id!r} not found"})
                    return
                cwd = record.get("cwd", "")
                rel = (qs.get("path") or [""])[0]
                if not rel:
                    self._json(400, {"error": "missing required query param: path"})
                    return
                abs_target = resolve_safe_path(cwd, rel)
                if abs_target is None:
                    self._json(400, {"error": "path escapes agent cwd"})
                    return
                if not os.path.exists(abs_target):
                    self._json(404, {"error": f"path {rel!r} does not exist"})
                    return
                if os.path.isdir(abs_target):
                    self._json(400, {"error": f"path {rel!r} is a directory; use /files"})
                    return
                real_cwd = os.path.realpath(cwd)
                abs_real = os.path.realpath(abs_target)
                canonical_rel = abs_real[len(real_cwd) + 1:] if abs_real.startswith(real_cwd + os.sep) else rel
                try:
                    info = read_file_content(abs_target)
                except OSError as e:
                    self._json(500, {"error": f"file read failed: {e}"})
                    return
                self._json(200, {"id": agent_id, "cwd": cwd, "path": canonical_rel, **info})
                return

            # Raw byte streaming with HTTP Range support — for media (video/audio)
            # and any binary too large for the base64-over-JSON /file endpoint.
            if path.startswith("/agents/") and path.endswith("/raw"):
                if not self._require_auth():
                    return
                agent_id = path[len("/agents/"):-len("/raw")]
                record = reg.get_record(agent_id)
                if not record:
                    # Peer-owned agent: stream-proxy the (range) request to the owner.
                    peer = _peer_for_agent(agent_id)
                    if peer:
                        self._proxy_raw_to_peer(peer, agent_id, qs_raw)
                        return
                    self._json(404, {"error": f"agent {agent_id!r} not found"})
                    return
                cwd = record.get("cwd", "")
                rel = (qs.get("path") or [""])[0]
                if not rel:
                    self._json(400, {"error": "missing required query param: path"})
                    return
                abs_target = resolve_safe_path(cwd, rel)
                if abs_target is None:
                    self._json(400, {"error": "path escapes agent cwd"})
                    return
                if not os.path.exists(abs_target) or os.path.isdir(abs_target):
                    self._json(404, {"error": f"path {rel!r} is not a readable file"})
                    return
                self._serve_file_range(abs_target)
                return

            self._send(404, "not found\n")

        except Exception as e:
            self._send(500, f"error: {e}\n")

    def do_POST(self):
        parsed = urlsplit(self.path)
        path = parsed.path

        try:
            if path == "/agents/register":
                if not self._require_auth():
                    return
                length = int(self.headers.get("Content-Length", "0") or 0)
                if length <= 0 or length > 65536:
                    self._json(400, {"error": "Content-Length missing or out of range"})
                    return
                try:
                    payload = json.loads(self.rfile.read(length).decode("utf-8"))
                except json.JSONDecodeError as e:
                    self._json(400, {"error": f"invalid JSON: {e}"})
                    return

                pid = payload.get("pid")
                if not isinstance(pid, int) or pid <= 0:
                    self._json(400, {"error": "'pid' must be a positive integer"})
                    return
                if not proc.is_claude_pid(pid):
                    self._json(409, {"error": f"pid {pid} is not a live claude process"})
                    return

                label = payload.get("label") or None
                agent_id = payload.get("id") or None
                cwd = payload.get("cwd") or None
                control_port = payload.get("control_port") or None
                control_bind = payload.get("control_bind") or None
                dtach_socket = payload.get("dtach_socket") or None
                domain = payload.get("domain")
                domain = str(domain).strip() if domain else None

                record = reg.register(
                    pid=pid,
                    label=label,
                    agent_id=agent_id,
                    cwd=cwd,
                    control_port=control_port,
                    control_bind=control_bind,
                    dtach_socket=dtach_socket,
                    domain=domain,
                )
                self._json(200, {
                    "id":            record["id"],
                    "label":         record["label"],
                    "state":         record["state"],
                    "registered_at": record["registered_at"],
                })
                return

            if path == "/agents/unregister":
                if not self._require_auth():
                    return
                length = int(self.headers.get("Content-Length", "0") or 0)
                if length <= 0 or length > 65536:
                    self._json(400, {"error": "Content-Length missing or out of range"})
                    return
                try:
                    payload = json.loads(self.rfile.read(length).decode("utf-8"))
                except json.JSONDecodeError as e:
                    self._json(400, {"error": f"invalid JSON: {e}"})
                    return

                agent_id = payload.get("id")
                label = payload.get("label")
                pid = payload.get("pid")
                if not any([agent_id, label, pid]):
                    self._json(400, {"error": "provide 'id', 'label', or 'pid'"})
                    return
                removed = reg.remove(
                    agent_id=str(agent_id) if agent_id else None,
                    label=str(label) if label else None,
                    pid=int(pid) if pid else None,
                )
                self._json(200, {"removed": removed})
                return

            if path.startswith("/agents/") and path.endswith("/unregister"):
                if not self._require_auth():
                    return
                agent_id = path[len("/agents/"):-len("/unregister")]
                removed = reg.remove(agent_id=agent_id)
                self._json(200, {"removed": removed})
                return

            if path.startswith("/agents/") and path.endswith("/prompt"):
                if not self._require_auth():
                    return
                agent_id = path[len("/agents/"):-len("/prompt")]
                record = reg.get_record(agent_id)

                length = int(self.headers.get("Content-Length", "0") or 0)

                if not record:
                    peer = _peer_for_agent(agent_id)
                    if peer:
                        body_bytes = self.rfile.read(length) if length > 0 else b""
                        ct = self.headers.get("Content-Type", "application/json")
                        try:
                            status, hdrs, data = _proxy_to_peer(
                                peer, f"/agents/{agent_id}/prompt", "",
                                method="POST", body_bytes=body_bytes,
                                extra_headers={"Content-Type": ct},
                            )
                        except Exception as e:
                            self._json(502, {"error": f"peer proxy failed: {e}"})
                            return
                        self.send_response(status)
                        self.send_header("Content-Type", "application/json")
                        self.send_header("Content-Length", str(len(data)))
                        self.end_headers()
                        self.wfile.write(data)
                        return
                    self._json(404, {"error": f"agent {agent_id!r} not found"})
                    return

                state = record.get("state", "DISCONNECTED")
                if state == "DISCONNECTED":
                    self._json(409, {"error": f"agent {agent_id!r} is not running (DISCONNECTED)"})
                    return

                if length <= 0 or length > PROMPT_MAX_CONTENT_LENGTH:
                    self._json(400, {"error": "Content-Length missing or out of range"})
                    return
                try:
                    body_bytes = self.rfile.read(length)
                    payload = json.loads(body_bytes.decode("utf-8"))
                except json.JSONDecodeError as e:
                    self._json(400, {"error": f"invalid JSON: {e}"})
                    return

                prompt_text = (payload.get("prompt") or payload.get("content") or "").strip()
                if not prompt_text:
                    self._json(400, {"error": "missing or empty 'prompt' field"})
                    return

                raw_images = payload.get("images") or []
                images = []
                if raw_images:
                    if not isinstance(raw_images, list):
                        self._json(400, {"error": "'images' must be an array"})
                        return
                    if len(raw_images) > IMAGE_MAX_COUNT:
                        self._json(400, {"error": f"too many images (max {IMAGE_MAX_COUNT})"})
                        return
                    total_decoded = 0
                    for idx, img in enumerate(raw_images):
                        if not isinstance(img, dict):
                            self._json(400, {"error": f"images[{idx}] must be an object"})
                            return
                        mime = (img.get("mimeType") or "").strip().lower()
                        if mime not in ALLOWED_MIME_TYPES:
                            self._json(400, {"error": f"images[{idx}] unsupported mimeType {mime!r}"})
                            return
                        data_field = img.get("data") or ""
                        if isinstance(data_field, str) and data_field.startswith("data:"):
                            comma = data_field.find(",")
                            data_field = data_field[comma + 1:] if comma != -1 else ""
                        try:
                            decoded = base64.b64decode(data_field, validate=True)
                        except Exception:
                            self._json(400, {"error": f"images[{idx}] invalid base64"})
                            return
                        if len(decoded) > IMAGE_MAX_BYTES_EACH:
                            self._json(413, {"error": f"images[{idx}] too large"})
                            return
                        total_decoded += len(decoded)
                        if total_decoded > IMAGE_MAX_TOTAL_BYTES:
                            self._json(413, {"error": "total image payload too large"})
                            return
                        name = (img.get("name") or f"image{idx}").replace("/", "_")
                        images.append({"name": name, "mimeType": mime, "decoded": decoded})

                pid = record.get("pid", 0)
                ctrl_port = record.get("control_port") or 0
                ctrl_bind = record.get("control_bind") or "127.0.0.1"

                # Preferred live-write path: a reverse-connect channel shim. If
                # the agent's session has a parked SSE stream, push the prompt
                # down it -> the shim relays it into the live session as a
                # notifications/claude/channel message. Attachments are written to
                # disk under the agent's cwd and referenced by PATH in meta
                # (image_path / attachment_*), mirroring claude's own channels;
                # the live agent reads them from those paths.
                api_for_chan = _record_to_api(record)
                chan_sid = api_for_chan.get("session_id") or record.get("session_id")
                if chan_sid and channel.has_connection(chan_sid):
                    # Zombie guard: a channel-plugin shim can outlive its claude
                    # agent (orphaned process), leaving this SSE parked with no
                    # live agent behind it. Delivering would return a misleading
                    # 202 while the prompt vanishes. channel.agent_alive() checks
                    # the shim's parent is still a live claude (survives /clear
                    # rotation). If not, drop the stale connection and fail loudly
                    # so the caller + GUI see the agent as gone.
                    if not channel.agent_alive(chan_sid):
                        stale = channel.get_connection(chan_sid)
                        if stale is not None:
                            channel.drop_connection(chan_sid, stale)
                        self._json(503, {
                            "error":      "agent process is gone (zombie channel) — relaunch the agent",
                            "id":         agent_id,
                            "session_id": chan_sid,
                        })
                        return
                    chan_meta = {"user": "central", "origin": "central"}
                    chan_text = prompt_text
                    if images:
                        img_meta = _materialize_images(images, api_for_chan.get("cwd") or record.get("cwd", ""))
                        if img_meta:
                            # Paths go in meta ONLY (they surface to the agent as
                            # <channel ... image_path="..."> attributes — the same
                            # convention claude's telegram channel uses). The prompt
                            # text is left clean so the GUI keeps rendering the
                            # uploaded image inline instead of showing a path.
                            chan_meta.update(img_meta)
                        else:
                            # materialization failed -> don't silently drop; fall through
                            chan_meta = None
                    if chan_meta is not None:
                        delivered = channel.deliver(chan_sid, chan_text, meta=chan_meta)
                        if delivered:
                            self._json(202, {
                                "id":         agent_id,
                                "routed":     "channel-shim",
                                "session_id": chan_sid,
                                "state":      state,
                                "images":     len(images),
                            })
                            return
                    # fall through to legacy paths if the queue was full/closed

                if not images and ctrl_port and state == "CONTROLLABLE":
                    ctrl_token = os.environ.get("CONTROL_TOKEN", "")
                    plugin_body = json.dumps({"content": prompt_text}).encode("utf-8")
                    req = urllib.request.Request(
                        f"http://{ctrl_bind}:{ctrl_port}/prompt",
                        data=plugin_body,
                        method="POST",
                    )
                    req.add_header("Content-Type", "application/json")
                    req.add_header("Content-Length", str(len(plugin_body)))
                    if ctrl_token:
                        req.add_header("Authorization", f"Bearer {ctrl_token}")
                    try:
                        with urllib.request.urlopen(req, timeout=5) as resp:
                            plugin_status = resp.status
                            plugin_resp = resp.read().decode("utf-8", errors="replace")
                    except urllib.error.HTTPError as e:
                        plugin_status = e.code
                        plugin_resp = e.read().decode("utf-8", errors="replace") if e.fp else ""
                    except Exception as e:
                        self._json(502, {"error": f"control plugin proxy failed: {e}"})
                        return
                    if plugin_status in (200, 202):
                        self._json(202, {
                            "id":     agent_id,
                            "routed": "control-plugin",
                            "bind":   ctrl_bind,
                            "port":   ctrl_port,
                            "status": plugin_status,
                        })
                    else:
                        self._json(502, {
                            "error":  f"control plugin returned {plugin_status}",
                            "body":   plugin_resp,
                        })
                    return

                # ONLINE (alive, no live control port): fall back to
                # `claude --print --resume <session_id>`. This writes to the SAME
                # session JSONL, so the transcript tail streams the reply.
                api = _record_to_api(record)
                sid = api.get("session_id") or record.get("session_id")
                if not sid:
                    self._json(409, {
                        "error": f"agent {agent_id!r} has no known session to resume",
                        "state": state,
                    })
                    return

                resume_cwd = api.get("cwd") or record.get("cwd") or os.path.expanduser("~")
                argv = [
                    CLAUDE_BIN, "--print", "--resume", sid,
                    "--permission-mode", "bypassPermissions",
                ]
                model = payload.get("model")
                if model:
                    argv += ["--model", str(model)]
                argv.append(prompt_text)
                try:
                    cp = subprocess.run(
                        argv,
                        capture_output=True,
                        text=True,
                        timeout=RESUME_TIMEOUT,
                        cwd=resume_cwd,
                    )
                except subprocess.TimeoutExpired:
                    self._json(504, {
                        "error": f"claude --resume timed out after {RESUME_TIMEOUT}s",
                        "state": state,
                        "session_id": sid,
                    })
                    return
                except Exception as e:
                    self._json(502, {"error": f"claude --resume failed: {e}", "state": state})
                    return

                self._json(200, {
                    "id":         agent_id,
                    "routed":     "resume",
                    "state":      state,
                    "session_id": sid,
                    "returncode": cp.returncode,
                    "stdout":     cp.stdout,
                    "stderr":     cp.stderr,
                })
                return

            self._send(404, "not found\n")

        except Exception as e:
            self._send(500, f"error: {e}\n")


def _reaper_loop():
    """Background thread: periodically drop stale DISCONNECTED records so dead
    and orphaned agents don't pile up in the registry (and the GUI)."""
    while True:
        time.sleep(REAP_INTERVAL)
        try:
            removed = reg.reap_stale(int(REAP_TTL))
            if removed:
                print(f"agent-discovery: reaped {len(removed)} stale record(s): {', '.join(removed)}", flush=True)
        except Exception as e:
            print(f"agent-discovery: reaper error: {e}", flush=True)


def serve(bind: str = BIND, port: int = PORT):
    reg.load_from_disk()
    # ThreadingHTTPServer: held-open SSE handlers (GET /channel/connect) must not
    # block other requests or the scan loop. daemon_threads makes connection
    # threads die with the server.
    server = ThreadingHTTPServer((bind, port), Handler)
    server.daemon_threads = True
    if REAP_TTL > 0:
        threading.Thread(target=_reaper_loop, daemon=True).start()
        print(
            f"agent-discovery: reaper on — drop DISCONNECTED records older than {int(REAP_TTL)}s every {int(REAP_INTERVAL)}s",
            flush=True,
        )
    print(
        f"agent-discovery {VERSION} listening on {bind}:{port}",
        flush=True,
    )
    server.serve_forever()
