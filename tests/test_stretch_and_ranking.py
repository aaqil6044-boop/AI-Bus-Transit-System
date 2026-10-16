"""Regression tests: other bus numbers for the same stretch, and never recommending a long way round.

Run from the project folder:  python -m unittest discover -s tests
"""
import sqlite3
import unittest

from transit import otp
from transit.lines import lines_for_stretch

A = (12.9693, 77.7500)    # boarding stop
B = (12.9780, 77.5723)    # alighting stop
MID = (12.9750, 77.6600)


def stretch_db():
    conn = sqlite3.connect(':memory:')
    conn.executescript('''
        CREATE TABLE stops (stop_id TEXT PRIMARY KEY, stop_name TEXT, stop_lat REAL, stop_lon REAL);
        CREATE TABLE routes (route_id TEXT PRIMARY KEY, route_short_name TEXT, route_long_name TEXT);
        CREATE TABLE trips (trip_id TEXT PRIMARY KEY, route_id TEXT);
        CREATE TABLE stop_times (trip_id TEXT, arrival_time TEXT, departure_time TEXT, stop_id TEXT, stop_sequence INTEGER);
    ''')
    conn.executemany('INSERT INTO stops VALUES (?,?,?,?)', [
        ('a1', 'Board', *A), ('a2', 'Board (other platform)', A[0] + 0.0008, A[1]),   # ~90 m away
        ('m', 'Middle', *MID), ('b1', 'Alight', *B), ('far', 'Far', 13.10, 77.40)])
    conn.executemany('INSERT INTO routes VALUES (?,?,?)', [
        ('r1', 'KBS-1K', ''), ('r2', '333-E', ''), ('r3', 'REVERSE', ''), ('r4', 'ONEOFF', ''),
        ('r5', 'ELSEWHERE', ''), ('r6', 'TEST-X', '')])
    trips = []
    def trip(tid, route, stops):
        trips.append((tid, route))
        conn.executemany('INSERT INTO stop_times VALUES (?,?,?,?,?)',
                         [(tid, '08:00:00', '08:00:00', s, i) for i, s in enumerate(stops)])
    for n in range(3):
        trip(f'k{n}', 'r1', ['a1', 'm', 'b1'])          # planned line
        trip(f'e{n}', 'r2', ['a2', 'b1'])               # same stretch from a sibling platform
        trip(f'r{n}', 'r3', ['b1', 'm', 'a1'])          # passes both stops the OTHER way
        trip(f'x{n}', 'r5', ['a1', 'far'])              # leaves from here, does not go there
        trip(f't{n}', 'r6', ['a1', 'b1'])               # excluded non-service route
    trip('o0', 'r4', ['a1', 'b1'])                      # a single special trip
    conn.executemany('INSERT INTO trips VALUES (?,?)', trips)
    return conn


class StretchLinesTests(unittest.TestCase):
    def test_lines_that_really_cover_the_stretch(self):
        lines = lines_for_stretch(stretch_db(), *A, *B, excluded_route_ids={'r6'})
        names = [line['route'] for line in lines]
        self.assertIn('KBS-1K', names)
        self.assertIn('333-E', names, 'a sibling platform within a short walk counts')
        self.assertNotIn('REVERSE', names, 'same two stops in the opposite order is the wrong direction')
        self.assertNotIn('ELSEWHERE', names)
        self.assertNotIn('ONEOFF', names, 'a single special trip is not offered as a usual alternative')
        self.assertNotIn('TEST-X', names, 'excluded non-service routes stay out')

    def test_exclude_by_name(self):
        names = [line['route'] for line in lines_for_stretch(stretch_db(), *A, *B, exclude=['kbs-1k'], excluded_route_ids={'r6'})]
        self.assertEqual(names, ['333-E'])

    def test_no_stop_near_point(self):
        self.assertEqual(lines_for_stretch(stretch_db(), 13.5, 77.0, *B), [])


def option(name, minutes, stops, transit=True):
    legs = [{'transit': True, 'route_name': name,
             'from': {'name': f'{name} from', 'lat': a[0], 'lon': a[1]},
             'to': {'name': f'{name} to', 'lat': b[0], 'lon': b[1]}} for a, b in zip(stops, stops[1:])]
    return {'route_numbers': [name], 'transit': transit, 'legs': legs, 'advisories': [],
            'total_elapsed_minutes': minutes, 'transfers': len(legs) - 1, 'walking_minutes': 2}


class BacktrackRankingTests(unittest.TestCase):
    origin = {'stop_lat': A[0], 'stop_lon': A[1]}
    destination = {'stop_lat': B[0], 'stop_lon': B[1]}
    HOSKOTE = (13.0700, 77.7980)   # well away from the destination before turning back

    def test_long_way_round_is_flagged_but_kept(self):
        direct = option('KBS-1K', 99, [A, B])
        detour = option('328-H', 69, [A, self.HOSKOTE, B])
        routes = [detour, direct]
        otp._mark_backtracking(routes, self.origin, self.destination)
        self.assertTrue(detour['detour'])
        self.assertGreater(detour['backtrack_km'], 3)
        self.assertFalse(direct['detour'])
        self.assertIn('Long way round', detour['advisories'][0])
        ranked = otp._rank(routes, 'fastest')
        self.assertIs(ranked[0], direct, 'a sensible option is recommended over an earlier long way round')
        self.assertIn(detour, ranked, 'the long way round is still listed')

    def test_detour_can_lead_when_nothing_sensible_exists(self):
        detour = option('328-H', 69, [A, self.HOSKOTE, B])
        otp._mark_backtracking([detour], self.origin, self.destination)
        self.assertIs(otp._rank([detour], 'fastest')[0], detour)

    def test_small_wiggle_is_not_a_detour(self):
        wiggle = option('500-D', 80, [A, (A[0] + 0.01, A[1] + 0.005), B])
        otp._mark_backtracking([wiggle], self.origin, self.destination)
        self.assertFalse(wiggle['detour'])


if __name__ == '__main__':
    unittest.main()
