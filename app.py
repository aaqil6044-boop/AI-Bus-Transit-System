"""Local demo server for the Adaptive Transit Assistant prototype.

Run with: python app.py
Then open: http://127.0.0.1:8765
"""

from __future__ import annotations

import json
import os
from datetime import datetime, timezone
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from transit import gemini, heading_paths
from transit.assistant import handle_assistant
from transit.planner import search_stops
from transit.otp import plan_journey, router_status, RouterUnavailable
from transit.network import network_summary
from transit.bmtc_live import BMTCUnavailable, live_route

ROOT = Path(__file__).parent
# Bump together with BUILD in static/app.js: the page warns when it talks to an older server.
BUILD = "2026-10-26-dock-2"
ROUTES_FILE = ROOT / "data" / "routes.json"
FEEDBACK_FILE = ROOT / "data" / "feedback.jsonl"
TRANSIT_DATABASE = ROOT / "data" / "bengaluru_transit.db"
MAX_BODY_BYTES = 256 * 1024
DATABASE_HELP = ("The Bengaluru stop database is missing. Run: python scripts/import_gtfs.py data/bmtc_gtfs.zip")
# Only the web app is served. The project folder also holds the database, logs and backups.
PUBLIC_PREFIXES = ("/static/",)


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


class TransitHandler(SimpleHTTPRequestHandler):
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
        # Local builds change frequently. Never serve an older interface from browser cache.
        if urlparse(self.path).path in ("/", "/static/index.html", "/static/app.js", "/static/styles.css"):
            self.send_header("Cache-Control", "no-store, max-age=0")
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
        if request_path == "/":
            self.path = "/static/index.html"
        elif not request_path.startswith(PUBLIC_PREFIXES):
            self.send_error(HTTPStatus.NOT_FOUND, "Not found")
            return
        super().do_GET()

    def do_HEAD(self):
        request_path = urlparse(self.path).path
        if request_path != "/" and not request_path.startswith(PUBLIC_PREFIXES):
            self.send_error(HTTPStatus.NOT_FOUND, "Not found")
            return
        super().do_HEAD()

    def _handle_api_get(self, request_path: str, query: dict) -> bool:
        if request_path == "/api/health":
            self._json_response({
                "ok": True,
                "database": TRANSIT_DATABASE.exists(),
                "router": router_status(),
                "assistant": gemini.status(),
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
                self._json_response(result)
            except BMTCUnavailable as error:
                status = HTTPStatus.SERVICE_UNAVAILABLE if error.status in (401, 403) else HTTPStatus.BAD_GATEWAY
                self._json_response({"available": False, "error": str(error)}, status=status)
            except ValueError as error:
                self._json_response({"available": False, "error": str(error)}, status=HTTPStatus.BAD_REQUEST)
            return True
        if request_path == "/api/routes":
            self._json_response(load_routes())
            return True
        if request_path == "/api/stops":
            if not TRANSIT_DATABASE.exists():
                self._json_response({"stops": [], "error": DATABASE_HELP}, status=HTTPStatus.SERVICE_UNAVAILABLE)
                return True
            self._json_response({"stops": search_stops(TRANSIT_DATABASE, query.get("q", [""])[0])})
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
            try:
                result = plan_journey(
                    TRANSIT_DATABASE,
                    payload.get("origin_stop_id", ""),
                    payload.get("destination_stop_id", ""),
                    profile if isinstance(profile, dict) else {},
                    payload.get("origin_point"),
                    payload.get("destination_point"),
                )
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

    def _read_json(self) -> dict | None:
        try:
            length = int(self.headers.get("Content-Length", 0))
        except ValueError:
            length = -1
        if length < 0 or length > MAX_BODY_BYTES:
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
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)


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
