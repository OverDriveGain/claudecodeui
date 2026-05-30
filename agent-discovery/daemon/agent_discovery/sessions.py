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


def session_id_from_path(jsonl_path: str) -> str:
    """Extract the session UUID from a JSONL filename stem."""
    if not jsonl_path:
        return ""
    base = os.path.basename(jsonl_path)
    return base[:-6] if base.endswith(".jsonl") else ""
