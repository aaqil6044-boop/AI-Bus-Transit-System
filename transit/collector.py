"""A polite background collector that fills the learned-delay data for the busiest routes.

Learned delays (transit/reliability.py) only grow when someone checks a route live, so most routes
stay "not enough measurements" for weeks. This loop asks BMTC about the busiest bus numbers in the
timetable, one route at a time, at most one route a minute (``COLLECTOR_SECONDS``), during service
hours only. Each answer is recorded exactly like a traveller's own live check: BMTC's scheduled and
actual arrival times. Nothing is estimated or invented here.

Switches (environment): ``COLLECTOR=off`` turns it off; ``COLLECTOR_ROUTES`` (default 20);
``COLLECTOR_SECONDS`` between checks (default 60, minimum 30); ``COLLECTOR_HOURS`` (default "6-22", IST).
After a failed BMTC call the loop waits 10 minutes before trying again.
"""
from __future__ import annotations

import os
import sqlite3
import threading
import time
from contextlib import closing
from datetime import datetime, timedelta, timezone

IST = timezone(timedelta(hours=5, minutes=30))
BACKOFF_SECONDS = 600

_lock = threading.Lock()
_state = {"running": False, "routes": [], "checks": 0, "failed": 0, "last_route": None, "last_at": None,
          "last_error": "", "next_index": 0, "paused": ""}


def enabled() -> bool:
    off = ("off", "0", "false", "no")
    return (os.environ.get("COLLECTOR", "on").strip().lower() not in off and
            os.environ.get("RELIABILITY", "on").strip().lower() not in off)


def settings() -> dict:
    def number(name, default, low):
        try:
            return max(low, int(os.environ.get(name, default)))
        except ValueError:
            return default
    hours = os.environ.get("COLLECTOR_HOURS", "6-22")
    try:
        start, end = (int(part) for part in hours.split("-", 1))
    except ValueError:
        start, end = 6, 22
    return {"routes": number("COLLECTOR_ROUTES", 20, 1), "seconds": number("COLLECTOR_SECONDS", 60, 30),
            "hours": (max(0, min(start, 23)), max(1, min(end, 24)))}


def busiest_routes(database, limit: int = 20) -> list[str]:
    """Bus numbers with the most timetabled trips (metro lines left out), one per BMTC bus number."""
    with closing(sqlite3.connect(str(database))) as conn:
        rows = conn.execute(
            "SELECT r.route_short_name, count(*) AS trips FROM trips t JOIN routes r ON r.route_id = t.route_id "
            "WHERE r.route_type = '3' AND r.route_id NOT LIKE 'METRO:%' AND coalesce(r.route_short_name, '') <> '' "
            "GROUP BY r.route_short_name ORDER BY trips DESC, r.route_short_name LIMIT ?", (limit * 3,)).fetchall()
    chosen, seen = [], set()
    for name, _trips in rows:
        base = str(name).strip().upper().split(" ")[0]
        if base and base not in seen:
            seen.add(base)
            chosen.append(str(name).strip())
        if len(chosen) >= limit:
            break
    return chosen


def in_service_hours(now: datetime, hours: tuple[int, int]) -> bool:
    return hours[0] <= now.astimezone(IST).hour < hours[1]


def check_once(routes: list[str], now: datetime | None = None, *, live=None, hours=(6, 22)) -> str | None:
    """Ask BMTC about the next route in turn. Returns the route checked, or None when it is not time."""
    now = now or datetime.now(IST)
    if not routes:
        return None
    if not in_service_hours(now, hours):
        with _lock:
            _state["paused"] = "outside service hours"
        return None
    if live is None:
        from .bmtc_live import live_route
        live = live_route
    with _lock:
        index = _state["next_index"] % len(routes)
        _state["next_index"] = index + 1
        _state["paused"] = ""
    route = routes[index]
    try:
        live(route, force_refresh=True)      # records BMTC's scheduled/actual times as a side effect
        with _lock:
            _state["checks"] += 1
            _state["last_route"], _state["last_at"], _state["last_error"] = route, now.isoformat(timespec="seconds"), ""
    except Exception as error:               # BMTC down or slow: note it and let the loop back off
        with _lock:
            _state["failed"] += 1
            _state["last_route"], _state["last_at"] = route, now.isoformat(timespec="seconds")
            _state["last_error"] = f"{type(error).__name__}: {str(error)[:120]}"
        raise
    return route


def _loop(database) -> None:
    config = settings()
    try:
        routes = busiest_routes(database, config["routes"])
    except sqlite3.Error as error:
        print(f"[Collector] stopped: {error}", flush=True)
        return
    with _lock:
        _state.update(running=True, routes=routes)
    print(f"[Collector] learning delays for {len(routes)} busy routes, one check every {config['seconds']} s "
          f"between {config['hours'][0]}:00 and {config['hours'][1]}:00", flush=True)
    time.sleep(90)                           # let warm-up and the first travellers go first
    while True:
        wait = config["seconds"]
        try:
            check_once(routes, hours=config["hours"])
        except Exception:
            wait = BACKOFF_SECONDS
        time.sleep(wait)


def start(database) -> bool:
    if not enabled():
        return False
    with _lock:
        if _state["running"]:
            return True
        _state["running"] = True
    threading.Thread(target=_loop, args=(database,), daemon=True, name="delay-collector").start()
    return True


def status() -> dict:
    with _lock:
        return {"enabled": enabled(), "running": _state["running"], "routes": len(_state["routes"]),
                "checks": _state["checks"], "failed": _state["failed"], "last_route": _state["last_route"],
                "last_at": _state["last_at"], "last_error": _state["last_error"], "paused": _state["paused"]}
