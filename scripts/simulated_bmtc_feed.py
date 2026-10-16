"""SIMULATED BMTC live feed, for testing the live-bus screens when the real feed is unavailable.

Nothing here is real: bus positions are invented. Stop ORDER comes from the imported GTFS data,
so direction logic (up/down, ahead of / past your stop) can be exercised realistically.

Usage (two windows, from the project folder):
    python scripts/simulated_bmtc_feed.py            # moving buses; add --static for fixed positions
    set BMTC_API_ROOT=http://127.0.0.1:8790/WebAPI   (Windows cmd; PowerShell: $env:BMTC_API_ROOT=...)
    python app.py
Every bus then shows up as a live vehicle in the app. Remove the variable to go back to the real feed.
"""
import argparse
import json
import sqlite3
import time
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

IST = timezone(timedelta(hours=5, minutes=30))
DB = Path(__file__).resolve().parent.parent / "data" / "bengaluru_transit.db"
STATIC = False
FIXED = (2, 4, 1, 3)  # station positions used with --static: 2 fresh, 1 stale, 1 without a timestamp
db = None
routes = {}


def stop_sequence(route_id, direction):
    trip = db.execute(
        "SELECT t.trip_id FROM trips t WHERE route_id=? AND direction_id=? "
        "ORDER BY (SELECT COUNT(*) FROM stop_times s WHERE s.trip_id=t.trip_id) DESC LIMIT 1",
        (route_id, direction)).fetchone()
    if not trip:
        return []
    return [dict(row) for row in db.execute(
        "SELECT s.stop_id, s.stop_name, s.stop_lat lat, s.stop_lon lon FROM stop_times st "
        "JOIN stops s USING(stop_id) WHERE st.trip_id=? ORDER BY st.stop_sequence", (trip["trip_id"],))]


def stamp(age):
    if age is None:
        return ""
    return (datetime.now(IST) - timedelta(seconds=age)).strftime("%d-%m-%Y %H:%M:%S")


def branch(stops, tag):
    count = len(stops)
    if not count:
        return {"data": [], "mapData": []}
    ticks = int(time.time() // 15)
    buses = []
    for k, (offset, age) in enumerate(((0, 8), (count // 4, 20), (count // 2, 700), (3 * count // 4, None))):
        position = (FIXED[k] if STATIC else offset + ticks) % count
        s = stops[position]
        buses.append((position, {"vehicleid": f"{tag}{k}", "vehiclenumber": f"SIM-{tag.upper()}{k}",
                                 "centerlat": s["lat"], "centerlong": s["lon"], "lastrefreshon": stamp(age),
                                 "eta": "", "currentlocationid": s["stop_id"]}))
    groups = [{"stationid": s["stop_id"], "stationname": s["stop_name"], "centerlat": s["lat"],
               "centerlong": s["lon"], "vehicleDetails": []} for s in stops]
    for position, bus in buses:
        for ahead, group in enumerate(groups[position:]):
            entry = dict(bus)
            # Simulated ETA, ~2 min per stop, for buses with a timestamp (BMTC's format: YYYY-MM-DD HH:MM:SS).
            if ahead and bus["lastrefreshon"]:
                entry["eta"] = (datetime.now(IST) + timedelta(minutes=2 * ahead)).strftime("%Y-%m-%d %H:%M:%S")
            group["vehicleDetails"].append(entry)
    return {"data": groups, "mapData": []}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))) or b"{}")
        endpoint = self.path.rsplit("/", 1)[-1]
        if endpoint == "SearchRoute_v2":
            text = str(body.get("routetext", "")).strip().lower()
            result = {"data": [{"routeno": name, "routeparentid": int(rid)} for rid, name in routes.items()
                               if name.lower() == text or name.lower().startswith(text + " ")]}
        elif endpoint == "SearchByRouteDetails_v4":
            rid = str(body["routeid"])
            result = {"up": branch(stop_sequence(rid, 1), "u"), "down": branch(stop_sequence(rid, 0), "d")}
        else:
            result = {}
        data = json.dumps(result).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


def main():
    global STATIC, db
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--port", type=int, default=8790)
    parser.add_argument("--static", action="store_true", help="fixed bus positions instead of moving ones")
    args = parser.parse_args()
    STATIC = args.static
    if not DB.exists():
        raise SystemExit(f"Stop database not found at {DB}. Run scripts/import_gtfs.py first.")
    db = sqlite3.connect(str(DB), check_same_thread=False)
    db.row_factory = sqlite3.Row
    routes.update({row["route_id"]: row["route_short_name"] for row in db.execute("SELECT route_id, route_short_name FROM routes")})
    print(f"SIMULATED BMTC feed on http://127.0.0.1:{args.port}/WebAPI  (invented bus positions, real stop order)")
    ThreadingHTTPServer(("127.0.0.1", args.port), Handler).serve_forever()


if __name__ == "__main__":
    main()
