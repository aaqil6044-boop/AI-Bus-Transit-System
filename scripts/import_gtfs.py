"""Command-line entry point for importing a Bengaluru GTFS feed."""

from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from transit.gtfs import import_gtfs  # noqa: E402


def main() -> None:
    if len(sys.argv) != 2:
        raise SystemExit("Usage: python scripts/import_gtfs.py data/bmtc_gtfs.zip")
    result = import_gtfs(sys.argv[1], ROOT / "data" / "bengaluru_transit.db")
    print("Imported Bengaluru GTFS data:")
    for name, count in result.items():
        print(f"- {name}: {count:,}")


if __name__ == "__main__":
    main()
