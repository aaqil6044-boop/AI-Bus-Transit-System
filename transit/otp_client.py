"""OpenTripPlanner 2 client for Bengaluru Adaptive Transit Assistant."""

from __future__ import annotations

import json
import os
import sqlite3
import urllib.error
import urllib.request
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

OTP_URL = os.getenv(
    "OTP_GRAPHQL_URL",
    "http://127.0.0.1:8080/otp/gtfs/v1"
)

IST = ZoneInfo("Asia/Kolkata")


FEEDS_QUERY = """
{
  feeds {
    feedId
  }
}
"""


STOP_QUERY = """
query Stop($id: String!) {
  stop(id: $id) {
    gtfsId
    name
    lat
    lon
  }
}
"""


PLAN_QUERY = """
query Plan(
  $fromPlace: String!
  $toPlace: String!
  $date: String!
  $time: String!
  $transportModes: [TransportMode!]!
  $maxTransfers: Int
  $walkReluctance: Float
  $numItineraries: Int
  $searchWindow: Long
) {
  plan(
    fromPlace: $fromPlace
    toPlace: $toPlace
    date: $date
    time: $time
    arriveBy: false
    transportModes: $transportModes
    maxTransfers: $maxTransfers
    walkReluctance: $walkReluctance
    walkSpeed: 1.35
    waitReluctance: 1.0
    numItineraries: $numItineraries
    searchWindow: $searchWindow
    ignoreRealtimeUpdates: true
  ) {
    messageStrings
    messageEnums
    itineraries {
      duration
      numberOfTransfers
      walkTime
      walkDistance
      waitingTime
      start
      end
      legs {
        id
        mode
        transitLeg
        duration
        startTime
        endTime
        headsign
        realTime
        from {
          lat
          lon
          name
        }
        to {
          lat
          lon
          name
        }
        route {
          shortName
          longName
          mode
          gtfsId
        }
        trip {
          gtfsId
          tripHeadsign
          routeShortName
        }
        intermediateStops {
          gtfsId
          lat
          lon
          name
        }
        legGeometry {
          length
          points
        }
      }
    }
  }
}
"""


def _request(query: str, variables: dict | None = None) -> dict:
    body = json.dumps({
        "query": query,
        "variables": variables or {}
    }).encode("utf-8")

    request = urllib.request.Request(
        OTP_URL,
        data=body,
        headers={
            "Content-Type": "application/json",
            "Accept": "application/json",
        },
        method="POST",
    )

    raw = None
    try:
        with urllib.request.urlopen(request, timeout=35) as response:
            raw = response.read().decode("utf-8")
    except urllib.error.HTTPError as exc:
        # OTP returns HTTP 4xx with a JSON error body for GraphQL errors.
        # Read the body so we can surface the actual OTP message.
        try:
            raw = exc.read().decode("utf-8")
        except Exception:
            raw = None
        if not raw:
            raise RuntimeError(
                f"OpenTripPlanner returned HTTP {exc.code}. "
                "Check that OTP loaded the GTFS graph successfully."
            ) from exc
        # Fall through to JSON parsing below.
    except urllib.error.URLError as exc:
        raise RuntimeError(
            f"OpenTripPlanner is not reachable at {OTP_URL}. "
            "Make sure START_OTP.ps1 is running."
        ) from exc

    try:
        payload = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise RuntimeError(
            f"OpenTripPlanner returned invalid JSON: {raw[:500]}"
        ) from exc

    if payload.get("errors"):
        messages = []
        for error in payload["errors"]:
            messages.append(
                str(error.get("message", "GraphQL error"))
            )

        raise RuntimeError(
            "OpenTripPlanner GraphQL error: "
            + " | ".join(messages)
        )

    return payload.get("data") or {}



def _get_feed_ids() -> list[str]:
    data = _request(FEEDS_QUERY)

    feeds = data.get("feeds") or []

    result = []
    for feed in feeds:
        feed_id = str(feed.get("feedId") or "").strip()
        if feed_id:
            result.append(feed_id)

    if not result:
        raise RuntimeError(
            "OTP is running but did not report any GTFS feeds."
        )

    return result


