"""Regression tests for the journey builder, stop search, assistant and live-bus relevance.

Run from the project folder:  python -m unittest discover -s tests -p "test_*.py"
No network, router or real database is needed: small fixtures are built in memory.
"""
import json
import sqlite3
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from datetime import datetime, timedelta
from pathlib import Path
from unittest.mock import patch

import app as app_module
from transit import assistant, bmtc_live, otp
from transit.bmtc_live import IST
from transit.planner import search_stops


# ---------------------------------------------------------------- helpers
def make_database(stops, routes=()):
    handle = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
    handle.close()
    conn = sqlite3.connect(handle.name)
    conn.executescript("""
        CREATE TABLE stops (stop_id TEXT PRIMARY KEY, stop_name TEXT, stop_lat REAL, stop_lon REAL, wheelchair_boarding TEXT);
        CREATE TABLE routes (route_id TEXT PRIMARY KEY, route_short_name TEXT, route_long_name TEXT, route_type TEXT);
        CREATE TABLE trips (trip_id TEXT PRIMARY KEY, route_id TEXT, service_id TEXT, trip_headsign TEXT, direction_id TEXT, shape_id TEXT);
        CREATE TABLE stop_times (trip_id TEXT, arrival_time TEXT, departure_time TEXT, stop_id TEXT, stop_sequence INTEGER);
    """)
    conn.executemany("INSERT INTO stops VALUES (?,?,?,?,NULL)", stops)
    conn.executemany("INSERT INTO routes VALUES (?,?,?,'3')", routes)
    conn.commit()
    conn.close()
    return Path(handle.name)


def stamp(minutes):
    return (datetime(2026, 10, 14, 9, 0, tzinfo=otp.IST) + timedelta(minutes=minutes)).isoformat()


def place(name, lat=12.97, lon=77.75, stop=None):
    return {"name": name, "lat": lat, "lon": lon, "stop": {"gtfsId": f"BMTC:{stop}"} if stop else None}


def walk_leg(start, end, src, dst, meters=150):
    return {"mode": "WALK", "transitLeg": False, "start": {"scheduledTime": stamp(start)},
            "end": {"scheduledTime": stamp(end)}, "duration": (end - start) * 60, "distance": meters,
            "realTime": False, "headsign": None, "from": src, "to": dst, "route": None,
            "legGeometry": {"points": ""}, "stopCalls": None, "trip": None, "serviceDate": None}


def bus_leg(start, end, src, dst, name, route_id="1", trip="t1", direction="1", stops=3):
    calls = [{"stopLocation": {"gtfsId": f"BMTC:{n}", "name": f"Stop {n}", "lat": 12.97 + n * 0.001, "lon": 77.75},
              "schedule": {"time": {"departure": stamp(start + n), "arrival": stamp(start + n)}}} for n in range(stops)]
    return {"mode": "BUS", "transitLeg": True, "start": {"scheduledTime": stamp(start)},
            "end": {"scheduledTime": stamp(end)}, "duration": (end - start) * 60, "distance": 5000,
            "realTime": False, "headsign": "Somewhere", "from": src, "to": dst,
            "route": {"gtfsId": f"BMTC:{route_id}", "shortName": name, "longName": ""},
            "legGeometry": {"points": ""}, "stopCalls": calls,
            "trip": {"gtfsId": f"BMTC:{trip}", "directionId": direction, "tripHeadsign": "Somewhere"},
            "serviceDate": "2026-10-14"}


def itinerary(legs):
    return {"node": {"start": legs[0]["start"]["scheduledTime"], "end": legs[-1]["end"]["scheduledTime"], "legs": legs}}


REQUESTED = datetime(2026, 10, 14, 9, 0, tzinfo=otp.IST)


# ------------------------------------------------------------ journey builder
class NonServiceRouteTests(unittest.TestCase):
    def test_gtfs_test_entries_are_not_services(self):
        for name in ("O Test AFCS", "EXP Test AFCS", "Vivek_Test14", "O TEST AFCS 258", "KIA Test AFCS"):
            self.assertTrue(otp.is_non_service_route(name), name)

    def test_real_routes_are_kept(self):
        for name in ("500-D", "V-335E", "245-DA KMT-BMTCTC", "KIA-15A", "G-4", "335-E"):
            self.assertFalse(otp.is_non_service_route(name), name)

    def test_ids_come_from_the_database_short_name_only(self):
        db = make_database([], [("9494", "O Test AFCS", "Hosakote ⇔ KBS"),
                                ("3585", "245-DA", "BMTC Training Centre ⇔ KR Market"),
                                ("1", "500-D", "A ⇔ B")])
        self.assertEqual(otp.excluded_route_ids(db), ["BMTC:9494"])


