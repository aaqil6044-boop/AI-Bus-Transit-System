"""Small, optional adapter for BMTC's documented mobile API.

Endpoint shapes are documented by the community Bengaluru Transit SDK at
https://github.com/Sync271/bengaluru-transit (MIT) and
https://github.com/PratyushBalaji/BMTC-API. BMTC owns the API; neither source
is an official BMTC developer agreement. Failures must never block OTP routing.

Relevance model
---------------
A route number matching is NOT enough to call a bus useful: BMTC publishes an
"up" and a "down" branch per route, each with its own ordered stop list. A bus is
only ``approaching`` when, in one branch, the planned boarding stop comes
*before* the planned alighting stop and the bus has not yet passed the boarding
stop. Vehicles on the other branch are ``wrong_direction``; vehicles already past
the boarding stop are ``passed``; anything that cannot be verified is
``unverified`` and is never presented as suitable.
"""
from __future__ import annotations

import json
import math
import os
import re
import threading
import time
from datetime import datetime, timedelta, timezone
from urllib.error import HTTPError, URLError
from urllib.request import ProxyHandler, Request, build_opener

from . import reliability

API_ROOT = os.environ.get(
    "BMTC_API_ROOT", "https://bmtcmobileapi.karnataka.gov.in/WebAPI"
).rstrip("/")
IST = timezone(timedelta(hours=5, minutes=30))
BOUNDS = (12.65, 13.45, 77.20, 78.00)
FRESH_SECONDS = 120
BOARD_MATCH_M = 300      # planned boarding stop must be this close to a BMTC stop
ALIGHT_MATCH_M = 450     # alighting stop is only used to confirm the direction of travel
AMBIGUOUS_M = 80         # two branches this similar (loop routes) cannot be told apart
ESTIMATE_PROGRESS_M = 700
_cache: dict[str, tuple[float, dict]] = {}
_cache_lock = threading.Lock()


class BMTCUnavailable(RuntimeError):
    def __init__(self, message: str, status: int | None = None):
        super().__init__(message)
        self.status = status


def _post(endpoint: str, payload: dict) -> dict:
    body = json.dumps(payload).encode("utf-8")
    request = Request(
        f"{API_ROOT}/{endpoint}", body,
        headers={
            "Content-Type": "application/json",
            "Accept": "application/json, text/plain, */*",
            "lan": "en",
            "deviceType": "WEB",
            "User-Agent": "BengaluruTransitAssistant/1.0",
        }, method="POST",
    )
    try:
        with build_opener(ProxyHandler({})).open(request, timeout=7) as response:
            result = json.load(response)
    except HTTPError as error:
        if error.code in (401, 403):
            raise BMTCUnavailable(
                "BMTC is denying access to its live vehicle feed (HTTP 403). "
                "Scheduled route planning is still available.", error.code
            ) from error
        raise BMTCUnavailable(f"BMTC live service returned HTTP {error.code}.", error.code) from error
    except (URLError, TimeoutError, OSError, json.JSONDecodeError) as error:
        raise BMTCUnavailable("BMTC live service could not be reached. Scheduled routes are still available.") from error
    if not isinstance(result, dict):
        raise BMTCUnavailable("BMTC returned an unreadable live-feed response.")
    return result


def _cached_route(key: str) -> dict | None:
    with _cache_lock:
        entry = _cache.get(key)
        if entry and entry[0] > time.monotonic():
            return entry[1]
        _cache.pop(key, None)
    return None


def _save_route(key: str, payload: dict) -> dict:
    with _cache_lock:
        if key not in _cache and len(_cache) >= 128:
            _cache.pop(next(iter(_cache)))
        _cache[key] = (time.monotonic() + 20, payload)
    return payload


def _route_matches(requested: str, candidate: dict) -> bool:
    value = str(candidate.get("routeno") or candidate.get("routeNo") or "")
    normalize = lambda text: re.sub(r"[^a-z0-9]", "", text.casefold())
    return normalize(value) == normalize(requested)


def _search_term(route_number: str) -> str:
    """OTP often appends terminal names to BMTC's short public route code."""
    return route_number.split(maxsplit=1)[0]


def _number(value):
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _distance_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    dlat = math.radians(lat2 - lat1)
    dlon = math.radians(lon2 - lon1)
    a = (math.sin(dlat / 2) ** 2 +
         math.cos(math.radians(lat1)) * math.cos(math.radians(lat2)) * math.sin(dlon / 2) ** 2)
    return 2 * 6371000 * math.asin(math.sqrt(a))


