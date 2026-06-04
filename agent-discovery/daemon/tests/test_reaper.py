"""Regression test for the stale-record reaper (registry.reap_stale).

Self-contained, no pytest dependency. Run from the daemon dir:
    python3 tests/test_reaper.py
Exits non-zero on failure. Uses an isolated REGISTRY_PATH so it never touches
the real registry.
"""
import os
import sys
import tempfile
import time

# Isolate persistence BEFORE importing the registry (it binds REGISTRY_PATH at import).
os.environ["REGISTRY_PATH"] = tempfile.mktemp(suffix="-reaper-test.json")
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from agent_discovery import registry as reg, proc, channel  # noqa: E402

# Control liveness deterministically: only pid 4242 is "alive", no channels.
proc.is_claude_pid = lambda pid: pid == 4242
channel.has_connection = lambda sid: False

TTL = 1800


def _set(records):
    reg._registry.clear()
    reg._registry.update(records)


def _rec(rid, pid, last_seen):
    return {"id": rid, "label": rid, "pid": pid, "session_id": "", "last_seen": last_seen}


def main():
    now = time.time()

    # 1. Stale dead is reaped; recent dead is kept; live (alive pid) is kept
    #    even with an old last_seen.
    _set({
        "stale": _rec("stale", 0, now - TTL - 10),
        "recent": _rec("recent", 0, now - 10),
        "live": _rec("live", 4242, now - TTL - 10),
    })
    removed = reg.reap_stale(TTL)
    assert removed == ["stale"], f"expected only 'stale' reaped, got {removed}"
    assert set(reg._registry) == {"recent", "live"}, sorted(reg._registry)

    # 2. ttl <= 0 disables reaping entirely.
    _set({"x": _rec("x", 0, now - 99999)})
    assert reg.reap_stale(0) == [], "ttl<=0 must disable reaping"
    assert "x" in reg._registry

    # 3. A reconnect (refreshed last_seen) protects a record from reaping.
    _set({"r": _rec("r", 0, now - TTL - 10)})
    reg._registry["r"]["last_seen"] = time.time()  # simulate reconnect heartbeat
    assert reg.reap_stale(TTL) == [], "a reconnected record must not be reaped"
    assert "r" in reg._registry

    path = os.environ["REGISTRY_PATH"]
    if os.path.exists(path):
        os.remove(path)
    print("reaper test: PASS")


if __name__ == "__main__":
    main()
