"""Optional Google Gemini layer for the chat assistant.

What Gemini does here, and only this:
  * reads the traveller's free-form message (typos, landmarks, mixed languages, follow-ups such as
    "same but at 9 pm") and turns it into ONE structured action through function calling:
    plan a journey (places, preference, departure time), swap the trip, or reply in words;
  * answers general questions in a short sentence or two when no journey is asked for.

What Gemini never does:
  * it never supplies a route, bus number, timetable time or live bus position. Places it returns are
    looked up in the imported BMTC stop list, and journeys come from the same OpenTripPlanner router as
    the Find routes button. Live buses come only from the BMTC feed.

It is switched on only when ``GEMINI_API_KEY`` is set (environment variable or the project's .env
file). Without a key, or when Gemini is slow, rate-limited or rejects the request, the built-in
rule-based helper answers instead, so the app keeps working for free and offline.

Privacy: only the typed message, the names of the stops already chosen and up to six recent chat lines
are sent. GPS coordinates are never sent. On Google's free tier, Google may use this text to improve
its products.
"""
from __future__ import annotations

import http.client
import json
import os
import re
import socket
import ssl
import time
from datetime import datetime, timedelta, timezone
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import Request, getproxies, urlopen

API_ROOT = os.environ.get("GEMINI_API_ROOT", "https://generativelanguage.googleapis.com/v1beta").rstrip("/")
DEFAULT_MODEL = "gemini-3.1-flash-lite"   # free tier, fast, supports function calling
DEFAULT_FALLBACK_MODELS = ("gemini-3.5-flash-lite",)
CONNECT_SECONDS = 6          # opening the connection to Google
TOTAL_SECONDS = 24           # all attempts together; then the built-in helper answers at once


def _timeout_setting() -> float:
    """How long to wait for Gemini's answer (GEMINI_TIMEOUT, 3-60 s, default 15)."""
    try:
        value = float(os.environ.get("GEMINI_TIMEOUT", "") or 15)
    except ValueError:
        value = 15.0
    return min(60.0, max(3.0, value))


TIMEOUT_SECONDS = _timeout_setting()
TRANSIENT_STATUSES = (408, 429, 500, 502, 503, 504)
IST = timezone(timedelta(hours=5, minutes=30))
PREFERENCES = ("fastest", "less_walking", "fewer_transfers")

SYSTEM_PROMPT = """You are the request reader for a free Bengaluru (BMTC) bus journey planner.
Every message must become exactly ONE function call:
- plan_journey: the traveller wants to go somewhere, or changes a journey detail (place, time, preference).
  Use the place words the traveller gave, with spelling fixed (e.g. "majestic" -> "Majestic",
  "whitefeild" -> "Whitefield"). For a well-known landmark, mall, office park, college or hospital, give
  the name of the BMTC bus stop that serves it if you are confident (e.g. "Phoenix mall Whitefield" ->
  "Phoenix Market City"); otherwise give the landmark name as written. Never invent a place.
  Leave origin or destination empty when the traveller did not mention it (the app keeps the stop that
  is already selected). If the start is the traveller's current position ("from here", "my location",
  "where I am", "near me"), set from_my_location to true and leave origin empty.
  depart_at is 24-hour HH:MM in Bengaluru time, only if the traveller asked for a time; resolve phrases
  like "in 30 minutes" or "tonight at 9" using the current time given below. Otherwise leave it empty.
  preference: "less_walking", "fewer_transfers" or "fastest" only if asked for; otherwise empty.
- swap_trip: the traveller wants the reverse / return journey of the currently selected trip.
- check_live_buses: the traveller asks where a bus is right now, whether it is coming, how far away it is,
  or to track it ("where is my bus", "when will 500D come", "is KBS-1K near"). Put the bus number in
  route only if the traveller said one; otherwise leave it empty (the app uses the selected journey).
- reply: anything else (greetings, thanks, questions about how to use the app, general questions).
  Answer in one to three short sentences, in the traveller's language. NEVER state bus numbers, routes,
  timings, frequencies, fares or live bus positions in a reply: those come only from the planner and the
  BMTC feed. If the traveller asks which bus to take or when a bus comes, call plan_journey instead (or,
  if places are missing, reply asking for the start and destination).
"""