def freshness(age_seconds) -> str:
    """fresh: recent timestamp; stale: old timestamp; unavailable: no timestamp."""
    if age_seconds is None:
        return "unavailable"
    return "fresh" if age_seconds <= FRESH_SECONDS else "stale"


def _vehicle(value: dict, route_number: str, direction: str,
             station: dict | None = None) -> dict | None:
    try:
        lat = float(value.get("centerlat", value.get("latitude")))
        lon = float(value.get("centerlong", value.get("longitude")))
    except (TypeError, ValueError):
        return None
    if not (BOUNDS[0] <= lat <= BOUNDS[1] and BOUNDS[2] <= lon <= BOUNDS[3]):
        return None
    updated = str(value.get("lastrefreshon") or value.get("lastupdatedat") or "")
    age = None
    if updated:
        for pattern in ("%d-%m-%Y %H:%M:%S", "%d/%m/%Y %H:%M:%S"):
            try:
                timestamp = datetime.strptime(updated, pattern).replace(tzinfo=IST)
                age = max(0, int((datetime.now(IST) - timestamp).total_seconds()))
                break
            except ValueError:
                continue
    identifier = str(value.get("vehicleid") or value.get("vehicleId") or value.get("vehiclenumber") or "")
    next_stop = str(value.get("nextstop") or "")
    return {
        "id": identifier, "label": str(value.get("vehiclenumber") or value.get("busno") or "BMTC bus"),
        "route": str(value.get("routeno") or route_number), "direction": direction,
        "lat": lat, "lon": lon, "heading": _number(value.get("heading")),
        "next_stop": next_stop,
        "eta": "", "eta_stop": "",
        "updated_at": updated,
        "age_seconds": age,
        "freshness": freshness(age),
    }


def _fresher(new: dict, old: dict | None) -> bool:
    if old is None:
        return True
    if new["age_seconds"] is None:
        return False
    return old["age_seconds"] is None or new["age_seconds"] < old["age_seconds"]


def _parse_branches(details_by_route: list[tuple[int, dict]]) -> list[dict]:
    """Ordered station lists per (route id, direction) from BMTC route details."""
    branches = []
    for route_id, details in details_by_route:
        for direction in ("up", "down"):
            branch = details.get(direction) or {}
            groups = [row for row in (branch.get("data") or []) if isinstance(row, dict)]
            stations = []
            for index, group in enumerate(groups):
                stations.append({
                    "index": index,
                    "id": str(group.get("stationid")) if group.get("stationid") is not None else None,
                    "name": str(group.get("stationname") or ""),
                    "lat": _number(group.get("centerlat")), "lon": _number(group.get("centerlong")),
                    "group": group,
                })
            branches.append({
                "route_id": route_id, "direction": direction, "stations": stations,
                "by_id": {s["id"]: s["index"] for s in stations if s["id"] is not None},
                "map_data": [row for row in (branch.get("mapData") or []) if isinstance(row, dict)],
            })
    return branches


def _nearest_station(stations: list[dict], lat: float, lon: float):
    best = None
    for station in stations:
        if station["lat"] is None or station["lon"] is None:
            continue
        distance = _distance_m(lat, lon, station["lat"], station["lon"])
        if best is None or distance < best[0]:
            best = (distance, station)
    return best


