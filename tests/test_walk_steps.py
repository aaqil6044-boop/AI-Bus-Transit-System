"""Turn-by-turn walking directions taken from the router's own steps."""
import os
import unittest

os.environ.setdefault("GEOCODER", "off")
os.environ.setdefault("RELIABILITY", "off")
from transit import otp            # noqa: E402


class WalkStepTests(unittest.TestCase):
    def test_steps_are_kept_with_unnamed_ways_marked(self):
        leg = {"steps": [
            {"distance": 15.4, "relativeDirection": "DEPART", "streetName": "6th Cross", "lat": 12.97, "lon": 77.74, "bogusName": False},
            {"distance": 219.8, "relativeDirection": "LEFT", "streetName": "track", "lat": 12.973, "lon": 77.748, "bogusName": True},
            {"distance": 5, "relativeDirection": None, "streetName": None, "lat": "x", "lon": 77.7}]}
        steps = otp.walk_steps(leg)
        self.assertEqual(steps, [
            {"direction": "DEPART", "street": "6th Cross", "named": True, "distance": 15, "lat": 12.97, "lon": 77.74},
            {"direction": "LEFT", "street": "track", "named": False, "distance": 220, "lat": 12.973, "lon": 77.748}],
            "a step without a usable position is dropped")
        self.assertEqual(otp.walk_steps({}), [])

    def test_query_asks_the_router_for_steps(self):
        self.assertIn("steps { distance relativeDirection", otp.QUERY)


if __name__ == "__main__":
    unittest.main()
