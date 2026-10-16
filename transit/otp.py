"""Coordinate-based routing using the locally built OpenTripPlanner graph.

Every journey returned here is built from the BMTC *timetable* (GTFS). Times are
scheduled times, never live arrivals, and the response says so explicitly.
"""
import json
import math
import os
import re
import sqlite3
from contextlib import closing
from datetime import datetime, timedelta, timezone
from urllib.error import URLError
from urllib.request import ProxyHandler, Request, build_opener

ENDPOINT = os.environ.get('OTP_ENDPOINT', 'http://127.0.0.1:8766/otp/gtfs/v1')
FEED_ID = 'BMTC'
IST = timezone(timedelta(hours=5, minutes=30))

# Bengaluru routing area (also enforced for map points and live-bus lookups).
BOUNDS = (12.65, 13.45, 77.20, 78.00)

# A connection with a longer wait than this is only offered when nothing better
# exists, and is flagged. A transfer shorter than TIGHT_TRANSFER_MINUTES is flagged.
MAX_TRANSFER_WAIT_MINUTES = 40
LONG_WAIT_WARNING_MINUTES = 20
TIGHT_TRANSFER_MINUTES = 3
LONG_WALK_METERS = 900
MAX_WALK_ONLY_MINUTES = 30
TRIVIAL_WALK_METERS = 25

# The BMTC GTFS contains internal fare-system test entries ("O Test AFCS",
# "Vivek_Test14"...). They are not passenger services and must never be offered.
# Only the short name is checked: some real routes mention "Training Centre".
_NON_SERVICE_ROUTE = re.compile(r'(?<![a-z])(test|dummy)|afcs', re.IGNORECASE)

QUERY = '''query($origin: PlanLabeledLocationInput!, $destination: PlanLabeledLocationInput!,
    $dateTime: PlanDateTimeInput!, $filters: [TransitFilterInput!]) {
  planConnection(origin: $origin, destination: $destination,
    dateTime: $dateTime, first: 10,
    modes: {direct: [WALK], transit: {transit: [{mode: BUS}]}},
    preferences: {transit: {filters: $filters}}) {
    routingErrors { code description }
    edges { node { start end legs {
      mode start {scheduledTime} end {scheduledTime} duration distance transitLeg realTime headsign
      serviceDate
      trip { gtfsId directionId tripHeadsign }
      from {name lat lon stop {gtfsId}}
      to {name lat lon stop {gtfsId}}
      route {gtfsId shortName longName}
      legGeometry {points}
      stopCalls {
        stopLocation { ... on Stop { gtfsId name lat lon } }
        schedule { time { ... on ArrivalDepartureTime { arrival departure } } }
      }
    } } }
  }
}'''


class RouterUnavailable(RuntimeError):
    pass


def decode_polyline(encoded):
    result, index, lat, lon = [], 0, 0, 0
    while index < len(encoded):
        delta = []
        for _ in range(2):
            value, shift = 0, 0
            while True:
                byte = ord(encoded[index]) - 63
                index += 1
                value |= (byte & 31) << shift
                shift += 5
                if byte < 32:
                    break
            delta.append(~(value >> 1) if value & 1 else value >> 1)
        lat += delta[0]
        lon += delta[1]
        result.append([lon / 1e5, lat / 1e5])
    return result


def _meters(a, b):
    """Rough ground distance in metres between two [lon, lat] points."""
    dx = (a[0] - b[0]) * 111320 * math.cos(math.radians((a[1] + b[1]) / 2))
    dy = (a[1] - b[1]) * 110540
    return math.hypot(dx, dy)


ANCHOR_MIN_M, ANCHOR_MAX_M = 25, 500


def anchor_to_stops(geometry, source, target):
    """Make a leg's line start and end exactly at its boarding/alighting stops.

    GTFS shapes often begin at a bus-station entrance while the stop (platform) is a
    little way off, which leaves a visible gap between the walk, the marker and the bus
    line. The stops' own coordinates are real data, so a short connector is added. A gap
    larger than ANCHOR_MAX_M is left alone rather than drawing a misleading long line.
    """
    if not geometry:
        return geometry
    line = list(geometry)
    start = [source.get('lon'), source.get('lat')]
    end = [target.get('lon'), target.get('lat')]
    if None not in start and ANCHOR_MIN_M < _meters(line[0], start) < ANCHOR_MAX_M:
        line.insert(0, start)
    if None not in end and ANCHOR_MIN_M < _meters(line[-1], end) < ANCHOR_MAX_M:
        line.append(end)
    return line