def _match_direction(branches: list[dict], board: tuple[float, float] | None,
                     alight: tuple[float, float] | None) -> dict:
    """Find every branch in which the boarding stop comes before the alighting stop.

    ``valid`` holds (branch, board match, alight match) for each such branch,
    best first. ``verified`` is only True when an alighting stop confirmed the
    order and the two directions cannot be confused (loop routes).
    """
    empty = {"valid": [], "primary": None, "verified": False, "board": None, "alight": None}
    if board is None:
        return {**empty, "note": "No boarding stop was supplied, so the direction of travel cannot be checked."}
    candidates = []
    for branch in branches:
        near_board = _nearest_station(branch["stations"], *board)
        if not near_board or near_board[0] > BOARD_MATCH_M:
            continue
        if alight is None:
            candidates.append((near_board[0], branch, near_board, None))
            continue
        near_alight = _nearest_station(branch["stations"], *alight)
        if (near_alight and near_alight[0] <= ALIGHT_MATCH_M and
                near_alight[1]["index"] > near_board[1]["index"]):
            candidates.append((near_board[0] + near_alight[0], branch, near_board, near_alight))
    if not candidates:
        return {**empty, "note": ("BMTC's stop list for this route does not contain your boarding stop followed by "
                                  "your alighting stop, so no bus can be confirmed as heading the right way.")}
    candidates.sort(key=lambda item: item[0])
    score, primary, near_board, near_alight = candidates[0]
    valid = [(branch, nb, na) for _, branch, nb, na in candidates]
    result = {"valid": valid, "primary": primary, "board": near_board, "alight": near_alight, "verified": False}
    if alight is None:
        result["note"] = "No alighting stop was supplied, so the direction of travel cannot be confirmed."
    elif any(c[1]["direction"] != primary["direction"] and c[0] - score < AMBIGUOUS_M for c in candidates[1:]):
        result["note"] = ("Both directions of this route pass your stops (a loop route), so direction "
                          "cannot be confirmed.")
    else:
        result["verified"] = True
        result["note"] = (f"{primary['direction'].upper()} direction: BMTC lists "
                          f"{near_board[1]['name'] or 'your boarding stop'} before "
                          f"{near_alight[1]['name'] or 'your alighting stop'}.")
    return result


def _branch_vehicles(branch: dict, route_number: str) -> dict[str, dict]:
    """Vehicles BMTC reports on one branch, with progress along that branch."""
    found: dict[str, dict] = {}
    cur_ids: dict[str, str | None] = {}
    etas: dict[str, dict[int, str]] = {}
    for station in branch["stations"]:
        for raw in station["group"].get("vehicleDetails") or []:
            if not isinstance(raw, dict):
                continue
            item = _vehicle(raw, route_number, branch["direction"])
            if not item:
                continue
            key = item["id"] or f'{item["lat"]}:{item["lon"]}'
            if _fresher(item, found.get(key)):
                found[key] = item
            if raw.get("currentlocationid") is not None:
                cur_ids[key] = str(raw.get("currentlocationid"))
            if raw.get("eta"):
                etas.setdefault(key, {})[station["index"]] = str(raw.get("eta"))
    for raw in branch["map_data"]:
        item = _vehicle(raw, route_number, branch["direction"])
        if not item:
            continue
        key = item["id"] or f'{item["lat"]}:{item["lon"]}'
        previous = found.get(key)
        if previous is None:
            found[key] = item
        elif _fresher(item, previous):
            item["next_stop"] = item["next_stop"] or previous["next_stop"]
            found[key] = item
        elif item["next_stop"] and not previous["next_stop"]:
            previous["next_stop"] = item["next_stop"]
    for key, item in found.items():
        index = branch["by_id"].get(cur_ids.get(key)) if cur_ids.get(key) is not None else None
        source = "feed"
        if index is None:
            nearest = _nearest_station(branch["stations"], item["lat"], item["lon"])
            if nearest and nearest[0] <= ESTIMATE_PROGRESS_M:
                index, source = nearest[1]["index"], "estimated"
        item["_index"], item["progress_source"] = index, (source if index is not None else None)
        item["_etas"] = etas.get(key, {})
        upcoming = sorted(i for i in etas.get(key, {}) if index is not None and i > index)
        if upcoming:
            stop = branch["stations"][upcoming[0]]["name"]
            item["next_stop"], item["eta"], item["eta_stop"] = stop, etas[key][upcoming[0]], stop
    return found


AHEAD_MAX_STOPS = 150   # a whole BMTC run is rarely longer; this only guards against bad data


def _heading(branch: dict, index: int | None, until: int | None = None) -> dict | None:
    """The rest of this bus's run, in BMTC's stop order: from its next stop to the last stop.

    ``until`` (the traveller's boarding stop on this run, when the bus is coming to them) is passed
    back as ``board_stop_index`` so the page can mark it on the line."""
    stations = branch.get("stations") or []
    if index is None or not stations or index >= len(stations) - 1:
        return None
    end = min(len(stations) - 1, index + AHEAD_MAX_STOPS)
    stops = [{"name": s["name"], "lat": s["lat"], "lon": s["lon"]}
             for s in stations[index + 1:end + 1] if s["lat"] is not None and s["lon"] is not None]
    if not stops:
        return None
    heading = {"stops": stops, "towards": stations[-1]["name"] or None,
               "remaining_stops": len(stations) - 1 - index, "direction": branch.get("direction")}
    if until is not None and index < until <= end:
        heading["board_stop"] = stations[until]["name"]
    return heading


