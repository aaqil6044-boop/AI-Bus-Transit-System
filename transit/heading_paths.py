"""Road-following "where is this bus heading" lines for live buses.

BMTC's feed gives each live bus its run's stops in order. Joining those stops with straight lines
looks wrong (express routes cut across the map) and, when a bus's reported progress lags its real
position, the line starts by going backwards. This module instead follows the route's own road path
from the imported timetable (GTFS shapes):

  1. find the timetable paths for the bus number (and its depot/trip variants);
  2. place the bus on a path (it must be within ~300 m of it);
  3. walk the stops ahead IN ORDER along the path from there; a path is accepted only when most of
     the stops lie on it in that order;
  4. draw the path from the bus to the last matched stop.

When no timetable path fits, the stop-to-stop line is kept but cleaned up: stops the bus has
already passed are dropped and the line stops before any jump longer than ~2 km, so it never draws
a misleading straight shortcut. The result says which kind it is ("road" or "stops").
"""
from __future__ import annotations

import math
import sqlite3
from contextlib import closing

BUS_ON_PATH_M = 300        # a bus this far from a path is not on it
STOP_ON_PATH_M = 200       # a stop this far from a path is not served by it
MAX_STOP_GAP_M = 2000      # stop-to-stop fallback: never draw a straight jump longer than this
MAX_SHAPES = 10

_shape_cache: dict[str, list[tuple[float, float]]] = {}
_route_cache: dict[tuple[str, str], list[str]] = {}


def _meters(lat1, lon1, lat2, lon2) -> float:
    x = math.radians(lon2 - lon1) * math.cos(math.radians((lat1 + lat2) / 2))
    y = math.radians(lat2 - lat1)
    return 6371000 * math.hypot(x, y)


def _shape_ids(conn, database_key: str, route_name: str) -> list[str]:
    name = str(route_name or "").strip()
    key = (database_key, name.upper())
    if key not in _route_cache:
        base = name.split(" ")[0]
        rows = conn.execute(
            """SELECT t.shape_id, COUNT(*) AS n,
                      CASE WHEN UPPER(r.route_short_name) = UPPER(?) THEN 0 ELSE 1 END AS exact
               FROM trips t JOIN routes r ON r.route_id = t.route_id
               WHERE (UPPER(r.route_short_name) = UPPER(?) OR UPPER(r.route_short_name) = UPPER(?)
                      OR UPPER(r.route_short_name) LIKE UPPER(?) || ' %')
                 AND t.shape_id IS NOT NULL AND t.shape_id != ''
               GROUP BY t.shape_id ORDER BY exact, n DESC LIMIT ?""",
            (name, name, base, base, MAX_SHAPES)).fetchall()
        _route_cache[key] = [row[0] for row in rows]
    return _route_cache[key]


def _shape(conn, shape_id: str) -> list[tuple[float, float]]:
    if shape_id not in _shape_cache:
        if len(_shape_cache) > 400:
            _shape_cache.clear()
        _shape_cache[shape_id] = [(float(a), float(b)) for a, b in conn.execute(
            "SELECT shape_pt_lat, shape_pt_lon FROM shapes WHERE shape_id = ? ORDER BY shape_pt_sequence",
            (shape_id,))]
    return _shape_cache[shape_id]


def _passes(points, lat, lon, limit_m, start=0):
    """Indices where the path passes closest to a point, one per pass (a loop passes twice)."""
    found, best, best_d = [], None, None
    for index in range(start, len(points)):
        d = _meters(lat, lon, points[index][0], points[index][1])
        if d <= limit_m:
            if best is None or d < best_d:
                best, best_d = index, d
        elif best is not None:
            found.append((best, best_d))
            best = best_d = None
    if best is not None:
        found.append((best, best_d))
    return found


def _first_pass(points, lat, lon, limit_m, start):
    passes = _passes(points, lat, lon, limit_m, start)
    return passes[0] if passes else None