def _date(value):
    return datetime.fromisoformat(value.replace('Z', '+00:00'))


def is_non_service_route(short_name, long_name=''):
    """True for fare-system test entries that are not real passenger services."""
    return bool(_NON_SERVICE_ROUTE.search(str(short_name or '')))


_excluded_cache = {}


def excluded_route_ids(database):
    """OTP route ids (e.g. 'BMTC:9494') of non-service routes in the database."""
    try:
        key = (str(database), os.stat(str(database)).st_mtime_ns)
    except OSError:
        return []
    if key not in _excluded_cache:
        _excluded_cache.clear()
        try:
            with closing(sqlite3.connect(str(database))) as conn:
                rows = conn.execute('SELECT route_id, route_short_name, route_long_name FROM routes').fetchall()
        except sqlite3.Error:
            rows = []
        _excluded_cache[key] = [f'{FEED_ID}:{r[0]}' for r in rows if is_non_service_route(r[1], r[2])]
    return _excluded_cache[key]


def _in_bounds(lat, lon):
    return BOUNDS[0] <= lat <= BOUNDS[1] and BOUNDS[2] <= lon <= BOUNDS[3]


def _stop(conn, stop_id, point=None):
    if point:
        try:
            lat, lon = float(point['lat']), float(point['lon'])
        except (KeyError, TypeError, ValueError):
            raise ValueError('The selected map point has no valid coordinates.')
        if not _in_bounds(lat, lon):
            raise ValueError('Choose points inside the Bengaluru routing area.')
        return {'stop_id': str(point.get('id', 'map-point')),
                'stop_name': str(point.get('name') or 'Selected map point'),
                'stop_lat': lat, 'stop_lon': lon}
    row = conn.execute('SELECT * FROM stops WHERE stop_id = ?', (str(stop_id),)).fetchone()
    if row is None:
        raise ValueError('Select a valid starting point and destination from the suggestions.')
    return dict(row)


def _location(stop):
    return {'label': stop['stop_name'], 'location': {'coordinate': {
        'latitude': stop['stop_lat'], 'longitude': stop['stop_lon']}}}


def resolve_departure(profile, now=None):
    """Return (datetime, label, is_now) for the requested departure.

    ``depart_at`` ("HH:MM", 24-hour) with optional ``depart_date`` ("YYYY-MM-DD").
    ``departure_time_override`` is accepted as an older name for ``depart_at``.
    A bare clock time that has already passed today means the next occurrence
    (tomorrow) - never a time in the past.
    """
    now = (now or datetime.now(IST)).astimezone(IST)
    clock = profile.get('depart_at') or profile.get('departure_time_override')
    if not clock:
        return now, 'Now', True
    match = re.fullmatch(r'\s*(\d{1,2}):(\d{2})\s*', str(clock))
    if not match or int(match.group(1)) > 23 or int(match.group(2)) > 59:
        raise ValueError('Departure time must be a 24-hour time such as 09:30.')
    hour, minute = int(match.group(1)), int(match.group(2))
    date_text = profile.get('depart_date')
    if date_text:
        try:
            day = datetime.strptime(str(date_text), '%Y-%m-%d').date()
        except ValueError:
            raise ValueError('Departure date must look like 2026-10-14.')
        requested = datetime(day.year, day.month, day.day, hour, minute, tzinfo=IST)
    else:
        requested = now.replace(hour=hour, minute=minute, second=0, microsecond=0)
        if requested < now - timedelta(minutes=2):
            requested += timedelta(days=1)
    day_name = 'Today' if requested.date() == now.date() else (
        'Tomorrow' if requested.date() == (now + timedelta(days=1)).date() else requested.strftime('%a %d %b'))
    return requested, f'{day_name} {requested:%H:%M}', False


def _clock(value):
    return _date(value).astimezone(IST).strftime('%H:%M')


def _minutes_between(start, end):
    return max(0, math.ceil((end - start).total_seconds() / 60))


