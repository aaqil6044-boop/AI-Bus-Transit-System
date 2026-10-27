"""Finding places that are not written exactly like a BMTC stop: close spellings and OpenStreetMap look-ups.

No network: the OpenStreetMap look-up is replaced by a stand-in.
"""
import os
import tempfile
import unittest
from unittest.mock import patch

os.environ.setdefault("GEOCODER", "off")
from test_backend import make_database          # noqa: E402  (same folder; run with -s tests)
from transit import assistant, places           # noqa: E402

BROOKEFIELD = {"lat": "12.9667", "lon": "77.7180", "name": "Brookefield", "display_name": "Brookefield, Bengaluru"}


class PlaceTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.db = make_database([
            ("1", "Hope Farm", 12.984, 77.752),
            ("2", "White Field Bus Station", 12.9698, 77.7499),
            ("3", "Kundalahalli", 12.9635, 77.7155),
            ("4", "Kempegowda Bus Station", 12.977, 77.571)])

    def setUp(self):
        places._geo_cache.clear()
        places._names_cache.clear()
        folder = tempfile.mkdtemp()
        for p in (patch.dict(os.environ, {"GEOCODER": "on", "GEOCODE_CACHE_DIR": folder}),
                  patch.object(places.time, "sleep", lambda s: None)):
            p.start()
            self.addCleanup(p.stop)
        self.calls = []

    def lookup(self, answer):
        def fake(query, timeout):
            self.calls.append(query)
            if isinstance(answer, Exception):
                raise answer
            return answer
        return patch.object(places, "_nominatim", fake)

    def plan(self):
        captured = {}

        def fake_plan(db, origin_id, destination_id, profile, origin_point=None, destination_point=None, now=None):
            captured.update(origin_id=origin_id, origin_point=origin_point, destination_id=destination_id,
                            destination_point=destination_point)
            return {"origin": {"stop_name": "A"}, "destination": {"stop_name": "B"}, "requested": {"label": "Now"},
                    "routes": [{"transit": True, "route_numbers": ["500D"], "transfers": 0,
                                "departure_time": "10:00", "arrival_time": "10:40"}]}
        return patch.object(assistant, "plan_journey", fake_plan), captured

    def test_a_close_spelling_finds_the_stop_and_says_so(self):
        patcher, captured = self.plan()
        with patcher, self.lookup([]):
            result = assistant.handle_assistant(self.db, {"message": "from whitefeild to hope farm"})
        self.assertEqual(result["intent"], "plan")
        self.assertEqual(result["origin"]["stop_name"], "White Field Bus Station")
        self.assertEqual(captured["origin_id"], "2")
        self.assertIn('I read "whitefeild" as White Field Bus Station', result["reply"])
        self.assertEqual(self.calls, [], "a stop found by spelling needs no online look-up")

    def test_a_neighbourhood_is_found_on_openstreetmap_and_planned_from_its_point(self):
        patcher, captured = self.plan()
        with patcher, self.lookup([BROOKEFIELD]):
            result = assistant.handle_assistant(self.db, {"message": "from brookefield to hope farm"})
        self.assertEqual(result["intent"], "plan")
        self.assertTrue(result["origin"]["is_map_point"])
        self.assertEqual(result["origin"]["stop_name"], "Brookefield")
        self.assertEqual(captured["origin_point"]["lat"], 12.9667)
        self.assertEqual(captured["origin_point"]["lon"], 77.718)
        self.assertIn("OpenStreetMap", result["reply"])
        self.assertIn("Kundalahalli", result["reply"], "names the nearest real stop")
        self.assertNotIn("note", result["origin"])

    def test_results_are_cached(self):
        with self.lookup([BROOKEFIELD]):
            first = places.geocode("Brookefield")
            second = places.geocode("brookefield")
        self.assertEqual(first, second)
        self.assertEqual(len(self.calls), 1)

    def test_a_place_outside_bengaluru_is_not_used(self):
        with self.lookup([{"lat": "28.61", "lon": "77.21", "name": "Delhi"}]):
            result = assistant.handle_assistant(self.db, {"message": "from Connaught Place to hope farm"})
        self.assertFalse(result["ok"])
        self.assertIn("as a BMTC stop or a Bengaluru place", result["reply"])

    def test_a_place_with_no_bus_stop_nearby_is_not_used(self):
        with self.lookup([{"lat": "13.20", "lon": "77.40", "name": "Far Farm"}]):
            result = assistant.handle_assistant(self.db, {"message": "from far farm to hope farm"})
        self.assertFalse(result["ok"])

    def test_network_trouble_is_not_an_error_and_is_retried_later(self):
        with self.lookup(OSError("offline")):
            self.assertIsNone(places.geocode("Brookefield"))
        with self.lookup([BROOKEFIELD]):
            self.assertEqual(places.geocode("Brookefield")["name"], "Brookefield")

    def test_unrelated_words_are_not_matched_by_spelling(self):
        self.assertIsNone(places.close_stop_name(self.db, "Atlantis"))
        self.assertIsNone(places.close_stop_name(self.db, "Hope"), "too short to guess")
        self.assertEqual(places.close_stop_name(self.db, "kundalahali"), "Kundalahalli")

    def test_lookup_can_be_switched_off(self):
        with patch.dict(os.environ, {"GEOCODER": "off"}), self.lookup([BROOKEFIELD]):
            self.assertIsNone(places.geocode("Brookefield"))
        self.assertEqual(self.calls, [])


if __name__ == "__main__":
    unittest.main()
