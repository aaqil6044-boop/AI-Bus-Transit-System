from __future__ import annotations

import sqlite3
import time
from contextlib import closing
from pathlib import Path
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo


# ============================================================
# SIMPLE GTFS TRANSIT PLANNER
# ============================================================

TRANSFER_MINUTES = 5
MAX_TRANSFERS = 2
MAX_INITIAL_WAIT_MINUTES = 120
MAX_TWO_TRANSFER_SEARCH_SECONDS = 1.0
# A busy terminal can be served by more than one hundred GTFS route variants.
# Keep one-transfer planning responsive: return valid candidates discovered so
# far rather than making the browser wait while every theoretical interchange
# is enumerated.
MAX_ONE_TRANSFER_SEARCH_SECONDS = 1.8
MAX_SCHEDULED_BUS_SPEED_KMH = 50


def _connect(database):
    conn = sqlite3.connect(str(database))
    conn.row_factory = sqlite3.Row
    return conn


def _time_to_minutes(value):
    if value is None:
        return None

    value = str(value)

    try:
        h, m, s = value.split(":")
        return int(h) * 60 + int(m) + int(float(s)) / 60
    except Exception:
        return None


def _minutes_to_time(minutes):
    minutes = int(minutes) % (24 * 60)
    return f"{minutes // 60:02d}:{minutes % 60:02d}:00"


def _distance_km(start, end):
    """Return the straight-line distance between [longitude, latitude] points."""
    from math import asin, cos, radians, sin, sqrt

    lon1, lat1 = start
    lon2, lat2 = end
    lat_delta = radians(lat2 - lat1)
    lon_delta = radians(lon2 - lon1)
    haversine = (
        sin(lat_delta / 2) ** 2
        + cos(radians(lat1))
        * cos(radians(lat2))
        * sin(lon_delta / 2) ** 2
    )
    return 6371 * 2 * asin(sqrt(haversine))


def _route_distance_km(coordinates):
    return sum(
        _distance_km(start, end)
        for start, end in zip(coordinates, coordinates[1:])
    )


def _nearby_stops(conn, stop, limit=3, radius_km=0.7):
    """Return nearby, distinct boarding options from the real GTFS stop list."""
    origin = [float(stop["stop_lon"]), float(stop["stop_lat"])]
    rows = conn.execute(
        """
        SELECT stop_id, stop_name, stop_lat, stop_lon
        FROM stops
        WHERE stop_id != ?
          AND stop_lat IS NOT NULL
          AND stop_lon IS NOT NULL
        """,
        (str(stop["stop_id"]),),
    ).fetchall()

    nearby = []
    for row in rows:
        distance = _distance_km(
            origin,
            [float(row["stop_lon"]), float(row["stop_lat"])],
        )
        if distance <= radius_km:
            nearby.append(
                {
                    "stop_id": str(row["stop_id"]),
                    "stop_name": str(row["stop_name"]),
                    "stop_lat": float(row["stop_lat"]),
                    "stop_lon": float(row["stop_lon"]),
                    "walk_distance_m": round(distance * 1000),
                }
            )

    return sorted(nearby, key=lambda item: item["walk_distance_m"])[:limit]


def _fallback_guidance(conn, origin, destination, direct_distance_km):
    """Give the UI useful next actions when no practical bus itinerary exists."""
    if direct_distance_km <= 3:
        return {
            "type": "short_local_trip",
            "message": (
                f"This is a short local trip (about {direct_distance_km:.1f} km "
                "straight-line). The available scheduled buses are not practical; "
                "walking, cycling, or an auto is likely the better option."
            ),
            "origin_alternatives": [],
            "destination_alternatives": [],
        }

    return {
        "type": "nearby_stops",
        "message": (
            "No practical scheduled bus connection was found for these exact "
            "platforms. Try a nearby boarding or destination stop below."
        ),
        "origin_alternatives": _nearby_stops(conn, origin),
        "destination_alternatives": _nearby_stops(conn, destination),
    }


