"""Regression tests for road-following "heading" lines (transit/heading_paths.py)."""
import sqlite3
import unittest

from transit import heading_paths as hp


def stop(name, lat, lon):
    return {"name": name, "lat": lat, "lon": lon}


class HeadingPathTests(unittest.TestCase):
    """A route that runs east along a road, turns north, with stops every ~550 m."""

    @staticmethod
    def build(conn, road):
        conn.executescript("""
            CREATE TABLE routes (route_id TEXT, route_short_name TEXT, route_long_name TEXT);
            CREATE TABLE trips (trip_id TEXT, route_id TEXT, shape_id TEXT);
            CREATE TABLE shapes (shape_id TEXT, shape_pt_lat REAL, shape_pt_lon REAL, shape_pt_sequence INTEGER);""")
        conn.executemany("INSERT INTO routes VALUES (?,?,'')", [("r1", "500D"), ("r2", "500D VAR"), ("r3", "OTHER")])
        conn.executemany("INSERT INTO trips VALUES (?,?,?)", [("t1", "r1", "s-east"), ("t2", "r3", "s-other")])
        conn.executemany("INSERT INTO shapes VALUES ('s-east',?,?,?)", [(a, b, i) for i, (a, b) in enumerate(road)])
        conn.executemany("INSERT INTO shapes VALUES ('s-other',?,?,?)", [(13.2, 77.9 + i * 0.001, i) for i in range(20)])
        conn.commit()

    @classmethod
    def setUpClass(cls):
        # 100 m steps east for 3 km, then north for 3 km (an L: straight stop joins would cut the corner)
        east = [(12.95, 77.60 + i * 0.00092) for i in range(31)]
        north = [(12.95 + i * 0.0009, east[-1][1]) for i in range(1, 31)]
        cls.road = east + north
        cls.conn = sqlite3.connect(":memory:")
        cls.build(cls.conn, cls.road)
        cls.stops = [stop(f"S{n}", *cls.road[i]) for n, i in enumerate(range(0, 61, 6))]   # S0 .. S10, ~550 m apart

    def setUp(self):
        hp._route_cache.clear()
        hp._shape_cache.clear()

    def test_follows_the_road_round_the_corner(self):
        bus = self.road[3]
        result = hp.path_for(self.conn, "db", "500D", bus[0], bus[1], self.stops[1:9])
        self.assertEqual(result["source"], "road")
        self.assertEqual(result["path"][0], [bus[1], bus[0]], "starts at the bus")
        corner = [self.road[30][1], self.road[30][0]]
        self.assertIn(corner, result["path"], "goes round the corner, not straight across it")
        self.assertEqual([s["name"] for s in result["stops"]], [f"S{i}" for i in range(1, 9)])

    def test_a_stop_the_bus_already_passed_is_not_drawn(self):
        bus = self.road[9]                   # between S1 (index 6) and S2 (index 12); the feed still says "next S1"
        result = hp.path_for(self.conn, "db", "500D", bus[0], bus[1], self.stops[1:9])
        self.assertEqual(result["stops"][0]["name"], "S2")

    def test_variant_names_share_the_base_routes_path(self):
        bus = self.road[3]
        self.assertEqual(hp.path_for(self.conn, "db", "500D VAR", bus[0], bus[1], self.stops[1:6])["source"], "road")

    def test_bus_off_the_road_falls_back_to_cleaned_stop_line(self):
        off_bus = (12.9545, 77.6045)         # ~500 m off the road: not on the route's path
        result = hp.path_for(self.conn, "db", "500D", off_bus[0], off_bus[1], self.stops[1:9])
        self.assertEqual(result["source"], "stops")
        far_bus = (12.97, 77.60)             # ~2 km away: any line would start with a long jump
        self.assertIsNone(hp.path_for(self.conn, "db", "500D", far_bus[0], far_bus[1], self.stops[1:9]))

    def test_fallback_never_draws_a_long_straight_jump(self):
        stops = [stop("A", 12.95, 77.601), stop("B", 12.95, 77.605), stop("Far", 13.10, 77.70), stop("Z", 13.10, 77.701)]
        result = hp.path_for(self.conn, "db", "UNKNOWN", 12.95, 77.600, stops)
        self.assertEqual(result["source"], "stops")
        self.assertEqual([s["name"] for s in result["stops"]], ["A", "B"], "stops before the 17 km jump")

    def test_fallback_drops_a_stop_already_passed(self):
        stops = [stop("Passed", 12.95, 77.600), stop("Next", 12.95, 77.610), stop("After", 12.95, 77.615)]
        result = hp.path_for(self.conn, "db", "UNKNOWN", 12.95, 77.605, stops)   # bus between Passed and Next
        self.assertEqual(result["stops"][0]["name"], "Next")

    def test_attach_adds_paths_and_removes_unusable_headings(self):
        import tempfile, os, shutil
        folder = tempfile.mkdtemp()
        path = os.path.join(folder, "t.db")
        disk = sqlite3.connect(path)
        self.build(disk, self.road)
        disk.close()
        bus = self.road[3]
        result = {"route": "500D", "vehicles": [
            {"route": "500D", "lat": bus[0], "lon": bus[1], "heading": {"stops": self.stops[1:6], "towards": "S10"}},
            {"route": "500D", "lat": bus[0], "lon": bus[1], "heading": {"stops": [], "towards": "S10"}},
            {"route": "500D", "lat": bus[0], "lon": bus[1], "heading": None}]}
        hp.attach(path, result)
        first = result["vehicles"][0]["heading"]
        self.assertEqual(first["path_source"], "road")
        self.assertGreater(len(first["path"]), 6)
        self.assertIsNone(result["vehicles"][1]["heading"], "nothing to draw: no line rather than a wrong one")
        hp.attach(path, result)   # cached results are re-served: a second call changes nothing
        self.assertEqual(result["vehicles"][0]["heading"]["path"], first["path"])
        shutil.rmtree(folder, ignore_errors=True)


if __name__ == "__main__":
    unittest.main()
