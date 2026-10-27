"""Finding a place the traveller typed when it is not written exactly like a BMTC stop name.

Two free fallbacks, used only after the normal stop search finds nothing:

1. close spelling: "whitefeild" -> "White Field ..." (compared with every BMTC stop name; only very
   close matches are accepted, so an unrelated stop is never picked);
2. neighbourhoods, landmarks and offices that have no stop of their own ("Brookefield", "Manyata Tech
   Park"): looked up on OpenStreetMap (Nominatim, free, no key) inside Bengaluru only. The result is
   used as a map point, so the planner walks the traveller to the right stops itself. Nothing is
   invented: if OpenStreetMap does not know the place, the assistant says so.

Look-ups are cached (memory + a small file) and rate-limited to one per second, as Nominatim asks.
Set GEOCODER=off to disable the online look-up.
"""
from __future__ import annotations

import difflib
import json
import os
import sqlite3
import threading
import time
from contextlib import closing
from pathlib import Path
from urllib.parse import urlencode
from urllib.request import Request, urlopen

from .planner import normalize_stop_text

NOMINATIM = os.environ.get("GEOCODER_URL", "https://nominatim.openstreetmap.org/search")
USER_AGENT = "BengaluruTransitAssistant/1.0 (free BMTC journey planner; https://github.com/aaqil6044-boop/AI-Bus-Transit-System)"
# Bengaluru metropolitan area (lon/lat): results outside it are ignored.
VIEWBOX = (77.30, 13.25, 77.95, 12.70)
FUZZY_CUTOFF = 0.84
GEOCODE_TIMEOUT = 5.0

_names_cache: dict[str, list[tuple[str, str]]] = {}
_geo_cache: dict[str, dict | None] = {}
_geo_lock = threading.Lock()
_last_call = [0.0]


def _stop_names(database) -> list[tuple[str, str]]:
    key = str(database)
    if key not in _names_cache:
        with closing(sqlite3.connect(key)) as conn:
            names = sorted({row[0] for row in conn.execute("SELECT stop_name FROM stops") if row[0]})
        _names_cache[key] = [(normalize_stop_text(name), name) for name in names]
    return _names_cache[key]


def close_stop_name(database, text: str) -> str | None:
    """The BMTC stop name spelled closest to ``text``, or None when nothing is close enough."""
    wanted = normalize_stop_text(text)
    if len(wanted) < 5:
        return None
    best, best_score = None, 0.0
    matcher = difflib.SequenceMatcher(autojunk=False)
    matcher.set_seq2(wanted)
    for norm, name in _stop_names(database):
        for candidate, weight in ((norm, 1.0), (norm[:len(wanted)], 0.97)):
            if not candidate:
                continue
            matcher.set_seq1(candidate)
            if matcher.real_quick_ratio() * weight < max(FUZZY_CUTOFF, best_score):
                continue
            if matcher.quick_ratio() * weight < max(FUZZY_CUTOFF, best_score):
                continue
            score = matcher.ratio() * weight
            if score > best_score:
                best, best_score = (name if weight == 1.0 else _leading_words(name, len(wanted))), score
    return best if best_score >= FUZZY_CUTOFF else None


def _leading_words(name: str, length: int) -> str:
    """The first words of ``name`` covering about ``length`` letters ("White Field Post Office", 10 -> "White Field")."""
    words, taken = [], 0
    for word in name.split():
        words.append(word)
        taken += len(normalize_stop_text(word))
        if taken >= length - 1:
            break
    return " ".join(words)


def _cache_file() -> Path | None:
    folder = os.environ.get("GEOCODE_CACHE_DIR")
    path = Path(folder) if folder else Path(__file__).resolve().parent.parent / "data"
    return path / "geocode_cache.json" if path.is_dir() else None


def _load_disk_cache():
    if _geo_cache.get("__loaded__") is not None:
        return
    _geo_cache["__loaded__"] = {}
    path = _cache_file()
    try:
        if path and path.exists():
            stored = json.loads(path.read_text(encoding="utf-8"))
            if isinstance(stored, dict):
                for key, value in stored.items():
                    _geo_cache.setdefault(key, value)
    except (OSError, ValueError):
        pass


def _save_disk_cache():
    path = _cache_file()
    if not path:
        return
    data = {key: value for key, value in _geo_cache.items() if key != "__loaded__" and value is not None}
    try:
        tmp = path.with_suffix(".tmp")
        tmp.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
        os.replace(tmp, path)
    except OSError:
        pass


def _nominatim(query: str, timeout: float):
    params = urlencode({"q": f"{query}, Bengaluru", "format": "jsonv2", "limit": 3, "countrycodes": "in",
                        "viewbox": ",".join(str(v) for v in VIEWBOX), "bounded": 1, "accept-language": "en"})
    request = Request(f"{NOMINATIM}?{params}", headers={"User-Agent": USER_AGENT, "Accept": "application/json"})
    with urlopen(request, timeout=timeout) as response:
        return json.load(response)


def geocode(query: str, *, transport=None) -> dict | None:
    """{"name", "lat", "lon", "source"} for a Bengaluru place, or None. Never raises."""
    text = " ".join(str(query or "").split())
    if len(text) < 3 or os.environ.get("GEOCODER", "").lower() in ("off", "0", "false", "no"):
        return None
    key = text.casefold()
    with _geo_lock:
        _load_disk_cache()
        if key in _geo_cache:
            return _geo_cache[key]
        wait = 1.0 - (time.monotonic() - _last_call[0])
        if wait > 0 and transport is None:
            time.sleep(wait)
        _last_call[0] = time.monotonic()
    try:
        results = (transport or _nominatim)(text, GEOCODE_TIMEOUT)
    except Exception as error:   # network trouble: answer "not found" now, try again next time
        print(f"[Places] look-up failed for {text!r}: {type(error).__name__}: {error}", flush=True)
        return None
    found = None
    for item in results if isinstance(results, list) else []:
        try:
            lat, lon = float(item["lat"]), float(item["lon"])
        except (KeyError, TypeError, ValueError):
            continue
        if not (VIEWBOX[3] <= lat <= VIEWBOX[1] and VIEWBOX[0] <= lon <= VIEWBOX[2]):
            continue
        label = str(item.get("name") or "").strip() or str(item.get("display_name") or text).split(",")[0].strip()
        found = {"name": label or text, "lat": round(lat, 6), "lon": round(lon, 6), "source": "OpenStreetMap"}
        break
    with _geo_lock:
        _geo_cache[key] = found
        if found:
            _save_disk_cache()
    return found


def nearest_stop(database, lat: float, lon: float, within_m: float = 1500):
    """(stop dict, metres) of the closest BMTC stop, or (None, None)."""
    import math
    span = within_m / 111000
    with closing(sqlite3.connect(str(database))) as conn:
        rows = conn.execute(
            "SELECT stop_id, stop_name, stop_lat, stop_lon FROM stops WHERE stop_lat BETWEEN ? AND ? "
            "AND stop_lon BETWEEN ? AND ?", (lat - span, lat + span, lon - span * 1.03, lon + span * 1.03)).fetchall()
    best = None
    for stop_id, name, s_lat, s_lon in rows:
        x = math.radians(s_lon - lon) * math.cos(math.radians((s_lat + lat) / 2))
        d = 6371000 * math.hypot(x, math.radians(s_lat - lat))
        if d <= within_m and (best is None or d < best[1]):
            best = ({"stop_id": str(stop_id), "stop_name": name, "stop_lat": float(s_lat), "stop_lon": float(s_lon)}, d)
    return best if best else (None, None)
