"""Bus vs auto vs cab: cost and time for the same trip.

- Bus fare: BMTC's own fare tables from the timetable feed (fare_rules between fare zones, per route).
  The feed lists exact fares for AC routes and for many ordinary zone pairs, not all. For an ordinary
  bus without an exact rule, the fare is estimated as the median BMTC ordinary fare for the same distance
  (from the same tables: 5,12,18,23,24,28,30,33 ... rising with distance) and marked "about". An AC
  (Vajra / Vayu Vajra) ride without an exact rule gets no fare: their scale is different.
- Auto: Bengaluru meter tariff from 1 Aug 2025: Rs 36 for the first 2 km, Rs 18 per km after;
  1.5x between 22:00 and 05:00. Waiting time and tips are not included.
- Cab: Karnataka uniform city-taxi fare (Feb 2024 order), cars up to Rs 10 lakh: Rs 100 for the first
  4 km, Rs 24 per km after; +10% between 00:00 and 06:00; +5% GST. App prices can differ.
- Road distance: the route engine's driving route (car), else straight line x 1.35.
- Road time: road distance at Bengaluru's measured average traffic (TomTom Traffic Index 2025:
  36 min 9 s per 10 km; morning rush 41 min 6 s; evening rush 45 min 27 s). An estimate, not live traffic.
"""
from __future__ import annotations

import csv
import io
import json
import math
import sqlite3
import zipfile
from contextlib import closing
from datetime import datetime
from pathlib import Path
from urllib.request import ProxyHandler, Request, build_opener

AUTO = {"base": 36.0, "base_km": 2.0, "per_km": 18.0, "night": 1.5, "night_hours": (22, 5)}
CAB = {"base": 100.0, "base_km": 4.0, "per_km": 24.0, "night": 1.10, "night_hours": (0, 6), "gst": 0.05}
MINUTES_PER_KM = {"average": 3.615, "morning_rush": 4.11, "evening_rush": 4.545}
DETOUR = 1.35
SOURCES = [
    "Bus: BMTC fare tables in the timetable feed",
    "Auto: Bengaluru meter tariff from 1 Aug 2025 (Rs 36 first 2 km, Rs 18/km)",
    "Cab: Karnataka uniform taxi fare, Feb 2024 (Rs 100 first 4 km, Rs 24/km, +5% GST); app prices vary",
    "Road time: TomTom Traffic Index 2025 average for Bengaluru, not live traffic",
]


# ------------------------------------------------------------------ fare tables
def has_tables(conn) -> bool:
    names = {row[0] for row in conn.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}
    return {"fare_zones", "fare_prices", "fare_rules", "fare_by_km"} <= names


def ensure_tables(database, gtfs_zip) -> bool:
    """Copy BMTC's fare tables from the timetable zip into the stop database once (a few seconds).
    The tables then travel with the database (e.g. to the Azure server). Returns True when present."""
    database, gtfs_zip = Path(database), Path(gtfs_zip)
    if not database.exists():
        return False
    with closing(sqlite3.connect(str(database))) as conn:
        if has_tables(conn):
            return True
        if not gtfs_zip.exists():
            return False
        with conn:
            conn.executescript("DROP TABLE IF EXISTS fare_zones; DROP TABLE IF EXISTS fare_prices; "
                               "DROP TABLE IF EXISTS fare_rules; DROP TABLE IF EXISTS fare_by_km;")
        with zipfile.ZipFile(gtfs_zip) as archive:
            names = set(archive.namelist())
            if not {"fare_attributes.txt", "fare_rules.txt", "stops.txt"} <= names:
                return False
            read = lambda name: csv.DictReader(io.TextIOWrapper(archive.open(name), encoding="utf-8-sig"))
            prices = [(row["fare_id"], float(row["price"])) for row in read("fare_attributes.txt")
                      if row.get("fare_id") and _number(row.get("price")) is not None]
            rules = [(row.get("route_id") or "", row.get("origin_id") or "", row.get("destination_id") or "", row["fare_id"])
                     for row in read("fare_rules.txt") if row.get("fare_id")]
            zones = [(row["stop_id"], row["zone_id"]) for row in read("stops.txt") if row.get("zone_id")]
        with conn:
            conn.executescript("""
                CREATE TABLE fare_zones (stop_id TEXT PRIMARY KEY, zone_id TEXT NOT NULL);
                CREATE TABLE fare_prices (fare_id TEXT PRIMARY KEY, price REAL NOT NULL);
                CREATE TABLE fare_rules (route_id TEXT, origin_zone TEXT, destination_zone TEXT, fare_id TEXT);
                CREATE INDEX fare_rules_lookup ON fare_rules (origin_zone, destination_zone, route_id);""")
            conn.executemany("INSERT OR IGNORE INTO fare_zones VALUES (?, ?)", zones)
            conn.executemany("INSERT OR IGNORE INTO fare_prices VALUES (?, ?)", prices)
            conn.executemany("INSERT INTO fare_rules VALUES (?, ?, ?, ?)", rules)
            _build_distance_table(conn)
        print(f"[Fares] added {len(rules)} BMTC fare rules to the stop database", flush=True)
        return True