def _classify(item: dict, branch: dict, match: dict) -> dict:
    """Attach relevance to a vehicle; never mark a bus suitable without verification."""
    item["branch"] = branch["direction"]
    item["stops_away"] = None
    item["board_eta"] = None
    index = item.pop("_index", None)
    etas = item.pop("_etas", None) or {}
    # Where this bus goes next on its own run. Valid even when the traveller's direction is not
    # verified: it is simply BMTC's stop order for the run the bus is reported on.
    item["heading"] = _heading(branch, index)
    if not match.get("verified"):
        item["relevance"] = "unverified"
        item["reason"] = ("Route number matches, but BMTC's stop order could not confirm this bus is heading "
                          "from your boarding stop toward your destination.")
        return item
    own = next((entry for entry in match["valid"] if entry[0] is branch), None)
    if own is None:
        item["relevance"] = "wrong_direction"
        item["reason"] = f"Travelling {branch['direction'].upper()}: the opposite direction to your journey."
        return item
    if index is None:
        item["relevance"] = "unverified"
        item["reason"] = "Right direction, but BMTC did not publish how far along the route this bus is."
        return item
    board_index = own[1][1]["index"]
    if index > board_index:
        item["relevance"] = "passed"
        item["reason"] = "Already past your boarding stop."
    else:
        item["relevance"] = "approaching"
        item["stops_away"] = board_index - index
        # BMTC's own estimate for THIS bus at the traveller's boarding stop (never computed by us).
        item["board_eta"] = etas.get(board_index) or None
        item["heading"] = _heading(branch, index, until=board_index)
        item["board_stop"] = own[1][1]["name"]
        item["reason"] = ("Heading toward your boarding stop" if item["stops_away"] else "At your boarding stop") + \
            ("" if item.get("progress_source") == "feed" else " (position along route estimated from its coordinates)")
    return item


