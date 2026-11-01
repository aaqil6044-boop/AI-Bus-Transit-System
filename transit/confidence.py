"""Explain how resilient a scheduled journey is to missed connections.

This is deliberately not an arrival prediction.  It uses the timetable gap after
the transfer walk and, when available, the delay that ``reliability`` learned
from BMTC's own published actual times.  The result helps a traveller see why a
fast-looking itinerary may be fragile without inventing live ETAs.
"""

from __future__ import annotations


TIGHT_BUFFER_MINUTES = 6
RISKY_BUFFER_MINUTES = 2


def _number(value, default=0):
    try:
        return int(round(float(value)))
    except (TypeError, ValueError, OverflowError):
        return default


def _transfer(previous, current):
    scheduled = max(0, _number(current.get("wait_before_minutes")))
    learned = previous.get("reliability") if isinstance(previous.get("reliability"), dict) else None
    typical_delay = _number(learned.get("typical_delay_minutes")) if learned else 0
    # Early running does not make a connection safer: the incoming bus reaching
    # the interchange early merely leaves more waiting time for the passenger.
    expected_late = max(0, typical_delay)
    effective = scheduled - expected_late
    if effective <= RISKY_BUFFER_MINUTES:
        status, label = "risky", "At risk"
    elif effective <= TIGHT_BUFFER_MINUTES:
        status, label = "tight", "Tight"
    else:
        status, label = "comfortable", "Comfortable"

    stop = (current.get("from") or {}).get("name") or "the interchange"
    incoming = previous.get("route_name") or "the first service"
    outgoing = current.get("route_name") or "the next service"
    if learned and expected_late:
        reason = (f"{scheduled} min scheduled after reaching the stop; {incoming} is usually about "
                  f"{expected_late} min late here at this time, leaving roughly {max(0, effective)} min.")
    elif learned:
        reason = f"{scheduled} min scheduled after reaching the stop; {incoming} is usually close to time here."
    else:
        reason = f"{scheduled} min scheduled after reaching the stop; no learned delay adjustment is available yet."
    return {
        "status": status,
        "label": label,
        "stop": stop,
        "from_route": incoming,
        "to_route": outgoing,
        "scheduled_buffer_minutes": scheduled,
        "effective_buffer_minutes": effective if learned else scheduled,
        "reliability_adjustment_minutes": expected_late if learned else None,
        "has_reliability_evidence": bool(learned),
        "detail": reason,
    }


def assess(route):
    """Return a small, JSON-safe connection-confidence explanation."""
    legs = route.get("legs") if isinstance(route, dict) else None
    transit = [leg for leg in (legs or []) if isinstance(leg, dict) and leg.get("transit")]
    if not transit:
        return None
    if len(transit) == 1:
        return {
            "level": "high", "label": "High", "score": 96,
            "summary": "No vehicle change, so there is no scheduled connection to miss.",
            "transfers": [],
            "basis": "Connection confidence only; it does not predict whether the service itself will run on time.",
        }

    transfers = [_transfer(transit[index - 1], transit[index]) for index in range(1, len(transit))]
    risky = sum(item["status"] == "risky" for item in transfers)
    tight = sum(item["status"] == "tight" for item in transfers)
    score = max(5, 94 - 38 * risky - 18 * tight - 5 * max(0, len(transfers) - 1))
    if risky:
        level, label = "low", "Low"
        summary = (f"{risky} connection{'s are' if risky != 1 else ' is'} at risk. "
                   "Keep a backup route ready and check the next bus before you get down.")
    elif tight:
        level, label = "medium", "Medium"
        summary = (f"{tight} tight connection{'s' if tight != 1 else ''}. "
                   "Go directly to the next boarding point and watch live tracking.")
    else:
        level, label = "high", "High"
        summary = "Every scheduled connection has a comfortable buffer after the transfer walk."
    return {
        "level": level, "label": label, "score": score, "summary": summary,
        "transfers": transfers,
        "basis": "Calculated from timetable buffers after transfer walks and learned BMTC delay evidence when available; not a guarantee.",
    }


def annotate(routes):
    for route in routes or []:
        result = assess(route)
        if result:
            route["journey_confidence"] = result
            transit = [leg for leg in route.get("legs", []) if isinstance(leg, dict) and leg.get("transit")]
            for leg, connection in zip(transit[1:], result["transfers"]):
                leg["connection"] = connection
    return routes