def _add_practicality_metrics(route, start_minute, direct_distance_km):
    """Attach schedule and geometry metrics used to reject implausible options.

    GTFS shapes are absent from this dataset, so stop-to-stop geometry is only
    a schematic of the scheduled stop sequence. A large detour here is a strong
    signal that an otherwise valid timetable connection is not useful to show.
    """
    coordinates = route.get("coordinates", [])
    departure = _time_to_minutes(route.get("departure_time"))
    arrival = _time_to_minutes(route.get("arrival_time"))
    wait = max(0, int((departure or start_minute) - start_minute))
    elapsed = max(0, int((arrival or start_minute) - start_minute))
    route_distance = _route_distance_km(coordinates)
    detour_ratio = route_distance / max(direct_distance_km, 0.1)

    route.update(
        scheduled_wait_minutes=wait,
        total_elapsed_minutes=elapsed,
        route_distance_km=round(route_distance, 1),
        direct_distance_km=round(direct_distance_km, 1),
        detour_ratio=round(detour_ratio, 1),
    )

    maximum_distance = max(direct_distance_km * 3, direct_distance_km + 8)
    # A corrupt or mismatched timetable entry can claim an impossible trip
    # duration. Never present a bus journey faster than a generous urban-bus
    # upper speed allows.
    minimum_travel_minutes = (
        route_distance / MAX_SCHEDULED_BUS_SPEED_KMH * 60
    )
    impossible_schedule = route.get("total_minutes", 0) < minimum_travel_minutes
    advisories = []
    if wait > MAX_INITIAL_WAIT_MINUTES:
        advisories.append("Long scheduled wait before departure")
    if route_distance > maximum_distance:
        advisories.append("Long detour compared with the direct distance")
    if direct_distance_km <= 3 and elapsed > 60:
        advisories.append("Slow scheduled option for a short local trip")
    route["advisories"] = advisories

    # Keep real scheduled itineraries, even if inconvenient. Only discard a
    # timetable entry that implies an impossible physical travel speed.
    return not impossible_schedule


def _current_minutes(profile):
    profile = profile or {}

    override = profile.get("departure_time_override")

    if override:
        parsed = _time_to_minutes(override)
        if parsed is not None:
            return int(parsed)

    # Windows Python installations can be missing the IANA time-zone database.
    # The planner must still work for the normal UI flow, so retain the same
    # India Standard Time calculation when ZoneInfo data is unavailable.
    try:
        now = datetime.now(ZoneInfo("Asia/Kolkata"))
    except Exception:
        now = datetime.now(timezone.utc) + timedelta(hours=5, minutes=30)
    return now.hour * 60 + now.minute


def _ensure_indexes(conn):
    indexes = [
        """
        CREATE INDEX IF NOT EXISTS idx_stops_stop_id
        ON stops(stop_id)
        """,
        """
        CREATE INDEX IF NOT EXISTS idx_stop_times_stop_trip
        ON stop_times(stop_id, trip_id)
        """,
        """
        CREATE INDEX IF NOT EXISTS idx_stop_times_trip_sequence
        ON stop_times(trip_id, stop_sequence)
        """,
        """
        CREATE INDEX IF NOT EXISTS idx_stop_times_trip_stop
        ON stop_times(trip_id, stop_id)
        """,
        """
        CREATE INDEX IF NOT EXISTS idx_trips_route
        ON trips(route_id)
        """,
    ]

    for sql in indexes:
        try:
            conn.execute(sql)
        except Exception:
            pass

    conn.commit()


def _get_stop(conn, stop_id):
    return conn.execute(
        """
        SELECT stop_id, stop_name, stop_lat, stop_lon
        FROM stops
        WHERE stop_id = ?
        """,
        (str(stop_id),),
    ).fetchone()


def _route_info(conn, route_id):
    row = conn.execute(
        """
        SELECT
            route_id,
            COALESCE(route_short_name, '') AS route_short_name,
            COALESCE(route_long_name, '') AS route_long_name
        FROM routes
        WHERE route_id = ?
        """,
        (str(route_id),),
    ).fetchone()

    if not row:
        return {
            "route_id": str(route_id),
            "route_name": str(route_id),
        }

    name = row["route_short_name"] or row["route_long_name"] or row["route_id"]

    return {
        "route_id": str(row["route_id"]),
        "route_name": str(name),
        "route_short_name": str(row["route_short_name"]),
        "route_long_name": str(row["route_long_name"]),
    }