# Kept deliberately plain (no empty enum values, no parameter-less object schemas, few "required"
# fields): the API rejects some schema shapes outright. The app validates every value itself anyway.
TOOLS = [{"functionDeclarations": [
    {"name": "plan_journey",
     "description": "Plan or update a bus journey in Bengaluru.",
     "parameters": {"type": "object", "properties": {
         "origin": {"type": "string", "description": "Start place or BMTC stop name. Omit to keep the selected start."},
         "destination": {"type": "string", "description": "Destination place or BMTC stop name. Omit to keep the selected one."},
         "preference": {"type": "string", "description": "Only if asked for: fastest, less_walking or fewer_transfers."},
         "depart_at": {"type": "string", "description": "24-hour HH:MM departure time, only if a time was asked for."},
         "from_my_location": {"type": "boolean", "description": "True when the start is the traveller's current position."}}}},
    {"name": "check_live_buses",
     "description": "Show BMTC live bus positions for the selected journey, or for a bus number the traveller named.",
     "parameters": {"type": "object", "properties": {
         "route": {"type": "string", "description": "Bus number exactly as the traveller said it, e.g. 500D. Omit if none."}}}},
    {"name": "swap_trip",
     "description": "Reverse the currently selected start and destination (return trip)."},
    {"name": "reply",
     "description": "Reply in words when no journey needs planning.",
     "parameters": {"type": "object", "properties": {
         "text": {"type": "string", "description": "One to three short sentences."},
         "kind": {"type": "string", "description": "One of: help, question, unclear, smalltalk."}},
         "required": ["text"]}},
]}]


class GeminiUnavailable(Exception):
    """Gemini could not be used for this message; ``reason`` says why (never contains the key)."""

    NOTES = {
        "no_key": "",
        "rate_limited": "Gemini's free quota is used up for the moment, so the built-in helper answered.",
        "bad_key": "Gemini rejected the API key, so the built-in helper answered. Check GEMINI_API_KEY.",
        "bad_model": "The configured Gemini model is not available, so the built-in helper answered. Check GEMINI_MODEL.",
        "timeout": "Gemini did not answer in time, so the built-in helper answered.",
        "network": "Gemini could not be reached, so the built-in helper answered.",
        "blocked": "Gemini declined that message, so the built-in helper answered.",
        "bad_response": "Gemini gave an unusable answer, so the built-in helper answered.",
        "bad_request": "Gemini rejected the request (the reason is printed in the app window), so the built-in helper answered.",
    }

    def __init__(self, reason: str):
        super().__init__(reason)
        self.reason = reason

    @property
    def note(self) -> str:
        return self.NOTES.get(self.reason, "Gemini is unavailable, so the built-in helper answered.")


def settings() -> dict:
    key = os.environ.get("GEMINI_API_KEY", "").strip()
    model = os.environ.get("GEMINI_MODEL", "").strip() or DEFAULT_MODEL
    if not re.fullmatch(r"[A-Za-z0-9.\-_]{1,80}", model):
        model = DEFAULT_MODEL
    return {"enabled": bool(key), "key": key, "model": model}


def status() -> dict:
    """Safe to show in /api/health: says whether Gemini is on, never the key."""
    config = settings()
    return {"engine": "gemini" if config["enabled"] else "built-in",
            "model": config["model"] if config["enabled"] else None}


def _model_candidates(primary: str) -> list[str]:
    configured = os.environ.get("GEMINI_FALLBACK_MODELS", "").strip()
    fallbacks = configured.split(",") if configured else DEFAULT_FALLBACK_MODELS
    models = [primary]
    for value in fallbacks:
        model = str(value).strip()
        if re.fullmatch(r"[A-Za-z0-9.\-_]{1,80}", model) and model not in models:
            models.append(model)
    return models


class ConnectFailed(OSError):
    """No connection to Google could be opened at all (retrying the same host will not help)."""


def _addresses(host: str, port: int):
    """IPv4 addresses first: many cloud VMs (Azure included) have no working IPv6 route."""
    infos = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
    return [i for i in infos if i[0] == socket.AF_INET] + [i for i in infos if i[0] == socket.AF_INET6]


def _connect(host: str, port: int, connect_timeout: float) -> socket.socket:
    try:
        infos = _addresses(host, port)
    except OSError as error:
        raise ConnectFailed(f"could not look up {host} ({error})") from None
    problems = []
    for family, kind, proto, _name, address in infos:
        sock = socket.socket(family, kind, proto)
        sock.settimeout(connect_timeout)
        try:
            sock.connect(address)
            return sock
        except OSError as error:
            sock.close()
            problems.append(f"{address[0]}: {type(error).__name__}")
    raise ConnectFailed(f"could not connect to {host} ({'; '.join(problems) or 'no addresses'})")