class JourneyBuilderTests(unittest.TestCase):
    def build(self, edges, excluded=()):
        return otp.build_routes({"edges": edges}, REQUESTED, {}, excluded)

    def test_walk_roles_waits_and_stops(self):
        origin, board = place("Hope Farm"), place("Hope Farm", stop=1)
        alight, dest = place("Whitefield", stop=2), place("Whitefield")
        legs = [walk_leg(1, 3, origin, board), bus_leg(8, 20, board, alight, "KIA-15A", stops=4),
                walk_leg(20, 22, alight, dest, 140)]
        [route] = self.build([itinerary(legs)])
        roles = [leg["role"] for leg in route["legs"]]
        self.assertEqual(roles, ["access_walk", "bus", "egress_walk"])
        bus = route["legs"][1]
        self.assertEqual(bus["wait_before_minutes"], 5, "5 minutes waiting at the stop between arriving and the bus")
        self.assertEqual(route["first_bus_wait_minutes"], 5)
        self.assertEqual(bus["stop_count"], 3, "4 stop calls = 3 stops ridden")
        self.assertEqual([s["stop_name"] for s in bus["stops"]][0], "Stop 0")
        self.assertEqual(route["legs"][2]["instruction"], "Walk 140 m (2 min) to your destination.")
        self.assertIn("a different stop with the same name", self.build([itinerary([
            bus_leg(0, 5, place("A", stop=1), place("X", stop=2), "10"),
            walk_leg(5, 7, place("X", stop=2), place("X", stop=3)),
            bus_leg(10, 20, place("X", stop=3), place("B", stop=4), "11")])])[0]["legs"][1]["instruction"])
        self.assertEqual(route["leave_in_minutes"], 1)
        self.assertTrue(route["schedule_based"])
        self.assertTrue(all(leg["schedule_type"] == "timetable" for leg in route["legs"]))
        self.assertIn("Not a live arrival", route["schedule_note"])

    def test_bus_line_is_anchored_to_its_stops(self):
        def encode(points):
            out, plat, plon = "", 0, 0
            for lon, lat in points:
                for value in (round(lat * 1e5) - plat, round(lon * 1e5) - plon):
                    value = ~(value << 1) if value < 0 else value << 1
                    while value >= 32:
                        out += chr((32 | (value & 31)) + 63)
                        value >>= 5
                    out += chr(value + 63)
                plat, plon = round(lat * 1e5), round(lon * 1e5)
            return out

        board = place("KR Market - Platform 5", 12.9660, 77.5750, stop=1)
        alight = place("Hub", 12.9800, 77.5900, stop=2)
        # The GTFS shape starts ~170 m from the platform and ends right at the alighting stop.
        shape = [[77.5750, 12.9675], [77.5800, 12.9720], [77.5900, 12.9800]]
        leg = bus_leg(0, 20, board, alight, "167")
        leg["legGeometry"] = {"points": encode(shape)}
        [route] = self.build([itinerary([leg])])
        line = route["legs"][0]["coordinates"]
        self.assertEqual(line[0], [77.575, 12.966], "line begins exactly at the boarding stop")
        self.assertEqual(len(line), 4, "one short connector added, nothing else changed")
        self.assertEqual(line[-1], [77.59, 12.98], "an end that already meets the stop is untouched")
        self.assertEqual(route["coordinates"][0], line[0])
        far = otp.anchor_to_stops([[77.7, 12.9]], {"lon": 77.5, "lat": 13.0}, {"lon": 77.9, "lat": 12.8})
        self.assertEqual(far, [[77.7, 12.9]], "a large gap is never papered over with a long invented line")
        self.assertEqual(otp.anchor_to_stops([], board, alight), [])

    def test_transfer_wait_totals_and_warnings(self):
        a, b, c, d = (place(n, stop=i) for i, n in enumerate("ABCD"))
        legs = [bus_leg(0, 10, a, b, "100"), bus_leg(11, 25, b, c, "200"), bus_leg(50, 60, c, d, "300")]
        [route] = self.build([itinerary(legs)])
        self.assertEqual(route["transfers"], 2)
        self.assertEqual(route["transfer_wait_minutes"], 1 + 25)
        text = " ".join(route["advisories"])
        self.assertIn("Tight connection to 200", text)
        self.assertIn("Long wait for 300", text)

    def test_test_routes_never_reach_the_traveller(self):
        a, b = place("A", stop=1), place("B", stop=2)
        real = itinerary([bus_leg(0, 30, a, b, "500-D", route_id="5")])
        fake = itinerary([bus_leg(0, 20, a, b, "O Test AFCS", route_id="9494")])
        self.assertEqual([r["route_numbers"] for r in self.build([fake, real], excluded=["BMTC:9494"])], [["500-D"]])
        self.assertEqual(self.build([fake]), [], "short-name check also protects when the id list is stale")

    def test_very_long_transfer_wait_is_dropped_unless_it_is_the_only_option(self):
        a, b, c = (place(n, stop=i) for i, n in enumerate("ABC"))
        slow = itinerary([bus_leg(0, 10, a, b, "1"), bus_leg(110, 120, b, c, "2")])
        direct = itinerary([bus_leg(0, 60, a, c, "3")])
        self.assertEqual([r["route_numbers"] for r in self.build([slow, direct])], [["3"]])
        [only] = self.build([slow])
        self.assertIn("very long wait", only["advisories"][0])

    def test_dominated_options_are_removed_but_next_departures_are_kept(self):
        a, b, m, c = (place(n, stop=i) for i, n in enumerate("ABMC"))
        direct = itinerary([bus_leg(0, 40, a, c, "335E", trip="t1")])
        direct_later = itinerary([bus_leg(20, 60, a, c, "335E", trip="t2")])
        worse = itinerary([bus_leg(0, 20, a, m, "1"), bus_leg(25, 45, m, c, "2")])
        routes = self.build([direct, direct_later, worse])
        self.assertEqual(sorted(r["departure_time"] for r in routes), ["09:00", "09:20"])
        self.assertTrue(all(r["route_numbers"] == ["335E"] for r in routes))

    def test_long_walk_only_result_is_not_offered(self):
        walk = itinerary([walk_leg(0, 45, place("A"), place("B"), 3500)])
        self.assertEqual(self.build([walk]), [])

    def test_preference_ranking_uses_arrival_time_changes_and_walking(self):
        a, b, m = (place(n, stop=i) for i, n in enumerate("ABM"))
        fast_two = itinerary([bus_leg(0, 20, a, m, "1"), bus_leg(22, 40, m, b, "2")])
        slow_direct = itinerary([bus_leg(0, 50, a, b, "3")])
        routes = self.build([fast_two, slow_direct])
        self.assertEqual(otp._rank(list(routes), "fastest")[0]["route_numbers"], ["1", "2"])
        self.assertEqual(otp._rank(list(routes), "fewer_transfers")[0]["route_numbers"], ["3"])