def _routes_at_stop(conn, stop_id):
    rows = conn.execute(
        """
        SELECT DISTINCT t.route_id
        FROM stop_times st
        JOIN trips t ON t.trip_id = st.trip_id
        WHERE st.stop_id = ?
        """,
        (str(stop_id),),
    ).fetchall()

    return [str(row["route_id"]) for row in rows]


def _stops_on_route(conn, route_id):
    rows = conn.execute(
        """
        SELECT DISTINCT st.stop_id
        FROM stop_times st
        JOIN trips t ON t.trip_id = st.trip_id
        WHERE t.route_id = ?
        """,
        (str(route_id),),
    ).fetchall()

    return [str(row["stop_id"]) for row in rows]


def _common_stops(conn, route_a, route_b):
    rows = conn.execute(
        """
        SELECT DISTINCT a.stop_id
        FROM stop_times a
        JOIN trips ta ON ta.trip_id = a.trip_id
        JOIN stop_times b ON b.stop_id = a.stop_id
        JOIN trips tb ON tb.trip_id = b.trip_id
        WHERE ta.route_id = ?
          AND tb.route_id = ?
        LIMIT 100
        """,
        (str(route_a), str(route_b)),
    ).fetchall()

    return [str(row["stop_id"]) for row in rows]


def _find_trip_segment(
    conn,
    route_id,
    start_stop,
    end_stop,
    earliest_departure,
):
    """
    Find the earliest scheduled trip on route_id that travels
    from start_stop to end_stop in the correct direction.
    """

    rows = conn.execute(
        """
        SELECT
            st1.trip_id,
            st1.stop_sequence AS start_sequence,
            st1.departure_time AS departure_time,
            st2.stop_sequence AS end_sequence,
            st2.arrival_time AS arrival_time,
            COALESCE(t.trip_headsign, '') AS trip_headsign,
            COALESCE(t.shape_id, '') AS shape_id
        FROM stop_times st1
        JOIN stop_times st2
          ON st2.trip_id = st1.trip_id
         AND st2.stop_sequence > st1.stop_sequence
        JOIN trips t
          ON t.trip_id = st1.trip_id
        WHERE t.route_id = ?
          AND st1.stop_id = ?
          AND st2.stop_id = ?
          AND st1.departure_time IS NOT NULL
          AND st2.arrival_time IS NOT NULL
        ORDER BY st1.departure_time
        """,
        (
            str(route_id),
            str(start_stop),
            str(end_stop),
        ),
    ).fetchall()

    best = None

    for row in rows:
        departure = _time_to_minutes(row["departure_time"])
        arrival = _time_to_minutes(row["arrival_time"])

        if departure is None or arrival is None:
            continue

        if departure < earliest_departure:
            continue

        if arrival < departure:
            continue

        candidate = {
            "trip_id": str(row["trip_id"]),
            "departure": departure,
            "arrival": arrival,
            "headsign": str(row["trip_headsign"]),
            "shape_id": str(row["shape_id"]),
            "start_sequence": int(row["start_sequence"]),
            "end_sequence": int(row["end_sequence"]),
        }

        if best is None or candidate["arrival"] < best["arrival"]:
            best = candidate

    return best


def _segment_stops(conn, trip_id, start_sequence, end_sequence):
    rows = conn.execute(
        """
        SELECT
            st.stop_id,
            st.stop_sequence,
            st.arrival_time,
            st.departure_time,
            s.stop_name,
            s.stop_lat,
            s.stop_lon
        FROM stop_times st
        JOIN stops s
          ON s.stop_id = st.stop_id
        WHERE st.trip_id = ?
          AND st.stop_sequence >= ?
          AND st.stop_sequence <= ?
        ORDER BY st.stop_sequence
        """,
        (
            str(trip_id),
            int(start_sequence),
            int(end_sequence),
        ),
    ).fetchall()

    result = []

    for row in rows:
        result.append(
            {
                "stop_id": str(row["stop_id"]),
                "stop_name": str(row["stop_name"]),
                "lat": float(row["stop_lat"]),
                "lon": float(row["stop_lon"]),
                "stop_sequence": int(row["stop_sequence"]),
                "arrival_time": row["arrival_time"],
                "departure_time": row["departure_time"],
            }
        )

    return result


