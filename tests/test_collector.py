"""Background delay collector: which routes, when, how often, and what happens when BMTC fails."""
import os
import sqlite3
import tempfile
import unittest
from contextlib import closing
from datetime import datetime
from pathlib import Path
from unittest.mock import patch

os.environ.setdefault("GEOCODER", "off")
os.environ.setdefault("RELIABILITY", "off")
from transit import collector                     # noqa: E402

IST = collector.IST


def timetable(path):
    with closing(sqlite3.connect(path)) as conn, conn:
        conn.executescript("""
            CREATE TABLE routes (route_id TEXT PRIMARY KEY, route_short_name TEXT, route_long_name TEXT, route_type TEXT);
            CREATE TABLE trips (trip_id TEXT PRIMARY KEY, route_id TEXT, service_id TEXT, trip_headsign TEXT,
                                direction_id TEXT, shape_id TEXT);""")
        conn.executemany("INSERT INTO routes VALUES (?,?,'',?)", [
            ("r1", "500-D", "3"), ("r2", "375-D", "3"), ("r3", "KBS-1K KBS-D41G", "3"), ("r4", "KBS-1K", "3"),
            ("METRO:P", "Purple Line", "1"), ("r6", "G-7", "3")])
        trips = [("r1", 30), ("r2", 50), ("r3", 40), ("r4", 35), ("METRO:P", 500), ("r6", 5)]
        conn.executemany("INSERT INTO trips VALUES (?,?,'1','','0','')",
                         [(f"{route}-{n}", route) for route, count in trips for n in range(count)])


class CollectorTests(unittest.TestCase):
    def setUp(self):
        self.db = Path(tempfile.mkdtemp()) / "t.db"
        timetable(self.db)
        collector._state.update(next_index=0, checks=0, failed=0, last_route=None, last_error="", paused="")

    def test_busiest_bus_routes_once_per_bus_number(self):
        self.assertEqual(collector.busiest_routes(self.db, 3), ["375-D", "KBS-1K KBS-D41G", "500-D"],
                         "metro lines left out; depot variants of KBS-1K count once")
        self.assertEqual(len(collector.busiest_routes(self.db, 20)), 4)

    def test_checks_routes_in_turn_during_service_hours_only(self):
        asked = []
        live = lambda route, force_refresh=False: asked.append((route, force_refresh))
        day = datetime(2026, 11, 7, 9, 0, tzinfo=IST)
        for _ in range(3):
            collector.check_once(["A", "B"], day, live=live)
        self.assertEqual(asked, [("A", True), ("B", True), ("A", True)], "fresh BMTC answer each time, in turn")
        self.assertIsNone(collector.check_once(["A", "B"], datetime(2026, 11, 7, 23, 30, tzinfo=IST), live=live))
        self.assertIsNone(collector.check_once(["A", "B"], datetime(2026, 11, 7, 5, 59, tzinfo=IST), live=live))
        self.assertEqual(len(asked), 3, "nothing is asked at night")
        self.assertEqual(collector.status()["paused"], "outside service hours")
        self.assertEqual(collector.status()["checks"], 3)

    def test_failure_is_counted_and_raised_so_the_loop_backs_off(self):
        def broken(route, force_refresh=False):
            raise ConnectionError("BMTC timed out")
        with self.assertRaises(ConnectionError):
            collector.check_once(["A"], datetime(2026, 11, 7, 12, 0, tzinfo=IST), live=broken)
        state = collector.status()
        self.assertEqual((state["failed"], state["last_route"]), (1, "A"))
        self.assertIn("BMTC timed out", state["last_error"])

    def test_switches(self):
        with patch.dict(os.environ, {"COLLECTOR": "off", "RELIABILITY": "on"}):
            self.assertFalse(collector.enabled())
            self.assertFalse(collector.start(self.db))
        with patch.dict(os.environ, {"COLLECTOR": "on", "RELIABILITY": "off"}):
            self.assertFalse(collector.enabled(), "no learning, no collecting")
        with patch.dict(os.environ, {"COLLECTOR_SECONDS": "5", "COLLECTOR_ROUTES": "x", "COLLECTOR_HOURS": "7-21"}):
            config = collector.settings()
            self.assertEqual(config["seconds"], 30, "never faster than one check every 30 s")
            self.assertEqual(config["routes"], 20)
            self.assertEqual(config["hours"], (7, 21))


if __name__ == "__main__":
    unittest.main()