def _resolve_stop(stop_id: str) -> tuple[str, dict]:
    """Find which OTP feed contains this stop."""

    stop_id = str(stop_id).strip()

    feed_ids = _get_feed_ids()

    matches = []

    for feed_id in feed_ids:
        gtfs_id = f"{feed_id}:{stop_id}"

        try:
            data = _request(
                STOP_QUERY,
                {"id": gtfs_id}
            )
        except RuntimeError:
            continue

        stop = data.get("stop")

        if stop:
            matches.append((feed_id, stop))

    if not matches:
        raise ValueError(
            f"OTP could not resolve stop {stop_id}. "
            f"Checked feeds: {', '.join(feed_ids)}."
        )

    # Prefer an exact matching stop ID.
    for feed_id, stop in matches:
        if str(stop.get("gtfsId", "")).endswith(
            f":{stop_id}"
        ):
            return feed_id, stop

    return matches[0]


def _decode_polyline(encoded: str) -> list[list[float]]:
    if not encoded:
        return []

    points = []
    index = 0
    lat = 0
    lon = 0

    while index < len(encoded):

        result = 0
        shift = 0

        while True:
            if index >= len(encoded):
                return points

            byte = ord(encoded[index]) - 63
            index += 1

            result |= (byte & 0x1F) << shift
            shift += 5

            if byte < 0x20:
                break

        lat += ~(result >> 1) if result & 1 else result >> 1

        result = 0
        shift = 0

        while True:
            if index >= len(encoded):
                return points

            byte = ord(encoded[index]) - 63
            index += 1

            result |= (byte & 0x1F) << shift
            shift += 5

            if byte < 0x20:
                break

        lon += ~(result >> 1) if result & 1 else result >> 1

        points.append([
            lon / 1e5,
            lat / 1e5
        ])

    return points


def _leg_coordinates(leg: dict) -> list[list[float]]:
    geometry = leg.get("legGeometry") or {}

    points = _decode_polyline(
        str(geometry.get("points") or "")
    )

    if len(points) >= 2:
        return points

    fallback = []

    start = leg.get("from") or {}

    if start.get("lat") is not None and start.get("lon") is not None:
        fallback.append([
            float(start["lon"]),
            float(start["lat"])
        ])

    for stop in leg.get("intermediateStops") or []:
        if stop.get("lat") is not None and stop.get("lon") is not None:
            fallback.append([
                float(stop["lon"]),
                float(stop["lat"])
            ])

    end = leg.get("to") or {}

    if end.get("lat") is not None and end.get("lon") is not None:
        fallback.append([
            float(end["lon"]),
            float(end["lat"])
        ])

    return fallback


def _clock(epoch_ms) -> str:
    try:
        dt = datetime.fromtimestamp(
            int(epoch_ms) / 1000,
            tz=IST
        )
        return dt.strftime("%H:%M")
    except (TypeError, ValueError, OSError):
        return "â€”"


def _preference_settings(profile: dict) -> tuple[int, float]:
    preference = str(
        profile.get("preference", "fastest")
    )

    if preference == "less_walking":
        return 6, 4.0

    if preference == "fewer_transfers":
        return 2, 2.0

    if preference == "more_reliable":
        return 4, 2.5

    return 6, 2.0


def _personalization_score(route: dict, profile: dict) -> float:
    preference = str(
        profile.get("preference", "fastest")
    )

    mobility = str(
        profile.get("mobility", "standard")
    )

    familiarity = int(
        profile.get("familiarity", 3) or 3
    )

    score = route["total_minutes"]

    if preference == "less_walking":
        score += route["walking_minutes"] * 3.5

    elif preference == "fewer_transfers":
        score += route["transfers"] * 30

    elif preference == "more_reliable":
        score += route["transfers"] * 8

    if mobility in {
        "limited_mobility",
        "elderly_assistance"
    }:
        score += route["walking_minutes"] * 2.5
        score += route["transfers"] * 15

    score += (
        max(0, 4 - familiarity)
        * route["transfers"]
        * 4
    )

    return round(score, 2)


def _difficulty(route: dict, profile: dict) -> tuple[int, str]:

    score = (
        route["walking_minutes"] * 1.7
        + route["transfers"] * 14
        + max(
            0,
            4 - int(
                profile.get("familiarity", 3) or 3
            )
        ) * route["transfers"] * 4
    )

    if profile.get("mobility") in {
        "limited_mobility",
        "elderly_assistance"
    }:
        score += (
            route["walking_minutes"] * 1.5
            + route["transfers"] * 8
        )

    score = int(round(min(100, score)))

    if score < 32:
        return score, "Easy"

    if score < 58:
        return score, "Moderate"

    return score, "Difficult"


