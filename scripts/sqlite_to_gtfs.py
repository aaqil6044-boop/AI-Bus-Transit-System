"""Convert the project's SQLite GTFS tables into a standards-shaped GTFS ZIP.

The existing project database contains stops/routes/trips/stop_times but not the
full GTFS calendar tables. For the local prototype we therefore generate a
simple daily service calendar. This is a technical bridge for OTP; it should be
replaced by the original verified GTFS ZIP when that source is available.
"""

from __future__ import annotations

import csv
import sqlite3
import sys
import zipfile
from datetime import date
from pathlib import Path

FEED_ID = "BMTC"


def write_csv(path: Path, fieldnames: list[str], rows):
    with path.open("w", encoding="utf-8", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(rows)


def normalize_time(value: str) -> str:
    parts = str(value).strip().split(":")
    if len(parts) != 3:
        raise ValueError(f"Invalid GTFS time: {value!r}")
    h, m, s = (int(float(p)) for p in parts)
    if not (0 <= m <= 59 and 0 <= s <= 59 and 0 <= h <= 47):
        raise ValueError(f"Invalid GTFS time: {value!r}")
    return f"{h:02d}:{m:02d}:{s:02d}"


def main() -> int:
    if len(sys.argv) != 3:
        print("Usage: python scripts/sqlite_to_gtfs.py data/bengaluru_transit.db otp/bmtc_generated.gtfs.zip")
        return 2

    db_path = Path(sys.argv[1]).resolve()
    zip_path = Path(sys.argv[2]).resolve()

    if not db_path.exists():
        print(f"ERROR: SQLite database not found: {db_path}")
        return 1

    work = zip_path.parent / "_gtfs_build"
    if work.exists():
        import shutil
        shutil.rmtree(work)
    work.mkdir(parents=True)

    con = sqlite3.connect(str(db_path))
    con.row_factory = sqlite3.Row

    required = {
        "stops": {"stop_id", "stop_name", "stop_lat", "stop_lon"},
        "routes": {"route_id", "route_short_name", "route_long_name"},
        "trips": {"trip_id", "route_id", "trip_headsign"},
        "stop_times": {"trip_id", "stop_id", "stop_sequence", "arrival_time", "departure_time"},
    }
    for table, columns in required.items():
        cols = {row[1] for row in con.execute(f"PRAGMA table_info({table})")}
        missing = columns - cols
        if missing:
            raise RuntimeError(f"{table} is missing columns: {', '.join(sorted(missing))}")

    stops = con.execute("""
        SELECT stop_id, stop_name, stop_lat, stop_lon
        FROM stops
        WHERE stop_lat IS NOT NULL AND stop_lon IS NOT NULL
        ORDER BY stop_id
    """).fetchall()

    routes = con.execute("""
        SELECT route_id, route_short_name, route_long_name
        FROM routes
        ORDER BY route_id
    """).fetchall()

    trips = con.execute("""
        SELECT trip_id, route_id, trip_headsign
        FROM trips
        ORDER BY trip_id
    """).fetchall()

    stop_times = con.execute("""
        SELECT trip_id, stop_id, stop_sequence, arrival_time, departure_time
        FROM stop_times
        ORDER BY trip_id, CAST(stop_sequence AS INTEGER)
    """).fetchall()
    con.close()

    write_csv(work / "agency.txt",
              ["agency_id", "agency_name", "agency_url", "agency_timezone"],
              [{"agency_id": FEED_ID, "agency_name": "BMTC", "agency_url": "https://mybmtc.karnataka.gov.in/", "agency_timezone": "Asia/Kolkata"}])

    write_csv(work / "stops.txt",
              ["stop_id", "stop_name", "stop_lat", "stop_lon"],
              [dict(row) for row in stops])

    write_csv(work / "routes.txt",
              ["route_id", "agency_id", "route_short_name", "route_long_name", "route_type"],
              [{**dict(row), "agency_id": FEED_ID, "route_type": 3} for row in routes])

    write_csv(work / "trips.txt",
              ["route_id", "service_id", "trip_id", "trip_headsign"],
              [{**dict(row), "service_id": "BMTC_DAILY"} for row in trips])

    st_rows = []
    for row in stop_times:
        item = dict(row)
        item["arrival_time"] = normalize_time(item["arrival_time"])
        item["departure_time"] = normalize_time(item["departure_time"])
        st_rows.append(item)

    write_csv(work / "stop_times.txt",
              ["trip_id", "arrival_time", "departure_time", "stop_id", "stop_sequence"],
              st_rows)

    write_csv(work / "calendar.txt",
              ["service_id", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday", "start_date", "end_date"],
              [{
                  "service_id": "BMTC_DAILY",
                  "monday": 1, "tuesday": 1, "wednesday": 1,
                  "thursday": 1, "friday": 1, "saturday": 1, "sunday": 1,
                  "start_date": "20260101", "end_date": "20281231",
              }])

    write_csv(work / "feed_info.txt",
              ["feed_publisher_name", "feed_publisher_url", "feed_lang", "feed_start_date", "feed_end_date", "feed_version"],
              [{
                  "feed_publisher_name": "Bengaluru Adaptive Transit Assistant",
                  "feed_publisher_url": "http://localhost:8000",
                  "feed_lang": "en",
                  "feed_start_date": "20260101",
                  "feed_end_date": "20281231",
                  "feed_version": "sqlite-bridge",
              }])

    zip_path.parent.mkdir(parents=True, exist_ok=True)
    if zip_path.exists():
        zip_path.unlink()

    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as z:
        for file in sorted(work.glob("*.txt")):
            z.write(file, file.name)

    print(f"GTFS ZIP created: {zip_path}")
    print(f"Stops: {len(stops):,}")
    print(f"Routes: {len(routes):,}")
    print(f"Trips: {len(trips):,}")
    print(f"Stop times: {len(stop_times):,}")
    print("NOTE: calendar.txt is a generated daily calendar because the SQLite schema does not include GTFS service calendars.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
