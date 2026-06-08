"""
Session / JSONL resolution helpers.

Maps a claude process's cwd to its ~/.claude/projects/<slug>/ directory
and finds the newest JSONL transcript file there.
"""

import os
import threading
import time


HOME = os.path.expanduser("~")


# ---------------------------------------------------------------------------
# Foreign-session registry.
#
# An agent's transcript is resolved as "newest jsonl in its cwd" (so /clear,
# which rotates to a new jsonl, keeps rendering). But a session opened in the
# same folder by claudeui's Projects panel ALSO writes a jsonl there, and if it
# is newer it would be mistaken for the agent's transcript (cross-talk; the
# dedup then hides the user's new session). There is no content/structure marker
# that separates an agent's own session from a foreign one. So claudeui — which
# authoritatively knows every session IT spawns — tells the daemon which session
# ids are foreign (POST /foreign-session); those are excluded from cwd-newest
# transcript resolution. An agent's own /clear rotation is never reported
# foreign, so it is still followed.
# ---------------------------------------------------------------------------

_FOREIGN_LOCK = threading.Lock()
_FOREIGN_SIDS: dict[str, float] = {}  # session_id -> last_seen ts
_FOREIGN_TTL_SECONDS = 7 * 24 * 3600  # prune entries unseen for a week


def mark_foreign_session(session_id: str) -> None:
    """Record a session id as a foreign (claudeui-opened) session so it is never
    resolved as an agent's transcript. Idempotent; refreshes the last-seen ts."""
    if not session_id:
        return
    now = time.time()
    with _FOREIGN_LOCK:
        _FOREIGN_SIDS[session_id] = now
        if len(_FOREIGN_SIDS) > 64:  # lazy prune
            for s in [s for s, t in _FOREIGN_SIDS.items() if now - t > _FOREIGN_TTL_SECONDS]:
                _FOREIGN_SIDS.pop(s, None)


def is_foreign_session(session_id: str) -> bool:
    if not session_id:
        return False
    with _FOREIGN_LOCK:
        return session_id in _FOREIGN_SIDS


def slug_for(path: str) -> str:
    """Convert an absolute path to the ~/.claude/projects/<slug> name.

    Claude encodes the path by replacing '/' and ' ' with '-'.
    Example: /home/alice/projects/research -> -home-alice-projects-research
    """
    if not path:
        return ""
    return path.replace(" ", "-").replace("/", "-")


def newest_jsonl_path(cwd: str) -> tuple[str, float]:
    """Return (absolute_path, mtime) of the newest *.jsonl in the claude project dir
    corresponding to cwd, EXCLUDING sessions claudeui has flagged foreign (a
    Projects session opened in the same folder). Returns ("", 0.0) if not found."""
    if not cwd:
        return ("", 0.0)
    slug = slug_for(cwd)
    proj_dir = os.path.join(HOME, ".claude", "projects", slug)
    if not os.path.isdir(proj_dir):
        return ("", 0.0)
    best_path = ""
    best_mtime = 0.0
    try:
        for entry in os.listdir(proj_dir):
            if not entry.endswith(".jsonl"):
                continue
            if is_foreign_session(entry[:-6]):  # claudeui-opened session — not the agent's
                continue
            full = os.path.join(proj_dir, entry)
            try:
                m = os.stat(full).st_mtime
                if m > best_mtime:
                    best_mtime = m
                    best_path = full
            except OSError:
                continue
    except OSError:
        pass
    return (best_path, best_mtime)


def session_id_from_path(jsonl_path: str) -> str:
    """Extract the session UUID from a JSONL filename stem."""
    if not jsonl_path:
        return ""
    base = os.path.basename(jsonl_path)
    return base[:-6] if base.endswith(".jsonl") else ""
