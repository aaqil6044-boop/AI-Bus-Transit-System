"""Regression checks for matching an OTP route to a BMTC route variant."""
import os
os.environ.setdefault("RELIABILITY", "off")   # tests never write the real reliability database
import unittest
from unittest.mock import patch

from transit import bmtc_live


class RouteVariantTests(unittest.TestCase):
    def test_specific_variant_uses_its_own_route_id(self):
        requested_ids = []

        def response(endpoint, payload):
            if endpoint == "SearchRoute_v2":
                return {"data": [
                    {"routeno": "500-FB", "routeparentid": 2814},
                    {"routeno": "500-FB CSB-HSK", "routeparentid": 9018},
                ]}
            requested_ids.append(payload["routeid"])
            return {"up": {"data": [], "mapData": []},
                    "down": {"data": [], "mapData": []}}

        with patch.object(bmtc_live, "_post", side_effect=response):
            with patch.object(bmtc_live, "_cached_route", return_value=None):
                bmtc_live.live_route("500-FB CSB-HSK")
        self.assertEqual(requested_ids, [9018])

    def test_base_route_does_not_include_unrelated_variants(self):
        requested_ids = []

        def response(endpoint, payload):
            if endpoint == "SearchRoute_v2":
                return {"data": [
                    {"routeno": "500-FB", "routeparentid": 2814},
                    {"routeno": "500-FB CSB-HSK", "routeparentid": 9018},
                ]}
            requested_ids.append(payload["routeid"])
            return {"up": {"data": [], "mapData": []},
                    "down": {"data": [], "mapData": []}}

        with patch.object(bmtc_live, "_post", side_effect=response):
            with patch.object(bmtc_live, "_cached_route", return_value=None):
                bmtc_live.live_route("500-FB")
        self.assertEqual(requested_ids, [2814])


if __name__ == "__main__":
    unittest.main()
