"""Scheduled network coverage, distinct from passenger demand or live fleet data."""
import sqlite3
from functools import lru_cache
from pathlib import Path


def network_summary(database):
    path = Path(database)
    return _summary(str(path), path.stat().st_mtime_ns)


@lru_cache(maxsize=2)
def _summary(database, modified):
    with sqlite3.connect(database) as conn:
        conn.row_factory = sqlite3.Row
        totals = {name: conn.execute(f'SELECT COUNT(*) FROM {name}').fetchone()[0]
                  for name in ('stops', 'routes', 'trips')}
        hubs = conn.execute('''
            SELECT s.stop_name, s.stop_id, COUNT(DISTINCT t.route_id) AS route_count
            FROM stops s JOIN stop_times st ON st.stop_id=s.stop_id
            JOIN trips t ON t.trip_id=st.trip_id
            GROUP BY s.stop_id ORDER BY route_count DESC LIMIT 8
        ''').fetchall()
    return {'totals': totals, 'interchanges': [dict(row) for row in hubs],
            'tracking_status': 'BMTC live bus tracking is available when its feed permits access; freshness is shown per vehicle.',
            'basis': 'Imported GTFS schedule. Route counts describe service coverage, not passenger demand, live fleet size or crowding.',
            'optimization': 'Journey ranking balances time, walking and transfers. Fleet allocation requires passenger counts and vehicle availability.'}
