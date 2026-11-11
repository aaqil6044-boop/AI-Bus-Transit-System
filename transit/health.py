"""How the outside services are doing, for the admin status page and the page's outage notices.

Every call to BMTC's live feed, Gemini, the route engine and OpenStreetMap reports here whether it
worked and how long it took. Nothing about travellers is stored: only service name, time, success,
duration and a short error text (never keys or request contents). Kept in memory only.
"""
from __future__ import annotations

import threading
import time
from collections import deque

SERVICES = ("bmtc", "gemini", "router", "places", "weather")
_lock = threading.Lock()
_started = time.time()
_state = {name: {"ok": 0, "failed": 0, "last_ok": None, "last_error": None, "last_error_text": "",
                 "durations": deque(maxlen=50)} for name in SERVICES}
_errors: deque = deque(maxlen=30)


def record(service: str, ok: bool, seconds: float | None = None, error: str = "") -> None:
    if service not in _state:
        return
    now = time.time()
    with _lock:
        entry = _state[service]
        if ok:
            entry["ok"] += 1
            entry["last_ok"] = now
            if seconds is not None:
                entry["durations"].append(float(seconds))
        else:
            entry["failed"] += 1
            entry["last_error"] = now
            entry["last_error_text"] = str(error)[:200]
            _errors.append({"service": service, "at": now, "error": str(error)[:200]})


def status(service: str) -> str:
    """"ok", "down" (the latest call failed) or "unknown" (not used yet)."""
    with _lock:
        entry = _state.get(service)
        if not entry or (entry["last_ok"] is None and entry["last_error"] is None):
            return "unknown"
        if entry["last_error"] and (entry["last_ok"] is None or entry["last_error"] > entry["last_ok"]):
            return "down"
        return "ok"


def snapshot() -> dict:
    with _lock:
        services = {}
        for name, entry in _state.items():
            durations = sorted(entry["durations"])
            services[name] = {
                "status": "unknown" if entry["last_ok"] is None and entry["last_error"] is None else
                          "down" if entry["last_error"] and (entry["last_ok"] is None or entry["last_error"] > entry["last_ok"]) else "ok",
                "ok": entry["ok"], "failed": entry["failed"],
                "last_ok": entry["last_ok"], "last_error": entry["last_error"], "last_error_text": entry["last_error_text"],
                "median_seconds": round(durations[len(durations) // 2], 2) if durations else None,
                "slowest_seconds": round(durations[-1], 2) if durations else None,
            }
        return {"started": _started, "uptime_seconds": round(time.time() - _started), "services": services,
                "recent_errors": list(_errors)[::-1]}


class timed:
    """with health.timed("bmtc"): ...  records success, or the exception's text on failure."""

    def __init__(self, service: str):
        self.service = service

    def __enter__(self):
        self.started = time.monotonic()
        return self

    def __exit__(self, kind, error, _traceback):
        record(self.service, error is None, time.monotonic() - self.started,
               "" if error is None else f"{type(error).__name__}: {error}")
        return False
