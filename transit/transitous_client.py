"""Free Transitous/MOTIS routing adapter for Bengaluru Transit AI.

Uses the community Transitous API for public-transit routing. No API key or
billing account is required. The app sends coordinates rather than relying on
local GTFS stop IDs, so the local SQLite database is not required for routing.
"""
from __future__ import annotations

import json
import os
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime
from zoneinfo import ZoneInfo

TRANSITOUS_URL = os.getenv(
    "TRANSITOUS_URL",
    "https://api.transitous.org/api/v6/plan",
)
IST = ZoneInfo("Asia/Kolkata")
USER_AGENT = os.getenv(
    "TRANSITOUS_USER_AGENT",
    "Bengaluru-Transit-AI/1.0 (college project)",
)


def _request(url: str) -> dict:
    request = urllib.request.Request(
        url,
        headers={
            "Accept": "application/json",
            "User-Agent": USER_AGENT,
        },
        method="GET",
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            raw = response.read().decode("utf-8")
    except urllib.error.HTTPError as exc:
        body = ""
        try:
            body = exc.read().decode("utf-8")
        except Exception:
            pass
        raise RuntimeError(
            f"Transitous routing service returned HTTP {exc.code}: "
            f"{body[:400] or 'no details'}"
        ) from exc
    except urllib.error.URLError as exc:
        raise RuntimeError(
            "Transitous routing service is temporarily unreachable. "
            "Check your internet connection and try again."
        ) from exc

    try:
        return json.loads(raw)
    except json.JSONDecodeError as exc:
        raise RuntimeError("Transitous returned invalid JSON.") from exc


def _as_point(value: dict | None) -> tuple[float, float] | None:
    if not isinstance(value, dict):
        return None
    lat = value.get("lat", value.get("latitude"))
    lon = value.get("lon", value.get("longitude", value.get("lng")))
    try:
        lat = float(lat)
        lon = float(lon)
    except (TypeError, ValueError):
        return None
    if not (-90 <= lat <= 90 and -180 <= lon <= 180):
        return None
    return lat, lon


def _decode_polyline(encoded: str, precision: int = 6) -> list[list[float]]:
    if not encoded:
        return []
    result: list[list[float]] = []
    index = lat = lon = 0
    factor = 10 ** precision

    while index < len(encoded):
        values = []
        for _ in range(2):
            value = 0
            shift = 0
            while True:
                if index >= len(encoded):
                    return result
                byte = ord(encoded[index]) - 63
                index += 1
                value |= (byte & 0x1F) << shift
                shift += 5
                if byte < 0x20:
                    break
            values.append(~(value >> 1) if value & 1 else value >> 1)
        lat += values[0]
        lon += values[1]
        result.append([lon / factor, lat / factor])
    return result


def _geometry(value) -> list[list[float]]:
    if isinstance(value, dict):
        for key in ("coordinates", "points", "polyline"):
            if key in value:
                return _geometry(value[key])
        return []

    if isinstance(value, str):
        return _decode_polyline(value, 6)

    if not isinstance(value, list):
        return []

    out = []
    for point in value:
        if isinstance(point, (list, tuple)) and len(point) >= 2:
            try:
                a, b = float(point[0]), float(point[1])
            except (TypeError, ValueError):
                continue
            # GeoJSON is lon,lat; some transit responses use lat,lon.
            if abs(a) <= 90 and abs(b) > 90:
                a, b = b, a
            out.append([a, b])
        elif isinstance(point, dict):
            p = _as_point(point)
            if p:
                out.append([p[1], p[0]])
    return out


def _name(place: dict | None) -> str:
    if not isinstance(place, dict):
        return ""
    return str(
        place.get("name")
        or place.get("stationName")
        or place.get("stopName")
        or place.get("title")
        or ""
    )


def _route_number(leg: dict) -> str:
    route = leg.get("route") or leg.get("line") or {}
    if isinstance(route, str):
        return route
    return str(
        route.get("shortName")
        or route.get("routeShortName")
        or route.get("name")
        or route.get("displayName")
        or leg.get("routeShortName")
        or leg.get("routeName")
        or ""
    )


def _headsign(leg: dict) -> str:
    route = leg.get("route") or leg.get("line") or {}
    if not isinstance(route, dict):
        route = {}
    return str(
        leg.get("headsign")
        or leg.get("tripHeadsign")
        or route.get("longName")
        or route.get("to")
        or ""
    )


def _epoch_seconds(value) -> int | None:
    if value is None:
        return None
    if isinstance(value, (int, float)):
        # MOTIS commonly uses Unix seconds or milliseconds.
        return int(value / 1000 if value > 10_000_000_000 else value)
    text = str(value).strip()
    if not text:
        return None
    try:
        return int(float(text) / 1000 if float(text) > 10_000_000_000 else float(text))
    except ValueError:
        pass
    try:
        return int(datetime.fromisoformat(text.replace("Z", "+00:00")).timestamp())
    except ValueError:
        return None


def _clock(value) -> str:
    epoch = _epoch_seconds(value)
    if epoch is None:
        text = str(value or "")
        if "T" in text:
            text = text.split("T", 1)[1]
        return text[:5] if len(text) >= 5 else text
    return datetime.fromtimestamp(epoch, IST).strftime("%H:%M")


def _duration_minutes(leg: dict) -> int:
    value = leg.get("duration")
    if isinstance(value, (int, float)):
        return max(0, round(value / 60))
    start = _epoch_seconds(leg.get("startTime") or leg.get("departure"))
    end = _epoch_seconds(leg.get("endTime") or leg.get("arrival"))
    if start is not None and end is not None:
        return max(0, round((end - start) / 60))
    return 0


def _leg_stops(leg: dict) -> list[dict]:
    stops = []
    for key in ("intermediateStops", "stops", "stopSequence"):
        raw = leg.get(key)
        if isinstance(raw, list):
            for item in raw:
                if not isinstance(item, dict):
                    continue
                point = _as_point(item)
                if not point:
                    continue
                stops.append({
                    "stop_id": str(item.get("id") or item.get("stopId") or item.get("gtfsId") or ""),
                    "stop_name": _name(item),
                    "lat": point[0],
                    "lon": point[1],
                })
            if stops:
                break

    for place_key in ("from", "to"):
        place = leg.get(place_key)
        point = _as_point(place)
        if point:
            item = {
                "stop_id": str(
                    (place or {}).get("id")
                    or (place or {}).get("stopId")
                    or (place or {}).get("gtfsId")
                    or ""
                ),
                "stop_name": _name(place),
                "lat": point[0],
                "lon": point[1],
            }
            if place_key == "from":
                stops.insert(0, item)
            else:
                stops.append(item)

    deduped = []
    seen = set()
    for stop in stops:
        key = (stop["stop_id"], stop["stop_name"], round(stop["lat"], 6), round(stop["lon"], 6))
        if key not in seen:
            seen.add(key)
            deduped.append(stop)
    return deduped


def _extract_connections(payload: dict) -> list[dict]:
    for key in ("connections", "journeys", "itineraries", "routes"):
        value = payload.get(key)
        if isinstance(value, list):
            return value
    # Some MOTIS responses wrap the result.
    for value in payload.values():
        if isinstance(value, dict):
            found = _extract_connections(value)
            if found:
                return found
    return []


def _normalize_connection(connection: dict) -> dict | None:
    legs = connection.get("legs") or connection.get("sections") or []
    if not isinstance(legs, list):
        return None

    segments = []
    transit_segments = []
    walking_minutes = 0

    for raw in legs:
        if not isinstance(raw, dict):
            continue

        mode = str(raw.get("mode") or raw.get("transportMode") or raw.get("type") or "").upper()
        route_number = _route_number(raw)
        is_walk = mode in {"WALK", "FOOT", "PEDESTRIAN"} or not route_number

        coords = _geometry(
            raw.get("geometry")
            or raw.get("legGeometry")
            or raw.get("shape")
            or raw.get("path")
        )
        stops = _leg_stops(raw)

        if len(coords) < 2 and len(stops) >= 2:
            coords = [[s["lon"], s["lat"]] for s in stops]

        segment = {
            "mode": "WALK" if is_walk else "TRANSIT",
            "route_number": "Walk" if is_walk else route_number,
            "headsign": _headsign(raw),
            "departure": _clock(raw.get("startTime") or raw.get("departure")),
            "arrival": _clock(raw.get("endTime") or raw.get("arrival")),
            "walking_minutes": _duration_minutes(raw) if is_walk else 0,
            "coordinates": coords,
            "stops": stops,
        }
        segments.append(segment)

        if is_walk:
            walking_minutes += segment["walking_minutes"]
        else:
            transit_segments.append(segment)

    if not segments or not transit_segments:
        return None

    first = segments[0]["departure"]
    last = segments[-1]["arrival"]
    total = connection.get("duration")
    if isinstance(total, (int, float)):
        total_minutes = max(0, round(total / 60))
    else:
        start = _epoch_seconds(connection.get("startTime") or connection.get("departure"))
        end = _epoch_seconds(connection.get("endTime") or connection.get("arrival"))
        total_minutes = max(0, round((end - start) / 60)) if start is not None and end is not None else sum(
            s["walking_minutes"] + _duration_minutes({"departure": s["departure"], "arrival": s["arrival"]})
            for s in segments
        )

    transfers = max(0, len(transit_segments) - 1)
    transfer_stops = []
    for segment in transit_segments[1:]:
        if segment["stops"]:
            transfer_stops.append(segment["stops"][0]["stop_name"])

    wait = 0
    for previous, current in zip(transit_segments, transit_segments[1:]):
        a = previous["arrival"]
        b = current["departure"]
        try:
            ah, am = map(int, a.split(":")[:2])
            bh, bm = map(int, b.split(":")[:2])
            wait += max(0, (bh * 60 + bm) - (ah * 60 + am))
        except Exception:
            pass

    return {
        "total_minutes": total_minutes,
        "walking_minutes": walking_minutes,
        "scheduled_wait_minutes": wait,
        "transfers": transfers,
        "route_numbers": [s["route_number"] for s in transit_segments],
        "transfer_stops": transfer_stops,
        "sample_departure": first,
        "sample_arrival": last,
        "schedule_based": True,
        "segments": segments,
        "source": "Transitous / MOTIS",
    }


def plan_journey(origin: dict, destination: dict, profile: dict | None = None) -> dict:
    profile = profile or {}
    o = _as_point(origin)
    d = _as_point(destination)
    if not o or not d:
        raise ValueError("Both selected stops must have valid coordinates.")

    preference = str(profile.get("preference") or "fastest")
    params = {
        "fromPlace": f"{o[0]},{o[1]}",
        "toPlace": f"{d[0]},{d[1]}",
        "radius": 800,
        "transitModes": "TRANSIT",
        "directModes": "WALK",
        "detailedLegs": "true",
        "detailedTransfers": "true",
        "joinInterlinedLegs": "false",
        "numItineraries": 5,
        "numLegAlternatives": 2,
        "realtimeMode": "REALTIME_ANNOTATION_ONLY",
        "timeout": 20,
    }

    if preference == "fewer_transfers":
        params["maxTransfers"] = 3
    elif preference == "less_walking":
        params["pedestrianSpeed"] = 1.35
        params["maxPreTransitTime"] = 600
        params["maxPostTransitTime"] = 600

    url = TRANSITOUS_URL + "?" + urllib.parse.urlencode(params)
    payload = _request(url)
    connections = _extract_connections(payload)

    routes = []
    for connection in connections:
        normalized = _normalize_connection(connection)
        if normalized:
            routes.append(normalized)

    if not routes:
        return {
            "routes": [],
            "schedule_based": True,
            "message": "No scheduled public-transit journey was found for these stops.",
            "source": "Transitous / MOTIS",
        }

    # Keep alternatives useful and order according to the selected preference.
    if preference == "fewer_transfers":
        routes.sort(key=lambda r: (r["transfers"], r["total_minutes"], r["walking_minutes"]))
    elif preference == "less_walking":
        routes.sort(key=lambda r: (r["walking_minutes"], r["total_minutes"], r["transfers"]))
    else:
        routes.sort(key=lambda r: (r["total_minutes"], r["transfers"], r["walking_minutes"]))

    return {
        "routes": routes[:5],
        "schedule_based": True,
        "source": "Transitous / MOTIS",
        "origin": origin,
        "destination": destination,
    }
