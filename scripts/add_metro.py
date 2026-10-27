"""Add the official Namma Metro (BMRCL) timetable so journeys can combine metro and bus.

Download the metro GTFS zip from the Karnataka DULT Transit Data Hub (https://tdh.dult-karnataka.com),
then run, from the project folder:

    python scripts/add_metro.py path\\to\\bmrcl_gtfs.zip

What it does (nothing is invented; everything comes from the file you give it):
  1. checks the file is a GTFS feed that contains metro routes (route_type 1);
  2. copies it to data/metro_gtfs.zip;
  3. adds the metro stations to the stop search (named "<station> (Metro)") and the metro lines to the
     route list, replacing any earlier metro import;
  4. adds the feed to otp/build-config.json.

Then rebuild the route graph (build-otp-graph.ps1) and restart the route engine and the app.
Re-run this after re-importing the BMTC timetable, because that import rebuilds the stop database.
"""
from __future__ import annotations

import csv
import io
import json
import shutil
import sqlite3
import sys
import zipfile
from contextlib import closing
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PREFIX = "METRO:"
METRO_ROUTE_TYPES = {"1", "2", "12"}     # subway / rail / monorail in GTFS terms
FEED = {"type": "gtfs", "source": "../data/metro_gtfs.zip", "feedId": "METRO"}


def _rows(archive: zipfile.ZipFile, name: str) -> list[dict]:
    member = next((item for item in archive.namelist() if item.rsplit("/", 1)[-1] == name), None)
    if member is None:
        return []
    with archive.open(member) as raw:
        return list(csv.DictReader(io.TextIOWrapper(raw, encoding="utf-8-sig")))


def read_feed(source: Path) -> tuple[list[dict], list[dict]]:
    """(metro stations, metro routes) from a GTFS zip. Raises ValueError when it is not usable."""
    try:
        archive = zipfile.ZipFile(source)
    except (zipfile.BadZipFile, OSError) as error:
        raise ValueError(f"{source} is not a readable zip file ({error}).") from None
    with archive:
        missing = [name for name in ("stops.txt", "routes.txt", "trips.txt", "stop_times.txt")
                   if not any(item.rsplit("/", 1)[-1] == name for item in archive.namelist())]
        if missing:
            raise ValueError("This is not a complete GTFS feed; missing: " + ", ".join(missing))
        routes = [row for row in _rows(archive, "routes.txt") if str(row.get("route_type", "")).strip() in METRO_ROUTE_TYPES]
        if not routes:
            raise ValueError("No metro routes (route_type 1) were found in this file. Is it the BMRCL feed?")
        stations = []
        for row in _rows(archive, "stops.txt"):
            kind = str(row.get("location_type", "0") or "0").strip()
            if kind not in ("0", "1"):
                continue                          # entrances and other station parts
            try:
                lat, lon = float(row["stop_lat"]), float(row["stop_lon"])
            except (KeyError, TypeError, ValueError):
                continue
            if not (12.65 <= lat <= 13.45 and 77.20 <= lon <= 78.00):
                continue
            name = str(row.get("stop_name") or "").strip()
            if name:
                stations.append({"id": row["stop_id"], "name": name, "lat": lat, "lon": lon, "kind": kind})
        # When the feed lists stations (type 1) with platforms under them, list each station once.
        if any(s["kind"] == "1" for s in stations):
            stations = [s for s in stations if s["kind"] == "1"]
        if not stations:
            raise ValueError("No metro stations with coordinates inside Bengaluru were found.")
        return stations, routes


def station_label(name: str) -> str:
    clean = name.strip()
    return clean if "metro" in clean.lower() else f"{clean} (Metro)"


def add_to_database(database: Path, stations: list[dict], routes: list[dict]) -> None:
    with closing(sqlite3.connect(str(database))) as conn, conn:
        conn.execute("DELETE FROM stops WHERE stop_id LIKE ?", (PREFIX + "%",))
        conn.execute("DELETE FROM routes WHERE route_id LIKE ?", (PREFIX + "%",))
        conn.executemany("INSERT INTO stops VALUES (?, ?, ?, ?, ?)",
                         [(PREFIX + s["id"], station_label(s["name"]), s["lat"], s["lon"], None) for s in stations])
        conn.executemany("INSERT INTO routes VALUES (?, ?, ?, ?)",
                         [(PREFIX + r["route_id"], r.get("route_short_name") or r.get("route_long_name") or "Metro",
                           r.get("route_long_name") or "", r.get("route_type")) for r in routes])


def add_to_build_config(config_path: Path) -> bool:
    config = json.loads(config_path.read_text(encoding="utf-8"))
    feeds = config.setdefault("transitFeeds", [])
    if any(feed.get("feedId") == FEED["feedId"] for feed in feeds):
        return False
    feeds.append(dict(FEED))
    config_path.write_text(json.dumps(config, indent=2) + "\n", encoding="utf-8")
    return True


def main(argv=None) -> int:
    argv = sys.argv[1:] if argv is None else argv
    if len(argv) != 1:
        print(__doc__)
        return 2
    source = Path(argv[0])
    database = ROOT / "data" / "bengaluru_transit.db"
    if not database.exists():
        print("Import the BMTC timetable first: python scripts/import_gtfs.py data/bmtc_gtfs.zip")
        return 1
    try:
        stations, routes = read_feed(source)
    except ValueError as error:
        print(f"Not added: {error}")
        return 1
    target = ROOT / "data" / "metro_gtfs.zip"
    if source.resolve() != target.resolve():
        shutil.copyfile(source, target)
    add_to_database(database, stations, routes)
    added = add_to_build_config(ROOT / "otp" / "build-config.json")
    print(f"Added {len(stations)} metro stations and {len(routes)} metro lines.")
    print("Route-engine settings " + ("updated." if added else "already include the metro feed."))
    print("Next: rebuild the route graph (build-otp-graph.ps1), then restart the route engine and the app.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