def _shape_segment(conn, shape_id, stops):
    """Return the part of a GTFS shape nearest the segment's endpoint stops."""
    if not shape_id or len(stops) < 2:
        return None

    try:
        rows = conn.execute(
            """
            SELECT shape_pt_lon, shape_pt_lat
            FROM shapes
            WHERE shape_id = ?
            ORDER BY shape_pt_sequence
            """,
            (str(shape_id),),
        ).fetchall()
    except sqlite3.OperationalError:
        # Older project databases were imported before shapes were retained.
        return None

    coordinates = [
        [float(row["shape_pt_lon"]), float(row["shape_pt_lat"])]
        for row in rows
    ]
    if len(coordinates) < 2:
        return None

    start = [float(stops[0]["lon"]), float(stops[0]["lat"])]
    end = [float(stops[-1]["lon"]), float(stops[-1]["lat"])]
    start_index = min(
        range(len(coordinates)),
        key=lambda index: _distance_km(coordinates[index], start),
    )
    end_index = min(
        range(start_index, len(coordinates)),
        key=lambda index: _distance_km(coordinates[index], end),
    )

    selected = coordinates[start_index : end_index + 1]
    return selected if len(selected) >= 2 else None


def _make_segment(conn, route_id, start_stop, end_stop, earliest):
    trip = _find_trip_segment(
        conn,
        route_id,
        start_stop,
        end_stop,
        earliest,
    )

    if not trip:
        return None

    stops = _segment_stops(
        conn,
        trip["trip_id"],
        trip["start_sequence"],
        trip["end_sequence"],
    )

    info = _route_info(conn, route_id)

    return {
        "route_id": info["route_id"],
        "route_name": info["route_name"],
        "trip_id": trip["trip_id"],
        "headsign": trip["headsign"],
        "departure": trip["departure"],
        "arrival": trip["arrival"],
        "duration": max(0, int(trip["arrival"] - trip["departure"])),
        "stops": stops,
        # Use stop coordinates during candidate search. Shape geometry is
        # hydrated only for the final options shown to the user.
        "coordinates": [
            [stop["lon"], stop["lat"]]
            for stop in stops
        ],
        "shape_id": trip["shape_id"],
    }


def _build_route(segments):
    if not segments:
        return None

    all_stops = []

    for index, segment in enumerate(segments):
        segment_stops = segment["stops"]

        if index:
            # Don't duplicate the transfer stop.
            segment_stops = segment_stops[1:]

        all_stops.extend(segment_stops)

    if not all_stops:
        return None

    coordinates = []
    for segment in segments:
        for point in segment.get("coordinates", []):
            if not coordinates or point != coordinates[-1]:
                coordinates.append(point)

    departure = segments[0]["departure"]
    arrival = segments[-1]["arrival"]

    transfer_stops = []

    for segment in segments[:-1]:
        transfer_stops.append(
            segment["stops"][-1]["stop_name"]
        )

    return {
        "route_numbers": [
            segment["route_name"]
            for segment in segments
        ],
        "route_name": " → ".join(
            segment["route_name"]
            for segment in segments
        ),
        "route_ids": [
            segment["route_id"]
            for segment in segments
        ],
        "trip_ids": [
            segment["trip_id"]
            for segment in segments
        ],
        "segments": [
            {
                "route_id": segment["route_id"],
                "route_name": segment["route_name"],
                "trip_id": segment["trip_id"],
                "headsign": segment["headsign"],
                "departure_time": _minutes_to_time(segment["departure"]),
                "arrival_time": _minutes_to_time(segment["arrival"]),
                "duration_minutes": segment["duration"],
                "stops": segment["stops"],
                "coordinates": segment.get("coordinates", []),
                "shape_id": segment.get("shape_id", ""),
            }
            for segment in segments
        ],
        "total_minutes": max(0, int(arrival - departure)),
        "duration_minutes": max(0, int(arrival - departure)),
        "transfers": max(0, len(segments) - 1),
        "transfer_count": max(0, len(segments) - 1),
        "walking_minutes": 0,
        "transfer_stops": transfer_stops,
        "coordinates": coordinates,
        "geometry": {
            "type": "LineString",
            "coordinates": coordinates,
        },
        "departure_time": _minutes_to_time(departure),
        "arrival_time": _minutes_to_time(arrival),
        "stops": all_stops,
        "difficulty_level": (
            "Easy"
            if len(segments) == 1
            else "Moderate"
        ),
    }