class DepartureTimeTests(unittest.TestCase):
    NOW = datetime(2026, 10, 13, 22, 45, tzinfo=otp.IST)

    def test_default_is_now(self):
        when, label, is_now = otp.resolve_departure({}, self.NOW)
        self.assertEqual((when, label, is_now), (self.NOW, "Now", True))

    def test_past_clock_time_means_tomorrow_and_future_means_today(self):
        when, label, _ = otp.resolve_departure({"depart_at": "09:00"}, self.NOW)
        self.assertEqual((when.day, label), (14, "Tomorrow 09:00"))
        when, label, _ = otp.resolve_departure({"depart_at": "23:30"}, self.NOW)
        self.assertEqual((when.day, label), (13, "Today 23:30"))

    def test_explicit_date_and_legacy_name(self):
        when, _, _ = otp.resolve_departure({"departure_time_override": "08:15", "depart_date": "2026-10-20"}, self.NOW)
        self.assertEqual((when.month, when.day, when.hour, when.minute), (10, 20, 8, 15))

    def test_rejects_garbage(self):
        for bad in ({"depart_at": "25:00"}, {"depart_at": "9am"}, {"depart_at": "09:00", "depart_date": "tomorrow"}):
            with self.assertRaises(ValueError):
                otp.resolve_departure(bad, self.NOW)

    def test_out_of_area_map_point_is_rejected(self):
        conn = sqlite3.connect(":memory:")
        self.addCleanup(conn.close)
        with self.assertRaises(ValueError):
            otp._stop(conn, "", {"id": "p", "name": "Mumbai", "lat": 19.07, "lon": 72.87})