def live_route(route_number: str, stop_lat: float | None = None,
               stop_lon: float | None = None, *, force_refresh: bool = False,
               alight_lat: float | None = None, alight_lon: float | None = None) -> dict:
    route_number = str(route_number).strip()
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9 .-]{0,29}", route_number):
        raise ValueError("Choose a valid BMTC route number.")
    if (stop_lat is None) != (stop_lon is None):
        raise ValueError("Both boarding-stop coordinates are required.")
    if (alight_lat is None) != (alight_lon is None):
        raise ValueError("Both alighting-stop coordinates are required.")
    for lat, lon, what in ((stop_lat, stop_lon, "boarding"), (alight_lat, alight_lon, "alighting")):
        if lat is not None and not (BOUNDS[0] <= float(lat) <= BOUNDS[1] and BOUNDS[2] <= float(lon) <= BOUNDS[3]):
            raise ValueError(f"Choose a {what} stop inside the Bengaluru routing area.")
    cache_key = route_number.casefold()
    if stop_lat is not None:
        cache_key += f"|{float(stop_lat):.4f},{float(stop_lon):.4f}"
    if alight_lat is not None:
        cache_key += f">{float(alight_lat):.4f},{float(alight_lon):.4f}"
    cached = _cached_route(cache_key)
    if cached and not force_refresh:
        return cached

    lookup = _post("SearchRoute_v2", {"routetext": _search_term(route_number)})
    candidates = lookup.get("data", [])
    candidates = [r for r in candidates if isinstance(r, dict) and
                  (_route_matches(_search_term(route_number), r) or _route_matches(route_number, r))]
    exact_variant = [r for r in candidates if _route_matches(route_number, r)]
    if exact_variant:
        candidates = exact_variant
    else:
        candidates = [r for r in candidates if _route_matches(_search_term(route_number), r)]
    candidates.sort(key=lambda r: str(r.get("routeno", "")).casefold())
    if not candidates:
        return _save_route(cache_key, {
            "available": True, "route": route_number, "vehicles": [], "hidden": [],
            "counts": _counts([]), "direction": None,
            "message": "No exact BMTC route match was returned.", "updated_at": None,
        })

    route_ids = list(dict.fromkeys(
        int(route_id) for candidate in candidates
        if (route_id := candidate.get("routeparentid") or candidate.get("routeParentId")) is not None
    ))[:2]
    details_by_route = [(route_id, _post("SearchByRouteDetails_v4", {"routeid": int(route_id), "servicetypeid": 0}))
                        for route_id in route_ids]
    reliability.record_in_background(route_number, details_by_route)
    branches = _parse_branches(details_by_route)
    board = (float(stop_lat), float(stop_lon)) if stop_lat is not None else None
    alight = (float(alight_lat), float(alight_lon)) if alight_lat is not None else None
    match = _match_direction(branches, board, alight)

    # One physical bus may be reported on both branches (stale data); keep the
    # freshest report, and treat an exact tie as unverifiable.
    chosen: dict[str, tuple[dict, dict]] = {}
    for branch in branches:
        for key, item in _branch_vehicles(branch, route_number).items():
            previous = chosen.get(key)
            if previous is None or _fresher(item, previous[0]):
                chosen[key] = (item, branch)
            elif previous[0]["age_seconds"] == item["age_seconds"] and previous[1]["direction"] != branch["direction"]:
                previous[0]["_conflict"] = True
    classified = []
    for item, branch in chosen.values():
        conflict = item.pop("_conflict", False)
        _classify(item, branch, {**match, "verified": False, "valid": []} if conflict else match)
        classified.append(item)

    order = {"approaching": 0, "unverified": 1, "passed": 2, "wrong_direction": 3}
    classified.sort(key=lambda v: (order[v["relevance"]], v["stops_away"] if v["stops_away"] is not None else 999,
                                   v["age_seconds"] is None, v["age_seconds"] or 0))
    shown = [v for v in classified if v["relevance"] in ("approaching", "unverified")]
    hidden = [{"id": v["id"], "label": v["label"], "relevance": v["relevance"], "reason": v["reason"],
               "direction": v["direction"], "freshness": v["freshness"], "lat": v["lat"], "lon": v["lon"]}
              for v in classified if v["relevance"] in ("passed", "wrong_direction")]
    if shown:
        message = ""
    elif classified:
        message = "BMTC reports buses on this route, but none are heading toward your boarding stop right now."
    else:
        message = "No active bus positions were published for this route."
    result = {
        "available": True, "route": route_number, "vehicles": shown, "hidden": hidden,
        "counts": _counts(classified), "message": message,
        "updated_at": datetime.now(IST).isoformat(timespec="seconds"),
        "direction": None if board is None else {
            "verified": match["verified"], "branch": match["primary"]["direction"] if match["primary"] else None,
            "board_station": ({"name": match["board"][1]["name"], "distance_m": round(match["board"][0])}
                              if match.get("board") else None),
            "alight_station": ({"name": match["alight"][1]["name"], "distance_m": round(match["alight"][0])}
                               if match.get("alight") else None),
            "note": match["note"],
        },
    }
    if board is not None:
        if match["primary"] is not None and match.get("board"):
            distance, station = match["board"]
            arrivals = []
            for raw in station["group"].get("vehicleDetails") or []:
                bus = _vehicle(raw, route_number, match["primary"]["direction"]) if isinstance(raw, dict) else None
                if not bus:
                    continue
                key = bus["id"] or f'{bus["lat"]}:{bus["lon"]}'
                relevant = next((v for v in shown if (v["id"] or f'{v["lat"]}:{v["lon"]}') == key
                                 and v["relevance"] == "approaching"), None)
                if relevant is None:
                    continue
                bus["eta"] = str(raw.get("eta") or "")
                bus["eta_stop"] = str(station["name"])
                bus["relevance"] = "approaching"
                arrivals.append(bus)
            arrivals.sort(key=lambda bus: (not bool(bus["eta"]), bus["eta"],
                                           bus["age_seconds"] is None, bus["age_seconds"] or 0))
            result["boarding_stop"] = {
                "name": station["name"], "direction": match["primary"]["direction"],
                "distance_m": round(distance), "arrivals": arrivals,
                "direction_verified": match["verified"],
            }
        else:
            result["boarding_stop"] = None
    return _save_route(cache_key, result)


def _counts(vehicles: list[dict]) -> dict:
    counts = {"approaching": 0, "unverified": 0, "passed": 0, "wrong_direction": 0,
              "fresh": 0, "stale": 0, "unavailable": 0, "reported": len(vehicles)}
    for vehicle in vehicles:
        counts[vehicle["relevance"]] += 1
        counts[vehicle["freshness"]] += 1
    return counts
