"""Rain-aware trips: Open-Meteo forecast for the journey hours, cached, and silent when unavailable."""
import json
import os
import threading
import unittest
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone
from unittest.mock import patch

os.environ.setdefault("GEOCODER", "off")
os.environ.setdefault("RELIABILITY", "off")
import app as app_module                       # noqa: E402
from test_backend import make_database         # noqa: E402
from transit import weather                    # noqa: E402

IST = timezone(timedelta(hours=5, minutes=30))


def forecast(rows):
    return lambda lat, lon, timeout: {"hourly": {"time": [r[0] for r in rows], "precipitation": [r[1] for r in rows],
                                                 "precipitation_probability": [r[2] for r in rows]}}


class WeatherTests(unittest.TestCase):
    def setUp(self):
        weather._cache.clear()

    def test_rain_during_the_journey_hours(self):
        rows = [("2026-11-07T08:00", 0.0, 10), ("2026-11-07T09:00", 0.2, 30), ("2026-11-07T10:00", 2.6, 85),
                ("2026-11-07T11:00", 0.0, 20)]
        found = weather.rain_during(12.97, 77.59, datetime(2026, 11, 7, 9, 20, tzinfo=IST),
                                    datetime(2026, 11, 7, 10, 15, tzinfo=IST), transport=forecast(rows))
        self.assertTrue(found["wet"])
        self.assertEqual([hour["hour"] for hour in found["hours"]], ["09:00", "10:00"], "only the hours of the trip")
        self.assertEqual((found["max_mm"], found["max_probability"], found["wettest_hour"]), (2.6, 85, "10:00"))
        self.assertEqual(found["source"], "Open-Meteo forecast")

    def test_dry_trip(self):
        rows = [("2026-11-07T09:00", 0.1, 20)]
        found = weather.rain_during(12.97, 77.59, datetime(2026, 11, 7, 9, 0, tzinfo=IST),
                                    datetime(2026, 11, 7, 9, 40, tzinfo=IST), transport=forecast(rows))
        self.assertFalse(found["wet"])

    def test_forecast_is_cached_per_area(self):
        calls = []

        def counted(lat, lon, timeout):
            calls.append((lat, lon))
            return forecast([("2026-11-07T09:00", 0, 0)])(lat, lon, timeout)
        when = datetime(2026, 11, 7, 9, 0, tzinfo=IST)
        weather.rain_during(12.971, 77.594, when, when, transport=counted)
        weather.rain_during(12.974, 77.591, when, when, transport=counted)       # same ~10 km square
        self.assertEqual(calls, [(13.0, 77.6)])

    def test_unavailable_or_off_says_nothing(self):
        def broken(lat, lon, timeout):
            raise OSError("no network")
        when = datetime(2026, 11, 7, 9, 0, tzinfo=IST)
        self.assertIsNone(weather.rain_during(12.97, 77.59, when, when, transport=broken))
        self.assertIsNone(weather.rain_during(28.6, 77.2, when, when, transport=forecast([])), "outside Bengaluru")
        with patch.dict(os.environ, {"WEATHER": "off"}):
            weather._cache.clear()
            self.assertIsNone(weather.rain_during(12.97, 77.59, when, when, transport=forecast([("2026-11-07T09:00", 5, 99)])))


class WeatherEndpointTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.db = make_database([("1", "Hope Farm", 12.984, 77.752)])
        cls.patch = patch.object(app_module, "TRANSIT_DATABASE", cls.db)
        cls.patch.start()
        cls.server = app_module.ThreadingHTTPServer(("127.0.0.1", 0), app_module.TransitHandler)
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.patch.stop()

    def get(self, path):
        try:
            with urllib.request.urlopen(f"http://127.0.0.1:{self.server.server_address[1]}{path}", timeout=10) as response:
                return response.status, json.loads(response.read())
        except urllib.error.HTTPError as error:
            return error.code, json.loads(error.read())

    def test_endpoint(self):
        found = {"wet": True, "hours": [], "max_mm": 1.0, "max_probability": 70, "wettest_hour": "10:00", "source": "Open-Meteo forecast"}
        with patch.object(weather, "rain_during", return_value=found) as called:
            status, body = self.get("/api/weather?lat=12.97&lon=77.59&from=2026-11-07T09:00:00%2B05:30&to=2026-11-07T10:30:00%2B05:30")
        self.assertEqual((status, body["rain"]), (200, found))
        self.assertEqual(called.call_args[0][:2], (12.97, 77.59))
        self.assertEqual(self.get("/api/weather?lat=12.97&lon=77.59&from=2026-11-07T09:00&to=2026-11-07T10:00")[0], 400,
                         "times need a zone")
        self.assertEqual(self.get("/api/weather?lat=x&lon=77.59&from=a&to=b")[0], 400)
        self.assertEqual(self.get("/api/weather?lat=12.97&lon=77.59&from=2026-11-07T09:00:00%2B05:30"
                                  "&to=2026-11-07T19:00:00%2B05:30")[0], 400, "at most six hours")


if __name__ == "__main__":
    unittest.main()
