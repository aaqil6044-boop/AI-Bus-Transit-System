"""Honest arrival window: a likely range for when a journey really arrives, and why.

The timetable gives one arrival time. Buses rarely match it, so each journey also gets a range:

* ``stop``/``route``: BMTC's own scheduled-versus-actual times for the last bus (where the traveller
  gets off when there is enough evidence there, otherwise along the route), around that hour.
* ``city``: no measurements for that bus yet, but enough for other BMTC buses at that hour.
* ``timetable``: no measurements at all, so no range is shown, only the timetable time.
* ``metro``: the last part is by metro; arrival is from the metro timetable.

When a change of bus is at risk (transit/confidence.py), the window also says when the next bus on
the connecting line is timetabled, so the traveller sees the cost of missing it.

Every number comes from BMTC's timetable or BMTC's own measurements. Nothing is guessed.
"""
from __future__ import annotations

import sqlite3
import statistics
import time
from contextlib import closing
from datetime import datetime, timedelta, timezone
from pathlib import Path

from . import reliability

IST = timezone(timedelta(hours=5, minutes=30))
EARLIEST_EARLY = -5          # a bus that runs early does not get the traveller in more than ~5 min early
CITY_MIN_SAMPLES = 40
_city_cache: dict = {}


def _iso(value):
    try:
        return datetime.fromisoformat(str(value)).astimezone(IST)
    except (TypeError, ValueError):
        return None


def _clock(moment: datetime) -> str:
    return moment.astimezone(IST).strftime("%H:%M")


def city_spread(when: datetime, path=None) -> dict | None:
    """Middle half of all measured BMTC delays at this hour (weekday/weekend), or None if too few."""
    when = when.astimezone(IST)
    weekend = 1 if when.weekday() >= 5 else 0
    hours = {(when.hour + offset) % 24 for offset in (-1, 0, 1)}
    path = path or reliability.database_path()
    key = (str(path), weekend, when.hour)
    cached = _city_cache.get(key)
    if cached and time.monotonic() - cached[0] < 600:
        return cached[1]
    found = None
    try:
        if not Path(path).exists():
            raise OSError("no measurements file")
        with closing(reliability._connect(path)) as conn:
            bases = [row[0] for row in conn.execute("SELECT DISTINCT base FROM observations WHERE weekend = ?", (weekend,))]
        delays, days = [], set()
        for base in bases[:400]:
            for delay, day, hour, _station in reliability._clean_rows(path, base, weekend):
                if hour in hours:
                    delays.append(delay)
                    days.add(day)
        if len(delays) >= CITY_MIN_SAMPLES and len(days) >= reliability.MIN_DAYS:
            low, _middle, high = statistics.quantiles(sorted(delays), n=4)
            found = {"low": round(low), "high": round(high), "samples": len(delays), "days": len(days),
                     "routes": len(bases)}
    except (sqlite3.Error, OSError, statistics.StatisticsError):
        found = None
    if len(_city_cache) > 100:
        _city_cache.clear()
    _city_cache[key] = (time.monotonic(), found)
    return found


def _seconds(text) -> int | None:
    try:
        hours, minutes, seconds = (int(part) for part in str(text).split(":"))
        return hours * 3600 + minutes * 60 + seconds
    except (TypeError, ValueError):
        return None


def next_departure(conn, route_name: str, stop_id: str, after: datetime) -> datetime | None:
    """The next timetabled departure of the same bus number from this stop after ``after`` (within 3 h)."""
    after = after.astimezone(IST)
    midnight = after.replace(hour=0, minute=0, second=0, microsecond=0)
    start = int((after - midnight).total_seconds()) + 60
    base = reliability.base_route(route_name)
    best = None
    for day_shift in (0, -86400):                 # yesterday's trips run on as 24:xx after midnight
        low = start - day_shift
        rows = conn.execute(
            """SELECT st.departure_time, r.route_short_name FROM stop_times st
               JOIN trips t ON t.trip_id = st.trip_id JOIN routes r ON r.route_id = t.route_id
               WHERE st.stop_id = ? AND st.departure_time >= ? AND st.departure_time <= ?
               ORDER BY st.departure_time LIMIT 40""",
            (str(stop_id), _hms(low), _hms(low + 3 * 3600))).fetchall()
        for text, name in rows:
            if reliability.base_route(name) != base:
                continue
            seconds = _seconds(text)
            if seconds is None:
                continue
            moment = midnight + timedelta(seconds=seconds + day_shift)
            if moment > after and (best is None or moment < best):
                best = moment
            break
        if after.hour >= 4:
            break
    return best