def _fit(points, bus, stops):
    """Best way to lay bus + stops along one path: (score, slice, stops matched) or None."""
    best = None
    for bus_index, bus_d in _passes(points, bus[0], bus[1], BUS_ON_PATH_M):
        index, matched, total = bus_index, [], bus_d
        # Look a little behind the bus too, so a stop it has just passed is recognised as behind it
        # (its closest point on the road is before the bus) instead of being drawn as "next".
        back, walked = bus_index, 0.0
        while back > 0 and walked < 600:
            walked += _meters(points[back][0], points[back][1], points[back - 1][0], points[back - 1][1])
            back -= 1
        for stop in stops:
            hit = _first_pass(points, stop["lat"], stop["lon"], STOP_ON_PATH_M, back if not matched else index)
            if hit is None:
                continue
            if not matched and hit[0] < bus_index:
                # Closest road point is behind the bus: already passed (the feed's progress lags).
                # It must still be close to the road, or this is simply a different pass of a loop.
                continue
            # A stop matched far further along than the previous one means we skipped round a loop.
            if matched and hit[0] - index > max(400, len(points) // 2):
                continue
            index, total = hit[0], total + hit[1]
            matched.append((stop, hit[0]))
        needed = max(2, math.ceil(0.7 * len(stops))) if len(stops) >= 2 else 1
        if len(matched) < needed:
            continue
        score = total / (len(matched) + 1) - 25 * len(matched)
        if best is None or score < best[0]:
            best = (score, bus_index, matched)
    return best


def _stops_fallback(bus, stops):
    """Stop-to-stop line without stops already passed and without long straight jumps."""
    stops = [s for s in stops if s.get("lat") is not None and s.get("lon") is not None]
    # Drop leading stops the bus is already past: it sits between stop k and k+1 when going via
    # stop k would be a detour compared with heading straight to k+1.
    while len(stops) >= 2:
        a, b = stops[0], stops[1]
        via = _meters(bus[0], bus[1], a["lat"], a["lon"]) + _meters(a["lat"], a["lon"], b["lat"], b["lon"])
        direct = _meters(bus[0], bus[1], b["lat"], b["lon"])
        if direct < _meters(a["lat"], a["lon"], b["lat"], b["lon"]) and via > direct * 1.35:
            stops = stops[1:]
        else:
            break
    kept, previous = [], bus
    for stop in stops:
        if _meters(previous[0], previous[1], stop["lat"], stop["lon"]) > MAX_STOP_GAP_M:
            break
        kept.append(stop)
        previous = (stop["lat"], stop["lon"])
    return kept


def path_for(conn, database_key: str, route_name: str, bus_lat: float, bus_lon: float, stops: list[dict]) -> dict | None:
    """{"path": [[lon, lat], ...], "stops": [...], "source": "road" | "stops"} or None."""
    bus = (float(bus_lat), float(bus_lon))
    stops = [s for s in stops or [] if s.get("lat") is not None and s.get("lon") is not None]
    if not stops:
        return None
    best = None
    for shape_id in _shape_ids(conn, database_key, route_name):
        points = _shape(conn, shape_id)
        if len(points) < 2:
            continue
        fit = _fit(points, bus, stops)
        if fit and (best is None or fit[0] < best[0][0]):
            best = (fit, points)
    if best:
        (_score, bus_index, matched), points = best
        end = matched[-1][1]
        path = [[bus[1], bus[0]]] + [[lon, lat] for lat, lon in points[bus_index:end + 1]]
        return {"path": path, "stops": [stop for stop, _ in matched], "source": "road"}
    kept = _stops_fallback(bus, stops)
    if not kept:
        return None
    return {"path": [[bus[1], bus[0]]] + [[s["lon"], s["lat"]] for s in kept], "stops": kept, "source": "stops"}


def attach(database, result: dict) -> dict:
    """Add road-following paths to every shown vehicle's heading (in place; safe to call twice)."""
    vehicles = [v for v in (result or {}).get("vehicles") or []
                if isinstance(v.get("heading"), dict) and "path" not in v["heading"]]
    if not vehicles:
        return result
    try:
        conn = sqlite3.connect(str(database))
    except sqlite3.Error:
        return result
    with closing(conn):
        for vehicle in vehicles:
            heading = vehicle["heading"]
            try:
                fitted = path_for(conn, str(database), vehicle.get("route") or result.get("route") or "",
                                  vehicle["lat"], vehicle["lon"], heading.get("stops") or [])
            except (sqlite3.Error, TypeError, ValueError):
                fitted = None
            if fitted is None:
                vehicle["heading"] = None
                continue
            heading["path"], heading["stops"], heading["path_source"] = fitted["path"], fitted["stops"], fitted["source"]
    return result
