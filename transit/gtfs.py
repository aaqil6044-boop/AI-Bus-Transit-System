"""Import a GTFS feed into a small, queryable SQLite database.

The importer uses only Python's standard library so the team can run it on a
college laptop without a complicated environment setup.
"""

from __future__ import annotations

import csv
import io
import sqlite3
import zipfile
from contextlib import contextmanager
from pathlib import Path
from typing import Iterator, TextIO

GTFS_TABLES = (
    "stops.txt",
    "routes.txt",
    "trips.txt",
    "stop_times.txt",
    "shapes.txt",
)

SCHEMA = """
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS stops (
    stop_id TEXT PRIMARY KEY,
    stop_name TEXT NOT NULL,
    stop_lat REAL,
    stop_lon REAL,
    wheelchair_boarding TEXT
);
CREATE TABLE IF NOT EXISTS routes (
    route_id TEXT PRIMARY KEY,
    route_short_name TEXT,
    route_long_name TEXT,
    route_type TEXT
);
CREATE TABLE IF NOT EXISTS trips (
    trip_id TEXT PRIMARY KEY,
    route_id TEXT NOT NULL,
    service_id TEXT,
    trip_headsign TEXT,
    direction_id TEXT,
    shape_id TEXT,
    FOREIGN KEY(route_id) REFERENCES routes(route_id)
);
CREATE TABLE IF NOT EXISTS shapes (
    shape_id TEXT NOT NULL,
    shape_pt_lat REAL NOT NULL,
    shape_pt_lon REAL NOT NULL,
    shape_pt_sequence INTEGER NOT NULL,
    PRIMARY KEY(shape_id, shape_pt_sequence)
);
CREATE TABLE IF NOT EXISTS stop_times (
    trip_id TEXT NOT NULL,
    arrival_time TEXT,
    departure_time TEXT,
    stop_id TEXT NOT NULL,
    stop_sequence INTEGER NOT NULL,
    PRIMARY KEY(trip_id, stop_sequence),
    FOREIGN KEY(trip_id) REFERENCES trips(trip_id),
    FOREIGN KEY(stop_id) REFERENCES stops(stop_id)
);
CREATE INDEX IF NOT EXISTS idx_stops_name ON stops(stop_name);
CREATE INDEX IF NOT EXISTS idx_trips_route ON trips(route_id);
CREATE INDEX IF NOT EXISTS idx_stop_times_stop ON stop_times(stop_id, trip_id, stop_sequence);
CREATE INDEX IF NOT EXISTS idx_shapes_id_sequence ON shapes(shape_id, shape_pt_sequence);
"""


def _number(value: str | None) -> float | None:
    try:
        return float(value) if value else None
    except ValueError:
        return None


@contextmanager
def _open_gtfs_file(source: Path, name: str) -> Iterator[TextIO]:
    """Open a named GTFS file from either a directory or a ZIP archive."""
    if source.is_dir():
        with (source / name).open(encoding="utf-8-sig", newline="") as file:
            yield file
        return

    with zipfile.ZipFile(source) as archive:
        matches = [member for member in archive.namelist() if member.endswith(name)]
        if not matches:
            raise FileNotFoundError(f"{name} is missing from {source}")
        with archive.open(matches[0]) as raw_file:
            with io.TextIOWrapper(raw_file, encoding="utf-8-sig", newline="") as file:
                yield file


def _rows(source: Path, name: str) -> Iterator[dict[str, str]]:
    with _open_gtfs_file(source, name) as file:
        yield from csv.DictReader(file)


def _create_connection(database: Path) -> sqlite3.Connection:
    connection = sqlite3.connect(database)
    connection.executescript(
        "DROP TABLE IF EXISTS stop_times; DROP TABLE IF EXISTS trips; "
        "DROP TABLE IF EXISTS shapes; "
        "DROP TABLE IF EXISTS routes; DROP TABLE IF EXISTS stops;"
    )
    connection.executescript(SCHEMA)
    return connection


def import_gtfs(source: str | Path, database: str | Path) -> dict[str, int]:
    """Replace the local database with stops, routes, trips and stop times."""
    source_path = Path(source)
    database_path = Path(database)
    if not source_path.exists():
        raise FileNotFoundError(f"GTFS source does not exist: {source_path}")

    counts = {
        "stops": 0,
        "routes": 0,
        "trips": 0,
        "stop_times": 0,
        "shape_points": 0,
    }
    with _create_connection(database_path) as connection:
        connection.executemany(
            "INSERT INTO stops VALUES (?, ?, ?, ?, ?)",
            (
                (
                    row["stop_id"],
                    row.get("stop_name") or row["stop_id"],
                    _number(row.get("stop_lat")),
                    _number(row.get("stop_lon")),
                    row.get("wheelchair_boarding"),
                )
                for row in _rows(source_path, "stops.txt")
            ),
        )
        counts["stops"] = connection.execute("SELECT count(*) FROM stops").fetchone()[0]

        connection.executemany(
            "INSERT INTO routes VALUES (?, ?, ?, ?)",
            (
                (
                    row["route_id"],
                    row.get("route_short_name"),
                    row.get("route_long_name"),
                    row.get("route_type"),
                )
                for row in _rows(source_path, "routes.txt")
            ),
        )
        counts["routes"] = connection.execute("SELECT count(*) FROM routes").fetchone()[0]

        connection.executemany(
            "INSERT INTO trips VALUES (?, ?, ?, ?, ?, ?)",
            (
                (
                    row["trip_id"],
                    row["route_id"],
                    row.get("service_id"),
                    row.get("trip_headsign"),
                    row.get("direction_id"),
                    row.get("shape_id"),
                )
                for row in _rows(source_path, "trips.txt")
            ),
        )
        counts["trips"] = connection.execute("SELECT count(*) FROM trips").fetchone()[0]

        batch: list[tuple[str, str | None, str | None, str, int]] = []
        for row in _rows(source_path, "stop_times.txt"):
            batch.append(
                (
                    row["trip_id"],
                    row.get("arrival_time"),
                    row.get("departure_time"),
                    row["stop_id"],
                    int(row.get("stop_sequence") or 0),
                )
            )
            if len(batch) >= 5_000:
                connection.executemany("INSERT INTO stop_times VALUES (?, ?, ?, ?, ?)", batch)
                batch.clear()
        if batch:
            connection.executemany("INSERT INTO stop_times VALUES (?, ?, ?, ?, ?)", batch)
        counts["stop_times"] = connection.execute("SELECT count(*) FROM stop_times").fetchone()[0]

        # Shapes are optional in GTFS, but this feed contains them. They are
        # vital for drawing bus alignments without inventing road geometry.
        batch = []
        for row in _rows(source_path, "shapes.txt"):
            lat = _number(row.get("shape_pt_lat"))
            lon = _number(row.get("shape_pt_lon"))
            if lat is None or lon is None:
                continue
            batch.append(
                (
                    row["shape_id"],
                    lat,
                    lon,
                    int(row.get("shape_pt_sequence") or 0),
                )
            )
            if len(batch) >= 5_000:
                connection.executemany("INSERT INTO shapes VALUES (?, ?, ?, ?)", batch)
                batch.clear()
        if batch:
            connection.executemany("INSERT INTO shapes VALUES (?, ?, ?, ?)", batch)
        counts["shape_points"] = connection.execute("SELECT count(*) FROM shapes").fetchone()[0]
        # Persist query statistics so the route planner chooses indexed query
        # plans immediately after an import, rather than becoming slow on its
        # first presentation-day search.
        connection.execute("ANALYZE")

    return counts