def _hydrate_route_shapes(conn, route):
    """Replace stop-sequence lines with GTFS shapes for displayed routes only."""
    combined = []

    for segment in route.get("segments", []):
        coordinates = _shape_segment(
            conn,
            segment.get("shape_id", ""),
            segment.get("stops", []),
        ) or segment.get("coordinates", [])
        segment["coordinates"] = coordinates

        for point in coordinates:
            if not combined or point != combined[-1]:
                combined.append(point)

    if len(combined) >= 2:
        route["coordinates"] = combined
        route["geometry"] = {
            "type": "LineString",
            "coordinates": combined,
        }
        route["geometry_source"] = "gtfs_shape"

    return route


def _direct_routes(conn, origin_id, destination_id, start_minute):
    routes = _routes_at_stop(conn, origin_id)

    results = []

    for route_id in routes:
        segment = _make_segment(
            conn,
            route_id,
            origin_id,
            destination_id,
            start_minute,
        )

        if segment:
            route = _build_route([segment])

            if route:
                results.append(route)

    return results


def _candidate_transfer_stops(conn, route_id, destination, limit=6):
    """Return a bounded set of likely useful transfer stops on a route.

    Searching every stop on every route is slow at busy terminals. Prioritising
    stops nearest to the destination retains useful one-transfer journeys while
    keeping the browser-facing planner responsive.
    """
    rows = conn.execute(
        """
        SELECT DISTINCT s.stop_id, s.stop_lat, s.stop_lon
        FROM stop_times AS st
        JOIN trips AS t ON t.trip_id = st.trip_id
        JOIN stops AS s ON s.stop_id = st.stop_id
        WHERE t.route_id = ?
        """,
        (str(route_id),),
    ).fetchall()

    ranked = sorted(
        rows,
        key=lambda row: _distance_km(
            [float(row["stop_lon"]), float(row["stop_lat"])],
            destination,
        ),
    )
    if limit:
        ranked = ranked[:limit]
    return [str(row["stop_id"]) for row in ranked]


def _one_transfer_routes(
    conn,
    origin_id,
    destination_id,
    start_minute,
    candidate_limit=6,
):
    deadline = time.monotonic() + MAX_ONE_TRANSFER_SEARCH_SECONDS
    origin_routes = _routes_at_stop(conn, origin_id)
    routes_at_stop_cache = {}

    def routes_at(stop_id):
        stop_id = str(stop_id)
        if stop_id not in routes_at_stop_cache:
            routes_at_stop_cache[stop_id] = _routes_at_stop(conn, stop_id)
        return routes_at_stop_cache[stop_id]

    destination_routes = set(routes_at(destination_id))
    destination = _get_stop(conn, destination_id)
    destination_coordinates = [
        float(destination["stop_lon"]),
        float(destination["stop_lat"]),
    ]

    results = []

    for first_route in origin_routes:

        if time.monotonic() >= deadline:
            return results

        first_segments = {}

        for transfer_stop in _candidate_transfer_stops(
            conn,
            first_route,
            destination_coordinates,
            candidate_limit,
        ):

            if time.monotonic() >= deadline:
                return results

            second_routes = [
                route_id
                for route_id in routes_at(transfer_stop)
                if route_id in destination_routes
                and route_id != first_route
            ]

            if not second_routes:
                continue

            if transfer_stop not in first_segments:
                first_segments[transfer_stop] = _make_segment(
                    conn,
                    first_route,
                    origin_id,
                    transfer_stop,
                    start_minute,
                )

            first_segment = first_segments[transfer_stop]

            if not first_segment:
                continue

            transfer_arrival = first_segment["arrival"]

            for second_route in second_routes:
                if time.monotonic() >= deadline:
                    return results

                second_segment = _make_segment(
                    conn,
                    second_route,
                    transfer_stop,
                    destination_id,
                    transfer_arrival + TRANSFER_MINUTES,
                )

                if not second_segment:
                    continue

                route = _build_route(
                    [
                        first_segment,
                        second_segment,
                    ]
                )

                if route:
                    results.append(route)

    return results


