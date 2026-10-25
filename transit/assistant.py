"""Command helper behind the chat box (``POST /api/assistant``).

Two readers understand the traveller's message:
  * Google Gemini (optional, see transit/gemini.py) when GEMINI_API_KEY is set: free-form text,
    landmarks, typos, other languages and follow-ups;
  * the built-in rule-based parser, always available, used when Gemini is off or fails. It
    understands a small set of commands ("take me from Hope Farm to Majestic", "less walking",
    "leave at 9:30 pm", "swap") and says plainly when it does not understand.

Either way the assistant never invents stops or services: every place is looked up in the
imported BMTC stop list and every journey comes from the same planner as the Find routes button.
"""
from __future__ import annotations

import re

from . import gemini
from .otp import RouterUnavailable, plan_journey
from .planner import search_stops

HELP = ("I can plan Bengaluru bus journeys from your typed or spoken commands. "
        "Try \"from Hope Farm to Majestic\", add \"less walking\", \"fewer transfers\" or \"leave at 9:30 pm\", "
        "or say \"swap\" to reverse the trip. I am a simple built-in helper, not a general chatbot.")

_FILLER = re.compile(
    r"^(?:(?:please|hey|hi|hello|ok|okay)[ ,]+)*(?:(?:can|could) you\s+)?"
    r"(?:take me|get me|route me|navigate me|navigate|directions?|plan(?: a)?(?: trip| journey| route)?|find(?: me)?(?: a)?(?: route| bus)?"
    r"|show me(?: a)?(?: route)?|how do i get|how to get|how can i get|i (?:want|need) to (?:go|get|travel)|i would like to go|go|travel|bus)\b[ ,]*",
    re.I)
_TIME = re.compile(r"\b(?:leave|leaving|depart(?:ing)?|start(?:ing)?|at|by|around|after)\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b", re.I)
_PREFERENCES = (
    ("less_walking", re.compile(r"\b(?:with\s+|and\s+)?(?:less|least|minimal|minimum|little|no)\s+walking\b|\bwalk(?:ing)?\s+less\b", re.I)),
    ("fewer_transfers", re.compile(r"\b(?:with\s+|and\s+)?(?:fewer|fewest|least|less|minimal|no)\s+(?:transfers?|changes?)\b|\bdirect\b", re.I)),
    ("fastest", re.compile(r"\b(?:the\s+)?(?:fastest|quickest|shortest)(?:\s+(?:route|way|journey))?\b", re.I)),
)
_HERE = re.compile(r"\b(?:from\s+)?(?:right\s+)?(?:here|my\s+(?:current\s+)?location|current\s+location|where\s+i\s+am|near\s+me)\b", re.I)
_LIVE = re.compile(r"\bwhere(?:'s|\s+is)\s+(?:my|the|a)\s+bus\b|\blive\s+(?:bus|buses|position|location|tracking)\b|"
                   r"\btrack\b|\bbus(?:es)?\s+(?:near|nearby|coming)\b|"
                   r"\bwhen\s+(?:does|will|is)\b.*\b(?:come|coming|arrive|arriving|reach)\b", re.I)
_ROUTE_CODE = re.compile(r"\b((?:[A-Z]{1,4}-)?\d{1,3}[A-Z]{0,3}(?:-[A-Z]{1,4})?)\b", re.I)
_SWAP = re.compile(r"\b(?:swap|reverse|flip|return trip|way back|go back|other direction|opposite direction)\b", re.I)


