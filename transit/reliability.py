"""Learned route reliability from BMTC's own live data.

Every time the app fetches a route's live details, BMTC reports, for each bus at each stop it has
already passed, the scheduled time (sch_arrivaltime) and the actual time (actual_arrivaltime).
The difference is a measured delay, not a guess. This module stores those measurements (one row per
bus per stop per day, duplicates ignored) and summarises them by route, hour and weekday/weekend.

A summary is shown only with enough evidence (MIN_SAMPLES measurements over MIN_DAYS days); before
that, nothing is shown.

BMTC sometimes pairs a bus with the wrong timetable trip (one an hour earlier or later). Such a run looks
"76 min late" or "30 min early" from its very first stop, which a real bus almost never is: a real delay
starts small and builds up along the route. Runs whose delay at their first recorded stops is outside
START_OK are therefore left out of every summary (the raw rows are kept, so the rule can be improved).
Because delay builds up along a route, a summary for the traveller's own stop (BMTC's station ids are the
timetable's stop ids) is preferred; the whole-route figure is only a fallback. If BMTC's feed does not include the two times, nothing is recorded.
Measurements older than KEEP_DAYS are deleted.
"""
from __future__ import annotations

import os
import re
import sqlite3
import statistics
import threading
from contextlib import closing
from datetime import datetime, timedelta, timezone
from pathlib import Path

IST = timezone(timedelta(hours=5, minutes=30))
MIN_SAMPLES = 12
MIN_STOP_SAMPLES = 6        # at one stop: fewer measurements, but still on MIN_DAYS different days
MIN_DAYS = 3
START_OK = (-10, 20)        # minutes: a run starting outside this was paired with the wrong trip
RUN_GAP_MINUTES = 90        # the same bus later the same day is a new run
KEEP_DAYS = 60
MAX_LATE = 180       # minutes; anything beyond is a data error, not a delay
MAX_EARLY = 30

_lock = threading.Lock()
_ready: set[str] = set()


def database_path() -> Path:
    configured = os.environ.get("RELIABILITY_DB")
    if configured:
        return Path(configured)
    return Path(__file__).resolve().parent.parent / "data" / "reliability.db"


def _connect(path=None) -> sqlite3.Connection:
    path = Path(path or database_path())
    conn = sqlite3.connect(str(path), timeout=5)
    key = str(path)
    if key not in _ready:
        conn.executescript("""
            CREATE TABLE IF NOT EXISTS observations (
                route TEXT NOT NULL, base TEXT NOT NULL, direction TEXT, station TEXT NOT NULL,
                vehicle TEXT NOT NULL, day TEXT NOT NULL, scheduled TEXT NOT NULL, actual TEXT NOT NULL,
                delay INTEGER NOT NULL, hour INTEGER NOT NULL, weekend INTEGER NOT NULL,
                PRIMARY KEY (route, vehicle, station, day, scheduled));
            CREATE INDEX IF NOT EXISTS observations_lookup ON observations (base, weekend, hour);""")
        _ready.add(key)
    return conn


def base_route(name: str) -> str:
    """Depot/trip variants ("KBS-1K KBS-D41G") count as the same bus number."""
    return str(name or "").strip().upper().split(" ")[0]


def _minutes(value) -> int | None:
    match = re.search(r"(\d{1,2}):(\d{2})", str(value or ""))
    if not match:
        return None
    hours, minutes = int(match.group(1)), int(match.group(2))
    return hours * 60 + minutes if hours < 24 and minutes < 60 else None


