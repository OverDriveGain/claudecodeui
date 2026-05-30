"""
agent-discovery HTTP daemon.

Single-process, stdlib-only. Serves the registration API and agent metadata.
"""

import base64
import hmac
import json
import os
import time
import threading
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import parse_qs, urlsplit

from . import registry as reg
from . import proc
from .control import assess_controllable, load_control_env
from .sessions import newest_jsonl_path, session_id_from_path
from .files import resolve_safe_path, file_listing, read_file_content

VERSION = "0.1.0"

BIND = os.environ.get("BIND", "127.0.0.1")
PORT = int(os.environ.get("PORT", "9301"))
SCAN_INTERVAL = float(os.environ.get("SCAN_INTERVAL_SECONDS", "10.0"))

AUTH_TOKEN = os.environ.get("AGENT_DISCOVERY_TOKEN", "").strip()

PEERS: list[str] = [
    p.strip().rstrip("/")
    for p in os.environ.get("AGENT_DISCOVERY_PEERS", "").split(",")
    if p.strip()
]
PEER_TIMEOUT = float(os.environ.get("AGENT_DISCOVERY_PEER_TIMEOUT", "2.5"))

_peer_agent_cache: dict[str, str] = {}
_peer_cache_lock = threading.Lock()

IMAGE_MAX_COUNT = 5
IMAGE_MAX_BYTES_EACH = 5 * 1024 * 1024
IMAGE_MAX_TOTAL_BYTES = 20 * 1024 * 1024
PROMPT_MAX_CONTENT_LENGTH = IMAGE_MAX_TOTAL_BYTES + 512 * 1024
ALLOWED_MIME_TYPES = {"image/png", "image/jpeg", "image/gif", "image/webp"}


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

    cwd = record.get("cwd", "")
    if alive and pid:
        live_cwd = proc.cwd_of(pid)
        if live_cwd:
            cwd = live_cwd

    jsonl_path, jsonl_mtime = newest_jsonl_path(cwd) if cwd else ("", 0.0)
    session_id = session_id_from_path(jsonl_path)

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
        if not AUTH_TOKEN:
            self._json(503, {
                "error": (
                    "AGENT_DISCOVERY_TOKEN is not set; all gated endpoints are unavailable. "
                    "Set the token in the daemon environment."
                )
            })
            return False
        auth = self.headers.get("Authorization", "")
        presented = auth[len("Bearer "):].strip() if auth.startswith("Bearer ") else ""
        if not presented or not hmac.compare_digest(presented, AUTH_TOKEN):
            self._json(401, {"error": "unauthorized"})
            return False
        return True

    def do_GET(self):
        parsed = urlsplit(self.path)
        path = parsed.path
        qs = parse_qs(parsed.query)
        qs_raw = parsed.query

        try:
            if path in ("/health", "/"):
                self._json(200, {"ok": True, "version": VERSION})
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

                record = reg.register(
                    pid=pid,
                    label=label,
                    agent_id=agent_id,
                    cwd=cwd,
                    control_port=control_port,
                    control_bind=control_bind,
                    dtach_socket=dtach_socket,
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

                self._json(409, {
                    "error": (
                        f"agent {agent_id!r} is ONLINE but not CONTROLLABLE "
                        "(no live control port). Launch claude with --remote-control <port> "
                        "to enable prompt injection."
                    ),
                    "state": state,
                })
                return

            self._send(404, "not found\n")

        except Exception as e:
            self._send(500, f"error: {e}\n")


def serve(bind: str = BIND, port: int = PORT):
    reg.load_from_disk()
    server = HTTPServer((bind, port), Handler)
    print(
        f"agent-discovery {VERSION} listening on {bind}:{port}",
        flush=True,
    )
    server.serve_forever()