# ---------------------------------------------------------------- stop search
class StopSearchTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.db = make_database([
            ("1", "White Field Bus Station (Vydehi Hospital)", 12.976, 77.726),
            ("2", "Kempegowda Bus Station", 12.977, 77.571),
            ("3", "Kempegowda Arch", 13.0, 77.52),
            ("4", "Yeshawanthapura", 13.02, 77.54),
            ("5", "Hope Farm", 12.984, 77.752),
        ])

    def names(self, query):
        return [row["stop_name"] for row in search_stops(self.db, query)]

    def test_spacing_does_not_matter(self):
        self.assertIn("White Field Bus Station (Vydehi Hospital)", self.names("Whitefield"))
        self.assertEqual(self.names("hopefarm"), ["Hope Farm"])

    def test_known_local_names(self):
        self.assertEqual(self.names("Majestic")[0], "Kempegowda Bus Station")
        self.assertEqual(self.names("yeshwanthpur"), ["Yeshawanthapura"])

    def test_no_match_and_empty_query(self):
        self.assertEqual(self.names("zzzzz"), [])
        self.assertTrue(self.names(""))


# ------------------------------------------------------------------ assistant
class AssistantParsingTests(unittest.TestCase):
    def test_from_to(self):
        parsed = assistant.parse_command("Take me from Hope Farm to Majestic")
        self.assertEqual((parsed["origin"], parsed["destination"]), ("Hope Farm", "Majestic"))

    def test_bare_pair_and_reversed_phrasing(self):
        self.assertEqual(assistant.parse_command("Hope Farm to Majestic")["destination"], "Majestic")
        parsed = assistant.parse_command("go to Majestic from Hope Farm")
        self.assertEqual((parsed["origin"], parsed["destination"]), ("Hope Farm", "Majestic"))

    def test_preference_and_time(self):
        parsed = assistant.parse_command("from Hope Farm to Majestic with less walking, leave at 9:30 pm")
        self.assertEqual((parsed["preference"], parsed["depart_at"]), ("less_walking", "21:30"))
        self.assertEqual((parsed["origin"], parsed["destination"]), ("Hope Farm", "Majestic"))
        self.assertEqual(assistant.parse_command("fewer transfers please")["preference"], "fewer_transfers")
        self.assertEqual(assistant.parse_command("from A to B leave at 12 am")["depart_at"], "00:00")

    def test_swap_and_help(self):
        self.assertTrue(assistant.parse_command("swap")["swap"])
        self.assertIsNone(assistant.parse_command("what is the weather")["origin"])


class AssistantFlowTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.db = make_database([("1", "Hope Farm", 12.984, 77.752), ("2", "Kempegowda Bus Station", 12.977, 77.571)])

    def test_unknown_place_is_reported_not_invented(self):
        result = assistant.handle_assistant(self.db, {"message": "from Atlantis to Hope Farm"})
        self.assertFalse(result["ok"])
        self.assertIn("could not find a BMTC stop called \"Atlantis\"", result["reply"])
        self.assertIsNone(result["plan"])

    def test_missing_half_asks_a_question_and_keeps_the_stop(self):
        result = assistant.handle_assistant(self.db, {"message": "to Majestic"})
        self.assertEqual(result["intent"], "partial")
        self.assertEqual(result["destination"]["stop_name"], "Kempegowda Bus Station")
        self.assertIn("starting point", result["reply"])

    def test_plan_reply_carries_a_short_summary_separate_from_notes(self):
        route = {"transit": True, "route_numbers": ["KBS-1K"], "transfers": 0, "departure_time": "10:03", "arrival_time": "11:29"}
        plan = {"origin": {"stop_name": "Hope Farm"}, "destination": {"stop_name": "Kempegowda Bus Station"},
                "routes": [route], "requested": {"label": "Tomorrow 10:00"}}
        ctx = lambda i, n, lat, lon: {"id": i, "name": n, "lat": lat, "lon": lon}
        with patch.object(assistant, "plan_journey", return_value=plan):
            result = assistant.handle_assistant(self.db, {"message": "swap", "origin": ctx("1", "Hope Farm", 12.984, 77.752),
                                                          "destination": ctx("2", "Kempegowda Bus Station", 12.977, 77.571)})
        self.assertEqual(result["intent"], "plan")
        self.assertIn("Swapped", result["reply"])
        self.assertNotIn("Swapped", result["summary"], "the toast text is just the journey summary")
        self.assertIn("KBS-1K", result["summary"])
        self.assertTrue(result["reply"].startswith(result["summary"]), "the journey comes first, notes after")

    def test_router_down_still_resolves_the_places(self):
        with patch.object(assistant, "plan_journey", side_effect=otp.RouterUnavailable("The route engine is not running.")):
            result = assistant.handle_assistant(self.db, {"message": "Hope Farm to Majestic"})
        self.assertFalse(result["ok"])
        self.assertEqual(result["origin"]["stop_name"], "Hope Farm")
        self.assertIn("route engine is not running", result["reply"])

    def test_plan_receives_preference_and_time_and_swap_uses_page_context(self):
        seen = {}

        def fake_plan(db, origin_id, destination_id, profile, origin_point, destination_point, now=None):
            seen.update(origin=origin_id, destination=destination_id, profile=profile)
            return {"origin": {"stop_name": "o"}, "destination": {"stop_name": "d"}, "routes": [], "requested": {"label": "Now"},
                    "fallback": {"message": "none"}}

        with patch.object(assistant, "plan_journey", fake_plan):
            assistant.handle_assistant(self.db, {"message": "Hope Farm to Majestic less walking leave at 8:15"})
            self.assertEqual(seen["profile"], {"preference": "less_walking", "depart_at": "08:15"})
            assistant.handle_assistant(self.db, {"message": "swap",
                                                 "origin": {"id": "1", "name": "Hope Farm", "lat": 12.984, "lon": 77.752},
                                                 "destination": {"id": "2", "name": "KBS", "lat": 12.977, "lon": 77.571}})
            self.assertEqual((seen["origin"], seen["destination"]), ("2", "1"))

    def test_input_limits(self):
        with self.assertRaises(ValueError):
            assistant.handle_assistant(self.db, {"message": ""})
        with self.assertRaises(ValueError):
            assistant.handle_assistant(self.db, {"message": "x" * 301})


# ------------------------------------------------------- live-bus relevance
LINE = [(12.9800, 77.700 + 0.004 * i) for i in range(8)]      # S0..S7 west -> east


def fixture_bus(vid, index, age, current=True, lat=None, lon=None, eta=""):
    stamp_text = (datetime.now(IST) - timedelta(seconds=age)).strftime("%d-%m-%Y %H:%M:%S") if age is not None else ""
    bus = {"vehicleid": vid, "vehiclenumber": f"KA57F{vid}", "centerlat": lat if lat is not None else LINE[index][0],
           "centerlong": lon if lon is not None else LINE[index][1], "lastrefreshon": stamp_text, "eta": eta}
    if current:
        bus["currentlocationid"] = index
    return bus


def fixture_branch(order, buses):
    """order lists station numbers in travel order; buses is [(vehicle, station index in this branch)]."""
    groups = []
    for position, station in enumerate(order):
        groups.append({"stationid": station, "stationname": f"Stop {station}", "centerlat": LINE[station][0],
                       "centerlong": LINE[station][1], "vehicleDetails": []})
    for bus, position in buses:
        bus = dict(bus)
        if "currentlocationid" in bus:
            bus["currentlocationid"] = order[position]
        for group in groups[position:]:
            group["vehicleDetails"].append(bus)
    return {"data": groups, "mapData": []}


def feed(up_buses=(), down_buses=(), up_order=range(8), down_order=range(7, -1, -1)):
    details = {"up": fixture_branch(list(up_order), up_buses), "down": fixture_branch(list(down_order), down_buses)}

    def post(endpoint, payload):
        if endpoint == "SearchRoute_v2":
            return {"data": [{"routeno": "335E", "routeparentid": 77}]}
        return details

    return post


BOARD, ALIGHT = LINE[2], LINE[5]


