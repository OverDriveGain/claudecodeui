"""
cwd-jailed file operations for GET /agents/<id>/files and /agents/<id>/file.
"""

import base64
import mimetypes
import os
import stat as _stat_mod

FILE_READ_MAX_BYTES = 2 * 1024 * 1024

_TEXT_MIMES = {
    "application/json",
    "application/x-ndjson",
    "application/javascript",
    "application/x-sh",
    "application/x-python",
    "application/x-ruby",
    "application/x-perl",
    "application/x-yaml",
    "application/toml",
    "application/xml",
}


def is_text_mime(mime: str) -> bool:
    if not mime:
        return False
    if mime.startswith("text/"):
        return True
    return mime in _TEXT_MIMES


def resolve_safe_path(cwd: str, rel: str) -> str | None:
    """Resolve rel (relative to cwd) and verify it stays within cwd.

    Returns the absolute resolved path, or None if the path escapes cwd.
    """
    if not cwd:
        return None
    if not rel or rel in (".", ""):
        return os.path.realpath(cwd)
    rel = rel.lstrip("/")
    candidate = os.path.realpath(os.path.join(cwd, rel))
    real_cwd = os.path.realpath(cwd)
    if candidate != real_cwd and not candidate.startswith(real_cwd + os.sep):
        return None
    return candidate


def file_listing(abs_dir: str, cwd: str) -> list[dict]:
    """Return a one-level directory listing."""
    real_cwd = os.path.realpath(cwd)
    out = []
    try:
        entries = sorted(os.listdir(abs_dir))
    except PermissionError:
        return out
    for name in entries:
        full = os.path.join(abs_dir, name)
        try:
            st = os.stat(full)
        except OSError:
            continue
        kind = "dir" if _stat_mod.S_ISDIR(st.st_mode) else "file"
        abs_entry = os.path.realpath(full)
        if abs_entry.startswith(real_cwd + os.sep):
            path_rel = abs_entry[len(real_cwd) + 1:]
        elif abs_entry == real_cwd:
            path_rel = ""
        else:
            path_rel = name
        out.append({
            "name":     name,
            "type":     kind,
            "size":     st.st_size if kind == "file" else 0,
            "mtime":    st.st_mtime,
            "path_rel": path_rel,
        })
    return out


def read_file_content(abs_path: str) -> dict:
    """Read a file and return a dict with content, encoding, mime, size, truncated."""
    file_size = os.stat(abs_path).st_size
    mime, _ = mimetypes.guess_type(abs_path)
    if mime is None:
        try:
            with open(abs_path, "rb") as fh:
                probe = fh.read(512)
            mime = "application/octet-stream" if b"\x00" in probe else "text/plain"
        except OSError:
            mime = "application/octet-stream"

    text = is_text_mime(mime)
    truncated = file_size > FILE_READ_MAX_BYTES
    read_bytes = FILE_READ_MAX_BYTES if truncated else file_size

    with open(abs_path, "rb") as fh:
        raw = fh.read(read_bytes)

    if text:
        try:
            content = raw.decode("utf-8")
            encoding = "utf8"
        except UnicodeDecodeError:
            content = base64.b64encode(raw).decode("ascii")
            encoding = "base64"
            text = False
    else:
        content = base64.b64encode(raw).decode("ascii")
        encoding = "base64"

    return {
        "size":      file_size,
        "mime":      mime,
        "encoding":  encoding,
        "truncated": truncated,
        "content":   content,
    }