def _post(url: str, body: dict, key: str, timeout: float):
    data = json.dumps(body).encode("utf-8")
    headers = {"Content-Type": "application/json", "x-goog-api-key": key}
    parts = urlsplit(url)
    if parts.scheme != "https" or getproxies().get("https"):
        # Plain http (tests) or a configured proxy: the standard library path.
        request = Request(url, data=data, method="POST", headers=headers)
        try:
            with urlopen(request, timeout=timeout) as response:
                return response.status, json.load(response)
        except HTTPError as error:
            try:
                detail = json.load(error)
            except (ValueError, OSError):
                detail = {}
            return error.code, detail
    host, port = parts.hostname, parts.port or 443
    started = time.monotonic()
    raw = _connect(host, port, min(CONNECT_SECONDS, timeout))
    context = ssl.create_default_context()
    raw.settimeout(timeout)
    conn = http.client.HTTPSConnection(host, port, timeout=timeout, context=context)
    try:
        conn.sock = context.wrap_socket(raw, server_hostname=host)
        path = parts.path + ("?" + parts.query if parts.query else "")
        conn.request("POST", path, body=data, headers=headers)
        response = conn.getresponse()
        payload = response.read()
    except socket.timeout:
        raise TimeoutError("timed out") from None
    finally:
        conn.close()
    took = time.monotonic() - started
    if took > 6:
        _log(f"slow answer: {took:.1f} s", key)
    try:
        return response.status, json.loads(payload or b"{}")
    except ValueError:
        if response.status != 200:
            return response.status, {}
        raise


def _is_timeout(error) -> bool:
    return isinstance(error, TimeoutError) or "timed out" in str(error).lower()


def _request_failure(error, config, timeout) -> "GeminiUnavailable":
    if isinstance(error, ConnectFailed):
        _log(f"network: {error}. Check that the server can reach generativelanguage.googleapis.com on port 443.",
             config["key"])
        return GeminiUnavailable("network")
    if _is_timeout(error):
        _log(f"timeout: connected, but no answer within {timeout:.0f} s; set GEMINI_TIMEOUT to wait longer",
             config["key"])
        return GeminiUnavailable("timeout")
    _log(f"network: {type(error).__name__}: {error}", config["key"])
    return GeminiUnavailable("network")


def _generate(body: dict, config: dict, transport, timeout: float):
    """Call Gemini with bounded backoff and a stable-model fallback for transient failures."""
    requester = transport or _post
    models = _model_candidates(config["model"])
    last_status, last_data, last_model, last_error = 503, {}, config["model"], None
    deadline = time.monotonic() + max(timeout, TOTAL_SECONDS)
    for model_index, model in enumerate(models):
        attempts = 2 if model_index == 0 else 1
        url = f"{API_ROOT}/models/{model}:generateContent"
        for attempt in range(attempts):
            left = deadline - time.monotonic()
            if left < 2:
                return last_status, last_data, last_model, last_error
            try:
                status_code, data = requester(url, body, config["key"], min(timeout, left))
                last_status, last_data, last_model, last_error = status_code, data, model, None
            except ConnectFailed as error:
                return 504, {}, model, error          # same host for every model: retrying cannot help
            except (TimeoutError, OSError, URLError) as error:
                last_status, last_data, last_model, last_error = 504, {}, model, error
            except ValueError as error:
                return 200, {}, model, error
            if last_status not in TRANSIENT_STATUSES:
                return last_status, last_data, model, last_error
            if last_error is not None and _is_timeout(last_error) and transport is None:
                break                                  # a model that timed out gets no second wait
            more_attempts = attempt + 1 < attempts or model_index + 1 < len(models)
            if more_attempts:
                next_step = "retrying" if attempt + 1 < attempts else "trying fallback model"
                _log(f"HTTP {last_status} from model {model}; {next_step}", config["key"])
                if transport is None:
                    time.sleep(0.4 * (2 ** attempt))
    return last_status, last_data, last_model, last_error


def _log(message: str, key: str = "") -> None:
    """One diagnostic line in the app window. The key is scrubbed even if an error echoes it."""
    text = str(message)
    if key:
        text = text.replace(key, "***")
    print(f"[Gemini] {text[:400]}", flush=True)


