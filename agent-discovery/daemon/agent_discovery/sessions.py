"""
Session / JSONL resolution helpers.

Maps a claude process's cwd to its ~/.claude/projects/<slug>/ directory
and finds the newest JSONL transcript file there.
"""

import os


HOME = os.path.expanduser("~")


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
    corresponding to cwd. Returns ("", 0.0) if not found."""
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


# A channel-delivered prompt lands in the jsonl as a <channel source="plugin:channel:channel" …>
# block, so the presence of this marker means the file is a MANAGED-agent session.
_CHANNEL_MARKER = b"plugin:channel:channel"
_CHANNEL_SCAN_MAX_BYTES = 4 * 1024 * 1024  # cap per-file read; the marker appears early


def newest_channel_jsonl_path(cwd: str) -> tuple[str, float]:
    """Return (path, mtime) of the newest *.jsonl in cwd's project dir that carries
    channel activity — i.e. the agent's OWN session. A plain SDK/foreign session
    opened in the same folder has no channel messages and is skipped, so it can't be
    mistaken for the agent's transcript. Returns ("", 0.0) if none qualifies.

    Scans newest-first and stops at the first channel file (usually the newest, so
    one read). Caps each read so a huge non-channel file can't stall the scan."""
    if not cwd:
        return ("", 0.0)
    proj_dir = os.path.join(HOME, ".claude", "projects", slug_for(cwd))
    if not os.path.isdir(proj_dir):
        return ("", 0.0)
    candidates: list[tuple[float, str]] = []
    try:
        for entry in os.listdir(proj_dir):
            if not entry.endswith(".jsonl"):
                continue
            full = os.path.join(proj_dir, entry)
            try:
                candidates.append((os.stat(full).st_mtime, full))
            except OSError:
                continue
    except OSError:
        return ("", 0.0)
    candidates.sort(reverse=True)  # newest first
    for mtime, full in candidates[:12]:  # only the most recent handful
        try:
            with open(full, "rb") as f:
                if _CHANNEL_MARKER in f.read(_CHANNEL_SCAN_MAX_BYTES):
                    return (full, mtime)
        except OSError:
            continue
    return ("", 0.0)


def session_id_from_path(jsonl_path: str) -> str:
    """Extract the session UUID from a JSONL filename stem."""
    if not jsonl_path:
        return ""
    base = os.path.basename(jsonl_path)
    return base[:-6] if base.endswith(".jsonl") else ""