def _leg_stops(leg):
    stops = []
    for call in leg.get('stopCalls') or []:
        location = call.get('stopLocation') or {}
        if location.get('lat') is None:
            continue
        times = ((call.get('schedule') or {}).get('time')) or {}
        stamp = times.get('departure') or times.get('arrival')
        stops.append({
            'stop_id': str(location.get('gtfsId', '')).split(':', 1)[-1],
            'stop_name': location.get('name') or 'Stop',
            'lat': location['lat'], 'lon': location['lon'],
            'time': _clock(stamp) if stamp else '',
        })
    return stops


def build_routes(plan, requested, profile, excluded=()):
    """Turn an OTP planConnection payload into this app's journey contract."""
    excluded = set(excluded)
    routes = []
    removed_long_wait = []
    for edge in plan.get('edges', []):
        item = edge['node']
        legs = item['legs']
        buses = [leg for leg in legs if leg['transitLeg']]
        if any((leg.get('route') or {}).get('gtfsId') in excluded or
               is_non_service_route((leg.get('route') or {}).get('shortName')) for leg in buses):
            continue
        journey_legs, coords, segments, instructions, warnings = [], [], [], [], []
        previous_end = None
        first_wait = transfer_wait = 0
        bus_seen = 0
        last_index = len(legs) - 1
        for index, leg in enumerate(legs):
            geometry = anchor_to_stops(decode_polyline((leg.get('legGeometry') or {}).get('points', '')),
                                       leg['from'], leg['to'])
            coords.extend(geometry[1:] if coords and geometry and coords[-1] == geometry[0] else geometry)
            start, end = _date(leg['start']['scheduledTime']), _date(leg['end']['scheduledTime'])
            route_info = leg.get('route') or {}
            name = route_info.get('shortName') or route_info.get('longName') or leg['mode']
            minutes = max(1, math.ceil(float(leg['duration']) / 60)) if float(leg['duration']) > 0 else 0
            wait_before = _minutes_between(previous_end, start) if previous_end else 0
            previous_end = end
            record = {
                'mode': leg['mode'], 'transit': leg['transitLeg'],
                'route_name': name, 'headsign': leg.get('headsign') or (leg.get('trip') or {}).get('tripHeadsign') or '',
                'from': leg['from'], 'to': leg['to'], 'coordinates': geometry,
                'duration_minutes': minutes, 'distance_m': round(leg['distance']),
                'departure_time': start.astimezone(IST).strftime('%H:%M'),
                'arrival_time': end.astimezone(IST).strftime('%H:%M'),
                'realtime': bool(leg.get('realTime')),
                'schedule_type': 'live_estimate' if leg.get('realTime') else 'timetable',
                'wait_before_minutes': wait_before,
            }
            if leg['transitLeg']:
                bus_seen += 1
                stops = _leg_stops(leg)
                trip = leg.get('trip') or {}
                record.update(
                    role='bus', route_id=str(route_info.get('gtfsId', '')).split(':', 1)[-1],
                    trip_id=str(trip.get('gtfsId', '')).split(':', 1)[-1],
                    direction_id=trip.get('directionId'), service_date=leg.get('serviceDate'),
                    from_stop_id=str(((leg['from'].get('stop') or {}).get('gtfsId', ''))).split(':', 1)[-1],
                    to_stop_id=str(((leg['to'].get('stop') or {}).get('gtfsId', ''))).split(':', 1)[-1],
                    stops=stops, stop_count=max(0, len(stops) - 1))
                if bus_seen == 1:
                    first_wait = wait_before
                else:
                    transfer_wait += wait_before
                    if wait_before < TIGHT_TRANSFER_MINUTES:
                        warnings.append(f'Tight connection to {name} at {leg["from"]["name"]} ({wait_before} min). '
                                        'If you miss it, wait for the next scheduled bus.')
                    elif wait_before > LONG_WAIT_WARNING_MINUTES:
                        warnings.append(f'Long wait for {name} at {leg["from"]["name"]} ({wait_before} min).')
                riding = f'{record["stop_count"]} stop{"" if record["stop_count"] == 1 else "s"}, ' if stops else ''
                toward = f' toward {record["headsign"]}' if record['headsign'] else ''
                record['instruction'] = (
                    f'Board {name}{toward} at {leg["from"]["name"]}, scheduled {record["departure_time"]}. '
                    f'Ride {riding}{minutes} min, and get down at {leg["to"]["name"]}, scheduled {record["arrival_time"]}.')
                instructions.append(record['instruction'])
                segments.append({'route_name': name, 'coordinates': geometry,
                                 'stops': stops or [{'stop_name': place['name'], 'lat': place['lat'], 'lon': place['lon']}
                                                    for place in (leg['from'], leg['to'])]})
            else:
                if index == 0:
                    role = 'access_walk'
                elif index == last_index:
                    role = 'egress_walk'
                else:
                    role = 'transfer_walk'
                distance = round(leg['distance'])
                if role == 'egress_walk':
                    target = 'your destination'
                elif role == 'access_walk' and not leg['to'].get('stop'):
                    target = leg['to'].get('name') or 'the next point'
                else:
                    target = f"the {leg['to'].get('name') or 'next'} stop" if leg['to'].get('stop') else (leg['to'].get('name') or 'the next point')
                same_name = leg['from'].get('name') == leg['to'].get('name')
                if role == 'transfer_walk' and leg['to'].get('stop'):
                    target = f"{leg['to']['name']} for your next bus" if not same_name else \
                        f"the {leg['to']['name']} stop for your next bus (a different stop with the same name)"
                record.update(role=role, trivial=distance < TRIVIAL_WALK_METERS,
                              stops=[], stop_count=0)
                record['instruction'] = f'Walk {distance} m ({minutes} min) to {target}.'
                if distance > LONG_WALK_METERS:
                    warnings.append(f'Walk of {distance} m ({minutes} min) - {role.split("_")[0]}.')
                if not record['trivial']:
                    instructions.append(record['instruction'])
            journey_legs.append(record)
        arrival = _date(item['end'])
        start = _date(item['start'])
        walking_seconds = sum(float(leg['duration']) for leg in legs if not leg['transitLeg'])
        ride_seconds = sum(float(leg['duration']) for leg in buses)
        elapsed = _minutes_between(requested, arrival)
        route = {
            'route_numbers': [(leg.get('route') or {}).get('shortName') or (leg.get('route') or {}).get('longName') or 'Bus'
                              for leg in buses] or ['Walk'],
            'transfers': max(0, len(buses) - 1), 'walking_minutes': math.ceil(walking_seconds / 60),
            'walking_available': True, 'walking_source': 'street_network',
            'total_minutes': math.ceil(ride_seconds / 60), 'total_elapsed_minutes': elapsed,
            'trip_minutes': _minutes_between(start, arrival),
            'leave_in_minutes': _minutes_between(requested, start),
            'first_bus_wait_minutes': first_wait, 'transfer_wait_minutes': transfer_wait,
            'scheduled_wait_minutes': first_wait + transfer_wait,
            'departure_time': start.astimezone(IST).strftime('%H:%M'),
            'arrival_time': arrival.astimezone(IST).strftime('%H:%M'),
            'coordinates': coords, 'geometry_source': 'otp', 'segments': segments,
            'transfer_stops': [leg['from']['name'] for leg in buses[1:]],
            'instructions': instructions, 'legs': journey_legs,
            'advisories': list(dict.fromkeys(warnings)), 'schedule_based': True,
            'schedule_note': 'Scheduled from the BMTC timetable. Not a live arrival: buses can run early, late or not at all.',
            'transit': bool(buses),
            '_arrival': arrival, '_start': start, '_walk_seconds': walking_seconds,
        }
        max_transfer_wait = max([leg['wait_before_minutes'] for leg in journey_legs if leg['transit']][1:] or [0])
        if max_transfer_wait > MAX_TRANSFER_WAIT_MINUTES:
            removed_long_wait.append(route)
            continue
        if not buses and route['walking_minutes'] > MAX_WALK_ONLY_MINUTES:
            continue
        routes.append(route)
    if not routes and removed_long_wait:
        for route in removed_long_wait:
            route['advisories'].insert(0, 'Only connection found has a very long wait between buses.')
        routes = removed_long_wait
    return _drop_dominated(routes)


