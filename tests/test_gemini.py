"""Regression tests for the optional Gemini layer. Gemini itself is faked: no network or key needed.

Run from the project folder:  python -m unittest discover -s tests
"""
import os
os.environ.setdefault("GEOCODER", "off")   # tests never look places up online
import json
import os
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from datetime import datetime
from pathlib import Path
from unittest.mock import patch

import app as app_module
from transit import assistant, gemini
from test_backend import make_database

PLAN = {"origin": {"stop_name": "White Field Post Office"}, "destination": {"stop_name": "Kempegowda Bus Station"},
        "routes": [{"transit": True, "route_numbers": ["KBS-1K"], "transfers": 0,
                    "departure_time": "10:03", "arrival_time": "11:29"}],
        "requested": {"label": "Now"}}
NOW = datetime(2026, 10, 25, 17, 40, tzinfo=gemini.IST)


def call(name, **args):
    return {"candidates": [{"content": {"parts": [{"functionCall": {"name": name, "args": args}}]},
                            "finishReason": "STOP"}]}


class FakeGemini:
    """Records requests and answers with a canned function call or HTTP status."""

    def __init__(self, status=200, data=None, error=None):
        self.status, self.data, self.error, self.calls = status, data, error, []

    def __call__(self, url, body, key, timeout):
        self.calls.append({"url": url, "body": body, "key": key})
        if self.error:
            raise self.error
        return self.status, self.data


class GeminiAssistantTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.db = make_database([("1", "White Field Post Office", 12.9693, 77.7500),
                                ("2", "Kempegowda Bus Station", 12.9781, 77.5723),
                                ("3", "Hoodi", 12.9915, 77.7160)])

    def setUp(self):
        patcher = patch.dict(os.environ, {"GEMINI_API_KEY": "test-key-123", "GEMINI_MODEL": ""})
        patcher.start()
        self.addCleanup(patcher.stop)

    def ask(self, message, fake, **payload):
        with patch.object(assistant, "plan_journey", return_value=PLAN) as planner:
            result = assistant.handle_assistant(self.db, {"message": message, **payload}, now=NOW, gemini_transport=fake)
        return result, planner

    def test_messy_request_is_understood_and_planned_by_the_real_planner(self):
        fake = FakeGemini(data=call("plan_journey", origin="White Field Post Office", destination="Kempegowda Bus Station",
                                    preference="less_walking", depart_at="21:30"))
        result, planner = self.ask("pls get me frm whitefeild post office to majestic tonite 9.30, hate walking", fake)
        self.assertEqual(result["engine"], "gemini")
        self.assertEqual(result["intent"], "plan")
        self.assertIs(result["plan"], PLAN, "the journey comes from the planner, not from Gemini")
        args = planner.call_args[0]
        self.assertEqual((args[1], args[2]), ("1", "2"), "places resolved to real BMTC stop ids")
        self.assertEqual(args[3], {"preference": "less_walking", "depart_at": "21:30"})
        self.assertEqual(fake.calls[0]["url"].rsplit("/", 1)[-1], "gemini-3.1-flash-lite:generateContent")

    def test_place_gemini_invents_is_never_planned(self):
        fake = FakeGemini(data=call("plan_journey", origin="Atlantis Bus Stand", destination="Hoodi",
                                    preference="", depart_at=""))
        result, planner = self.ask("from atlantis to hoodi", fake)
        self.assertFalse(result["ok"])
        self.assertIsNone(result["plan"])
        planner.assert_not_called()

    def test_travellers_own_words_are_tried_when_geminis_stop_name_is_wrong(self):
        fake = FakeGemini(data=call("plan_journey", origin="Whitefield TTMC", destination="Hoodi",
                                    preference="", depart_at=""))
        result, planner = self.ask("from White Field Post Office to Hoodi", fake)
        self.assertEqual(result["intent"], "plan")
        self.assertEqual(planner.call_args[0][1], "1")

    def test_general_question_gets_a_short_labelled_answer_and_no_route(self):
        fake = FakeGemini(data=call("reply", text="Tap Find routes after choosing two stops.", kind="help"))
        result, planner = self.ask("how does this work?", fake)
        self.assertEqual((result["intent"], result["engine"]), ("answer", "gemini"))
        self.assertEqual(result["reply"], "Tap Find routes after choosing two stops.")
        self.assertIsNone(result["plan"])
        planner.assert_not_called()

    def test_follow_up_keeps_selected_stops_and_changes_only_the_time(self):
        fake = FakeGemini(data=call("plan_journey", origin="", destination="", preference="", depart_at="09:00"))
        ctx = lambda i, n, lat, lon: {"id": i, "name": n, "lat": lat, "lon": lon}
        result, planner = self.ask("same but at 9 tomorrow morning", fake,
                                   origin=ctx("1", "White Field Post Office", 12.9693, 77.75),
                                   destination=ctx("3", "Hoodi", 12.9915, 77.716),
                                   history=[{"role": "user", "text": "whitefield to hoodi"},
                                            {"role": "assistant", "text": "Planned."}])
        self.assertEqual(result["intent"], "plan")
        self.assertEqual((planner.call_args[0][1], planner.call_args[0][2]), ("1", "3"))
        self.assertEqual(planner.call_args[0][3]["depart_at"], "09:00")
        sent = json.dumps(fake.calls[0]["body"])
        self.assertIn("Selected start: White Field Post Office", sent)
        self.assertIn("whitefield to hoodi", sent, "recent chat lines are sent for follow-ups")
        self.assertNotIn("12.9693", sent, "coordinates are never sent to Gemini")
        self.assertNotIn("77.75", sent)

    def test_swap(self):
        fake = FakeGemini(data=call("swap_trip"))
        ctx = lambda i, n, lat, lon: {"id": i, "name": n, "lat": lat, "lon": lon}
        result, planner = self.ask("return trip please", fake, origin=ctx("1", "White Field Post Office", 12.9693, 77.75),
                                   destination=ctx("3", "Hoodi", 12.9915, 77.716))
        self.assertEqual(planner.call_args[0][1], "3")
        self.assertEqual(planner.call_args[0][2], "1")

    def test_bad_values_from_gemini_are_dropped(self):
        fake = FakeGemini(data=call("plan_journey", origin="White Field Post Office", destination="Hoodi",
                                    preference="cheapest", depart_at="25:99"))
        result, planner = self.ask("whitefield to hoodi", fake)
        self.assertEqual(planner.call_args[0][3], {"preference": "fastest"})

    def test_failures_fall_back_to_the_built_in_helper_with_a_note(self):
        cases = [(FakeGemini(status=429, data={}), "quota"),
                 (FakeGemini(status=400, data={"error": {"details": [{"reason": "API_KEY_INVALID"}]}}), "API key"),
                 (FakeGemini(status=404, data={}), "GEMINI_MODEL"),
                 (FakeGemini(status=400, data={"error": {"status": "INVALID_ARGUMENT", "message": "bad schema"}}),
                  "rejected the request"),
                 (FakeGemini(status=503, data={}), "could not be reached"),
                 (FakeGemini(error=TimeoutError("timed out")), "in time"),
                 (FakeGemini(data={"candidates": [{"content": {"parts": [{"text": "Take bus 500D!"}]}}]}), "unusable"),
                 (FakeGemini(data={"promptFeedback": {"blockReason": "SAFETY"}}), "declined")]
        for fake, words in cases:
            with self.subTest(words=words):
                result, planner = self.ask("from White Field Post Office to Hoodi", fake)
                self.assertEqual(result["engine"], "built-in")
                self.assertIn(words, result["notice"])
                self.assertEqual(result["intent"], "plan", "the built-in helper still plans the trip")
                self.assertNotIn("500D", result["reply"], "free text from Gemini is never passed off as a route")

    def test_problems_are_explained_in_the_app_window_without_the_key(self):
        import contextlib, io
        out = io.StringIO()
        fake = FakeGemini(status=400, data={"error": {"status": "INVALID_ARGUMENT",
                                                      "message": "properties: should be non-empty (key test-key-123)"}})
        with contextlib.redirect_stdout(out):
            self.ask("from White Field Post Office to Hoodi", fake)
            self.ask("from White Field Post Office to Hoodi",
                     FakeGemini(data={"candidates": [{"content": {"parts": [{"text": "hello"}]}, "finishReason": "STOP"}]}))
        printed = out.getvalue()
        self.assertIn("HTTP 400", printed)
        self.assertIn("should be non-empty", printed)
        self.assertIn("parts=[['text']]", printed, "the shape of an unusable answer is described")
        self.assertNotIn("test-key-123", printed)
        self.assertNotIn("hello", printed, "the model's or traveller's text is not printed")

    def test_a_rejected_request_is_retried_once_without_tool_config(self):
        answers = [(400, {"error": {"status": "INVALID_ARGUMENT", "message": "allowedFunctionNames unsupported"}}),
                   (200, call("plan_journey", origin="White Field Post Office", destination="Hoodi"))]
        sent = []
        def fake(url, body, key, timeout):
            sent.append(body)
            return answers[len(sent) - 1]
        import contextlib, io
        with contextlib.redirect_stdout(io.StringIO()):
            result, planner = self.ask("whitefield to hoodi", fake)
        self.assertEqual(len(sent), 2)
        self.assertIn("toolConfig", sent[0])
        self.assertNotIn("toolConfig", sent[1])
        self.assertEqual((result["engine"], result["intent"]), ("gemini", "plan"))

    def test_transient_overload_retries_then_uses_fallback_model(self):
        calls = []
        def fake(url, body, key, timeout):
            calls.append(url)
            if "gemini-3.1-flash-lite" in url:
                return 503, {"error": {"status": "UNAVAILABLE"}}
            return 200, call("reply", text="Ready to help.", kind="smalltalk")
        result, planner = self.ask("can you help me?", fake)
        self.assertEqual((result["engine"], result["reply"]), ("gemini", "Ready to help."))
        self.assertEqual(sum("gemini-3.1-flash-lite" in url for url in calls), 2)
        self.assertIn("gemini-3.5-flash-lite", calls[-1])
        planner.assert_not_called()

    def test_request_schema_avoids_shapes_the_api_rejects(self):
        for function in gemini.TOOLS[0]["functionDeclarations"]:
            parameters = function.get("parameters")
            if parameters is not None:
                self.assertTrue(parameters.get("properties"), f"{function['name']}: object schema without properties")
            for prop in (parameters or {}).get("properties", {}).values():
                self.assertNotIn("", prop.get("enum", []), f"{function['name']}: empty enum value")

    def test_without_a_key_gemini_is_never_called(self):
        fake = FakeGemini(data=call("reply", text="hi", kind="smalltalk"))
        with patch.dict(os.environ, {"GEMINI_API_KEY": ""}):
            result, _ = self.ask("from White Field Post Office to Hoodi", fake)
        self.assertEqual(fake.calls, [])
        self.assertEqual(result["engine"], "built-in")
        self.assertNotIn("notice", result)

    def test_request_shape(self):
        body = gemini.build_request("hello", history=[{"role": "assistant", "text": "x"}, {"role": "user", "text": "a"},
                                                      {"role": "user", "text": "b"}], now=NOW)
        self.assertEqual(body["toolConfig"]["functionCallingConfig"]["mode"], "ANY")
        self.assertEqual([c["role"] for c in body["contents"]], ["user"], "history starts with the traveller and alternates")
        self.assertIn("Sunday 17:40", body["contents"][0]["parts"][0]["text"])
        self.assertEqual(body["generationConfig"]["thinkingConfig"]["thinkingLevel"], "MINIMAL")
        self.assertEqual(body["generationConfig"]["maxOutputTokens"], 512)
        names = [f["name"] for f in body["tools"][0]["functionDeclarations"]]
        self.assertEqual(names, ["plan_journey", "check_live_buses", "swap_trip", "reply"])

    def test_model_name_is_validated(self):
        with patch.dict(os.environ, {"GEMINI_MODEL": "../../evil?x=1"}):
            self.assertEqual(gemini.settings()["model"], gemini.DEFAULT_MODEL)
        with patch.dict(os.environ, {"GEMINI_MODEL": "gemini-3.8-flash"}):
            self.assertEqual(gemini.settings()["model"], "gemini-3.8-flash")