def _normalize_itinerary(
    itinerary: dict,
    profile: dict
) -> dict:

    legs = itinerary.get("legs") or []

    segments = []
    route_numbers = []
    transfer_stops = []

    walking_minutes = 0
    realtime_seen = False
    transit_count = 0

    for leg in legs:

        mode = str(
            leg.get("mode") or "WALK"
        )

        transit = bool(
            leg.get("transitLeg")
        )

        coords = _leg_coordinates(leg)

        duration_minutes = max(
            0,
            int(
                round(
                    float(
                        leg.get("duration") or 0
                    ) / 60
                )
            )
        )

        if mode == "WALK":
            walking_minutes += duration_minutes

        route = leg.get("route") or {}
        trip = leg.get("trip") or {}

        route_number = (
            route.get("shortName")
            or trip.get("routeShortName")
            or ""
        )

        headsign = (
            leg.get("headsign")
            or trip.get("tripHeadsign")
            or ""
        )

        if transit:

            if transit_count > 0:

                name = (
                    leg.get("from") or {}
                ).get("name")

                if name:
                    transfer_stops.append(
                        str(name)
                    )

            transit_count += 1

            if route_number and route_number not in route_numbers:
                route_numbers.append(
                    str(route_number)
                )

            realtime_seen = (
                realtime_seen
                or bool(leg.get("realTime"))
            )

        if len(coords) >= 2:

            segments.append({
                "mode": mode,
                "transit": transit,
                "route_number": str(route_number),
                "headsign": str(headsign),
                "duration_minutes": duration_minutes,
                "coordinates": coords,
                "from_stop": (
                    leg.get("from") or {}
                ).get("name"),
                "to_stop": (
                    leg.get("to") or {}
                ).get("name"),
                "departure": _clock(
                    leg.get("startTime")
                ),
                "arrival": _clock(
                    leg.get("endTime")
                ),
            })

    total_minutes = max(
        0,
        int(
            round(
                float(
                    itinerary.get("duration") or 0
                ) / 60
            )
        )
    )

    waiting_minutes = max(
        0,
        int(
            round(
                float(
                    itinerary.get("waitingTime") or 0
                ) / 60
            )
        )
    )

    transfers = int(
        itinerary.get("numberOfTransfers") or 0
    )

    route = {
        "total_minutes": total_minutes,
        "duration_minutes": total_minutes,
        "walking_minutes": walking_minutes,
        "scheduled_wait_minutes": waiting_minutes,
        "transfers": transfers,
        "route_numbers": route_numbers,
        "transfer_stops": transfer_stops,
        "segments": segments,
        "coordinates": [
            point
            for segment in segments
            for point in segment["coordinates"]
        ],
        "sample_departure": _clock(
            (legs[0] if legs else {}).get("startTime")
        ),
        "sample_arrival": _clock(
            (legs[-1] if legs else {}).get("endTime")
        ),
        "schedule_based": True,
        "realtime_available": realtime_seen,
        "provider": "OpenTripPlanner 2.10",
        "data_mode": "Bengaluru GTFS + OpenStreetMap",
    }

    difficulty_score, difficulty_level = _difficulty(
        route,
        profile
    )

    route["difficulty_score"] = difficulty_score
    route["difficulty_level"] = difficulty_level

    route["success_probability"] = max(
        5,
        min(
            95,
            round(
                100 - difficulty_score * 0.8
            )
        )
    )

    route["personalization_score"] = (
        _personalization_score(
            route,
            profile
        )
    )

    route["reasons"] = [
        (
            "No transfer is required."
            if transfers == 0
            else f"{transfers} transfer"
                 f"{'s' if transfers != 1 else ''}"
                 " are required."
        ),
        f"Walking time is about {walking_minutes} minutes.",
        (
            "This route was ranked using your selected travel preference."
            if profile.get("preference")
            else "This route was ranked using travel time."
        ),
    ]

    return route