def _two_transfer_routes(
    conn,
    origin_id,
    destination_id,
    start_minute,
):
    origin_routes = _routes_at_stop(conn, origin_id)
    destination_routes = set(
        _routes_at_stop(conn, destination_id)
    )

    results = []
    deadline = time.monotonic() + MAX_TWO_TRANSFER_SEARCH_SECONDS

    for first_route in origin_routes:

        if time.monotonic() >= deadline:
            return results

        first_stops = _stops_on_route(
            conn,
            first_route,
        )

        for transfer_one in first_stops:

            if time.monotonic() >= deadline:
                return results

            second_routes = _routes_at_stop(
                conn,
                transfer_one,
            )

            for second_route in second_routes:

                if second_route == first_route:
                    continue

                second_stops = _stops_on_route(
                    conn,
                    second_route,
                )

                for transfer_two in second_stops:

                    if time.monotonic() >= deadline:
                        return results

                    if transfer_two == transfer_one:
                        continue

                    third_routes = _routes_at_stop(
                        conn,
                        transfer_two,
                    )

                    third_routes = [
                        route
                        for route in third_routes
                        if route in destination_routes
                        and route != second_route
                    ]

                    if not third_routes:
                        continue

                    first_segment = _make_segment(
                        conn,
                        first_route,
                        origin_id,
                        transfer_one,
                        start_minute,
                    )

                    if not first_segment:
                        continue

                    second_segment = _make_segment(
                        conn,
                        second_route,
                        transfer_one,
                        transfer_two,
                        first_segment["arrival"]
                        + TRANSFER_MINUTES,
                    )

                    if not second_segment:
                        continue

                    third_start = (
                        second_segment["arrival"]
                        + TRANSFER_MINUTES
                    )

                    for third_route in third_routes:

                        third_segment = _make_segment(
                            conn,
                            third_route,
                            transfer_two,
                            destination_id,
                            third_start,
                        )

                        if not third_segment:
                            continue

                        route = _build_route(
                            [
                                first_segment,
                                second_segment,
                                third_segment,
                            ]
                        )

                        if route:
                            results.append(route)

                        if len(results) >= 8:
                            return results

    return results


def _deduplicate(routes):
    seen = set()
    result = []

    for route in routes:
        # The source feed can contain multiple route/trip IDs that display the
        # same public route number. Keep one useful option rather than filling
        # the UI with visually identical alternatives.
        signature = tuple(route.get("route_numbers", []))

        if signature in seen:
            continue

        seen.add(signature)
        result.append(route)

    return result


def _find_scheduled_routes(conn, origin_id, destination_id, start_minute):
    """Find the best scheduled connection for one exact pair of stops."""
    routes = _direct_routes(conn, origin_id, destination_id, start_minute)
    if routes:
        return routes

    routes = _one_transfer_routes(
        conn, origin_id, destination_id, start_minute
    )
    if routes:
        return routes

    # Broaden the transfer search only when the fast nearby-stop pass found
    # nothing. This keeps everyday planning responsive without losing the
    # less-obvious real connections in the feed.
    routes = _one_transfer_routes(
        conn,
        origin_id,
        destination_id,
        start_minute,
        candidate_limit=None,
    )
    if routes:
        return routes

    return _two_transfer_routes(
        conn, origin_id, destination_id, start_minute
    )