def _error_text(data) -> str:
    error = data.get("error") if isinstance(data, dict) else None
    if isinstance(error, dict):
        return f"{error.get('status', '')} {error.get('message', '')}".strip()
    return ""


def clean_route(value) -> str | None:
    """A bus number as BMTC writes them (500D, KBS-1K, 335-E, V-335E); anything else is dropped."""
    text = re.sub(r"\s+", " ", str(value or "")).strip().upper()
    return text if re.fullmatch(r"[A-Z0-9][A-Z0-9 .-]{0,19}", text) and re.search(r"\d", text) else None


def _clean_text(value, limit: int) -> str:
    text = re.sub(r"\s+", " ", str(value or "")).strip()
    return text[:limit]


def _valid_time(value) -> str | None:
    text = str(value or "").strip()
    match = re.fullmatch(r"([01]?\d|2[0-3]):([0-5]\d)", text)
    return f"{int(match.group(1)):02d}:{match.group(2)}" if match else None


def _history_contents(history) -> list:
    contents = []
    for item in (history or [])[-6:]:
        if not isinstance(item, dict):
            continue
        text = _clean_text(item.get("text"), 300)
        if not text:
            continue
        role = "model" if item.get("role") in ("assistant", "model") else "user"
        if contents and contents[-1]["role"] == role:
            contents[-1]["parts"][0]["text"] += "\n" + text
        else:
            contents.append({"role": role, "parts": [{"text": text}]})
    while contents and contents[0]["role"] != "user":
        contents.pop(0)
    return contents


def build_request(message: str, *, origin_name=None, destination_name=None, preference=None,
                  depart_at=None, history=None, now=None) -> dict:
    now = (now or datetime.now(IST)).astimezone(IST)
    state = (f"Current time in Bengaluru: {now.strftime('%A %H:%M')}. "
             f"Selected start: {origin_name or 'none'}. Selected destination: {destination_name or 'none'}. "
             f"Selected preference: {preference or 'fastest'}. Selected departure: {depart_at or 'now'}.")
    contents = _history_contents(history)
    turn = {"role": "user", "parts": [{"text": f"[{state}]\n{_clean_text(message, 300)}"}]}
    if contents and contents[-1]["role"] == "user":
        contents[-1]["parts"][0]["text"] += "\n" + turn["parts"][0]["text"]
    else:
        contents.append(turn)
    return {
        "systemInstruction": {"parts": [{"text": SYSTEM_PROMPT}]},
        "contents": contents,
        "generationConfig": {"thinkingConfig": {"thinkingLevel": "MINIMAL"}, "maxOutputTokens": 512},
        "tools": TOOLS,
        "toolConfig": {"functionCallingConfig": {"mode": "ANY",
                                                 "allowedFunctionNames": ["plan_journey", "swap_trip",
                                                                          "check_live_buses", "reply"]}},
    }


def parse_response(data: dict) -> dict:
    """Turn Gemini's function call into a validated action, or raise GeminiUnavailable."""
    if (data.get("promptFeedback") or {}).get("blockReason"):
        raise GeminiUnavailable("blocked")
    candidates = data.get("candidates") or []
    if not candidates:
        raise GeminiUnavailable("bad_response")
    candidate = candidates[0]
    if str(candidate.get("finishReason", "")).upper() in ("SAFETY", "BLOCKLIST", "PROHIBITED_CONTENT", "SPII"):
        raise GeminiUnavailable("blocked")
    call = next((part.get("functionCall") for part in (candidate.get("content") or {}).get("parts") or []
                 if isinstance(part, dict) and isinstance(part.get("functionCall"), dict)), None)
    if not call:
        raise GeminiUnavailable("bad_response")
    name, args = call.get("name"), call.get("args") or {}
    if not isinstance(args, dict):
        raise GeminiUnavailable("bad_response")
    if name == "plan_journey":
        preference = str(args.get("preference") or "").strip()
        return {"action": "plan",
                "origin": _clean_text(args.get("origin"), 80) or None,
                "destination": _clean_text(args.get("destination"), 80) or None,
                "preference": preference if preference in PREFERENCES else None,
                "depart_at": _valid_time(args.get("depart_at")),
                "from_my_location": args.get("from_my_location") is True}
    if name == "swap_trip":
        return {"action": "swap"}
    if name == "check_live_buses":
        return {"action": "live", "route": clean_route(args.get("route"))}
    if name == "reply":
        text = _clean_text(args.get("text"), 600)
        if not text:
            raise GeminiUnavailable("bad_response")
        return {"action": "reply", "text": text,
                "kind": args.get("kind") if args.get("kind") in ("help", "question", "unclear", "smalltalk") else "question"}
    raise GeminiUnavailable("bad_response")