class LiveRelevanceTests(unittest.TestCase):
    def live(self, post, board=BOARD, alight=ALIGHT, **kw):
        bmtc_live._cache.clear()
        with patch.object(bmtc_live, "_post", post):
            return bmtc_live.live_route("335E", board[0], board[1], alight_lat=alight[0] if alight else None,
                                        alight_lon=alight[1] if alight else None, force_refresh=True, **kw)

    def by_id(self, result):
        return {v["id"]: v for v in result["vehicles"] + result["hidden"]}

    def test_each_kind_of_bus_gets_the_right_label(self):
        post = feed(
            up_buses=[(fixture_bus("approach", 0, 20), 0), (fixture_bus("close", 1, 40), 1),
                      (fixture_bus("gone", 4, 20), 4)],
            down_buses=[(fixture_bus("opposite", 3, 10), 4)])
        result = self.live(post)
        buses = self.by_id(result)
        self.assertTrue(result["direction"]["verified"])
        self.assertEqual(result["direction"]["branch"], "up")
        self.assertEqual((buses["approach"]["relevance"], buses["approach"]["stops_away"]), ("approaching", 2))
        self.assertEqual((buses["close"]["relevance"], buses["close"]["stops_away"]), ("approaching", 1))
        self.assertEqual(buses["gone"]["relevance"], "passed")
        self.assertEqual(buses["opposite"]["relevance"], "wrong_direction")
        self.assertEqual([v["id"] for v in result["vehicles"]], ["close", "approach"], "nearest approaching bus first")
        self.assertEqual({v["id"] for v in result["hidden"]}, {"gone", "opposite"})
        self.assertEqual(result["counts"]["approaching"], 2)

    def test_route_number_alone_never_makes_a_bus_suitable(self):
        post = feed(up_buses=[(fixture_bus("a", 0, 10), 0)])
        no_alight = self.live(post, alight=None)
        self.assertFalse(no_alight["direction"]["verified"])
        self.assertEqual([v["relevance"] for v in no_alight["vehicles"]], ["unverified"])
        self.assertIn("alighting stop", no_alight["direction"]["note"])

    def test_alighting_stop_not_after_boarding_in_either_branch(self):
        post = feed(up_buses=[(fixture_bus("a", 0, 10), 0)])
        result = self.live(post, board=LINE[5], alight=LINE[5])   # same place: no order exists
        self.assertFalse(result["direction"]["verified"])
        self.assertEqual({v["relevance"] for v in result["vehicles"]}, {"unverified"})
        self.assertIn("does not contain your boarding stop followed by", result["direction"]["note"])

    def test_reverse_journey_flips_which_branch_is_relevant(self):
        post = feed(up_buses=[(fixture_bus("east", 0, 10), 0)], down_buses=[(fixture_bus("west", 6, 10), 1)])
        result = self.live(post, board=LINE[5], alight=LINE[2])
        buses = self.by_id(result)
        self.assertEqual(result["direction"]["branch"], "down")
        self.assertEqual(buses["west"]["relevance"], "approaching")
        self.assertEqual(buses["east"]["relevance"], "wrong_direction")

    def test_loop_route_with_both_directions_valid_is_not_verified(self):
        loop = list(range(8)) + list(range(8))   # same stops twice: both branches contain board before alight
        post = feed(up_buses=[(fixture_bus("a", 0, 10), 0)], up_order=loop, down_order=loop)
        result = self.live(post)
        self.assertFalse(result["direction"]["verified"])
        self.assertTrue(all(v["relevance"] == "unverified" for v in result["vehicles"]))

    def test_arrival_estimate_is_bmtcs_own_eta_at_the_boarding_stop(self):
        post = feed(up_buses=[(fixture_bus("soon", 0, 15), 0)], down_buses=[(fixture_bus("other", 6, 15), 1)])
        details = post("SearchByRouteDetails_v4", {})
        for branch in details.values():
            for position, group in enumerate(branch["data"]):
                # a different BMTC ETA at every stop (copies: the fixture shares one dict across stops)
                group["vehicleDetails"] = [dict(bus, eta=f"2026-10-14 10:{position:02d}:00") for bus in group["vehicleDetails"]]
        buses = self.by_id(self.live(post))
        self.assertEqual(buses["soon"]["board_eta"], "2026-10-14 10:02:00", "ETA at the boarding stop (Stop 2), not the next stop")
        self.assertEqual(buses["soon"]["board_stop"], "Stop 2")
        self.assertIsNone(buses["other"].get("board_eta"), "no arrival estimate for a bus going the other way")

    def test_heading_lists_the_next_stops_on_the_buses_own_run(self):
        post = feed(up_buses=[(fixture_bus("east", 0, 15), 0)], down_buses=[(fixture_bus("west", 6, 15), 1)])
        buses = self.by_id(self.live(post))
        heading = buses["east"]["heading"]
        self.assertEqual([s["name"] for s in heading["stops"]], [f"Stop {i}" for i in range(1, 8)],
                         "stops after the bus, in BMTC's order, to the end of a short line")
        self.assertEqual(heading["towards"], "Stop 7")
        self.assertEqual(heading["direction"], "up")
        self.assertNotIn("heading", buses["west"], "hidden (opposite direction) buses carry no line")

    def test_heading_runs_to_the_end_of_the_buses_route_and_marks_the_boarding_stop(self):
        long_line = list(range(8)) * 6           # 48 stations on one run
        post = feed(up_buses=[(fixture_bus("far", 0, 15), 0)], up_order=long_line, down_order=[7, 6])
        branch = bmtc_live._parse_branches([(1, post("SearchByRouteDetails_v4", {}))])[0]
        whole = bmtc_live._heading(branch, 0)
        self.assertEqual(len(whole["stops"]), 47, "every remaining stop to the last one")
        self.assertEqual(whole["towards"], "Stop 7")
        self.assertNotIn("board_stop", whole)
        coming = bmtc_live._heading(branch, 3, until=20)
        self.assertEqual(coming["board_stop"], "Stop 4", "station 20 of the run is Stop 4")
        self.assertIsNone(bmtc_live._heading(branch, None), "no position along the route: no line")
        self.assertIsNone(bmtc_live._heading(branch, 47), "already at the last stop")

    def test_no_eta_from_bmtc_means_none_shown(self):
        buses = self.by_id(self.live(feed(up_buses=[(fixture_bus("quiet", 0, 15), 0)])))
        self.assertIsNone(buses["quiet"]["board_eta"])

    def test_freshness_is_reported_separately_from_relevance(self):
        post = feed(up_buses=[(fixture_bus("fresh", 0, 15), 0), (fixture_bus("stale", 1, 900), 1),
                              (fixture_bus("none", 0, None), 0)])
        buses = self.by_id(self.live(post))
        self.assertEqual([buses[k]["freshness"] for k in ("fresh", "stale", "none")], ["fresh", "stale", "unavailable"])
        self.assertTrue(all(buses[k]["relevance"] == "approaching" for k in buses))
        self.assertIsNone(buses["none"]["age_seconds"])

    def test_position_without_progress_is_estimated_or_unverified(self):
        far = fixture_bus("far", 0, 10, current=False, lat=12.90, lon=77.60)       # nowhere near the line
        near = fixture_bus("near", 0, 10, current=False, lat=LINE[1][0], lon=LINE[1][1])
        post = feed(up_buses=[(far, 0), (near, 0)])
        buses = self.by_id(self.live(post))
        self.assertEqual(buses["far"]["relevance"], "unverified", "no progress can be established")
        self.assertEqual((buses["near"]["relevance"], buses["near"]["progress_source"]), ("approaching", "estimated"))
        self.assertIn("estimated", buses["near"]["reason"])

    def test_boarding_stop_arrivals_only_list_approaching_buses(self):
        post = feed(up_buses=[(fixture_bus("a", 0, 10, eta="2026-10-14 09:05:00"), 0),
                              (fixture_bus("gone", 4, 10, eta="2026-10-14 09:09:00"), 4)])
        boarding = self.live(post)["boarding_stop"]
        self.assertEqual([b["id"] for b in boarding["arrivals"]], ["a"])
        self.assertTrue(boarding["direction_verified"])

    def test_boarding_stop_far_from_any_bmtc_stop_gives_no_match(self):
        result = self.live(feed(up_buses=[(fixture_bus("a", 0, 10), 0)]), board=(12.90, 77.60))
        self.assertIsNone(result["boarding_stop"])
        self.assertFalse(result["direction"]["verified"])

    def test_cache_does_not_mix_different_destinations(self):
        bmtc_live._cache.clear()
        post = feed(up_buses=[(fixture_bus("a", 0, 10), 0)])
        with patch.object(bmtc_live, "_post", post):
            forward = bmtc_live.live_route("335E", BOARD[0], BOARD[1], alight_lat=ALIGHT[0], alight_lon=ALIGHT[1])
            backward = bmtc_live.live_route("335E", ALIGHT[0], ALIGHT[1], alight_lat=BOARD[0], alight_lon=BOARD[1])
        self.assertNotEqual(forward["direction"]["branch"], backward["direction"]["branch"])

    def test_feed_failure_is_an_actionable_error(self):
        def down(endpoint, payload):
            raise bmtc_live.BMTCUnavailable("BMTC live service could not be reached. Scheduled routes are still available.")

        bmtc_live._cache.clear()
        with patch.object(bmtc_live, "_post", down):
            with self.assertRaises(bmtc_live.BMTCUnavailable) as caught:
                bmtc_live.live_route("335E", BOARD[0], BOARD[1])
        self.assertIn("Scheduled routes are still available", str(caught.exception))

    def test_input_validation(self):
        for kwargs in ({"stop_lat": 12.98}, {"stop_lat": 12.98, "stop_lon": 77.7, "alight_lat": 12.9},
                       {"stop_lat": 40.0, "stop_lon": 77.7}):
            with self.assertRaises(ValueError):
                bmtc_live.live_route("335E", **kwargs)
        with self.assertRaises(ValueError):
            bmtc_live.live_route("<script>")


