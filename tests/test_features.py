"""Learned reliability, saved places in the assistant, metro import and journey timestamps."""
import csv
import io
import json
import os
import tempfile
import unittest
import zipfile
from datetime import datetime
from pathlib import Path
from unittest.mock import patch

os.environ.setdefault("GEOCODER", "off")
os.environ.setdefault("RELIABILITY", "off")
from test_backend import REQUESTED, bus_leg, itinerary, make_database, place, walk_leg   # noqa: E402
from transit import assistant, otp, reliability                                         # noqa: E402

import importlib.util                                                                    # noqa: E402
_spec = importlib.util.spec_from_file_location("add_metro", Path(__file__).resolve().parent.parent / "scripts" / "add_metro.py")
add_metro = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(add_metro)

IST = reliability.IST


def details(rows):
    """A SearchByRouteDetails_v4-shaped answer: rows = [(station, vehicle, scheduled, actual)]."""
    groups = {}
    for station, vehicle, scheduled, actual in rows:
        groups.setdefault(station, []).append({"vehicleid": vehicle, "sch_arrivaltime": scheduled,
                                               "actual_arrivaltime": actual})
    return [(1, {"up": {"data": [{"stationid": s, "routeno": "500-D", "vehicleDetails": v} for s, v in groups.items()]},
                 "down": {"data": []}})]


class ReliabilityTests(unittest.TestCase):
    def setUp(self):
        self.path = Path(tempfile.mkdtemp()) / "rel.db"

    def test_measured_delay_wraps_midnight_and_drops_impossible_values(self):
        now = datetime(2026, 10, 14, 10, 0, tzinfo=IST)
        rows = reliability.measurements("500-D", details([
            ("s1", "v1", "09:00", "09:07"),       # 7 late
            ("s2", "v1", "09:10", "09:08"),       # 2 early
            ("s3", "v2", "09:20", ""),            # not passed yet: nothing
            ("s4", "v3", "23:58", "00:03"),       # past midnight: 5 late (belongs to yesterday? no: 00:03 < now)
            ("s5", "v4", "09:00", "15:30"),       # 6.5 h: a data error
        ]), now)
        delays = sorted(row[8] for row in rows)
        self.assertEqual(delays, [-2, 5, 7])
        self.assertTrue(all(row[1] == "500-D" for row in rows))

    def test_actual_time_after_now_belongs_to_yesterday(self):
        now = datetime(2026, 10, 14, 0, 10, tzinfo=IST)
        rows = reliability.measurements("500-D", details([("s1", "v1", "23:50", "23:55")]), now)
        self.assertEqual(rows[0][5], "2026-10-13")

    def test_duplicates_are_ignored_and_summary_needs_enough_days(self):
        when = datetime(2026, 10, 14, 9, 0, tzinfo=IST)            # Wednesday
        one_day = details([(f"s{i}", "v1", "09:00", "09:06") for i in range(20)])
        reliability.record("500-D", one_day, when, self.path)
        reliability.record("500-D", one_day, when, self.path)      # the same answer again
        self.assertIsNone(reliability.summary("500-D", when, self.path), "one day of data is not enough")
        for day in (15, 16):
            reliability.record("500-D", one_day, datetime(2026, 10, day, 9, 30, tzinfo=IST), self.path)
        found = reliability.summary("500-D VAR", when, self.path)
        self.assertEqual(found["typical_delay_minutes"], 6)
        self.assertEqual(found["samples"], 60)
        self.assertEqual(found["days"], 3)
        self.assertIn("usually about 6 min late", found["text"])
        self.assertIn("BMTC measurements", found["text"])
        self.assertIsNone(reliability.summary("500-D", datetime(2026, 10, 18, 9, 0, tzinfo=IST), self.path),
                          "weekend is summarised separately")

    def test_feed_without_times_records_nothing(self):
        plain = [(1, {"up": {"data": [{"stationid": "s1", "vehicleDetails": [{"vehicleid": "v1"}]}]}})]
        self.assertEqual(reliability.record("500-D", plain, None, self.path), 0)
        self.assertEqual(reliability.record("500-D", "garbage", None, self.path), 0)

    def test_annotate_adds_only_bus_legs_with_evidence(self):
        for day in (14, 15, 16):
            reliability.record("500-D", details([(f"s{i}", "v1", "09:00", "09:01") for i in range(5)]),
                               datetime(2026, 10, day, 9, 30, tzinfo=IST), self.path)
        legs = [{"transit": True, "role": "bus", "route_name": "500-D", "departure_iso": "2026-10-21T09:10:00+05:30"},
                {"transit": True, "role": "metro", "route_name": "500-D", "departure_iso": "2026-10-21T09:10:00+05:30"},
                {"transit": False}]
        reliability.annotate([{"legs": legs}], self.path)
        self.assertIn("usually on time", legs[0]["reliability"]["text"])
        self.assertNotIn("reliability", legs[1])


class AssistantFeatureTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.db = make_database([("1", "Hope Farm", 12.984, 77.752), ("2", "Kempegowda Bus Station", 12.977, 77.571)])

    home = {"label": "Home", "id": "point-home", "name": "My flat", "lat": 12.95, "lon": 77.70, "is_map_point": True}
    work = {"label": "Work", "id": "2", "name": "Kempegowda Bus Station", "lat": 12.977, "lon": 77.571}

    def test_take_me_home_starts_from_my_location(self):
        result = assistant.handle_assistant(self.db, {"message": "take me home", "saved": [self.home]})
        self.assertEqual(result["intent"], "use_location")
        self.assertEqual(result["destination"]["stop_name"], "My flat")
        self.assertTrue(result["destination"]["is_map_point"])

    def test_home_not_saved_says_how_to_save_it(self):
        result = assistant.handle_assistant(self.db, {"message": "take me home"})
        self.assertFalse(result["ok"])
        self.assertIn("You have not saved Home yet", result["reply"])

    def test_saved_places_plan_from_the_right_points(self):
        captured = {}

        def fake_plan(db, origin_id, destination_id, profile, origin_point=None, destination_point=None, now=None):
            captured.update(origin_id=origin_id, origin_point=origin_point, destination_id=destination_id,
                            destination_point=destination_point)
            return {"origin": {"stop_name": "My flat"}, "destination": {"stop_name": "KBS"}, "routes": [],
                    "requested": {"label": "Now"}, "fallback": {"message": "none"}}
        with patch.object(assistant, "plan_journey", fake_plan):
            result = assistant.handle_assistant(self.db, {"message": "from my home to office", "saved": [self.home, self.work]})
        self.assertEqual(result["intent"], "plan")
        self.assertEqual(captured["origin_point"]["lat"], 12.95)          # a map point is planned from its point
        self.assertEqual(captured["destination_id"], "2")                  # a saved BMTC stop by its id
        self.assertIsNone(captured["destination_point"])

    def test_saved_place_outside_bengaluru_is_ignored(self):
        bad = dict(self.home, lat=28.6, lon=77.2)
        result = assistant.handle_assistant(self.db, {"message": "take me home", "saved": [bad]})
        self.assertIn("You have not saved Home yet", result["reply"])

    def test_reliability_question_without_data_is_honest(self):
        with patch.object(reliability, "summary", return_value=None):
            result = assistant.handle_assistant(self.db, {"message": "is 500D usually late?"})
        self.assertEqual(result["engine"], "instant")
        self.assertIn("do not have enough BMTC measurements for 500D", result["reply"])

    def test_reliability_question_with_data(self):
        found = {"text": "500D is usually about 6 min late around this time on weekdays (…).", "typical_delay_minutes": 6}
        with patch.object(reliability, "summary", return_value=found):
            result = assistant.handle_assistant(self.db, {"message": "how reliable is 500D"})
        self.assertEqual(result["reply"], found["text"])
        self.assertEqual(result["reliability"], found)