def _add_final_walk(route, requested_destination, alight_stop):
    """Describe a short final walk when a nearby real stop is more useful."""
    walk_km = _distance_km(
        [float(alight_stop["stop_lon"]), float(alight_stop["stop_lat"])],
        [
            float(requested_destination["stop_lon"]),
            float(requested_destination["stop_lat"]),
        ],
    )
    walk_metres = max(1, round(walk_km * 1000))
    # This is intentionally an approximate access estimate, not a claimed
    # street-by-street walking route. At 80 m/min it is conservative enough
    # for a last-mile interchange.
    walk_minutes = max(1, round(walk_metres / 80))
    bus_arrival = route.get("arrival_time")
    bus_arrival_minutes = _time_to_minutes(bus_arrival)

    route["walking_minutes"] = walk_minutes
    route["final_walk_distance_m"] = walk_metres
    route["final_walk_from"] = str(alight_stop["stop_name"])
    route["final_walk_to"] = str(requested_destination["stop_name"])
    route["bus_arrival_time"] = bus_arrival
    if bus_arrival_minutes is not None:
        route["arrival_time"] = _minutes_to_time(
            bus_arrival_minutes + walk_minutes
        )
    route["total_elapsed_minutes"] = (
        route.get("total_elapsed_minutes", 0) + walk_minutes
    )
    route.setdefault("advisories", []).append(
        f"Alight at {alight_stop['stop_name']} and walk about {walk_metres} m to your destination"
    )


def plan_journey(
    database: str | Path,
    origin_id: str,
    destination_id: str,
    profile: dict | None = None,
):
    profile = profile or {}
    database = Path(database)

    if not database.exists():
        raise ValueError(
            "Bengaluru transit database was not found."
        )

    with _connect(database) as conn:

        _ensure_indexes(conn)

        origin = _get_stop(conn, origin_id)
        destination = _get_stop(conn, destination_id)

        if not origin:
            raise ValueError(
                f"Origin stop {origin_id} was not found."
            )

        if not destination:
            raise ValueError(
                f"Destination stop {destination_id} was not found."
            )

        if str(origin_id) == str(destination_id):
            raise ValueError(
                "Choose two different stops."
            )

        start_minute = _current_minutes(profile)

        routes = _find_scheduled_routes(
            conn,
            str(origin_id),
            str(destination_id),
            start_minute,
        )

        direct_distance_km = _distance_km(
            [float(origin["stop_lon"]), float(origin["stop_lat"])],
            [float(destination["stop_lon"]), float(destination["stop_lat"])],
        )
        routes = [
            route
            for route in _deduplicate(routes)
            if _add_practicality_metrics(
                route,
                start_minute,
                direct_distance_km,
            )
        ]

        # GTFS commonly represents the two sides of a road, a bus bay, or a
        # terminal platform as separate stops. If the exact platform has no
        # connection, try nearby real destination stops and include the short
        # final walk instead of incorrectly saying that the destination is
        # unreachable.
        if not routes:
            for nearby_destination in _nearby_stops(
                conn,
                destination,
                limit=3,
                radius_km=0.65,
            ):
                nearby_routes = _find_scheduled_routes(
                    conn,
                    str(origin_id),
                    nearby_destination["stop_id"],
                    start_minute,
                )
                for route in _deduplicate(nearby_routes):
                    if not _add_practicality_metrics(
                        route,
                        start_minute,
                        direct_distance_km,
                    ):
                        continue
                    _add_final_walk(route, destination, nearby_destination)
                    routes.append(route)
                if len(routes) >= 8:
                    break

        # Rank by the actual time from the requested departure, not merely
        # time spent inside vehicles. This prevents a late-evening service
        # from being labelled the fastest option for a morning request.
        routes.sort(
            key=lambda route: (
                route.get("total_elapsed_minutes", 999999),
                route.get("transfers", 999),
            )
        )
        routes = [
            _hydrate_route_shapes(conn, route)
            for route in routes[:8]
        ]
        fallback = (
            None
            if routes
            else _fallback_guidance(
                conn,
                origin,
                destination,
                direct_distance_km,
            )
        )

        return {
            "origin": dict(origin),
            "destination": dict(destination),
            "routes": routes,
            "data_mode": "Bengaluru scheduled network",
            "planned_from_local_time": _minutes_to_time(
                start_minute
            ),
            "notice": (
                "Routes are calculated from the imported Bengaluru GTFS "
                "schedule. Times are timetable-based; routes with a long "
                "wait or detour are retained and clearly flagged."
                if routes
                else "No practical scheduled bus journey was found. "
                "Available timetable connections require a long wait, "
                "an extreme detour, or are slower than a short local trip."
            ),
            "fallback": fallback,
        }

