"""Nearby stops (timetable departures in the next hour) and bus vs auto vs cab costs."""
import csv
import io
import os
import sqlite3
import tempfile
import unittest
import zipfile
from contextlib import closing
from datetime import datetime, timedelta, timezone
from pathlib import Path

os.environ.setdefault("GEOCODER", "off")
os.environ.setdefault("RELIABILITY", "off")
from transit import fares, nearby                     # noqa: E402

IST = timezone(timedelta(hours=5, minutes=30))


def build_db(path):
    with closing(sqlite3.connect(path)) as conn, conn:
        conn.executescript("""
            CREATE TABLE stops (stop_id TEXT PRIMARY KEY, stop_name TEXT, stop_lat REAL, stop_lon REAL, wheelchair_boarding TEXT);
            CREATE TABLE routes (route_id TEXT PRIMARY KEY, route_short_name TEXT, route_long_name TEXT, route_type TEXT);
            CREATE TABLE trips (trip_id TEXT PRIMARY KEY, route_id TEXT, service_id TEXT, trip_headsign TEXT, direction_id TEXT, shape_id TEXT);
            CREATE TABLE stop_times (trip_id TEXT, arrival_time TEXT, departure_time TEXT, stop_id TEXT, stop_sequence INTEGER);""")
        conn.executemany("INSERT INTO stops VALUES (?,?,?,?,NULL)", [
            ("A", "Here Stop", 12.9700, 77.7500), ("B", "Across Road", 12.9702, 77.7502),
            ("C", "Far Stop", 12.9800, 77.7500), ("Z", "Terminus", 12.9750, 77.6000),
            ("METRO:X", "Here (Metro)", 12.9701, 77.7501)])
        conn.executemany("INSERT INTO routes VALUES (?,?,'','3')", [("r1", "500-D"), ("r2", "V-335E"), ("r3", "KBS-1K")])
        conn.executemany("INSERT INTO trips VALUES (?,?,'1',?,'0','')", [
            ("t1", "r1", "Hebbal"), ("t2", "r1", "Hebbal"), ("t3", "r1", "Hebbal"), ("t4", "r1", "Hebbal"),
            ("t5", "r3", "Majestic"), ("t6", "r1", "Silk Board"), ("t7", "r1", "Hebbal")])
        rows = []
        for trip, at_a in (("t1", "08:05:00"), ("t2", "08:20:00"), ("t3", "08:35:00"), ("t4", "08:50:00"), ("t5", "08:10:00"),
                           ("t7", "24:20:00")):
            rows += [(trip, at_a, at_a, "A", 1), (trip, at_a, at_a, "Z", 2)]
        rows += [("t6", "08:15:00", "08:15:00", "Z", 1), ("t6", "08:30:00", "08:30:00", "A", 2)]   # ends at A
        conn.executemany("INSERT INTO stop_times VALUES (?,?,?,?,?)", rows)


class NearbyTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.db = Path(tempfile.mkdtemp()) / "t.db"
        build_db(cls.db)

    def test_next_hour_grouped_by_line(self):
        result = nearby.nearby(self.db, 12.9700, 77.7500, datetime(2026, 11, 7, 8, 0, tzinfo=IST))
        names = [stop["name"] for stop in result["stops"]]
        self.assertEqual(names[:2], ["Here Stop", "Across Road"], "closest first; metro stations are not bus stops")
        self.assertNotIn("Here (Metro)", names)
        self.assertNotIn("Far Stop", [s["name"] for s in result["stops"] if s["meters"] > 600])
        lines = result["stops"][0]["lines"]
        self.assertEqual([(line["route"], line["headsign"]) for line in lines], [("500-D", "Hebbal"), ("KBS-1K", "Majestic")])
        self.assertEqual(lines[0]["times"], ["08:05", "08:20", "08:35"], "at most three times per line")
        self.assertEqual(lines[0]["minutes"][0], 5)
        self.assertEqual(result["stops"][0]["towards"], ["Hebbal", "Majestic"])
        self.assertNotIn("Silk Board", [line["headsign"] for line in lines], "a trip that ends here is not a departure")
        self.assertEqual(result["source"], "BMTC timetable (not live)")

    def test_after_midnight_uses_trips_running_past_24h(self):
        result = nearby.nearby(self.db, 12.9700, 77.7500, datetime(2026, 11, 7, 0, 10, tzinfo=IST))
        self.assertEqual(result["stops"][0]["lines"][0]["times"], ["00:20"])

    def test_outside_bengaluru_is_refused(self):
        with self.assertRaises(ValueError):
            nearby.nearby(self.db, 28.6, 77.2)


def gtfs_zip(path):
    def table(header, rows):
        buffer = io.StringIO()
        writer = csv.writer(buffer)
        writer.writerow(header)
        writer.writerows(rows)
        return buffer.getvalue()
    with zipfile.ZipFile(path, "w") as archive:
        archive.writestr("fare_attributes.txt", table(["fare_id", "price"], [["F45", "45.00"], ["F30", "30.00"], ["F5", "5.00"]]))
        rules = [["F45", "r2", "ZA", "ZZ"]]
        # ordinary fares by distance for the estimate table: many zone pairs at ~0 km and ~16 km
        stops_extra = []
        for i in range(40):
            rules.append(["F5", "", f"N{i}", f"N{i}"])
            rules.append(["F30", "", f"N{i}", f"M{i}"])
            stops_extra += [[f"n{i}", "x", f"N{i}", 12.90, 77.50], [f"m{i}", "y", f"M{i}", 12.90, 77.65]]
        archive.writestr("fare_rules.txt", table(["fare_id", "route_id", "origin_id", "destination_id"], rules))
        archive.writestr("stops.txt", table(["stop_id", "stop_name", "zone_id", "stop_lat", "stop_lon"],
                                           [["A", "Here Stop", "ZA", 12.97, 77.75], ["Z", "Terminus", "ZZ", 12.975, 77.60]] + stops_extra))