def plan_journey(
    origin_stop_id: str,
    destination_stop_id: str,
    profile: dict | None = None
) -> dict:

    profile = profile or {}

    origin_stop_id = str(
        origin_stop_id or ""
    ).strip()

    destination_stop_id = str(
        destination_stop_id or ""
    ).strip()

    if not origin_stop_id or not destination_stop_id:
        raise ValueError(
            "Select both an origin and a destination stop."
        )

    if origin_stop_id == destination_stop_id:
        raise ValueError(
            "Choose two different stops."
        )

    # Validate the selected stops against the local GTFS database.
    database = (
        Path(__file__).resolve().parent.parent
        / "data"
        / "bengaluru_transit.db"
    )

    if not database.exists():
        raise ValueError(
            f"Transit database not found: {database}"
        )

    with sqlite3.connect(str(database)) as connection:

        connection.row_factory = sqlite3.Row

        origin = connection.execute(
            """
            SELECT stop_id, stop_name
            FROM stops
            WHERE stop_id = ?
            """,
            (origin_stop_id,)
        ).fetchone()

        destination = connection.execute(
            """
            SELECT stop_id, stop_name
            FROM stops
            WHERE stop_id = ?
            """,
            (destination_stop_id,)
        ).fetchone()

    if not origin:
        raise ValueError(
            f"Origin stop {origin_stop_id} "
            "was not found in the GTFS database."
        )

    if not destination:
        raise ValueError(
            f"Destination stop {destination_stop_id} "
            "was not found in the GTFS database."
        )

    # IMPORTANT:
    # Discover the actual OTP feed instead of assuming BMTC.
    origin_feed, otp_origin = _resolve_stop(
        origin_stop_id
    )

    destination_feed, otp_destination = _resolve_stop(
        destination_stop_id
    )

    if origin_feed != destination_feed:
        raise ValueError(
            "The selected stops belong to different OTP feeds: "
            f"{origin_feed} and {destination_feed}."
        )

    feed_id = origin_feed

    origin_name = str(
        otp_origin.get("name")
        or origin["stop_name"]
    ).strip()

    destination_name = str(
        otp_destination.get("name")
        or destination["stop_name"]
    ).strip()

    from_place = (
        f"{origin_name}::{feed_id}:{origin_stop_id}"
    )

    to_place = (
        f"{destination_name}::{feed_id}:{destination_stop_id}"
    )

    max_transfers, walk_reluctance = (
        _preference_settings(profile)
    )

    now = datetime.now(IST)

    variables = {
        "fromPlace": from_place,
        "toPlace": to_place,
        "date": now.strftime("%Y-%m-%d"),
        "time": now.strftime("%H:%M:%S"),
        "transportModes": [
            {"mode": "WALK"},
            {"mode": "TRANSIT"},
        ],
        "maxTransfers": max_transfers,
        "walkReluctance": walk_reluctance,
        "numItineraries": 8,
        "searchWindow": 7200,
    }

    data = _request(
        PLAN_QUERY,
        variables
    )

    plan = data.get("plan") or {}

    itineraries = (
        plan.get("itineraries") or []
    )

    if not itineraries:

        messages = []

        for message in (
            plan.get("messageStrings") or []
        ):
            if message:
                messages.append(str(message))

        for message in (
            plan.get("messageEnums") or []
        ):
            if message:
                messages.append(str(message))

        detail = "; ".join(messages)

        raise ValueError(
            "OpenTripPlanner returned no itinerary. "
            + (
                f"OTP details: {detail}"
                if detail
                else
                "No additional OTP details were provided."
            )
        )

    routes = [
        _normalize_itinerary(
            itinerary,
            profile
        )
        for itinerary in itineraries
    ]

    routes = [
        route
        for route in routes
        if route["segments"]
        and len(route["coordinates"]) >= 2
    ]

    if not routes:
        raise ValueError(
            "OTP returned itineraries, but none contained "
            "usable route geometry."
        )

    routes.sort(
        key=lambda item: (
            item["personalization_score"],
            item["transfers"],
            item["total_minutes"],
        )
    )

    return {
        "routes": routes[:8],
        "data_mode": (
            "OpenTripPlanner scheduled transit"
        ),
        "provider": "OpenTripPlanner 2.10",
        "notice": (
            "Routes are schedule-based. This application "
            "does not claim live bus positions or live ETAs "
            "unless a verified real-time feed is connected."
        ),
        "otp_feed_id": feed_id,
        "otp_from_place": from_place,
        "otp_to_place": to_place,
    }


def healthcheck() -> bool:
    try:
        _request(
            "{ __typename }",
            {}
        )
        return True
    except Exception:
        return False