def _sequence(route):
    return tuple(route['route_numbers'])


def _drop_dominated(routes):
    """Keep sensible alternatives only.

    An option is dropped when a *different* bus combination arrives no later with
    no more changes and no more walking. Later departures of the same bus
    combination are kept (people want "the next bus"), up to three of them.
    """
    kept = []
    for route in routes:
        key = (route['_arrival'], route['transfers'], route['_walk_seconds'])
        dominated = any(
            _sequence(other) != _sequence(route) and
            other['_arrival'] <= key[0] and other['transfers'] <= key[1] and other['_walk_seconds'] <= key[2]
            for other in routes)
        if not dominated:
            kept.append(route)
    per_sequence, final = {}, []
    for route in sorted(kept, key=lambda r: r['_arrival']):
        count = per_sequence.get(_sequence(route), 0)
        if count < 3:
            per_sequence[_sequence(route)] = count + 1
            final.append(route)
    return final


def _km(lat1, lon1, lat2, lon2):
    return _meters((lon1, lat1), (lon2, lat2)) / 1000


BACKTRACK_MIN_KM = 3.0


def _mark_backtracking(routes, origin, destination):
    """Flag options that ride well AWAY from the destination before coming back.

    Example: Whitefield to Majestic by first going out to Hoskote. The timetable may still show it
    arriving first, so it stays listed, but it is not recommended over a sensible direct option.
    """
    try:
        olat, olon = float(origin['stop_lat']), float(origin['stop_lon'])
        dlat, dlon = float(destination['stop_lat']), float(destination['stop_lon'])
    except (KeyError, TypeError, ValueError):
        return
    start_gap = _km(olat, olon, dlat, dlon)
    for route in routes:
        worst, worst_name = 0.0, ''
        for leg in route.get('legs', []):
            if not leg.get('transit'):
                continue
            for place in (leg.get('from') or {}, leg.get('to') or {}):
                try:
                    gap = _km(float(place['lat']), float(place['lon']), dlat, dlon) - start_gap
                except (KeyError, TypeError, ValueError):
                    continue
                if gap > worst:
                    worst, worst_name = gap, place.get('name') or ''
        route['backtrack_km'] = round(worst, 1)
        route['detour'] = worst >= max(BACKTRACK_MIN_KM, 0.15 * start_gap)
        if route['detour']:
            route['advisories'] = [f'Long way round: goes about {round(worst)} km farther from your destination '
                                   f'(out to {worst_name}) before heading back. Listed because the timetable '
                                   'has it arriving sooner; buses on this path may be less frequent.'] + \
                                  list(route.get('advisories') or [])


