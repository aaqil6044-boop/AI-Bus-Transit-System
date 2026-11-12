"""Local demo server for the Adaptive Transit Assistant prototype.

Run with: python app.py
Then open: http://127.0.0.1:8765
"""

from __future__ import annotations

import gzip
import json
import secrets
import sqlite3
import threading
import time
import os
from datetime import datetime, timedelta, timezone
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from transit import collector, gemini, health, heading_paths, kannada, reliability
from transit.assistant import handle_assistant, handle_snap
from transit.planner import search_stops
from transit.otp import plan_journey, router_status, RouterUnavailable
from transit.network import network_summary
from transit.bmtc_live import BMTCUnavailable, live_route

ROOT = Path(__file__).parent
# Bump together with BUILD in static/app.js: the page warns when it talks to an older server.
BUILD = "2026-11-13-next-service-1"
ROUTES_FILE = ROOT / "data" / "routes.json"
FEEDBACK_FILE = ROOT / "data" / "feedback.jsonl"
TRANSIT_DATABASE = ROOT / "data" / "bengaluru_transit.db"
MAX_BODY_BYTES = 256 * 1024
MAX_PHOTO_BODY_BYTES = 6 * 1024 * 1024   # Snap & go: one photo (base64) plus context
DATABASE_HELP = ("The Bengaluru stop database is missing. Run: python scripts/import_gtfs.py data/bmtc_gtfs.zip")
# Only the web app is served. The project folder also holds the database, logs and backups.
PUBLIC_PREFIXES = ("/static/",)
ROOT_FILES = {"/sw.js": "/static/sw.js", "/manifest.webmanifest": "/static/manifest.webmanifest"}


def load_routes() -> dict:
    with ROUTES_FILE.open(encoding="utf-8") as route_file:
        return json.load(route_file)


def preference_weight(preference: str, route: dict) -> float:
    """Return an added penalty for a route that does not match the preference."""
    if preference == "less_walking":
        return route["walking_minutes"] * 2.0
    if preference == "fewer_transfers":
        return route["transfers"] * 12.0
    if preference == "more_reliable":
        return (100 - route["reliability"]) * 1.2
    return route["total_minutes"] * 0.25


def evaluate_route(route: dict, profile: dict) -> dict:
    """Explainable baseline that will later be replaced by a trained ML model.

    The score deliberately keeps safety and accessibility factors visible, so the
    result can be understood and audited during the project demonstration.
    """
    familiarity = int(profile.get("familiarity", 3))
    mobility = profile.get("mobility", "standard")
    preference = profile.get("preference", "fastest")

    difficulty = (
        route["walking_minutes"] * 1.7
        + route["transfers"] * 14
        + route["delay_risk"] * 0.35
        + (100 - route["reliability"]) * 0.45
        + max(0, 4 - familiarity) * route["transfers"] * 4
    )
    if mobility == "limited_mobility":
        difficulty += route["walking_minutes"] * 1.2 + route["transfers"] * 8
    elif mobility == "elderly_assistance":
        difficulty += route["walking_minutes"] * 1.5 + route["transfers"] * 10

    score = round(min(100, difficulty))
    if score < 32:
        level = "Easy"
    elif score < 58:
        level = "Moderate"
    else:
        level = "Difficult"

    reasons = []
    if route["transfers"] == 0:
        reasons.append("No bus transfer is required")
    elif route["transfers"] == 1:
        reasons.append("Only one transfer is required")
    else:
        reasons.append(f"This route requires {route['transfers']} transfers")
    reasons.append(f"Walking time is about {route['walking_minutes']} minutes")
    if route["reliability"] >= 85:
        reasons.append("The route has high scheduled reliability")
    elif route["delay_risk"] >= 45:
        reasons.append("The route has a higher expected delay risk")

    result = dict(route)
    result.update(
        difficulty_score=score,
        difficulty_level=level,
        success_probability=max(5, min(95, round(100 - score * 0.8))),
        preference_penalty=round(preference_weight(preference, route), 1),
        reasons=reasons,
    )
    return result