def understand(message: str, *, transport=None, timeout: float | None = None, **context) -> dict:
    """Ask Gemini what the traveller wants. Returns an action dict or raises GeminiUnavailable."""
    config = settings()
    if not config["enabled"]:
        raise GeminiUnavailable("no_key")
    timeout = timeout or _timeout_setting()
    body = build_request(message, **context)
    status_code, data, used_model, request_error = _generate(body, config, transport, timeout)
    if isinstance(request_error, ValueError):
        raise GeminiUnavailable("bad_response") from None
    if request_error is not None:
        raise _request_failure(request_error, config, timeout) from None
    if status_code == 400 and "API_KEY" not in json.dumps(data) and "toolConfig" in body:
        # Some models reject the forced function-call setting; retry once with the plain request.
        _log(f"HTTP 400 from model {used_model}: {_error_text(data) or 'no error message'} (retrying without toolConfig)",
             config["key"])
        body = {name: value for name, value in body.items() if name != "toolConfig"}
        status_code, data, used_model, request_error = _generate(body, config, transport, timeout)
        if request_error is not None:
            raise _request_failure(request_error, config, timeout) from None
    if status_code != 200:
        _log(f"HTTP {status_code} from model {used_model}: {_error_text(data) or 'no error message'}", config["key"])
    if status_code == 429:
        raise GeminiUnavailable("rate_limited")
    if status_code in (401, 403) or (status_code == 400 and "API_KEY" in json.dumps(data)):
        raise GeminiUnavailable("bad_key")
    if status_code == 404:
        raise GeminiUnavailable("bad_model")
    if status_code == 400:
        raise GeminiUnavailable("bad_request")
    if status_code != 200 or not isinstance(data, dict):
        raise GeminiUnavailable("network" if status_code >= 500 else "bad_response")
    try:
        return parse_response(data)
    except GeminiUnavailable as error:
        # Describe the shape of what came back (not the traveller's text) so a format change is visible.
        candidate = (data.get("candidates") or [{}])[0] if isinstance(data.get("candidates"), list) else {}
        parts = (candidate.get("content") or {}).get("parts") or [] if isinstance(candidate, dict) else []
        _log(f"unusable answer ({error.reason}): finishReason={candidate.get('finishReason') if isinstance(candidate, dict) else None}, "
             f"parts={[sorted(part.keys()) for part in parts if isinstance(part, dict)]}, "
             f"blockReason={(data.get('promptFeedback') or {}).get('blockReason')}", config["key"])
        raise


def load_dotenv(path) -> None:
    """Read KEY=VALUE lines from a local .env file without overriding real environment variables."""
    try:
        with open(path, encoding="utf-8") as handle:
            lines = handle.read().splitlines()
    except OSError:
        return
    for line in lines:
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        name, value = line.split("=", 1)
        name, value = name.strip(), value.strip().strip('"').strip("'")
        if re.fullmatch(r"[A-Z][A-Z0-9_]*", name) and name not in os.environ:
            os.environ[name] = value


# ---------------------------------------------------------------- explaining the options
EXPLAIN_PROMPT = """You explain bus journey options to a traveller in Bengaluru, in plain friendly English.
You get the options as facts. Write at most three short sentences that help the traveller choose:
which is quickest, which has least walking or fewest changes, and any trade-off worth knowing
(a long way round, an early or late departure, other bus numbers that also go the same way).
Use ONLY the facts given. Never add a bus number, time, duration, count, fare, frequency or place
that is not in the facts. Do not repeat every number; pick what matters. Call explain with the text."""