def _clean(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip(" ,.;!?\"'")


def parse_command(message: str) -> dict:
    """Split a message into places, preference, departure time and swap intent."""
    text = _clean(str(message))
    parsed = {"origin": None, "destination": None, "preference": None, "depart_at": None, "swap": False,
              "from_here": False, "live": False, "route": None}
    if _LIVE.search(text):
        # "where is my bus", "when will 500D come": a live-position question, not a journey plan.
        parsed["live"] = True
        code = next((m.group(1) for m in _ROUTE_CODE.finditer(text)
                     if not re.fullmatch(r"\d{1,2}", m.group(1))), None)   # "9" in "at 9" is a time
        parsed["route"] = code.upper() if code else None
        return parsed
    if _HERE.search(text):
        parsed["from_here"] = True
        text = _HERE.sub(" ", text)
    if _SWAP.search(text):
        parsed["swap"] = True
        text = _SWAP.sub(" ", text)
    for name, pattern in _PREFERENCES:
        if pattern.search(text):
            parsed["preference"] = name
            text = pattern.sub(" ", text)
            break
    match = _TIME.search(text)
    if match:
        hour, minute, meridiem = int(match.group(1)), int(match.group(2) or 0), (match.group(3) or "").lower()
        if meridiem == "pm" and hour < 12:
            hour += 12
        elif meridiem == "am" and hour == 12:
            hour = 0
        if hour <= 23 and minute <= 59 and (meridiem or match.group(2) or match.group(0).split()[0].lower() in
                                            ("leave", "leaving", "depart", "departing", "start", "starting")):
            parsed["depart_at"] = f"{hour:02d}:{minute:02d}"
            text = text[:match.start()] + " " + text[match.end():]
    text = _clean(_FILLER.sub("", _clean(text)))
    for pattern, order in ((r"^from (.+?) to (.+)$", "od"), (r"^(.+?) to (.+)$", "od"),
                           (r"^to (.+?) from (.+)$", "do"), (r"^(.+?) from (.+)$", "do")):
        found = re.match(pattern, text, re.I)
        if found:
            first, second = _clean(found.group(1)), _clean(found.group(2))
            parsed["origin"], parsed["destination"] = (first, second) if order == "od" else (second, first)
            break
    else:
        if re.match(r"^to .+", text, re.I):
            parsed["destination"] = _clean(text[3:])
        elif re.match(r"^from .+", text, re.I):
            parsed["origin"] = _clean(text[5:])
    for key in ("origin", "destination"):
        if parsed[key]:
            parsed[key] = re.sub(r"^(?:the|my)\s+", "", parsed[key], flags=re.I) or None
    return parsed


def _stop_dict(row: dict) -> dict:
    return {"stop_id": row["stop_id"], "stop_name": row["stop_name"],
            "stop_lat": row["stop_lat"], "stop_lon": row["stop_lon"]}


def resolve_place(database, text: str):
    """Return (stop or None, number of other matching stops, suggestions)."""
    matches = search_stops(database, text, limit=15)
    if matches:
        best = matches[0]
        others = sum(1 for row in matches[1:] if row["stop_name"] == best["stop_name"])
        return _stop_dict(best), others, []
    suggestions = []
    for word in sorted(re.findall(r"[A-Za-z]{4,}", text), key=len, reverse=True)[:2]:
        for row in search_stops(database, word, limit=4):
            if row["stop_name"] not in suggestions:
                suggestions.append(row["stop_name"])
    return None, 0, suggestions[:4]


def _context_stop(value):
    """Accept the browser's current endpoint: an id string or a small object."""
    if isinstance(value, dict) and value.get("lat") is not None and value.get("lon") is not None:
        return value
    return None


def _plan_args(database, stop, context):
    """Planner arguments for either a database stop or a map point from the page."""
    if context is not None and context.get("is_map_point"):
        return str(context.get("id", "map-point")), {"id": context.get("id"), "name": context.get("name"),
                                                      "lat": context["lat"], "lon": context["lon"]}
    return str(stop["stop_id"]), None


def handle_assistant(database, payload: dict, now=None, gemini_transport=None) -> dict:
    message = str(payload.get("message") or "").strip()
    if not message:
        raise ValueError("Type a command such as \"from Hope Farm to Majestic\".")
    if len(message) > 300:
        raise ValueError("Please keep the command under 300 characters.")
    rules = parse_command(message)
    engine, notice, ai = "built-in", "", None
    if gemini.settings()["enabled"]:
        origin_now = _context_to_stop(_context_stop(payload.get("origin")))
        destination_now = _context_to_stop(_context_stop(payload.get("destination")))
        try:
            ai = gemini.understand(
                message, transport=gemini_transport,
                origin_name=origin_now["stop_name"] if origin_now else None,
                destination_name=destination_now["stop_name"] if destination_now else None,
                preference=payload.get("preference"), depart_at=payload.get("depart_at"),
                history=payload.get("history") if isinstance(payload.get("history"), list) else None,
                now=now)
            engine = "gemini"
        except gemini.GeminiUnavailable as error:
            notice = error.note
    live = (ai and ai["action"] == "live") or (ai is None and rules.get("live"))
    if live:
        route = (ai or {}).get("route") if ai else rules.get("route")
        route = gemini.clean_route(route)
        reply = _reply(f"Checking BMTC live positions for {route}…" if route else
                       "Checking BMTC live positions for your selected journey…", intent="live",
                       origin=_context_to_stop(_context_stop(payload.get("origin"))),
                       destination=_context_to_stop(_context_stop(payload.get("destination"))),
                       preference=payload.get("preference") if payload.get("preference") in gemini.PREFERENCES else "fastest",
                       depart_at=payload.get("depart_at") or None)
        reply["route"] = route
    elif ai and ai["action"] == "reply":
        reply = _reply(ai["text"], intent="answer",
                       origin=_context_to_stop(_context_stop(payload.get("origin"))),
                       destination=_context_to_stop(_context_stop(payload.get("destination"))),
                       preference=payload.get("preference") if payload.get("preference") in gemini.PREFERENCES else "fastest",
                       depart_at=payload.get("depart_at") or None)
    else:
        parsed = rules if ai is None else {
            "origin": ai.get("origin"), "destination": ai.get("destination"), "preference": ai.get("preference"),
            "depart_at": ai.get("depart_at"), "swap": ai["action"] == "swap",
            "from_here": bool(ai.get("from_my_location"))}
        if parsed.get("from_here"):
            reply = _from_here(database, payload, parsed, rules if ai is not None else None)
        else:
            reply = _answer(database, payload, parsed, rules if ai is not None else None, now)
    reply["engine"] = engine
    if notice:
        reply["notice"] = notice
    return reply


def _from_here(database, payload: dict, parsed: dict, rules) -> dict:
    """Start = the traveller's own position. Only the browser knows it, so resolve the destination
    here and let the page take a GPS fix and plan (the page never sends GPS to Gemini)."""
    preference = parsed.get("preference") or payload.get("preference") or "fastest"
    if preference not in gemini.PREFERENCES:
        preference = "fastest"
    depart_at = parsed.get("depart_at") or payload.get("depart_at") or None
    destination = _context_to_stop(_context_stop(payload.get("destination")))
    if parsed.get("destination"):
        stop, _others, suggestions = resolve_place(database, parsed["destination"])
        if stop is None and rules and rules.get("destination"):
            stop, _others, more = resolve_place(database, rules["destination"])
            suggestions = suggestions or more
        if stop is None:
            hint = (" Closest names: " + ", ".join(suggestions) + ".") if suggestions else ""
            return _reply(f"I could not find a BMTC stop called \"{parsed['destination']}\".{hint}", intent="error",
                          preference=preference, depart_at=depart_at)
        destination = stop
    text = ("Using your current location as the start" +
            (f", going to {destination['stop_name']}." if destination else ". Where do you want to go?"))
    return _reply(text, intent="use_location", destination=destination, preference=preference, depart_at=depart_at)


def _answer(database, payload: dict, parsed: dict, rules, now) -> dict:
    """Resolve places, then plan with the real router. ``rules`` is the rule-based reading, used
    as a second guess when a place Gemini named is not in the BMTC stop list."""
    preference = parsed["preference"] or payload.get("preference") or "fastest"
    if preference not in ("fastest", "less_walking", "fewer_transfers"):
        preference = "fastest"
    depart_at = parsed["depart_at"] or payload.get("depart_at") or None
    origin_ctx, destination_ctx = _context_stop(payload.get("origin")), _context_stop(payload.get("destination"))
    # Keep a stop the traveller already chose on the page.
    origin = _context_to_stop(origin_ctx)
    destination = _context_to_stop(destination_ctx)
    notes = []
    busiest = []

    if parsed["swap"] and not (parsed["origin"] or parsed["destination"]):
        if not (origin and destination):
            return _reply(HELP if not (origin or destination) else "Choose both a start and a destination first, then I can swap them.",
                          intent="help", preference=preference, depart_at=depart_at)
        origin, destination = destination, origin
        origin_ctx, destination_ctx = destination_ctx, origin_ctx
        notes.append("Swapped your start and destination.")
    else:
        for key in ("origin", "destination"):
            if parsed[key]:
                stop, others, suggestions = resolve_place(database, parsed[key])
                if stop is None and rules and rules.get(key) and rules[key].casefold() != parsed[key].casefold():
                    stop, others, more = resolve_place(database, rules[key])
                    suggestions = suggestions or more
                if stop is None:
                    hint = (" Closest names: " + ", ".join(suggestions) + ".") if suggestions else ""
                    return _reply(f"I could not find a BMTC stop called \"{parsed[key]}\".{hint} BMTC spells some names "
                                  "its own way (for example \"White Field\" or \"Yeshawanthapura\"). Try a shorter name or "
                                  "use Pick on map.", intent="error", origin=origin, destination=destination,
                                  preference=preference, depart_at=depart_at)
                if key == "origin":
                    origin, origin_ctx = stop, None
                else:
                    destination, destination_ctx = stop, None
                if others and stop["stop_name"] not in busiest:
                    busiest.append(stop["stop_name"])

    if busiest:
        notes.append("Several stops share the name " + " and ".join(busiest) +
                     "; I used the busiest. Use the From/To boxes to pick another.")

    if not (parsed["origin"] or parsed["destination"] or parsed["swap"]):
        if parsed["preference"] or parsed["depart_at"]:
            if not (origin and destination):
                return _reply("Preference noted. Tell me where you are going, for example \"from Hope Farm to Majestic\".",
                              intent="partial", origin=origin, destination=destination,
                              preference=preference, depart_at=depart_at)
        else:
            return _reply(HELP, intent="help", origin=origin, destination=destination,
                          preference=preference, depart_at=depart_at)

    if origin is None or destination is None:
        missing = "starting point" if origin is None else "destination"
        known = destination if origin is None else origin
        return _reply(f"Got it: {known['stop_name']}. Where is your {missing}?", intent="partial",
                      origin=origin, destination=destination, preference=preference, depart_at=depart_at)
    if origin["stop_id"] == destination["stop_id"] or (
            origin["stop_lat"] == destination["stop_lat"] and origin["stop_lon"] == destination["stop_lon"]):
        return _reply("The start and destination are the same place. Choose two different places.", intent="error",
                      origin=origin, destination=destination, preference=preference, depart_at=depart_at)

    origin_id, origin_point = _plan_args(database, origin, origin_ctx)
    destination_id, destination_point = _plan_args(database, destination, destination_ctx)
    profile = {"preference": preference}
    if depart_at:
        profile["depart_at"] = depart_at
    try:
        plan = plan_journey(database, origin_id, destination_id, profile, origin_point, destination_point, now=now)
    except RouterUnavailable as error:
        return _reply(f"I found {origin['stop_name']} and {destination['stop_name']}, but {error}", intent="error",
                      origin=origin, destination=destination, preference=preference, depart_at=depart_at)
    reply = _reply(" ".join([_summary(plan)] + notes), intent="plan", origin=origin, destination=destination,
                   preference=preference, depart_at=depart_at, plan=plan)
    reply["summary"] = _summary(plan)
    return reply


def _context_to_stop(context):
    if context is None:
        return None
    return {"stop_id": str(context.get("id") or context.get("stop_id") or "map-point"),
            "stop_name": str(context.get("name") or context.get("stop_name") or "Selected point"),
            "stop_lat": float(context["lat"]), "stop_lon": float(context["lon"])}


def _summary(plan: dict) -> str:
    routes = plan.get("routes") or []
    origin, destination = plan["origin"]["stop_name"], plan["destination"]["stop_name"]
    if not routes:
        return (plan.get("fallback") or {}).get("message") or f"No scheduled bus journey was found from {origin} to {destination}."
    best = routes[0]
    when = plan.get("requested", {}).get("label", "Now")
    if best.get("transit"):
        buses = " then ".join(best["route_numbers"])
        changes = "direct" if best["transfers"] == 0 else f"{best['transfers']} change{'s' if best['transfers'] > 1 else ''}"
        detail = f"bus {buses} ({changes}), leave {best['departure_time']}, arrive {best['arrival_time']}"
    else:
        detail = f"walking is best: about {best['walking_minutes']} min"
    return (f"{origin} → {destination} ({when}): {detail}. Scheduled times, not live arrivals. "
            f"{len(routes)} option{'s' if len(routes) != 1 else ''} are in the panel below.")


def _reply(reply: str, *, intent: str, origin=None, destination=None, preference="fastest", depart_at=None, plan=None) -> dict:
    return {"ok": intent != "error", "intent": intent, "reply": reply, "origin": origin, "destination": destination,
            "preference": preference, "depart_at": depart_at, "plan": plan}