STATIC_ROOT = (ROOT / "static").resolve()
COMPRESSIBLE = {".js", ".css", ".html", ".json", ".webmanifest", ".svg", ".txt", ".md"}
_gzip_cache: dict = {}
_answer_cache: dict = {}
_answer_lock = threading.Lock()


def gzipped_file(path: Path) -> bytes:
    """A text file's gzip bytes, kept in memory until the file changes."""
    stat = path.stat()
    key = str(path)
    cached = _gzip_cache.get(key)
    if cached and cached[0] == (stat.st_mtime_ns, stat.st_size):
        return cached[1]
    data = gzip.compress(path.read_bytes(), compresslevel=6, mtime=0)
    if len(_gzip_cache) > 64:
        _gzip_cache.clear()
    _gzip_cache[key] = ((stat.st_mtime_ns, stat.st_size), data)
    return data


def remembered(key: str, seconds: float, compute):
    """compute() once per key for a short time (repeat searches and plans answer instantly).
    Errors are never remembered."""
    now = time.monotonic()
    with _answer_lock:
        hit = _answer_cache.get(key)
        if hit and now - hit[0] < seconds:
            return hit[1]
    value = compute()
    with _answer_lock:
        if len(_answer_cache) > 500:
            for old in sorted(_answer_cache, key=lambda k: _answer_cache[k][0])[:250]:
                _answer_cache.pop(old, None)
        _answer_cache[key] = (now, value)
    return value


def stop_suggestions(text):
    """Stop search for the From/To boxes. Kannada input is matched against BMTC's own Kannada stop names,
    and each suggestion carries its Kannada name when BMTC publishes one."""
    query = text
    if kannada.has_kannada(text):
        query = kannada.find_stop_name(TRANSIT_DATABASE, text) or text
    rows = search_stops(TRANSIT_DATABASE, query)
    try:
        names = kannada.kannada_names(TRANSIT_DATABASE)
    except Exception:
        names = {}
    if names:
        rows = [{**row, "name_kn": names[row["stop_name"]]} if row.get("stop_name") in names else row for row in rows]
    return rows


def warm_up():
    """Load the stop index, the spelling list and the route engine before the first traveller does."""
    started = time.monotonic()
    try:
        if TRANSIT_DATABASE.exists():
            from transit import fares
            fares.ensure_tables(TRANSIT_DATABASE, ROOT / "data" / "bmtc_gtfs.zip")
            try:
                kannada.ensure_table(TRANSIT_DATABASE, ROOT / "data" / "bmtc_gtfs.zip")
                kannada.kannada_names(TRANSIT_DATABASE)
            except Exception as error:   # Kannada names are optional
                print(f"Kannada stop names unavailable: {error}", flush=True)
            search_stops(TRANSIT_DATABASE, "majestic")
            from transit import places
            places.close_stop_name(TRANSIT_DATABASE, "whitefeild")
        for _attempt in range(40):                 # the route engine may still be loading
            if router_status():
                break
            time.sleep(15)
        if TRANSIT_DATABASE.exists() and router_status():
            with sqlite3.connect(str(TRANSIT_DATABASE)) as conn:
                ids = [row[0] for row in conn.execute(
                    "SELECT stop_id FROM stops WHERE stop_name IN ('Kempegowda Bus Station', 'Shivajinagara Bus Station') LIMIT 2")]
            if len(ids) == 2:
                plan_journey(TRANSIT_DATABASE, ids[0], ids[1], {})
        print(f"Warm-up finished in {time.monotonic() - started:.1f} s", flush=True)
    except Exception as error:  # warm-up is a nicety; it must never stop the app
        print(f"Warm-up skipped: {type(error).__name__}: {error}", flush=True)