class FareTests(unittest.TestCase):
    def setUp(self):
        folder = Path(tempfile.mkdtemp())
        self.db, self.zip = folder / "t.db", folder / "g.zip"
        build_db(self.db)
        with closing(sqlite3.connect(self.db)) as conn, conn:
            conn.executemany("INSERT INTO stops VALUES (?,?,?,?,NULL)",
                             [(f"n{i}", "x", 12.90, 77.50) for i in range(40)] + [(f"m{i}", "y", 12.90, 77.65) for i in range(40)])
        gtfs_zip(self.zip)

    def test_tables_are_added_once(self):
        self.assertTrue(fares.ensure_tables(self.db, self.zip))
        self.assertTrue(fares.ensure_tables(self.db, self.zip))
        with closing(sqlite3.connect(self.db)) as conn:
            self.assertEqual(conn.execute("SELECT count(*) FROM fare_rules").fetchone()[0], 81)
        self.assertFalse(fares.ensure_tables(Path(tempfile.mkdtemp()) / "none.db", self.zip))

    def test_exact_estimated_and_unknown_fares(self):
        fares.ensure_tables(self.db, self.zip)
        with closing(sqlite3.connect(self.db)) as conn:
            self.assertEqual(fares.bus_fare(conn, "r2", "A", "Z", "V-335E"), (45.0, True), "exact AC fare from BMTC's rule")
            fare, exact = fares.bus_fare(conn, "r3", "A", "Z", "KBS-1K")
            self.assertFalse(exact)
            self.assertEqual(fare, 30.0, "ordinary bus, ~16 km: BMTC's median ordinary fare for that distance")
            self.assertEqual(fares.bus_fare(conn, "r9", "A", "Z", "V-500D"), (None, False), "AC without a rule: no guess")

    def test_official_auto_and_cab_tariffs(self):
        self.assertEqual(fares.auto_fare(1.5), 36)                   # minimum fare covers 2 km
        self.assertEqual(fares.auto_fare(10), 36 + 8 * 18)            # Rs 18 per km after 2 km
        self.assertEqual(fares.auto_fare(10, hour=23), 270)           # 1.5x from 22:00 to 05:00
        self.assertEqual(fares.cab_fare(3), 105)                      # Rs 100 up to 4 km, +5% GST
        self.assertEqual(fares.cab_fare(10), 257)                     # (100 + 6 x 24) x 1.05 = 256.2 -> 257
        self.assertEqual(fares.cab_fare(10, hour=2), 282)             # +10% between 00:00 and 06:00

    def test_road_time_uses_measured_city_traffic(self):
        self.assertEqual(fares.road_minutes(10, hour=14), 36)         # TomTom 2025: 36 min 9 s per 10 km
        self.assertEqual(fares.road_minutes(10, hour=9), 41)          # morning rush
        self.assertEqual(fares.road_minutes(10, hour=18), 45)         # evening rush
        self.assertEqual(fares.road_minutes(10, hour=18, weekday=False), 36)

    def test_compare_adds_costs_to_a_plan(self):
        fares.ensure_tables(self.db, self.zip)
        plan = {"origin": {"stop_lat": 12.97, "stop_lon": 77.75}, "destination": {"stop_lat": 12.975, "stop_lon": 77.60},
                "requested": {"iso": "2026-11-07T14:00:00+05:30"},
                "routes": [{"legs": [{"transit": True, "role": "bus", "route_id": "r2", "route_name": "V-335E",
                                      "from_stop_id": "A", "to_stop_id": "Z"}]},
                           {"legs": [{"transit": True, "role": "bus", "route_id": "r9", "route_name": "V-500D",
                                      "from_stop_id": "A", "to_stop_id": "Z"}]}]}
        drive = lambda query: {"data": {"planConnection": {"edges": [{"node": {"legs": [{"distance": 18000}]}}]}}}
        fares.compare(self.db, plan, transport=drive)
        self.assertEqual(plan["compare"]["road_km"], 18.0)
        self.assertEqual(plan["compare"]["road_distance"], "road")
        self.assertEqual(plan["compare"]["auto"]["fare"], 36 + 16 * 18)
        self.assertEqual(plan["routes"][0]["bus_fare"], {"total": 45, "exact": True, "legs_without_fare": 0})
        self.assertEqual(plan["routes"][0]["legs"][0]["fare"], {"amount": 45, "exact": True}, "each ride carries its own fare")
        self.assertNotIn("fare", plan["routes"][1]["legs"][0], "no fare: nothing is guessed")
        self.assertEqual(plan["routes"][1]["bus_fare"]["total"], None)
        broken = lambda query: {}
        plan2 = {"origin": {"stop_lat": 12.97, "stop_lon": 77.75}, "destination": {"stop_lat": 12.975, "stop_lon": 77.60},
                 "requested": {"iso": "2026-11-07T14:00:00+05:30"}, "routes": []}
        fares.compare(self.db, plan2, transport=broken)
        self.assertEqual(plan2["compare"]["road_distance"], "estimate", "no driving route: straight line x 1.35")


if __name__ == "__main__":
    unittest.main()