def _add_stretch_lines(database, routes, excluded):
    """For every bus leg, list the OTHER bus numbers the timetable runs over the same stretch,
    so the traveller (and the live check) can use whichever comes first."""
    from transit.lines import lines_for_stretch
    bad_ids = {str(item).split(':', 1)[-1] for item in excluded}
    cache = {}
    try:
        conn = sqlite3.connect(str(database))
    except sqlite3.Error:
        return
    with closing(conn):
        for route in routes:
            for leg in route.get('legs', []):
                if not leg.get('transit'):
                    continue
                try:
                    a, b = leg['from'], leg['to']
                    key = (round(float(a['lat']), 5), round(float(a['lon']), 5), round(float(b['lat']), 5), round(float(b['lon']), 5))
                except (KeyError, TypeError, ValueError):
                    continue
                if key not in cache:
                    try:
                        cache[key] = lines_for_stretch(conn, *key, excluded_route_ids=bad_ids)
                    except sqlite3.Error:
                        cache[key] = []
                # Depot/trip variants ("KBS-1K KBS-D41G") are the same bus number for a traveller.
                base = lambda name: str(name).strip().upper().split(' ')[0]
                seen = {base(leg.get('route_name', ''))}
                others = []
                for line in cache[key]:
                    if base(line['route']) in seen:
                        continue
                    seen.add(base(line['route']))
                    others.append(line['route'])
                leg['also_served_by'] = others[:4]


def _rank(routes, preference):
    transfer_weight = 12 if preference == 'fewer_transfers' else 0
    walking_weight = 2 if preference == 'less_walking' else 0
    for route in routes:
        route['preference_score'] = (route['total_elapsed_minutes'] + transfer_weight * route['transfers']
                                     + walking_weight * route['walking_minutes'])
        route['recommendation_reason'] = {
            'fewer_transfers': 'Balances arrival time with fewer bus changes',
            'less_walking': 'Balances arrival time with less walking',
        }.get(preference, 'Earliest scheduled arrival')
    if routes:
        best_elapsed = min(r['total_elapsed_minutes'] for r in routes)
        best_walk = min(r['walking_minutes'] for r in routes)
        best_transfers = min(r['transfers'] for r in routes)
        for route in routes:
            route['highlights'] = []
            if route['total_elapsed_minutes'] == best_elapsed:
                route['highlights'].append('Earliest arrival')
            if route['walking_minutes'] == best_walk:
                route['highlights'].append('Least walking')
            if route['transfers'] == best_transfers:
                route['highlights'].append('Fewest changes')
    # An option that rides far away from the destination is never put first while a sensible one exists.
    sensible = any(r.get('transit') and not r.get('detour') for r in routes)
    routes.sort(key=lambda r: (bool(sensible and r.get('detour')), r['preference_score'], r['total_elapsed_minutes']))
    for route in routes:
        if sensible and route.get('detour'):
            route['recommendation_reason'] = 'Timetable arrival is early, but it goes the long way round'
    for route in routes:
        route.pop('_arrival', None)
        route.pop('_start', None)
        route.pop('_walk_seconds', None)
    return routes[:8]