def _hms(seconds: int) -> str:
    return f"{seconds // 3600:02d}:{seconds % 3600 // 60:02d}:{seconds % 60:02d}"


def arrival_window(route: dict, *, conn=None, path=None) -> dict | None:
    legs = [leg for leg in route.get("legs") or [] if isinstance(leg, dict)]
    rides = [leg for leg in legs if leg.get("transit")]
    scheduled = _iso(route.get("arrival_iso"))
    if not rides or scheduled is None:
        return None
    last = rides[-1]
    line = last.get("route_name") or "the bus"
    stop = (last.get("to") or {}).get("name") or ""
    window = {"scheduled": _clock(scheduled), "scheduled_iso": scheduled.isoformat(), "line": line, "stop": stop,
              "basis": "timetable", "earliest": None, "latest": None, "missed": []}
    learned = last.get("arrival_reliability") if isinstance(last.get("arrival_reliability"), dict) else None
    if last.get("role") == "metro":
        window["basis"] = "metro"
    elif learned and learned.get("range_minutes"):
        low, high = learned["range_minutes"]
        window.update(basis=learned.get("scope") or "route", low=int(low), high=int(high),
                      samples=learned.get("samples"), days=learned.get("days"), period=learned.get("period"))
    else:
        spread = city_spread(_iso(last.get("arrival_iso")) or scheduled, path)
        if spread:
            window.update(basis="city", low=spread["low"], high=spread["high"], samples=spread["samples"],
                          days=spread["days"], period="weekends" if scheduled.weekday() >= 5 else "weekdays")
    if window["basis"] in ("stop", "route", "city"):
        low = max(EARLIEST_EARLY, min(window["low"], window["high"]))
        high = max(window["low"], window["high"], low)
        window["earliest"] = _clock(scheduled + timedelta(minutes=low))
        window["latest"] = _clock(scheduled + timedelta(minutes=high))
        window["earliest_iso"] = (scheduled + timedelta(minutes=low)).isoformat()
        window["latest_iso"] = (scheduled + timedelta(minutes=high)).isoformat()
    # A change of bus at risk: what missing it costs, from the timetable.
    if conn is not None:
        for leg in rides[1:]:
            connection = leg.get("connection") if isinstance(leg.get("connection"), dict) else {}
            if connection.get("status") not in ("risky", "tight"):
                continue
            planned = _iso(leg.get("departure_iso"))
            if planned is None or not leg.get("from_stop_id"):
                continue
            following = next_departure(conn, leg.get("route_name") or "", leg["from_stop_id"], planned)
            if following is None:
                window["missed"].append({"line": leg.get("route_name"), "stop": (leg.get("from") or {}).get("name"),
                                         "next": None, "later_minutes": None, "status": connection["status"]})
                continue
            later = round((following - planned).total_seconds() / 60)
            window["missed"].append({"line": leg.get("route_name"), "stop": (leg.get("from") or {}).get("name"),
                                     "next": _clock(following), "later_minutes": later, "status": connection["status"]})
    return window


def annotate(database, routes, path=None) -> None:
    """Add ``arrival_window`` to each journey (in place). Never raises into the journey planner."""
    try:
        connection = sqlite3.connect(str(database)) if database else None
    except sqlite3.Error:
        connection = None
    try:
        for route in routes or []:
            try:
                found = arrival_window(route, conn=connection, path=path)
            except (sqlite3.Error, ValueError, TypeError, KeyError) as error:
                print(f"[Arrival window] skipped: {type(error).__name__}: {error}", flush=True)
                found = None
            if found:
                route["arrival_window"] = found
    finally:
        if connection is not None:
            connection.close()