class TransitHandler(SimpleHTTPRequestHandler):
    extensions_map = {**SimpleHTTPRequestHandler.extensions_map, ".webmanifest": "application/manifest+json",
                      ".js": "text/javascript"}
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def translate_path(self, path):
        """Serve files from static/ only. The URL prefix check alone is not enough: encoded "..",
        e.g. /static/%2e%2e/.env, would otherwise reach the project folder (data, .env key file)."""
        resolved = Path(super().translate_path(path)).resolve()
        if resolved != STATIC_ROOT and STATIC_ROOT not in resolved.parents:
            return str(STATIC_ROOT / "__not_found__")
        return str(resolved)

    def list_directory(self, path):
        # No folder listings (they would expose backup file names).
        self.send_error(HTTPStatus.NOT_FOUND, "Not found")
        return None

    def end_headers(self):
        parsed = urlparse(self.path)
        if parsed.path.startswith("/static/") and "v=" in parsed.query:
            # Versioned files (app.js?v=...) never change under the same address: browsers may keep them.
            self.send_header("Cache-Control", "public, max-age=31536000, immutable")
        elif parsed.path in ("/", "/static/index.html", "/static/app.js", "/static/styles.css", "/static/sw.js",
                             "/static/i18n.js"):
            # The page itself (and unversioned copies) always comes fresh, so a new version shows at once.
            self.send_header("Cache-Control", "no-store, max-age=0")
        elif parsed.path.startswith(("/static/icons/", "/static/vendor/")):
            self.send_header("Cache-Control", "public, max-age=604800")
        super().end_headers()

    def send_error(self, code, message=None, explain=None):
        """API paths always receive JSON, never an HTML error page."""
        if urlparse(self.path).path.startswith("/api/"):
            self._json_response({"error": message or HTTPStatus(code).phrase, "message": message or HTTPStatus(code).phrase},
                                status=HTTPStatus(code))
            return
        super().send_error(code, message, explain)

    def do_GET(self):
        parsed = urlparse(self.path)
        request_path = parsed.path
        try:
            if request_path.startswith("/api/") and self._handle_api_get(request_path, parse_qs(parsed.query)):
                return
        except Exception as error:  # last resort: the page must always get JSON
            self._json_response({"error": f"Unexpected server error: {error}"}, status=HTTPStatus.INTERNAL_SERVER_ERROR)
            return
        if request_path.startswith("/api/"):
            self.send_error(HTTPStatus.NOT_FOUND, "Endpoint not found")
            return
        if request_path == "/status":
            self._status_page(parse_qs(parsed.query))
            return
        if request_path == "/":
            self.path = "/static/index.html"
        elif request_path in ROOT_FILES:
            # The installable-app files must live at the site root to cover the whole page.
            self.path = ROOT_FILES[request_path]
        elif not request_path.startswith(PUBLIC_PREFIXES):
            self.send_error(HTTPStatus.NOT_FOUND, "Not found")
            return
        if self._send_compressed():
            return
        super().do_GET()

    def _send_compressed(self) -> bool:
        """Text files go out gzip-compressed when the browser accepts it (about 4x smaller)."""
        if "gzip" not in self.headers.get("Accept-Encoding", ""):
            return False
        path = Path(self.translate_path(self.path))
        if path.suffix.lower() not in COMPRESSIBLE or not path.is_file():
            return False
        try:
            body = gzipped_file(path)
        except OSError:
            return False
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", self.guess_type(str(path)))
        self.send_header("Content-Encoding", "gzip")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Vary", "Accept-Encoding")
        self.end_headers()
        self.wfile.write(body)
        return True

    def do_HEAD(self):
        request_path = urlparse(self.path).path
        if request_path in ROOT_FILES:
            self.path = ROOT_FILES[request_path]
        elif request_path != "/" and not request_path.startswith(PUBLIC_PREFIXES):
            self.send_error(HTTPStatus.NOT_FOUND, "Not found")
            return
        super().do_HEAD()

    def _status_page(self, query: dict):
        """Admin status page. Allowed from this computer, or with ?token= matching STATUS_TOKEN."""
        token = os.environ.get("STATUS_TOKEN", "").strip()
        # Behind nginx every request comes from 127.0.0.1, so a forwarded request is never "local".
        forwarded = any(self.headers.get(name) for name in ("X-Forwarded-For", "X-Real-IP", "Forwarded"))
        local = self.client_address[0] in ("127.0.0.1", "::1") and not forwarded
        if not local and not (token and secrets.compare_digest(str(query.get("token", [""])[0]), token)):
            self.send_error(HTTPStatus.NOT_FOUND, "Not found")
            return
        body = status_page_html().encode("utf-8")
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Robots-Tag", "noindex")
        self.end_headers()
        self.wfile.write(body)

    def _handle_api_get(self, request_path: str, query: dict) -> bool:
        if request_path == "/api/health":
            self._json_response({
                "ok": True,
                "database": TRANSIT_DATABASE.exists(),
                "router": router_status(),
                "assistant": gemini.status(),
                "services": {name: health.status(name) for name in health.SERVICES},
                "collector": {key: value for key, value in collector.status().items() if key != "last_error"},
                "build": BUILD,
                "checked_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            })
            return True
        if request_path == "/api/network":
            if not TRANSIT_DATABASE.exists():
                self._json_response({"error": DATABASE_HELP}, status=HTTPStatus.SERVICE_UNAVAILABLE)
                return True
            self._json_response(network_summary(TRANSIT_DATABASE))
            return True
        if request_path == "/api/bmtc/route":
            route_number = query.get("q", [""])[0]
            try:
                number = lambda name: float(query[name][0]) if query.get(name) and query[name][0] != "" else None
                result = live_route(
                    route_number, number("stop_lat"), number("stop_lon"),
                    force_refresh=query.get("refresh", [""])[0] == "1",
                    alight_lat=number("alight_lat"), alight_lon=number("alight_lon"))
                # Lay each bus's "heading" line along the route's own roads from the timetable.
                if TRANSIT_DATABASE.exists():
                    heading_paths.attach(TRANSIT_DATABASE, result)
                if isinstance(result, dict):
                    result = {**result, "reliability": reliability.summary(route_number)}
                self._json_response(result)
            except BMTCUnavailable as error:
                status = HTTPStatus.SERVICE_UNAVAILABLE if error.status in (401, 403) else HTTPStatus.BAD_GATEWAY
                self._json_response({"available": False, "error": str(error)}, status=status)
            except ValueError as error:
                self._json_response({"available": False, "error": str(error)}, status=HTTPStatus.BAD_REQUEST)
            return True
        if request_path == "/api/reliability":
            route_number = str(query.get("route", [""])[0]).strip()[:30]
            if not route_number:
                self._json_response({"error": "Choose a route number."}, status=HTTPStatus.BAD_REQUEST)
                return True
            self._json_response({"route": reliability.base_route(route_number), "summary": reliability.summary(route_number),
                                 "min_days": reliability.MIN_DAYS, "min_samples": reliability.MIN_SAMPLES})
            return True
        if request_path == "/api/routes":
            self._json_response(load_routes())
            return True
        if request_path == "/api/nearby":
            from transit.nearby import nearby
            try:
                lat, lon = float(query.get("lat", [""])[0]), float(query.get("lon", [""])[0])
                radius = int(float(query.get("radius", ["600"])[0]))
            except (TypeError, ValueError):
                self._json_response({"error": "Send lat and lon."}, status=HTTPStatus.BAD_REQUEST)
                return True
            if not TRANSIT_DATABASE.exists():
                self._json_response({"stops": [], "error": DATABASE_HELP}, status=HTTPStatus.SERVICE_UNAVAILABLE)
                return True
            try:
                # Rounded to ~10 m: the same spot asked again within a minute is answered from memory.
                key = f"nearby|{round(lat, 4)}|{round(lon, 4)}|{radius}|{datetime.now().strftime('%H%M')}"
                self._json_response(remembered(key, 60, lambda: nearby(TRANSIT_DATABASE, lat, lon, radius_m=radius)))
            except ValueError as error:
                self._json_response({"error": str(error)}, status=HTTPStatus.BAD_REQUEST)
            return True
        if request_path == "/api/weather":
            from transit import weather
            try:
                lat, lon = float(query.get("lat", [""])[0]), float(query.get("lon", [""])[0])
                start = datetime.fromisoformat(str(query.get("from", [""])[0]))
                end = datetime.fromisoformat(str(query.get("to", [""])[0]))
                if start.tzinfo is None or end.tzinfo is None or end < start or end - start > timedelta(hours=6):
                    raise ValueError
            except (TypeError, ValueError):
                self._json_response({"error": "Send lat, lon, and from/to times with a time zone (at most 6 hours apart)."},
                                    status=HTTPStatus.BAD_REQUEST)
                return True
            self._json_response({"rain": weather.rain_during(lat, lon, start, end), "enabled": weather.enabled()})
            return True
        if request_path == "/api/stops":
            if not TRANSIT_DATABASE.exists():
                self._json_response({"stops": [], "error": DATABASE_HELP}, status=HTTPStatus.SERVICE_UNAVAILABLE)
                return True
            text = str(query.get("q", [""])[0])[:80]
            self._json_response({"stops": remembered(f"stops|{text.strip().lower()}", 600,
                                                     lambda: stop_suggestions(text))})
            return True
        return False

    def do_POST(self):
        path = urlparse(self.path).path
        try:
            self._handle_post(path)
        except Exception as error:
            self._json_response({"error": f"Unexpected server error: {error}"}, status=HTTPStatus.INTERNAL_SERVER_ERROR)

    def _handle_post(self, path: str):
        if path == "/api/recommend":
            payload = self._read_json()
            if payload is None:
                return
            routes = [
                evaluate_route(route, payload.get("profile", {}))
                for route in load_routes()["routes"]
                if route["origin"] == payload.get("origin")
                and route["destination"] == payload.get("destination")
            ]
            routes.sort(key=lambda route: route["difficulty_score"] + route["preference_penalty"])
            self._json_response({"routes": routes, "model_status": "explainable baseline"})
            return

        if path == "/api/plan":
            payload = self._read_json()
            if payload is None:
                return
            if not TRANSIT_DATABASE.exists():
                self._json_response({"error": DATABASE_HELP}, status=HTTPStatus.SERVICE_UNAVAILABLE)
                return
            profile = payload.get("profile")
            plan_args = (payload.get("origin_stop_id", ""), payload.get("destination_stop_id", ""),
                         profile if isinstance(profile, dict) else {}, payload.get("origin_point"),
                         payload.get("destination_point"))
            try:
                # The same journey asked again within 45 s (back button, preference toggled back, a shared
                # link opened twice) is answered from memory; timetable answers change minute by minute.
                key = "plan|" + json.dumps(plan_args, sort_keys=True, default=str)
                result = remembered(key, 45, lambda: plan_journey(TRANSIT_DATABASE, *plan_args))
            except RouterUnavailable as error:
                self._json_response({"error": str(error), "router_unavailable": True},
                                    status=HTTPStatus.SERVICE_UNAVAILABLE)
                return
            except ValueError as error:
                self._json_response({"error": str(error)}, status=HTTPStatus.BAD_REQUEST)
                return
            self._json_response(result)
            return

        if path == "/api/assistant":
            payload = self._read_json()
            if payload is None:
                return
            if not TRANSIT_DATABASE.exists():
                self._json_response({"ok": False, "error": DATABASE_HELP, "reply": DATABASE_HELP},
                                    status=HTTPStatus.SERVICE_UNAVAILABLE)
                return
            try:
                self._json_response(handle_assistant(TRANSIT_DATABASE, payload))
            except ValueError as error:
                self._json_response({"ok": False, "error": str(error), "reply": str(error)},
                                    status=HTTPStatus.BAD_REQUEST)
            return

        if path == "/api/snap":
            # Snap & go: Gemini reads the photo; places and journeys come from the normal planner.
            payload = self._read_json(MAX_PHOTO_BODY_BYTES)
            if payload is None:
                return
            if not TRANSIT_DATABASE.exists():
                self._json_response({"error": DATABASE_HELP}, status=HTTPStatus.SERVICE_UNAVAILABLE)
                return
            self._json_response(handle_snap(TRANSIT_DATABASE, payload))
            return
        if path == "/api/explain":
            # A short Gemini comparison of the options on screen, checked against those options.
            payload = self._read_json()
            if payload is None:
                return
            routes = payload.get("routes")
            if not isinstance(routes, list) or not routes:
                self._json_response({"ok": False, "error": "No journey options to explain."}, status=HTTPStatus.BAD_REQUEST)
                return
            try:
                text = gemini.explain(routes[:5], preference=payload.get("preference"))
            except gemini.GeminiUnavailable as error:
                self._json_response({"ok": False, "reason": error.reason})
                return
            self._json_response({"ok": True, "text": text, "engine": "gemini"})
            return

        if path == "/api/feedback":
            payload = self._read_json()
            if payload is None:
                return
            payload["recorded_at"] = datetime.now(timezone.utc).isoformat()
            FEEDBACK_FILE.parent.mkdir(parents=True, exist_ok=True)
            with FEEDBACK_FILE.open("a", encoding="utf-8") as feedback_file:
                feedback_file.write(json.dumps(payload) + "\n")
            self._json_response({"message": "Thank you. Your feedback has been recorded."}, HTTPStatus.CREATED)
            return

        self.send_error(HTTPStatus.NOT_FOUND, "Endpoint not found")

    def _read_json(self, limit: int = MAX_BODY_BYTES) -> dict | None:
        try:
            length = int(self.headers.get("Content-Length", 0))
        except ValueError:
            length = -1
        if length < 0 or length > limit:
            self._json_response({"error": "Request is empty or too large."}, status=HTTPStatus.BAD_REQUEST)
            return None
        try:
            payload = json.loads(self.rfile.read(length).decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            self._json_response({"error": "Please send valid JSON."}, status=HTTPStatus.BAD_REQUEST)
            return None
        if not isinstance(payload, dict):
            self._json_response({"error": "Please send a JSON object."}, status=HTTPStatus.BAD_REQUEST)
            return None
        return payload

    def _json_response(self, payload: dict, status: HTTPStatus = HTTPStatus.OK):
        body = json.dumps(payload).encode("utf-8")
        compressed = len(body) > 1400 and "gzip" in (self.headers.get("Accept-Encoding", "") if self.headers else "")
        if compressed:
            body = gzip.compress(body, compresslevel=5, mtime=0)
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        if compressed:
            self.send_header("Content-Encoding", "gzip")
            self.send_header("Vary", "Accept-Encoding")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)


def status_page_html() -> str:
    """Plain HTML: services, timings, recent errors, data sizes. No keys, no traveller data."""
    import html as h
    snap = health.snapshot()
    ai = gemini.status()
    rows = []
    for name, info in snap["services"].items():
        when = lambda t: "—" if not t else datetime.fromtimestamp(t, timezone.utc).astimezone().strftime("%d %b %H:%M:%S")
        rows.append(f"<tr class='{info['status']}'><td>{h.escape(name)}</td><td><b>{h.escape(info['status'])}</b></td>"
                    f"<td>{info['ok']} / {info['failed']}</td><td>{info['median_seconds'] if info['median_seconds'] is not None else '—'} s"
                    f" (max {info['slowest_seconds'] if info['slowest_seconds'] is not None else '—'} s)</td>"
                    f"<td>{when(info['last_ok'])}</td><td>{when(info['last_error'])}<br><small>{h.escape(info['last_error_text'])}</small></td></tr>")
    errors = "".join(f"<li>{datetime.fromtimestamp(e['at'], timezone.utc).astimezone().strftime('%d %b %H:%M:%S')} · "
                     f"<b>{h.escape(e['service'])}</b> · {h.escape(e['error'])}</li>" for e in snap["recent_errors"]) or "<li>None</li>"
    try:
        import sqlite3 as sq
        path = reliability.database_path()
        with sq.connect(str(path)) as conn:
            count, days, routes = conn.execute("SELECT count(*), count(distinct day), count(distinct base) FROM observations").fetchone()
        learned = f"{count} measurements · {routes} routes · {days} days"
    except Exception:
        learned = "no measurements yet"
    gather = collector.status()
    learned += (f" · background collector: {'on' if gather['running'] else 'off'}, {gather['checks']} checks"
                f" ({gather['failed']} failed) over {gather['routes']} busy routes"
                + (f", last {gather['last_route']} at {gather['last_at']}" if gather["last_route"] else "")
                + (f", paused: {gather['paused']}" if gather["paused"] else "")
                + (f", last error: {gather['last_error']}" if gather["last_error"] else ""))
    uptime = snap["uptime_seconds"]
    return f"""<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Status · Bengaluru Transit</title><meta http-equiv="refresh" content="30">
<style>body{{font:15px system-ui,sans-serif;background:#0b1622;color:#e8f4ff;margin:0;padding:20px}}h1{{margin:0 0 4px}}
table{{border-collapse:collapse;width:100%;margin:14px 0}}td,th{{border-bottom:1px solid #2a3d4f;padding:8px;text-align:left;vertical-align:top}}
tr.ok b{{color:#62e6a8}}tr.down b{{color:#ff8a98}}tr.unknown b{{color:#9fb3c4}}small{{color:#9fb3c4}}.card{{background:#14212e;border-radius:12px;padding:14px;margin:12px 0}}
li{{margin:4px 0}}</style>
<h1>Bengaluru Transit · status</h1><p>Build {h.escape(BUILD)} · running {uptime // 3600} h {uptime % 3600 // 60} min · refreshes every 30 s</p>
<div class="card"><b>Stop database:</b> {"present" if TRANSIT_DATABASE.exists() else "MISSING"} ·
<b>Route engine:</b> {"running" if router_status() else "NOT RUNNING"} · <b>Chat:</b> {h.escape(ai.get("engine", ""))} ({h.escape(str(ai.get("model", "")))}) ·
<b>Learned delays:</b> {h.escape(learned)}</div>
<table><tr><th>Service</th><th>Now</th><th>Worked / failed</th><th>Typical time</th><th>Last worked</th><th>Last failed</th></tr>{"".join(rows)}</table>
<div class="card"><b>Recent errors</b><ol>{errors}</ol></div>
<p><small>Counts reset when the app restarts. Nothing about travellers is recorded here.</small></p></html>"""


def main():
    # A local .env file (never shared) can hold GEMINI_API_KEY; real environment variables win.
    gemini.load_dotenv(ROOT / ".env")
    host = os.getenv("APP_HOST", "127.0.0.1").strip() or "127.0.0.1"
    try:
        port = int(os.getenv("PORT", "8765"))
    except ValueError:
        raise SystemExit("PORT must be a number between 1 and 65535.") from None
    if not 1 <= port <= 65535:
        raise SystemExit("PORT must be a number between 1 and 65535.")
    try:
        server = ThreadingHTTPServer((host, port), TransitHandler)
    except OSError as error:
        raise SystemExit(f"Cannot listen on {host}:{port} ({error}). Close the other copy of the app, then try again.")
    print(f"Adaptive Transit Assistant running at http://{host}:{port}")
    threading.Thread(target=warm_up, daemon=True).start()
    if TRANSIT_DATABASE.exists() and collector.start(TRANSIT_DATABASE):
        print("Delay collector: on (set COLLECTOR=off in .env to stop it)")
    ai = gemini.status()
    print(f"Chat assistant: Gemini ({ai['model']})" if ai["engine"] == "gemini"
          else "Chat assistant: built-in helper (set GEMINI_API_KEY in .env to use Gemini)")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nServer stopped")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