def _leg_start(route):
    return route['_start']


def _signature(route):
    return (_sequence(route), route['departure_time'], route['arrival_time'])


def _post_otp(variables):
    request = Request(ENDPOINT, json.dumps({'query': QUERY, 'variables': variables}).encode(),
                      {'Content-Type': 'application/json'})
    try:
        with build_opener(ProxyHandler({})).open(request, timeout=25) as response:
            return json.load(response)
    except (URLError, TimeoutError, OSError, ValueError) as exc:
        raise RouterUnavailable('The route engine is not running. Start the project with run-local.cmd '
                                '(or start-otp-router.cmd) and wait until it finishes loading, then search again.') from exc


def router_status():
    """Cheap health probe used by /api/health and the start-up banner."""
    request = Request(ENDPOINT, json.dumps({'query': '{__typename}'}).encode(), {'Content-Type': 'application/json'})
    try:
        with build_opener(ProxyHandler({})).open(request, timeout=2) as response:
            return json.load(response).get('data', {}).get('__typename') == 'QueryType'
    except (URLError, TimeoutError, OSError, ValueError):
        return False


def plan_journey(database, origin_id, destination_id, profile=None,
                 origin_point=None, destination_point=None, now=None):
    profile = profile or {}
    with closing(sqlite3.connect(str(database))) as conn:
        conn.row_factory = sqlite3.Row
        origin = _stop(conn, origin_id, origin_point)
        destination = _stop(conn, destination_id, destination_point)
    requested, requested_label, is_now = resolve_departure(profile, now)
    excluded = excluded_route_ids(database)
    filters = [{'exclude': [{'routes': excluded}]}] if excluded else None

    def search(earliest):
        data = _post_otp({'origin': _location(origin), 'destination': _location(destination),
                          'dateTime': {'earliestDeparture': earliest.isoformat()}, 'filters': filters})
        if data.get('errors'):
            raise RouterUnavailable('The route engine rejected the query: ' + str(data['errors'][0].get('message', 'unknown error')))
        return data['data']['planConnection']

    plan = search(requested)
    found = build_routes(plan, requested, profile, excluded)
    if found and len(found) < 4:
        # Few options: also look a little later so the traveller sees the next buses.
        first_start = min(_leg_start(route) for route in found)
        try:
            later = build_routes(search(first_start + timedelta(minutes=3)), requested, profile, excluded)
        except RouterUnavailable:
            later = []
        known = {_signature(route) for route in found}
        found += [route for route in later if _signature(route) not in known]
        found = _drop_dominated(found)
    _mark_backtracking(found, origin, destination)
    routes = _rank(found, profile.get('preference', 'fastest'))
    _add_stretch_lines(database, routes, excluded)
    errors = plan.get('routingErrors', [])
    if routes:
        fallback = None
    else:
        detail = '; '.join(e['description'] for e in errors)
        fallback = {'message': f'No scheduled bus journey was found leaving {"now" if is_now else requested_label}. '
                    'Services thin out late at night and early in the morning: try another time with '
                    '"Leave at", or choose a nearby stop.' + (f' (Router said: {detail})' if detail else '')}
    return {'origin': origin, 'destination': destination, 'routes': routes,
            'engine': 'OpenTripPlanner', 'data_mode': 'Scheduled buses and road-based walking',
            'requested': {'iso': requested.isoformat(), 'label': requested_label, 'is_now': is_now},
            'notice': 'Times come from the BMTC timetable and exclude live traffic. They are not live arrivals.',
            'fallback': fallback}
