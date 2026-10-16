from pathlib import Path
import sqlite3, time
from transit.planner import plan_journey
DB=Path(__file__).resolve().parent/'data'/'bengaluru_transit.db'
# These are real stop IDs already used during debugging.
PAIRS=[('35931','24838')]

def main():
    if not DB.exists():
        print('Real DB not found:',DB); return 2
    with sqlite3.connect(DB) as c:
        print('Real DB:',DB)
        print('Counts:', {k:c.execute(f'SELECT COUNT(*) FROM {k}').fetchone()[0] for k in ('stops','trips','stop_times')})
    for a,b in PAIRS:
        t=time.perf_counter()
        try:
            r=plan_journey(DB,a,b,{'preference':'fastest'})
            dt=time.perf_counter()-t
            print(f'{a} -> {b}: OK | {dt:.2f}s')
            for x in r.get('routes',[]): print('  routes:', ' -> '.join(x.get('route_numbers',[])), '| transfers:',x.get('transfers'),'| total:',x.get('total_minutes'),'min')
            return 0
        except Exception as e:
            print(f'{a} -> {b}: ERROR | {time.perf_counter()-t:.2f}s | {type(e).__name__}: {e}')
            return 1
if __name__=='__main__': raise SystemExit(main())
