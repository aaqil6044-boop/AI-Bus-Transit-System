"""Honest arrival window: measured range, city-wide range, no range without evidence, and missed connections."""
import os
import sqlite3
import tempfile
import unittest
from contextlib import closing
from datetime import datetime, timedelta, timezone
from pathlib import Path

os.environ.setdefault("GEOCODER", "off")
os.environ.setdefault("RELIABILITY", "off")
from transit import reliability, window          # noqa: E402

IST = timezone(timedelta(hours=5, minutes=30))


def timetable():
    path = Path(tempfile.mkdtemp()) / "t.db"
    with closing(sqlite3.connect(path)) as conn, conn:
        conn.executescript("""
            CREATE TABLE routes (route_id TEXT PRIMARY KEY, route_short_name TEXT, route_long_name TEXT, route_type TEXT);
            CREATE TABLE trips (trip_id TEXT PRIMARY KEY, route_id TEXT, service_id TEXT, trip_headsign TEXT, direction_id TEXT, shape_id TEXT);
            CREATE TABLE stop_times (trip_id TEXT, arrival_time TEXT, departure_time TEXT, stop_id TEXT, stop_sequence INTEGER);""")
        conn.executemany("INSERT INTO routes VALUES (?,?,'','3')", [("r1", "KIA-9"), ("r2", "500-D")])
        conn.executemany("INSERT INTO trips VALUES (?,?,'1','','0','')", [("a", "r1"), ("b", "r1"), ("c", "r2"), ("d", "r1")])
        conn.executemany("INSERT INTO stop_times VALUES (?,?,?,?,?)", [
            ("a", "09:30:00", "09:30:00", "X", 1), ("c", "09:35:00", "09:35:00", "X", 1),
            ("b", "09:52:00", "09:52:00", "X", 1), ("d", "24:15:00", "24:15:00", "X", 1)])
    return path


def journey(arrival_reliability=None, connection=None, role="bus"):
    legs = [{"transit": True, "role": "bus", "route_name": "500-D", "from": {"name": "A"}, "to": {"name": "X"},
             "departure_iso": "2026-11-09T09:00:00+05:30", "arrival_iso": "2026-11-09T09:25:00+05:30"},
            {"transit": True, "role": role, "route_name": "KIA-9", "from": {"name": "X"}, "to": {"name": "Hebbala"},
             "from_stop_id": "X", "departure_iso": "2026-11-09T09:30:00+05:30", "arrival_iso": "2026-11-09T09:58:00+05:30",
             "arrival_reliability": arrival_reliability, "connection": connection}]
    return {"arrival_iso": "2026-11-09T10:02:00+05:30", "legs": legs}


class WindowTests(unittest.TestCase):
    def setUp(self):
        window._city_cache.clear()
        self.empty = Path(tempfile.mkdtemp()) / "none.db"

    def test_measured_range_at_the_stop(self):
        learned = {"range_minutes": [-3, 9], "scope": "stop", "samples": 25, "days": 4, "period": "weekdays"}
        found = window.arrival_window(journey(learned), path=self.empty)
        self.assertEqual((found["basis"], found["earliest"], found["latest"]), ("stop", "09:59", "10:11"))
        self.assertEqual(found["scheduled"], "10:02")

    def test_early_running_is_capped(self):
        learned = {"range_minutes": [-14, 2], "scope": "route", "samples": 25, "days": 4, "period": "weekdays"}
        found = window.arrival_window(journey(learned), path=self.empty)
        self.assertEqual(found["earliest"], "09:57", "never more than 5 min before the timetable")

    def test_no_measurements_no_range(self):
        found = window.arrival_window(journey(), path=self.empty)
        self.assertEqual(found["basis"], "timetable")
        self.assertIsNone(found["earliest"])
        self.assertIsNone(found["latest"])

    def test_metro_last_leg_is_timetable(self):
        self.assertEqual(window.arrival_window(journey(role="metro"), path=self.empty)["basis"], "metro")

    def test_city_wide_range_when_this_bus_has_no_measurements(self):
        path = Path(tempfile.mkdtemp()) / "rel.db"
        rows = []
        for day in ("2026-11-02", "2026-11-03", "2026-11-04"):
            for n, delay in enumerate([2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 3, 5, 7, 9]):
                rows.append(("335-E", "335-E", "up", f"s{n}", f"v{n}", day, f"09:{n + 10:02d}", "", delay, 9, 0))
        with closing(reliability._connect(path)) as conn, conn:
            conn.executemany("INSERT INTO observations VALUES (?,?,?,?,?,?,?,?,?,?,?)", rows)
        found = window.arrival_window(journey(), path=path)
        self.assertEqual(found["basis"], "city")
        self.assertGreaterEqual(found["samples"], window.CITY_MIN_SAMPLES)
        self.assertLess(found["earliest"], found["latest"])

    def test_missed_connection_names_the_next_bus(self):
        db = timetable()
        with closing(sqlite3.connect(db)) as conn:
            found = window.arrival_window(journey(connection={"status": "risky"}), conn=conn, path=self.empty)
            self.assertEqual(found["missed"], [{"line": "KIA-9", "stop": "X", "next": "09:52", "later_minutes": 22,
                                                "status": "risky"}], "same bus number only; 500-D at 09:35 is not it")
            comfortable = window.arrival_window(journey(connection={"status": "comfortable"}), conn=conn, path=self.empty)
            self.assertEqual(comfortable["missed"], [])
            late = window.next_departure(conn, "KIA-9", "X", datetime(2026, 11, 9, 0, 5, tzinfo=IST))
            self.assertEqual(late.strftime("%H:%M"), "00:15", "after midnight, yesterday's 24:15 trip counts")

    def test_annotate_never_breaks_a_plan(self):
        routes = [journey(), {"legs": "broken"}]
        window.annotate(timetable(), routes, path=self.empty)
        self.assertIn("arrival_window", routes[0])
        self.assertNotIn("arrival_window", routes[1])


if __name__ == "__main__":
    unittest.main()
