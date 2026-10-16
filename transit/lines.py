"""Which bus lines cover one stretch of a journey, from the imported BMTC timetable (GTFS).

A line "covers" a stretch when one of its timetabled trips stops at the boarding stop (or a stop
within a short walk of it) and LATER on the same trip at the alighting stop (or one near it).
Stop order on the same trip is what makes this direction-safe: a line passing the same two stops
the other way round is not counted.

This is timetable data only. It says which bus numbers are scheduled to do the trip; it never
says that a bus is coming now. Live positions are a separate check against the BMTC feed.
"""
import math
import sqlite3
from contextlib import closing

BOARD_RADIUS_M = 200      # platforms/sibling stops for the same boarding point
ALIGHT_RADIUS_M = 350     # getting down one stop-pole away still reaches the same place
MAX_LINES = 6


def _meters(lat1, lon1, lat2, lon2):
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 6371000 * 2 * math.asin(math.sqrt(a))


def _stops_near(conn, lat, lon, radius):
    dlat = radius / 111320
    dlon = radius / (111320 * max(0.2, math.cos(math.radians(lat))))
    rows = conn.execute(
        'SELECT stop_id, stop_lat, stop_lon FROM stops WHERE stop_lat BETWEEN ? AND ? AND stop_lon BETWEEN ? AND ?',
        (lat - dlat, lat + dlat, lon - dlon, lon + dlon)).fetchall()
    return [row[0] for row in rows if _meters(lat, lon, row[1], row[2]) <= radius]


def lines_for_stretch(conn, board_lat, board_lon, alight_lat, alight_lon, *,
                      exclude=(), excluded_route_ids=(), limit=MAX_LINES):
    """Return [{'route': short name, 'trips': n}], the lines with the most timetabled trips first.

    ``exclude`` drops line names already shown (for example the bus the journey already uses).
    ``trips`` counts timetable entries across all service days, so it shows how frequent a line is
    relative to the others, not how many buses run today. No departure times are given here
    because this lookup does not apply the service calendar.
    """
    board = _stops_near(conn, board_lat, board_lon, BOARD_RADIUS_M)
    alight = _stops_near(conn, alight_lat, alight_lon, ALIGHT_RADIUS_M)
    if not board or not alight:
        return []
    marks_b = ','.join('?' * len(board))
    marks_a = ','.join('?' * len(alight))
    rows = conn.execute(
        f'''SELECT r.route_id, COALESCE(NULLIF(r.route_short_name, ''), r.route_long_name) AS name,
                   a.trip_id, MIN(a.departure_time) AS dep
            FROM stop_times a
            JOIN stop_times b ON b.trip_id = a.trip_id AND b.stop_sequence > a.stop_sequence
            JOIN trips t ON t.trip_id = a.trip_id
            JOIN routes r ON r.route_id = t.route_id
            WHERE a.stop_id IN ({marks_b}) AND b.stop_id IN ({marks_a})
            GROUP BY a.trip_id''', (*board, *alight)).fetchall()
    # Minimum share of trips for a line to be worth showing: drops one-off depot/special trips.
    min_trips = 2
    skip = {str(name).strip().upper() for name in exclude if name}
    bad_ids = set(excluded_route_ids)
    lines = {}
    for route_id, name, _trip, dep in rows:
        if not name or route_id in bad_ids or str(name).strip().upper() in skip:
            continue
        entry = lines.setdefault(name, {'route': name, 'trips': 0})
        entry['trips'] += 1
    result = [entry for entry in lines.values() if entry['trips'] >= min_trips]
    result.sort(key=lambda e: (-e['trips'], e['route']))
    return result[:limit]


def lines_for_stretch_db(database, *args, **kwargs):
    with closing(sqlite3.connect(str(database))) as conn:
        return lines_for_stretch(conn, *args, **kwargs)