def _build_distance_table(conn) -> None:
    """Median ordinary fare per whole kilometre (straight line between fare-zone centres)."""
    import statistics
    centres = {zone: (lat, lon) for zone, lat, lon in conn.execute(
        "SELECT z.zone_id, AVG(s.stop_lat), AVG(s.stop_lon) FROM fare_zones z JOIN stops s USING (stop_id) GROUP BY z.zone_id")}
    bins: dict = {}
    for origin, destination, price in conn.execute(
            "SELECT r.origin_zone, r.destination_zone, p.price FROM fare_rules r JOIN fare_prices p USING (fare_id) "
            "WHERE r.route_id = ''"):
        if origin in centres and destination in centres:
            bins.setdefault(int(_straight_km(centres[origin], centres[destination])), []).append(price)
    conn.execute("CREATE TABLE fare_by_km (km INTEGER PRIMARY KEY, price REAL NOT NULL, samples INTEGER NOT NULL)")
    conn.executemany("INSERT INTO fare_by_km VALUES (?, ?, ?)",
                     [(km, statistics.median(prices), len(prices)) for km, prices in bins.items() if len(prices) >= 30])


def _number(value):
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


AC_PREFIXES = ("V-", "KIA-", "VAJRA", "VAYU")


def bus_fare(conn, route_id: str, from_stop: str, to_stop: str, route_name: str = "") -> tuple[float | None, bool]:
    """(fare, exact) for one ride. Exact from BMTC's rule when there is one; otherwise, for an ordinary
    bus, BMTC's median ordinary fare for that distance (exact=False); otherwise (None, False)."""
    zone = dict(conn.execute("SELECT stop_id, zone_id FROM fare_zones WHERE stop_id IN (?, ?)", (from_stop, to_stop)))
    origin, destination = zone.get(str(from_stop)), zone.get(str(to_stop))
    exact = _exact_fare(conn, route_id, origin, destination) if origin and destination else None
    if exact is not None:
        return exact, True
    if str(route_name or "").upper().startswith(AC_PREFIXES):
        return None, False
    points = dict((stop_id, (lat, lon)) for stop_id, lat, lon in conn.execute(
        "SELECT stop_id, stop_lat, stop_lon FROM stops WHERE stop_id IN (?, ?)", (from_stop, to_stop)))
    if str(from_stop) not in points or str(to_stop) not in points:
        return None, False
    km = int(_straight_km(points[str(from_stop)], points[str(to_stop)]))
    row = conn.execute("SELECT price FROM fare_by_km WHERE km <= ? ORDER BY km DESC LIMIT 1", (km,)).fetchone()
    return (float(row[0]), False) if row else (None, False)


def _exact_fare(conn, route_id, origin, destination):
    row = conn.execute(
        """SELECT p.price FROM fare_rules r JOIN fare_prices p ON p.fare_id = r.fare_id
           WHERE r.origin_zone = ? AND r.destination_zone = ? AND (r.route_id = ? OR r.route_id = '')
           ORDER BY CASE WHEN r.route_id = ? THEN 0 ELSE 1 END LIMIT 1""",
        (origin, destination, str(route_id or ""), str(route_id or ""))).fetchone()
    return float(row[0]) if row else None


# ------------------------------------------------------------------ auto and cab
def _night(hour: int, hours: tuple[int, int]) -> bool:
    start, end = hours
    return hour >= start or hour < end if start > end else start <= hour < end


def auto_fare(km: float, hour: int = 12) -> int:
    fare = AUTO["base"] + max(0.0, km - AUTO["base_km"]) * AUTO["per_km"]
    if _night(hour, AUTO["night_hours"]):
        fare *= AUTO["night"]
    return int(math.ceil(fare))


