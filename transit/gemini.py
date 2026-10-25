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

import json
import os
import re
from datetime import datetime, timedelta, timezone
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

API_ROOT = os.environ.get("GEMINI_API_ROOT", "https://generativelanguage.googleapis.com/v1beta").rstrip("/")
DEFAULT_MODEL = "gemini-3.5-flash-lite"   # free tier, stable, supports function calling
TIMEOUT_SECONDS = 8
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
  is already selected). "from here"/"my location" means leave origin empty.
  depart_at is 24-hour HH:MM in Bengaluru time, only if the traveller asked for a time; resolve phrases
  like "in 30 minutes" or "tonight at 9" using the current time given below. Otherwise leave it empty.
  preference: "less_walking", "fewer_transfers" or "fastest" only if asked for; otherwise empty.
- swap_trip: the traveller wants the reverse / return journey of the currently selected trip.
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
         "depart_at": {"type": "string", "description": "24-hour HH:MM departure time, only if a time was asked for."}}}},
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


def _post(url: str, body: dict, key: str, timeout: float):
    request = Request(url, data=json.dumps(body).encode("utf-8"), method="POST",
                      headers={"Content-Type": "application/json", "x-goog-api-key": key})
    try:
        with urlopen(request, timeout=timeout) as response:
            return response.status, json.load(response)
    except HTTPError as error:
        try:
            detail = json.load(error)
        except (ValueError, OSError):
            detail = {}
        return error.code, detail


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
        "tools": TOOLS,
        "toolConfig": {"functionCallingConfig": {"mode": "ANY",
                                                 "allowedFunctionNames": ["plan_journey", "swap_trip", "reply"]}},
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
                "depart_at": _valid_time(args.get("depart_at"))}
    if name == "swap_trip":
        return {"action": "swap"}
    if name == "reply":
        text = _clean_text(args.get("text"), 600)
        if not text:
            raise GeminiUnavailable("bad_response")
        return {"action": "reply", "text": text,
                "kind": args.get("kind") if args.get("kind") in ("help", "question", "unclear", "smalltalk") else "question"}
    raise GeminiUnavailable("bad_response")


def understand(message: str, *, transport=None, timeout: float = TIMEOUT_SECONDS, **context) -> dict:
    """Ask Gemini what the traveller wants. Returns an action dict or raises GeminiUnavailable."""
    config = settings()
    if not config["enabled"]:
        raise GeminiUnavailable("no_key")
    url = f"{API_ROOT}/models/{config['model']}:generateContent"
    body = build_request(message, **context)
    try:
        status_code, data = (transport or _post)(url, body, config["key"], timeout)
    except (TimeoutError, OSError, URLError) as error:
        reason = "timeout" if "timed out" in str(error).lower() or isinstance(error, TimeoutError) else "network"
        _log(f"{reason}: {type(error).__name__}: {error}", config["key"])
        raise GeminiUnavailable(reason) from None
    except ValueError:
        raise GeminiUnavailable("bad_response") from None
    if status_code == 400 and "API_KEY" not in json.dumps(data) and "toolConfig" in body:
        # Some models reject the forced function-call setting; retry once with the plain request.
        _log(f"HTTP 400 from model {config['model']}: {_error_text(data) or 'no error message'} (retrying without toolConfig)",
             config["key"])
        body = {name: value for name, value in body.items() if name != "toolConfig"}
        try:
            status_code, data = (transport or _post)(url, body, config["key"], timeout)
        except (TimeoutError, OSError, URLError, ValueError) as error:
            _log(f"retry failed: {type(error).__name__}: {error}", config["key"])
            raise GeminiUnavailable("network") from None
    if status_code != 200:
        _log(f"HTTP {status_code} from model {config['model']}: {_error_text(data) or 'no error message'}", config["key"])
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