class DotenvAndHealthTests(unittest.TestCase):
    def test_dotenv_fills_missing_values_only(self):
        folder = Path(tempfile.mkdtemp())
        (folder / ".env").write_text('# comment\nGEMINI_API_KEY="from-file"\nGEMINI_MODEL=\nlower=x\n', encoding="utf-8")
        with patch.dict(os.environ, {}, clear=False):
            os.environ.pop("GEMINI_API_KEY", None)
            os.environ["GEMINI_MODEL"] = "keep-me"
            gemini.load_dotenv(folder / ".env")
            self.assertEqual(os.environ["GEMINI_API_KEY"], "from-file")
            self.assertEqual(os.environ["GEMINI_MODEL"], "keep-me", "a real environment variable wins")
            self.assertNotIn("lower", os.environ)

    def test_health_reports_engine_but_never_the_key_and_env_file_is_not_served(self):
        root = Path(app_module.__file__).parent
        env_file = root / ".env"
        created = not env_file.exists()
        if created:
            env_file.write_text("GEMINI_API_KEY=should-not-leak\n", encoding="utf-8")
        server = app_module.ThreadingHTTPServer(("127.0.0.1", 0), app_module.TransitHandler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        base = f"http://127.0.0.1:{server.server_address[1]}"
        try:
            with patch.dict(os.environ, {"GEMINI_API_KEY": "secret-value-xyz"}), \
                    patch.object(app_module, "router_status", return_value=False):
                opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
                with opener.open(base + "/api/health", timeout=5) as response:
                    text = response.read().decode()
                self.assertNotIn("secret-value-xyz", text)
                with opener.open(base + "/static/app.js", timeout=5) as response:
                    response.read()
                    self.assertEqual(response.status, 200, "real static files are still served")
                with opener.open(base + "/", timeout=5) as response:
                    response.read()
                    self.assertEqual(response.status, 200)
                self.assertEqual(json.loads(text)["assistant"]["engine"], "gemini")
                for path in ("/.env", "/static/../.env", "/static/%2e%2e/.env", "/static/%2E%2E/%2E%2E/project/.env",
                             "/static/..%2f.env", "/static/%2e%2e/data/bengaluru_transit.db", "/static/%2e%2e/app.py",
                             "/.env.example", "/static/vendor/"):
                    with self.subTest(path=path):
                        with self.assertRaises(urllib.error.HTTPError) as caught:
                            opener.open(base + path, timeout=5)
                        self.assertEqual(caught.exception.code, 404)
        finally:
            server.shutdown()
            server.server_close()
            if created:
                env_file.unlink()


class AdvancedFeatureTests(unittest.TestCase):
    """Live-bus questions, "from here" and the fact-checked explanation."""

    @classmethod
    def setUpClass(cls):
        cls.db = make_database([("1", "White Field Post Office", 12.9693, 77.7500),
                                ("2", "Kempegowda Bus Station", 12.9781, 77.5723)])

    def setUp(self):
        patcher = patch.dict(os.environ, {"GEMINI_API_KEY": "test-key-123", "GEMINI_MODEL": ""})
        patcher.start()
        self.addCleanup(patcher.stop)

    def ask(self, message, fake=None, **payload):
        with patch.object(assistant, "plan_journey", return_value=PLAN) as planner:
            result = assistant.handle_assistant(self.db, {"message": message, **payload}, now=NOW, gemini_transport=fake)
        return result, planner

    def test_live_question_from_gemini(self):
        result, planner = self.ask("is 500d coming?", FakeGemini(data=call("check_live_buses", route="500d")))
        self.assertEqual((result["intent"], result["route"]), ("live", "500D"))
        planner.assert_not_called()

    def test_live_question_route_is_sanitised(self):
        result, _ = self.ask("where is my bus", FakeGemini(data=call("check_live_buses", route="<script>")))
        self.assertEqual(result["intent"], "live")
        self.assertIsNone(result["route"], "anything that is not a bus number is dropped")

    def test_live_question_without_gemini(self):
        with patch.dict(os.environ, {"GEMINI_API_KEY": ""}):
            for message, route in (("where is my bus", None), ("when will KBS-1K come", "KBS-1K"),
                                   ("when does 500D arrive", "500D")):
                with self.subTest(message=message):
                    result, planner = self.ask(message)
                    self.assertEqual((result["intent"], result["route"]), ("live", route))
                    planner.assert_not_called()

    def test_from_here_lets_the_page_use_gps_and_resolves_only_the_destination(self):
        fake = FakeGemini(data=call("plan_journey", destination="Majestic", from_my_location=True))
        result, planner = self.ask("take me to majestic from here", fake)
        self.assertEqual(result["intent"], "use_location")
        self.assertEqual(result["destination"]["stop_name"], "Kempegowda Bus Station")
        self.assertIsNone(result["origin"])
        planner.assert_not_called()   # the page plans after it has a GPS fix

    def test_from_here_without_gemini(self):
        with patch.dict(os.environ, {"GEMINI_API_KEY": ""}):
            result, _ = self.ask("from here to majestic")
        self.assertEqual(result["intent"], "use_location")
        self.assertEqual(result["destination"]["stop_name"], "Kempegowda Bus Station")

    def test_from_here_with_unknown_destination(self):
        fake = FakeGemini(data=call("plan_journey", destination="Atlantis", from_my_location=True))
        result, _ = self.ask("from here to atlantis", fake)
        self.assertEqual(result["intent"], "error")


ROUTES = [{"route_numbers": ["KBS-1K"], "departure_time": "19:31", "arrival_time": "20:59", "trip_minutes": 89,
           "transfers": 0, "walking_minutes": 2, "leave_in_minutes": 4, "also_lines": ["333-E", "333-K"]},
          {"route_numbers": ["328-H", "KSRTC-MULABAGILU-1"], "departure_time": "19:27", "arrival_time": "20:30",
           "trip_minutes": 63, "transfers": 1, "walking_minutes": 12, "detour": True}]


class ExplanationTests(unittest.TestCase):
    def setUp(self):
        patcher = patch.dict(os.environ, {"GEMINI_API_KEY": "test-key-123", "GEMINI_MODEL": ""})
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_facts_keep_zero_values(self):
        facts = gemini.facts_from_routes(ROUTES)
        self.assertEqual(facts[0]["changes"], 0)
        self.assertTrue(facts[1]["long_way_round"])
        self.assertNotIn("long_way_round", facts[0])

    def test_grounded_summaries_pass(self):
        facts = gemini.facts_from_routes(ROUTES)
        for text in ("Option 1 (KBS-1K) is direct with 0 changes: leave 19:31, arrive 20:59. 333-E and 333-K also go there.",
                     "Option 2 arrives earlier at 20:30 but goes the long way round, with 1 change and 12 min of walking."):
            with self.subTest(text=text):
                self.assertTrue(gemini.explanation_is_grounded(text, facts))

    def test_anything_not_in_the_results_is_rejected(self):
        facts = gemini.facts_from_routes(ROUTES)
        for text in ("Take 500D instead.", "Option 1 takes 75 minutes.", "Leave at 19:45 for option 1.",
                     "The fare is 25 rupees.", "Buses come every 10 minutes.", "Option 3 is best."):
            with self.subTest(text=text):
                self.assertFalse(gemini.explanation_is_grounded(text, facts))

    def test_explain_returns_checked_text_or_refuses(self):
        good = FakeGemini(data=call("explain", text="Option 1 (KBS-1K) is direct; option 2 is quicker but the long way round."))
        self.assertIn("KBS-1K", gemini.explain(ROUTES, transport=good))
        bad = FakeGemini(data=call("explain", text="Option 1 KBS-1K comes every 5 minutes."))
        import contextlib, io
        with contextlib.redirect_stdout(io.StringIO()):
            with self.assertRaises(gemini.GeminiUnavailable) as caught:
                gemini.explain(ROUTES, transport=bad)
        self.assertEqual(caught.exception.reason, "ungrounded")
        sent = json.dumps(good.calls[0]["body"])
        self.assertIn("KSRTC-MULABAGILU-1", sent)
        self.assertEqual(good.calls[0]["body"]["toolConfig"]["functionCallingConfig"]["allowedFunctionNames"], ["explain"])

    def test_explain_endpoint_without_key_says_so(self):
        server = app_module.ThreadingHTTPServer(("127.0.0.1", 0), app_module.TransitHandler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        try:
            with patch.dict(os.environ, {"GEMINI_API_KEY": ""}):
                opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
                request = urllib.request.Request(f"http://127.0.0.1:{server.server_address[1]}/api/explain",
                                                 data=json.dumps({"routes": ROUTES}).encode(), method="POST",
                                                 headers={"Content-Type": "application/json"})
                with opener.open(request, timeout=5) as response:
                    self.assertEqual(json.loads(response.read()), {"ok": False, "reason": "no_key"})
        finally:
            server.shutdown()
            server.server_close()


if __name__ == "__main__":
    unittest.main()
