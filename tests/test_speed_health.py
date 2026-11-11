"""Speed and sturdiness: compression, caching headers, remembered answers, service health, status page."""
import gzip
import json
import os
import threading
import time
import unittest
import urllib.error
import urllib.request
from unittest.mock import patch

os.environ.setdefault("GEOCODER", "off")
os.environ.setdefault("RELIABILITY", "off")
import app as app_module                                   # noqa: E402
from test_backend import make_database                     # noqa: E402
from transit import health                                 # noqa: E402


class ServerSpeedTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.db = make_database([("1", "Hope Farm", 12.984, 77.752), ("2", "White Field", 12.976, 77.726)])
        cls.patch = patch.object(app_module, "TRANSIT_DATABASE", cls.db)
        cls.patch.start()
        cls.server = app_module.ThreadingHTTPServer(("127.0.0.1", 0), app_module.TransitHandler)
        cls.port = cls.server.server_address[1]
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.patch.stop()

    def get(self, path, headers=None, body=None):
        data = json.dumps(body).encode() if body is not None else None
        request = urllib.request.Request(f"http://127.0.0.1:{self.port}{path}", data,
                                         {**({"Content-Type": "application/json"} if data else {}), **(headers or {})})
        try:
            with urllib.request.urlopen(request, timeout=10) as response:
                return response.status, response.headers, response.read()
        except urllib.error.HTTPError as error:
            return error.code, error.headers, error.read()

    def test_page_files_are_compressed_and_identical(self):
        status, headers, body = self.get("/static/app.js", {"Accept-Encoding": "gzip"})
        self.assertEqual(status, 200)
        self.assertEqual(headers.get("Content-Encoding"), "gzip")
        original = (app_module.STATIC_ROOT / "app.js").read_bytes()
        self.assertEqual(gzip.decompress(body), original)
        self.assertLess(len(body), len(original) / 2.5)
        plain = self.get("/static/app.js")
        self.assertIsNone(plain[1].get("Content-Encoding"), "browsers that do not ask get the plain file")
        self.assertEqual(plain[2], original)

    def test_cache_rules(self):
        self.assertIn("immutable", self.get("/static/app.js?v=123")[1].get("Cache-Control"))
        self.assertIn("no-store", self.get("/static/app.js")[1].get("Cache-Control"), "unversioned: always fresh")
        self.assertIn("no-store", self.get("/")[1].get("Cache-Control"), "the page itself: always fresh")

    def test_compression_never_leaks_outside_static(self):
        status, _headers, _body = self.get("/static/%2e%2e/app.py", {"Accept-Encoding": "gzip"})
        self.assertEqual(status, 404)

    def test_big_json_is_compressed_small_json_is_not(self):
        big = self.get("/api/stops?q=hope", {"Accept-Encoding": "gzip"})
        self.assertEqual(json.loads(gzip.decompress(big[2]) if big[1].get("Content-Encoding") else big[2])["stops"][0]["stop_name"], "Hope Farm")
        small = self.get("/api/reliability?route=", {"Accept-Encoding": "gzip"})
        self.assertIsNone(small[1].get("Content-Encoding"))

    def test_repeat_plan_is_answered_from_memory(self):
        calls = []

        def slow_plan(*args):
            calls.append(args)
            return {"routes": [], "origin": {"stop_name": "Hope Farm"}, "destination": {"stop_name": "White Field"}}
        app_module._answer_cache.clear()
        body = {"origin_stop_id": "1", "destination_stop_id": "2", "profile": {"preference": "fastest"}}
        with patch.object(app_module, "plan_journey", slow_plan):
            self.get("/api/plan", body=body)
            self.get("/api/plan", body=body)
            self.get("/api/plan", body={**body, "profile": {"preference": "less_walking"}})
        self.assertEqual(len(calls), 2, "the same request twice runs the planner once; a different one runs again")

    def test_errors_are_not_remembered(self):
        app_module._answer_cache.clear()
        attempts = []

        def failing():
            attempts.append(1)
            raise ValueError("no")
        for _ in range(2):
            with self.assertRaises(ValueError):
                app_module.remembered("k", 60, failing)
        self.assertEqual(len(attempts), 2)

    def test_status_page_local_only_unless_token(self):
        self.assertEqual(self.get("/status")[0], 200, "open on this computer")
        self.assertEqual(self.get("/status", {"X-Real-IP": "203.0.113.9"})[0], 404, "through nginx: hidden")
        with patch.dict(os.environ, {"STATUS_TOKEN": "s3cret"}):
            self.assertEqual(self.get("/status?token=s3cret", {"X-Real-IP": "203.0.113.9"})[0], 200)
            self.assertEqual(self.get("/status?token=wrong", {"X-Real-IP": "203.0.113.9"})[0], 404)
        page = self.get("/status")[2].decode()
        self.assertIn("Recent errors", page)
        self.assertNotIn(os.environ.get("GEMINI_API_KEY", "no-key-set-here") or "no-key", page)

    def test_health_reports_services(self):
        status, _headers, body = self.get("/api/health")
        self.assertEqual(sorted(json.loads(body)["services"]), sorted(health.SERVICES))


class HealthTrackerTests(unittest.TestCase):
    def test_latest_result_decides(self):
        health.record("places", True, 0.2)
        self.assertEqual(health.status("places"), "ok")
        time.sleep(0.01)
        health.record("places", False, None, "TimeoutError: slow")
        self.assertEqual(health.status("places"), "down")
        snap = health.snapshot()
        self.assertEqual(snap["recent_errors"][0]["service"], "places")
        time.sleep(0.01)
        with health.timed("places"):
            pass
        self.assertEqual(health.status("places"), "ok")
        with self.assertRaises(RuntimeError):
            with health.timed("places"):
                raise RuntimeError("boom")
        self.assertEqual(health.status("places"), "down")
        self.assertIn("boom", health.snapshot()["services"]["places"]["last_error_text"])

    def test_unknown_service_ignored(self):
        health.record("nope", True)
        self.assertNotIn("nope", health.snapshot()["services"])


if __name__ == "__main__":
    unittest.main()