class JourneyFieldTests(unittest.TestCase):
    def test_timestamps_and_metro_legs(self):
        a, b, c = place("A", stop="1"), place("B", stop="2"), place("C", stop="3")
        metro = bus_leg(12, 30, b, c, "Purple Line", route_id="M1")
        metro["mode"] = "SUBWAY"
        metro["route"]["color"] = "8A2BE2"
        routes = otp.build_routes({"edges": [itinerary([walk_leg(0, 2, place("Start"), a),
                                                        bus_leg(2, 10, a, b, "500-D"), walk_leg(10, 12, b, b, 10), metro])]},
                                  REQUESTED, {})
        route = routes[0]
        self.assertEqual(route["departure_iso"][:16], "2026-10-14T09:00")
        self.assertTrue(route["uses_metro"])
        bus, train = [leg for leg in route["legs"] if leg["transit"]]
        self.assertEqual((bus["role"], bus["vehicle"]), ("bus", "bus"))
        self.assertEqual((train["role"], train["vehicle"], train["line_color"]), ("metro", "metro", "#8A2BE2"))
        self.assertEqual(bus["departure_iso"][:16], "2026-10-14T09:02")

    def test_query_allows_metro(self):
        self.assertIn("{mode: SUBWAY}", otp.QUERY)


def gtfs_zip(path, routes, stops):
    with zipfile.ZipFile(path, "w") as archive:
        def write(name, header, rows):
            buffer = io.StringIO()
            writer = csv.writer(buffer)
            writer.writerow(header)
            writer.writerows(rows)
            archive.writestr(name, buffer.getvalue())
        write("routes.txt", ["route_id", "route_short_name", "route_long_name", "route_type"], routes)
        write("stops.txt", ["stop_id", "stop_name", "stop_lat", "stop_lon", "location_type", "parent_station"], stops)
        write("trips.txt", ["route_id", "service_id", "trip_id"], [["P", "WK", "t1"]])
        write("stop_times.txt", ["trip_id", "arrival_time", "departure_time", "stop_id", "stop_sequence"],
              [["t1", "06:00:00", "06:00:00", "S1", "1"]])


class MetroImportTests(unittest.TestCase):
    def setUp(self):
        self.folder = Path(tempfile.mkdtemp())

    def test_stations_routes_and_build_config(self):
        source = self.folder / "metro.zip"
        gtfs_zip(source, [["P", "Purple", "Purple Line", "1"]],
                 [["S1", "Majestic", "12.9757", "77.5729", "1", ""], ["S1a", "Majestic", "12.9757", "77.5729", "0", "S1"],
                  ["S2", "MG Road Metro Station", "12.9755", "77.6066", "1", ""], ["X", "Far", "28.6", "77.2", "1", ""]])
        stations, routes = add_metro.read_feed(source)
        self.assertEqual(sorted(s["name"] for s in stations), ["MG Road Metro Station", "Majestic"])
        db = make_database([("1", "Kempegowda Bus Station", 12.977, 77.571)])
        add_metro.add_to_database(db, stations, routes)
        add_metro.add_to_database(db, stations, routes)                  # running twice replaces, never duplicates
        import sqlite3
        from contextlib import closing
        with closing(sqlite3.connect(db)) as conn:
            names = sorted(row[0] for row in conn.execute("SELECT stop_name FROM stops WHERE stop_id LIKE 'METRO:%'"))
            self.assertEqual(names, ["MG Road Metro Station", "Majestic (Metro)"])
            self.assertEqual(conn.execute("SELECT count(*) FROM routes WHERE route_id LIKE 'METRO:%'").fetchone()[0], 1)
        from transit.planner import search_stops
        self.assertEqual(search_stops(db, "Majestic")[0]["stop_name"], "Kempegowda Bus Station",
                         "the bus station still comes first for 'Majestic'")
        config = self.folder / "build-config.json"
        config.write_text(json.dumps({"transitFeeds": [{"type": "gtfs", "source": "../data/bmtc_gtfs.zip", "feedId": "BMTC"}]}))
        self.assertTrue(add_metro.add_to_build_config(config))
        self.assertFalse(add_metro.add_to_build_config(config), "added once only")
        self.assertEqual([f["feedId"] for f in json.loads(config.read_text())["transitFeeds"]], ["BMTC", "METRO"])

    def test_a_bus_only_feed_is_refused(self):
        source = self.folder / "bus.zip"
        gtfs_zip(source, [["R", "500D", "", "3"]], [["S1", "A", "12.97", "77.6", "0", ""]])
        with self.assertRaises(ValueError):
            add_metro.read_feed(source)
        (self.folder / "junk.zip").write_text("not a zip")
        with self.assertRaises(ValueError):
            add_metro.read_feed(self.folder / "junk.zip")


if __name__ == "__main__":
    unittest.main()
