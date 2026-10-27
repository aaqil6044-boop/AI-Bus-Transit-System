"""Learned route reliability from BMTC's own live data.

Every time the app fetches a route's live details, BMTC reports, for each bus at each stop it has
already passed, the scheduled time (sch_arrivaltime) and the actual time (actual_arrivaltime).
The difference is a measured delay, not a guess. This module stores those measurements (one row per
bus per stop per day, duplicates ignored) and summarises them by route, hour and weekday/weekend.

A summary is shown only with enough evidence (MIN_SAMPLES measurements over MIN_DAYS days); before
that, nothing is shown. If BMTC's feed does not include the two times, nothing is recorded.
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
MIN_DAYS = 3
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


def summary(route_name: str, when: datetime | None = None, path=None) -> dict | None:
    """Typical delay for this bus number around this hour (weekday or weekend), or None when there
    is not enough evidence yet."""
    when = (when or datetime.now(IST)).astimezone(IST)
    base = base_route(route_name)
    if not base:
        return None
    try:
        if not Path(path or database_path()).exists():
            return None
        with closing(_connect(path)) as conn:
            hours = [(when.hour + offset) % 24 for offset in (-1, 0, 1)]
            rows = conn.execute(
                "SELECT delay, day FROM observations WHERE base = ? AND weekend = ? AND hour IN (?,?,?)",
                (base, 1 if when.weekday() >= 5 else 0, *hours)).fetchall()
    except sqlite3.Error:
        return None
    days = {day for _delay, day in rows}
    if len(rows) < MIN_SAMPLES or len(days) < MIN_DAYS:
        return None
    delays = sorted(delay for delay, _day in rows)
    quartiles = statistics.quantiles(delays, n=4) if len(delays) >= 4 else [delays[0], 0, delays[-1]]
    typical = round(statistics.median(delays))
    low, high = round(quartiles[0]), round(quartiles[2])
    if abs(typical) <= 2:
        text = "usually on time"
    elif typical > 0:
        text = f"usually about {typical} min late"
    else:
        text = f"usually about {-typical} min early"
    period = "weekends" if when.weekday() >= 5 else "weekdays"
    return {
        "route": base, "typical_delay_minutes": typical, "range_minutes": [low, high],
        "samples": len(delays), "days": len(days), "period": period,
        "hours": f"{hours[0]:02d}:00–{(hours[2] + 1) % 24:02d}:00",
        "text": f"{base} is {text} around this time on {period} "
                f"(range {low} to {high} min; {len(delays)} BMTC measurements over {len(days)} days).",
        "source": "Measured from BMTC's own scheduled and actual times",
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
            found = summary(leg.get("route_name") or "", when, path)
            if found:
                leg["reliability"] = found