def cab_fare(km: float, hour: int = 12) -> int:
    fare = CAB["base"] + max(0.0, km - CAB["base_km"]) * CAB["per_km"]
    if _night(hour, CAB["night_hours"]):
        fare *= CAB["night"]
    return int(math.ceil(fare * (1 + CAB["gst"])))


def road_minutes(km: float, hour: int = 12, weekday: bool = True) -> int:
    period = "average"
    if weekday and 8 <= hour < 11:
        period = "morning_rush"
    elif weekday and 17 <= hour < 21:
        period = "evening_rush"
    return max(1, int(round(km * MINUTES_PER_KM[period])))


def _straight_km(a, b) -> float:
    x = math.radians(b[1] - a[1]) * math.cos(math.radians((a[0] + b[0]) / 2))
    return 6371.0 * math.hypot(x, math.radians(b[0] - a[0]))


def road_km(origin, destination, endpoint: str | None = None, transport=None) -> tuple[float, str]:
    """(km, "road" | "estimate"). Asks the route engine for a driving route; falls back to a straight
    line x 1.35 (typical city detour)."""
    query = ("{ planConnection(origin:{location:{coordinate:{latitude:%f,longitude:%f}}}, "
             "destination:{location:{coordinate:{latitude:%f,longitude:%f}}}, modes:{directOnly:true, direct:[CAR]}, first:1) "
             "{ edges { node { legs { distance } } } } }") % (origin[0], origin[1], destination[0], destination[1])
    try:
        if transport:
            data = transport(query)
        else:
            from transit import otp
            request = Request(endpoint or otp.ENDPOINT, json.dumps({"query": query}).encode(), {"Content-Type": "application/json"})
            with build_opener(ProxyHandler({})).open(request, timeout=6) as response:
                data = json.load(response)
        edges = data["data"]["planConnection"]["edges"]
        meters = sum(float(leg["distance"]) for leg in edges[0]["node"]["legs"])
        if meters > 0:
            return round(meters / 1000, 1), "road"
    except Exception:
        pass
    return round(_straight_km(origin, destination) * DETOUR, 1), "estimate"


def compare(database, plan: dict, *, transport=None) -> None:
    """Add plan["compare"] (auto/cab for the whole trip) and route["bus_fare"] for each option (in place)."""
    origin, destination = plan.get("origin") or {}, plan.get("destination") or {}
    try:
        a = (float(origin["stop_lat"]), float(origin["stop_lon"]))
        b = (float(destination["stop_lat"]), float(destination["stop_lon"]))
    except (KeyError, TypeError, ValueError):
        return
    try:
        when = datetime.fromisoformat((plan.get("requested") or {}).get("iso") or "")
    except ValueError:
        when = datetime.now()
    km, kind = road_km(a, b, transport=transport)
    hour, weekday = when.hour, when.weekday() < 5
    minutes = road_minutes(km, hour, weekday)
    plan["compare"] = {
        "road_km": km, "road_distance": kind,
        "auto": {"fare": auto_fare(km, hour), "minutes": minutes, "night": _night(hour, AUTO["night_hours"])},
        "cab": {"fare": cab_fare(km, hour), "minutes": minutes, "night": _night(hour, CAB["night_hours"])},
        "sources": SOURCES,
    }
    try:
        with closing(sqlite3.connect(str(database))) as conn:
            if not has_tables(conn):
                return
            for route in plan.get("routes") or []:
                legs = [leg for leg in route.get("legs") or [] if leg.get("transit")]
                if not legs or any(leg.get("role") == "metro" for leg in legs):
                    continue
                fares = [bus_fare(conn, leg.get("route_id"), leg.get("from_stop_id"), leg.get("to_stop_id"),
                                  leg.get("route_name") or "") for leg in legs]
                for leg, (fare, exact) in zip(legs, fares):
                    if fare is not None:          # per ride, for "wait or walk" (what walking this stretch saves)
                        leg["fare"] = {"amount": round(fare), "exact": bool(exact)}
                known = [fare for fare, _exact in fares if fare is not None]
                route["bus_fare"] = {"total": round(sum(known)) if len(known) == len(fares) else None,
                                     "exact": all(exact for _fare, exact in fares),
                                     "legs_without_fare": len(fares) - len(known)}
    except sqlite3.Error:
        return