def measurements(route_number: str, details_by_route, now: datetime | None = None) -> list[tuple]:
    """Rows to store from SearchByRouteDetails_v4 answers: [(route, base, direction, station, vehicle,
    day, scheduled, actual, delay, hour, weekend), ...]."""
    now = (now or datetime.now(IST)).astimezone(IST)
    now_minutes = now.hour * 60 + now.minute
    rows = []
    for _route_id, details in details_by_route or []:
        if not isinstance(details, dict):
            continue
        for direction in ("up", "down"):
            for group in ((details.get(direction) or {}).get("data") or []):
                if not isinstance(group, dict):
                    continue
                station = str(group.get("stationid") or group.get("stationname") or "").strip()
                route = str(group.get("routeno") or route_number or "").strip().upper()
                if not station or not route:
                    continue
                for bus in group.get("vehicleDetails") or []:
                    if not isinstance(bus, dict):
                        continue
                    scheduled = _minutes(bus.get("sch_arrivaltime") or bus.get("sch_departuretime"))
                    actual = _minutes(bus.get("actual_arrivaltime") or bus.get("actual_departuretime"))
                    vehicle = str(bus.get("vehicleid") or bus.get("vehiclenumber") or "").strip()
                    if scheduled is None or actual is None or not vehicle:
                        continue
                    delay = actual - scheduled
                    if delay < -720:
                        delay += 1440          # scheduled 23:55, actual 00:05
                    elif delay > 720:
                        delay -= 1440
                    if not -MAX_EARLY <= delay <= MAX_LATE:
                        continue
                    # An "actual" time later than now belongs to yesterday (we are just past midnight).
                    day = now.date() - timedelta(days=1) if actual > now_minutes + 5 else now.date()
                    weekend = 1 if day.weekday() >= 5 else 0
                    rows.append((route, base_route(route), direction, station, vehicle, day.isoformat(),
                                 f"{scheduled // 60:02d}:{scheduled % 60:02d}", f"{actual // 60:02d}:{actual % 60:02d}",
                                 delay, scheduled // 60, weekend))
    return rows


def record(route_number: str, details_by_route, now: datetime | None = None, path=None) -> int:
    """Store the measurements in one BMTC answer. Returns how many rows were offered. Never raises."""
    try:
        rows = measurements(route_number, details_by_route, now)
        if not rows:
            return 0
        cutoff = ((now or datetime.now(IST)).astimezone(IST).date() - timedelta(days=KEEP_DAYS)).isoformat()
        _rows_cache.clear()
        with _lock, closing(_connect(path)) as conn, conn:
            conn.executemany("INSERT OR IGNORE INTO observations VALUES (?,?,?,?,?,?,?,?,?,?,?)", rows)
            conn.execute("DELETE FROM observations WHERE day < ?", (cutoff,))
        return len(rows)
    except (sqlite3.Error, OSError, ValueError, TypeError) as error:
        print(f"[Reliability] not recorded: {type(error).__name__}: {error}", flush=True)
        return 0


def record_in_background(route_number: str, details_by_route) -> None:
    if os.environ.get("RELIABILITY", "").lower() in ("off", "0", "false", "no"):
        return
    threading.Thread(target=record, args=(route_number, details_by_route), daemon=True).start()


_rows_cache: dict = {}


def _clean_rows(path, base: str, weekend: int):
    """All measurements for this bus number (weekday or weekend) with mispaired runs left out:
    [(delay, day, hour, station), ...]. Cached for two minutes."""
    import time
    key = (str(path), base, weekend)
    cached = _rows_cache.get(key)
    if cached and time.monotonic() - cached[0] < 120:
        return cached[1]
    with closing(_connect(path)) as conn:
        rows = conn.execute(
            "SELECT route, vehicle, day, direction, station, scheduled, delay FROM observations "
            "WHERE base = ? AND weekend = ? LIMIT 50000", (base, weekend)).fetchall()
    runs: dict = {}
    for route, vehicle, day, direction, station, scheduled, delay in rows:
        minute = _minutes(scheduled)
        if minute is not None:
            runs.setdefault((route, vehicle, day, direction), []).append((minute, delay, day, station))
    kept = []
    for items in runs.values():
        items.sort()
        run = [items[0]]
        for previous, item in zip(items, items[1:]):
            if item[0] - previous[0] > RUN_GAP_MINUTES:
                kept.extend(_good_run(run))
                run = []
            run.append(item)
        kept.extend(_good_run(run))
    if len(_rows_cache) > 200:
        _rows_cache.clear()
    _rows_cache[key] = (time.monotonic(), kept)
    return kept


def _good_run(run):
    start = statistics.median(delay for _minute, delay, _day, _station in run[:3])
    if not START_OK[0] <= start <= START_OK[1]:
        return []
    return [(delay, day, minute // 60, station) for minute, delay, day, station in run]


def summary(route_name: str, when: datetime | None = None, path=None, *, station: str | None = None,
            station_name: str | None = None) -> dict | None:
    """Typical delay for this bus number around this hour (weekday or weekend): at ``station`` when
    there is enough evidence there, otherwise across the route. None when there is not enough evidence."""
    when = (when or datetime.now(IST)).astimezone(IST)
    base = base_route(route_name)
    if not base:
        return None
    try:
        if not Path(path or database_path()).exists():
            return None
        rows = _clean_rows(path or database_path(), base, 1 if when.weekday() >= 5 else 0)
    except sqlite3.Error:
        return None
    hours = [(when.hour + offset) % 24 for offset in (-1, 0, 1)]
    window = [row for row in rows if row[2] in hours]
    period = "weekends" if when.weekday() >= 5 else "weekdays"
    at_stop = [row for row in window if station and str(row[3]) == str(station)]
    if at_stop and len(at_stop) >= MIN_STOP_SAMPLES and len({row[1] for row in at_stop}) >= MIN_DAYS:
        chosen, scope = at_stop, "stop"
    elif len(window) >= MIN_SAMPLES and len({row[1] for row in window}) >= MIN_DAYS:
        chosen, scope = window, "route"
    else:
        return None
    delays = sorted(row[0] for row in chosen)
    days = {row[1] for row in chosen}
    quartiles = statistics.quantiles(delays, n=4) if len(delays) >= 4 else [delays[0], 0, delays[-1]]
    typical = round(statistics.median(delays))
    low, high = round(quartiles[0]), round(quartiles[2])
    if abs(typical) <= 2:
        how = "usually on time"
    elif typical > 0:
        how = f"usually about {typical} min late"
    else:
        how = f"usually about {-typical} min early"
    where = f" at {station_name}" if scope == "stop" and station_name else " at this stop" if scope == "stop" else ""
    note = "" if scope == "stop" else " Delays build up along the route, so it depends on the stop."
    return {
        "route": base, "typical_delay_minutes": typical, "range_minutes": [low, high],
        "samples": len(delays), "days": len(days), "period": period, "scope": scope,
        "hours": f"{hours[0]:02d}:00–{(hours[2] + 1) % 24:02d}:00",
        "text": f"{base} is {how}{where} around this time on {period} "
                f"(range {low} to {high} min; {len(delays)} BMTC measurements over {len(days)} days).{note}",
        "source": "Measured from BMTC's own scheduled and actual times (runs BMTC paired with the wrong trip are left out)",
    }


def annotate(routes, path=None) -> None:
    """Add a 'reliability' summary to each bus leg that has enough evidence (in place)."""
    for route in routes or []:
        for leg in route.get("legs") or []:
            if not leg.get("transit") or leg.get("role") == "metro":
                continue
            try:
                when = datetime.fromisoformat(leg.get("departure_iso") or "")
            except (TypeError, ValueError):
                when = None
            found = summary(leg.get("route_name") or "", when, path, station=leg.get("from_stop_id") or None,
                            station_name=(leg.get("from") or {}).get("name"))
            if found:
                leg["reliability"] = found
            # Delay where the traveller gets off: what decides whether a connection is safe.
            try:
                arrival = datetime.fromisoformat(leg.get("arrival_iso") or "")
            except (TypeError, ValueError):
                arrival = None
            at_alight = summary(leg.get("route_name") or "", arrival, path, station=leg.get("to_stop_id") or None,
                                station_name=(leg.get("to") or {}).get("name"))
            if at_alight:
                leg["arrival_reliability"] = at_alight