# Names people type that differ from BMTC's own spelling in the GTFS data. Every
# target was checked against the imported stop names.
STOP_ALIASES = {
    "majestic": ["kempegowdabusstation"], "kbs": ["kempegowdabusstation"],
    "kempegowdabusstand": ["kempegowdabusstation"],
    "krishnarajapuram": ["krpuram"], "krpura": ["krpuram"],
    "yeshwanthpur": ["yeshawanthapura"], "yeshwantpur": ["yeshawanthapura"],
    "yeshwanthpura": ["yeshawanthapura"], "yeshvantpur": ["yeshawanthapura"],
    "malleswaram": ["malleshwaram"], "airport": ["kempegowdainternationalairport"],
    "kia": ["kempegowdainternationalairport"], "bengaluruairport": ["kempegowdainternationalairport"],
    "bellandur": ["bellanduru"], "varthur": ["varthuru"],
}


def normalize_stop_text(value):
    """Lower-case and drop spaces/punctuation so "Whitefield" finds "White Field"."""
    return "".join(ch for ch in str(value or "").lower() if ch.isalnum())


def search_stops(database, query, limit=12):
    database = Path(database)

    if not database.exists():
        raise ValueError("Bengaluru transit database was not found.")

    query = str(query or "").strip()
    wanted = normalize_stop_text(query)
    patterns = [wanted] + STOP_ALIASES.get(wanted, [])

    with closing(_connect(database)) as conn:
        conn.create_function("norm", 1, normalize_stop_text, deterministic=True)
        if not wanted:
            rows = conn.execute(
                "SELECT stop_id, stop_name, stop_lat, stop_lon FROM stops ORDER BY stop_name LIMIT ?",
                (int(limit),),
            ).fetchall()
            rows = [dict(row) for row in rows]
        else:
            tier = " ".join(
                f"WHEN norm(stop_name) = ?{n} THEN 0 WHEN norm(stop_name) LIKE ?{n} || '%' THEN 1"
                for n in range(1, len(patterns) + 1)
            )
            contains = " OR ".join(f"norm(stop_name) LIKE '%' || ?{n} || '%'" for n in range(1, len(patterns) + 1))
            rows = conn.execute(
                f"""
                SELECT stop_id, stop_name, stop_lat, stop_lon,
                       CASE {tier} ELSE 2 END AS tier FROM stops
                WHERE {contains}
                ORDER BY tier, length(stop_name), stop_name
                LIMIT ?{len(patterns) + 1}
                """,
                (*patterns, int(limit) * 4),
            ).fetchall()
            # Within a match tier, busy stops first: "Whitefield" should offer the
            # bus station before a post-office stop.
            counts = {
                row["stop_id"]: conn.execute(
                    "SELECT COUNT(DISTINCT t.route_id) FROM stop_times st "
                    "JOIN trips t ON t.trip_id = st.trip_id WHERE st.stop_id = ?",
                    (row["stop_id"],),
                ).fetchone()[0]
                for row in rows
            }
            rows = sorted(rows, key=lambda row: (row["tier"], -counts[row["stop_id"]],
                                                 len(row["stop_name"]), row["stop_name"]))[: int(limit)]
            rows = [{**dict(row), "route_count": counts[row["stop_id"]]} for row in rows]

    return [
        {
            "stop_id": str(row["stop_id"]),
            "stop_name": str(row["stop_name"]),
            "stop_lat": float(row["stop_lat"]),
            "stop_lon": float(row["stop_lon"]),
            "route_count": int(row.get("route_count") or 0),
        }
        for row in rows
    ]
