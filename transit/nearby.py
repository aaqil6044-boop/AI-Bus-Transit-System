"""Stops around a point, each with the buses timetabled to leave in the next hour.

Times come from the BMTC timetable (GTFS stop_times); they are labelled as timetable times by the page.
A trip that ENDS at the stop is not a departure there and is left out.
"""
from __future__ import annotations

import math
import sqlite3
from contextlib import closing
from datetime import datetime, timedelta, timezone

IST = timezone(timedelta(hours=5, minutes=30))
WALK_METERS_PER_MINUTE = 75
BOUNDS = (12.65, 13.45, 77.20, 78.00)


def _meters(lat1, lon1, lat2, lon2) -> float:
    x = math.radians(lon2 - lon1) * math.cos(math.radians((lat1 + lat2) / 2))
    return 6371000 * math.hypot(x, math.radians(lat2 - lat1))


def _seconds(text: str) -> int | None:
    try:
        hours, minutes, seconds = (int(part) for part in str(text).split(":"))
        return hours * 3600 + minutes * 60 + seconds
    except (TypeError, ValueError):
        return None


def _clock(seconds: int) -> str:
    seconds %= 86400
    return f"{seconds // 3600:02d}:{seconds % 3600 // 60:02d}"


def nearby(database, lat: float, lon: float, now: datetime | None = None, *, radius_m: int = 600,
           limit: int = 6, window_minutes: int = 60) -> dict:
    """{"stops": [{id, name, lat, lon, meters, walk_minutes, towards, lines: [{route, headsign, times, minutes}]}]}"""
    lat, lon = float(lat), float(lon)
    if not (BOUNDS[0] <= lat <= BOUNDS[1] and BOUNDS[2] <= lon <= BOUNDS[3]):
        raise ValueError("That location is outside Bengaluru.")
    now = (now or datetime.now(IST)).astimezone(IST)
    radius_m = max(100, min(int(radius_m), 1500))
    span = radius_m / 111000
    current = now.hour * 3600 + now.minute * 60 + now.second
    windows = [(current, current + window_minutes * 60, 0)]
    if current < 4 * 3600:                     # after midnight: yesterday's trips run on as 24:xx, 25:xx
        windows.append((current + 86400, current + 86400 + window_minutes * 60, -86400))
    with closing(sqlite3.connect(str(database))) as conn:
        candidates = conn.execute(
            "SELECT stop_id, stop_name, stop_lat, stop_lon FROM stops WHERE stop_lat BETWEEN ? AND ? "
            "AND stop_lon BETWEEN ? AND ? AND stop_id NOT LIKE 'METRO:%'",
            (lat - span, lat + span, lon - span * 1.03, lon + span * 1.03)).fetchall()
        stops = sorted(((_meters(lat, lon, s_lat, s_lon), stop_id, name, s_lat, s_lon)
                        for stop_id, name, s_lat, s_lon in candidates), key=lambda row: row[0])
        found = []
        for meters, stop_id, name, s_lat, s_lon in stops:
            if meters > radius_m or len(found) >= limit:
                break
            departures = []
            for start, end, shift in windows:
                departures += [(sec + shift, route, headsign) for sec, route, headsign in (
                    (_seconds(time_text), route, headsign) for time_text, route, headsign in conn.execute(
                        """SELECT st.departure_time, r.route_short_name, t.trip_headsign
                           FROM stop_times st JOIN trips t ON t.trip_id = st.trip_id JOIN routes r ON r.route_id = t.route_id
                           WHERE st.stop_id = ? AND st.departure_time >= ? AND st.departure_time <= ?
                             AND st.stop_sequence < (SELECT MAX(x.stop_sequence) FROM stop_times x WHERE x.trip_id = st.trip_id)
                           ORDER BY st.departure_time LIMIT 120""",
                        (stop_id, _clock_full(start), _clock_full(end)))) if sec is not None]
            lines: dict = {}
            for sec, route, headsign in sorted(departures):
                key = (route or "?", headsign or "")
                entry = lines.setdefault(key, {"route": route or "?", "headsign": headsign or "", "times": [], "minutes": []})
                if len(entry["times"]) < 3:
                    entry["times"].append(_clock(sec))
                    entry["minutes"].append(max(0, round((sec - current) / 60)))
            ordered = sorted(lines.values(), key=lambda line: line["minutes"][0])
            towards = []
            for line in ordered:
                if line["headsign"] and line["headsign"] not in towards:
                    towards.append(line["headsign"])
            found.append({"id": str(stop_id), "name": name, "lat": s_lat, "lon": s_lon, "meters": round(meters),
                          "walk_minutes": max(1, round(meters / WALK_METERS_PER_MINUTE)), "towards": towards[:3],
                          "lines": ordered[:8], "departures_in_window": len(departures)})
    return {"stops": found, "checked_at": now.isoformat(timespec="minutes"), "window_minutes": window_minutes,
            "radius_m": radius_m, "source": "BMTC timetable (not live)"}


def _clock_full(seconds: int) -> str:
    return f"{seconds // 3600:02d}:{seconds % 3600 // 60:02d}:{seconds % 60:02d}"
