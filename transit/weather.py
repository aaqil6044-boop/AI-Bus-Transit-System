"""Rain on the way: the hourly forecast for the hours of a journey, from Open-Meteo (free, no key).

Used only to say "rain is forecast while you travel" and to point at the option with the least
walking. A forecast is a forecast: the page names Open-Meteo and the hour, and nothing about the
buses themselves changes because of it.

``WEATHER=off`` turns it off. Answers are cached for 30 minutes per ~10 km square.
"""
from __future__ import annotations

import json
import os
import threading
import time
from datetime import datetime, timedelta, timezone
from urllib.parse import urlencode
from urllib.request import Request, urlopen

IST = timezone(timedelta(hours=5, minutes=30))
API = os.environ.get("OPEN_METEO_URL", "https://api.open-meteo.com/v1/forecast")   # override only for testing
TIMEOUT = 4
CACHE_SECONDS = 1800
WET_MM = 0.5            # mm in an hour: enough to get wet walking
WET_PROBABILITY = 60    # % chance of rain in the hour
BOUNDS = (12.65, 13.45, 77.20, 78.00)
USER_AGENT = "BengaluruTransitAssistant/1.0 (free local trip planner)"

_lock = threading.Lock()
_cache: dict = {}


def enabled() -> bool:
    return os.environ.get("WEATHER", "on").strip().lower() not in ("off", "0", "false", "no")


def _open_meteo(lat: float, lon: float, timeout: float) -> dict:
    params = urlencode({"latitude": lat, "longitude": lon, "hourly": "precipitation,precipitation_probability",
                        "timezone": "Asia/Kolkata", "forecast_days": 2})
    request = Request(f"{API}?{params}", headers={"User-Agent": USER_AGENT, "Accept": "application/json"})
    with urlopen(request, timeout=timeout) as response:
        return json.load(response)


def hourly(lat: float, lon: float, *, transport=None) -> dict | None:
    """{"YYYY-MM-DDTHH:00": (mm, probability)} for the next two days, or None when unavailable."""
    if not enabled():
        return None
    lat, lon = round(float(lat), 1), round(float(lon), 1)
    if not (BOUNDS[0] <= lat <= BOUNDS[1] and BOUNDS[2] <= lon <= BOUNDS[3]):
        return None
    key = (lat, lon)
    with _lock:
        cached = _cache.get(key)
        if cached and time.monotonic() - cached[0] < CACHE_SECONDS:
            return cached[1]
    try:
        from . import health
        with health.timed("weather"):
            data = (transport or _open_meteo)(lat, lon, TIMEOUT)
        hours = data["hourly"]
        table = {}
        for stamp, mm, chance in zip(hours["time"], hours.get("precipitation") or [], hours.get("precipitation_probability") or []):
            table[str(stamp)[:13] + ":00"] = (float(mm or 0), int(chance or 0))
        if not table:
            raise ValueError("no hourly rows")
    except Exception as error:      # forecast trouble: say nothing about rain rather than guess
        print(f"[Weather] unavailable: {type(error).__name__}: {error}", flush=True)
        with _lock:
            _cache[key] = (time.monotonic() - CACHE_SECONDS + 300, None)     # try again in 5 minutes
        return None
    with _lock:
        if len(_cache) > 50:
            _cache.clear()
        _cache[key] = (time.monotonic(), table)
    return table


def rain_during(lat: float, lon: float, start: datetime, end: datetime, *, transport=None) -> dict | None:
    """Forecast for the hours a journey covers. None when no forecast is available."""
    table = hourly(lat, lon, transport=transport)
    if table is None:
        return None
    start, end = start.astimezone(IST), max(start, end).astimezone(IST)
    moment = start.replace(minute=0, second=0, microsecond=0)
    hours = []
    while moment <= end and len(hours) < 6:
        key = moment.strftime("%Y-%m-%dT%H:00")
        if key in table:
            mm, chance = table[key]
            hours.append({"hour": moment.strftime("%H:00"), "mm": round(mm, 1), "probability": chance})
        moment += timedelta(hours=1)
    if not hours:
        return None
    wettest = max(hours, key=lambda item: (item["mm"], item["probability"]))
    wet = any(item["mm"] >= WET_MM or item["probability"] >= WET_PROBABILITY for item in hours)
    return {"wet": wet, "hours": hours, "max_mm": wettest["mm"], "max_probability": max(item["probability"] for item in hours),
            "wettest_hour": wettest["hour"], "source": "Open-Meteo forecast"}