# ------------------------------------------------------------ HTTP contract
class HttpContractTests(unittest.TestCase):
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

    def request(self, path, body=None, raw=None):
        data = raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
        req = urllib.request.Request(f"http://127.0.0.1:{self.port}{path}", data, {"Content-Type": "application/json"} if data else {})
        try:
            with urllib.request.urlopen(req, timeout=10) as response:
                return response.status, response.headers.get("Content-Type", ""), response.read()
        except urllib.error.HTTPError as error:
            return error.code, error.headers.get("Content-Type", ""), error.read()

    def test_api_errors_are_always_json(self):
        for path, body, raw in (("/api/plan", None, b"not json"), ("/api/plan", {"origin_stop_id": "nope"}, None),
                                ("/api/assistant", {"message": ""}, None), ("/api/missing", None, None),
                                ("/api/bmtc/route?q=%3Cx%3E", None, None)):
            status, kind, payload = self.request(path, body, raw)
            self.assertGreaterEqual(status, 400, path)
            self.assertIn("application/json", kind, path)
            self.assertTrue(json.loads(payload).get("error") or json.loads(payload).get("message"), path)

    def test_assistant_endpoint_exists_and_answers(self):
        status, kind, payload = self.request("/api/assistant", {"message": "hello"})
        data = json.loads(payload)
        self.assertEqual(status, 200)
        self.assertEqual(data["intent"], "help")
        status, _, payload = self.request("/api/assistant", {"message": "from Nowhereville to Hope Farm"})
        self.assertFalse(json.loads(payload)["ok"])

    def test_stops_search_and_health(self):
        status, _, payload = self.request("/api/stops?q=whitefield")
        self.assertEqual(json.loads(payload)["stops"][0]["stop_name"], "White Field")
        status, _, payload = self.request("/api/health")
        health = json.loads(payload)
        self.assertTrue(health["ok"] and health["database"])
        self.assertIsInstance(health["router"], bool)

    def test_router_down_is_a_clear_503(self):
        with patch.object(app_module, "plan_journey", side_effect=otp.RouterUnavailable("The route engine is not running.")):
            status, kind, payload = self.request("/api/plan", {"origin_stop_id": "1", "destination_stop_id": "2"})
        self.assertEqual(status, 503)
        self.assertTrue(json.loads(payload)["router_unavailable"])

    def test_project_files_are_not_served(self):
        for path in ("/app.py", "/data/bengaluru_transit.db", "/transit/otp.py", "/JOURNEY_FEATURES.md"):
            self.assertEqual(self.request(path)[0], 404, path)
        self.assertEqual(self.request("/")[0], 200)


if __name__ == "__main__":
    unittest.main()