def facts_from_routes(routes) -> list[dict]:
    """Compact, validated facts (first five options) from route dicts sent by the page."""
    facts = []
    for index, route in enumerate((routes or [])[:5]):
        if not isinstance(route, dict):
            continue
        def num(key):
            try:
                value = int(round(float(route.get(key))))
            except (TypeError, ValueError):
                return None
            return value if 0 <= value <= 600 else None
        buses = [clean_route(name) for name in (route.get("route_numbers") or [])][:5]
        also = [clean_route(name) for name in (route.get("also_lines") or [])][:4]
        fact = {
            "option": index + 1,
            "buses": [b for b in buses if b] if route.get("transit", True) else [],
            "walk_only": route.get("transit") is False,
            "leave": _valid_time(route.get("departure_time")),
            "arrive": _valid_time(route.get("arrival_time")),
            "door_to_door_min": num("trip_minutes"),
            "leave_in_min": num("leave_in_minutes"),
            "changes": num("transfers"),
            "walking_min": num("walking_minutes"),
            "long_way_round": bool(route.get("detour")),
            "other_buses_same_first_stretch": [a for a in also if a],
        }
        facts.append({key: value for key, value in fact.items()
                      if not (value is None or value is False or value == [])})
    return facts


_TIME_TOKEN = re.compile(r"\b([01]?\d|2[0-3])[:.]([0-5]\d)\b")
_CODE_TOKEN = re.compile(r"\b(?=[A-Z0-9-]*\d)(?=[A-Z0-9-]*[A-Z])[A-Z0-9]+(?:-[A-Z0-9]+)*\b", re.I)


def explanation_is_grounded(text: str, facts: list[dict]) -> bool:
    """True only if every time, number and bus code in the text appears in the facts."""
    times, numbers, codes = set(), set(), set()
    for fact in facts:
        for key, value in fact.items():
            if isinstance(value, bool):
                continue
            if isinstance(value, int):
                numbers.add(value)
            elif isinstance(value, str) and _TIME_TOKEN.fullmatch(value):
                times.add(value)
            elif isinstance(value, list):
                codes.update(str(v).upper() for v in value)
    numbers.add(len(facts))
    for match in _TIME_TOKEN.finditer(text):
        if f"{int(match.group(1)):02d}:{match.group(2)}" not in times:
            return False
    stripped = _TIME_TOKEN.sub(" ", text)
    for match in _CODE_TOKEN.finditer(stripped):
        token = match.group(0).upper()
        if token not in codes and not any(token in code.split() for code in codes):
            return False
    stripped = _CODE_TOKEN.sub(" ", stripped)
    for match in re.finditer(r"\d+", stripped):
        if int(match.group(0)) not in numbers:
            return False
    return True


def explain(routes, *, preference=None, transport=None, timeout: float | None = None) -> str:
    """A short comparison of the options, checked against the facts. Raises GeminiUnavailable."""
    config = settings()
    if not config["enabled"]:
        raise GeminiUnavailable("no_key")
    timeout = timeout or _timeout_setting()
    facts = facts_from_routes(routes)
    if len(facts) < 1:
        raise GeminiUnavailable("bad_response")
    body = {
        "systemInstruction": {"parts": [{"text": EXPLAIN_PROMPT}]},
        "contents": [{"role": "user", "parts": [{"text":
            f"Ranking preference: {preference if preference in PREFERENCES else 'fastest'}.\n"
            f"Options (facts): {json.dumps(facts, ensure_ascii=False)}"}]}],
        "generationConfig": {"thinkingConfig": {"thinkingLevel": "MINIMAL"}, "maxOutputTokens": 512},
        "tools": [{"functionDeclarations": [{
            "name": "explain", "description": "The short explanation for the traveller.",
            "parameters": {"type": "object", "properties": {
                "text": {"type": "string", "description": "At most three short sentences."}}, "required": ["text"]}}]}],
        "toolConfig": {"functionCallingConfig": {"mode": "ANY", "allowedFunctionNames": ["explain"]}},
    }
    status_code, data, used_model, request_error = _generate(body, config, transport, timeout)
    if request_error is not None:
        _log("explain failed", config["key"])
        raise _request_failure(request_error, config, timeout) from None
    if status_code != 200:
        _log(f"explain: HTTP {status_code} from {used_model}: {_error_text(data) or 'no error message'}", config["key"])
        raise GeminiUnavailable("rate_limited" if status_code == 429 else "bad_request")
    candidate = ((data or {}).get("candidates") or [{}])[0]
    call = next((part.get("functionCall") for part in (candidate.get("content") or {}).get("parts") or []
                 if isinstance(part, dict) and isinstance(part.get("functionCall"), dict)), None)
    text = _clean_text(((call or {}).get("args") or {}).get("text"), 500)
    if not text:
        raise GeminiUnavailable("bad_response")
    if not explanation_is_grounded(text, facts):
        _log("explain: answer mentioned a time, number or bus not in the results; discarded", config["key"])
        raise GeminiUnavailable("ungrounded")
    return text
