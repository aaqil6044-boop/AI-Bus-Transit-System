"""Kannada support for the built-in helper.

* BMTC's own timetable feed ships official Kannada stop names (GTFS ``translations.txt``). They are
  copied once into the stop database (table ``stop_names_kn``) so a traveller can type or say
  "ಹೆಬ್ಬಾಳ" and get the BMTC stop Hebbala. Nothing is machine-translated or guessed: a Kannada
  name is only accepted when it matches a name BMTC publishes (allowing small spelling differences).
* ``to_command`` turns an everyday Kannada request ("ಹೆಬ್ಬಾಳದಿಂದ ಮೆಜೆಸ್ಟಿಕ್‌ಗೆ ಕಡಿಮೆ ನಡಿಗೆ") into the
  plain command the rule-based parser already understands ("from Hebbala to Majestic, less walking").
"""
from __future__ import annotations

import csv
import difflib
import io
import re
import sqlite3
import threading
import unicodedata
import zipfile
from contextlib import closing
from pathlib import Path

KANNADA = re.compile(r"[ಀ-೿]")
_DIGITS = str.maketrans("೦೧೨೩೪೫೬೭೮೯", "0123456789")
_TOWARDS = re.compile(r"\s*\(\s*ಟುವರ್ಡ್ಸ್[^)]*\)\s*$")

# Common names people say that are not how BMTC writes the stop.
ALIASES = {
    "ಮೆಜೆಸ್ಟಿಕ್": "Majestic", "ಮೆಜಸ್ಟಿಕ್": "Majestic", "ಕೆಬಿಎಸ್": "Majestic", "ಮೆಜೆಸ್ಟಿಕ್ಬಸ್ನಿಲ್ದಾಣ": "Majestic",
    "ಸಿಲ್ಕ್ಬೋರ್ಡ್": "Silk Board", "ಸಿಲ್ಕ್‌ಬೋರ್ಡ್": "Silk Board", "ರೇಷ್ಮೆಮಂಡಳಿ": "Central Silk Board",
    "ವೈಟ್ಫೀಲ್ಡ್": "Whitefield", "ಏರ್ಪೋರ್ಟ್": "Airport", "ವಿಮಾನನಿಲ್ದಾಣ": "Airport",
    "ಕೆಆರ್ಪುರ": "KR Puram", "ಕೆಆರ್ಪುರಂ": "KR Puram", "ಯಶವಂತಪುರ": "Yeshwanthpur",
    "ಶಿವಾಜಿನಗರ": "Shivajinagara Bus Station", "ಎಲೆಕ್ಟ್ರಾನಿಕ್ಸಿಟಿ": "Electronic City",
}
SAVED = {"ಮನೆ": "home", "ಆಫೀಸ್": "work", "ಆಫೀಸು": "work", "ಕಚೇರಿ": "work", "ಕಛೇರಿ": "work", "ಕೆಲಸ": "work"}

_FROM = re.compile(r"‌?(?:ದಿಂದ|ನಿಂದ|ಯಿಂದ|ಇಂದ|ಿಂದ|ಂದ)$")
_TO = re.compile(r"‌?(?:ವರೆಗೆ|ವರೆಗು|ವರೆಗೂ|ಕ್ಕೆ|ಗೆ|ಕೆ)$")
_FILLER_WORDS = {
    "ನನಗೆ", "ನಾನು", "ದಯವಿಟ್ಟು", "ಬಸ್", "ಬಸ್ಸು", "ಮಾರ್ಗ", "ದಾರಿ", "ತೋರಿಸಿ", "ಹೇಳಿ", "ಬೇಕು", "ಹೋಗಬೇಕು", "ಹೋಗಲು",
    "ಹೋಗುವುದು", "ಹೋಗೋದು", "ಹೇಗೆ", "ಹೋಗಬೇಕಾಗಿದೆ", "ಹೋಗುತ್ತೇನೆ", "ಪ್ರಯಾಣ", "ಹುಡುಕಿ", "ಯಾವ", "ಯಾವುದು", "ಇದೆ",
    "ಹೋಗಿ", "ಹೋಗು", "ತಲುಪಲು", "ತಲುಪುವುದು", "ಸ್ವಲ್ಪ", "ಹೋಗೋಕೆ", "ಸಿಗುತ್ತೆ", "ಸಿಗುತ್ತದೆ", "ಮತ್ತು", "ಜೊತೆ",
}
_PREFERENCES = (
    ("less walking", re.compile(r"ಕಡಿಮೆ\s*(?:ನಡಿಗೆ|ನಡೆಯುವ|ನಡೆಯೋ|ನಡೆದು|ನಡಿಯೋ|ನಡೆಯಬೇಕು)\S*")),
    ("fewer transfers", re.compile(r"ಕಡಿಮೆ\s*(?:ಬದಲಾವಣೆ|ಬದಲಿಸುವ|ಬಸ್\s*ಬದಲಾವಣೆ)\S*|ನೇರ\s*ಬಸ್\S*|ಬದಲಾವಣೆ\s*ಇಲ್ಲದ\S*")),
    ("safer connections", re.compile(r"ಸುರಕ್ಷಿತ\s*ಸಂಪರ್ಕ\S*")),
    ("fastest", re.compile(r"ಅತಿ\s*ವೇಗ\S*|ವೇಗದ\S*|ಬೇಗ\s*ತಲುಪ\S*")),
)
_GREETING = re.compile(r"^(?:ನಮಸ್ಕಾರ|ನಮಸ್ತೆ|ಹಲೋ|ಹಾಯ್|ಶುಭೋದಯ)[!.।\s]*$")
_HELP = re.compile(r"^(?:ಸಹಾಯ|ಸಹಾಯ\s*ಮಾಡಿ|ಏನು\s*ಮಾಡಬಹುದು)[?!.\s]*$")
_SWAP = re.compile(r"ಹಿಂತಿರುಗ\S*|ವಾಪಸ್\S*|ವಾಪಾಸ್\S*|ತಿರುಗಿಸಿ|ವಿರುದ್ಧ\s*ದಿಕ್ಕ\S*|ರಿಟರ್ನ್")
_HERE = re.compile(r"ಇಲ್ಲಿಂದ|ನನ್ನ\s*(?:ಈಗಿನ\s*)?ಸ್ಥಳದಿಂದ|ನಾನು\s*ಇರುವ\s*ಕಡೆಯಿಂದ")
_LIVE = re.compile(r"ಎಲ್ಲಿದೆ|ಎಲ್ಲಿ\s*ಇದೆ|ಯಾವಾಗ\s*ಬರ\S*|ಎಲ್ಲಿ\s*ಬರುತ್ತಿದೆ|ಲೈವ್")
_LATE = re.compile(r"ತಡ\S*|ಲೇಟ್\S*|ಸಮಯಕ್ಕೆ\s*ಸರಿಯಾಗಿ|ಸಮಯಕ್ಕೆ\s*ಬರ\S*")
_ROUTE = re.compile(r"\b((?:[A-Za-z]{1,4}-?)?\d{1,3}[A-Za-z]{0,3}(?:-[A-Za-z]{1,4})?)\b")
_PERIOD = {"ಬೆಳಿಗ್ಗೆ": "am", "ಬೆಳಗ್ಗೆ": "am", "ಮುಂಜಾನೆ": "am", "ಮಧ್ಯಾಹ್ನ": "pm", "ಸಂಜೆ": "pm", "ರಾತ್ರಿ": "pm"}
_TIME = re.compile(r"(?:(ಬೆಳಿಗ್ಗೆ|ಬೆಳಗ್ಗೆ|ಮುಂಜಾನೆ|ಮಧ್ಯಾಹ್ನ|ಸಂಜೆ|ರಾತ್ರಿ)\s*)?(\d{1,2})(?:[:.](\d{2}))?\s*"
                   r"(?:(am|pm|AM|PM)\s*)?(ಗಂಟೆಗೆ|ಗಂಟೆ|ಕ್ಕೆ|ಕೆ|ಗೆ)?(?:\s*(?:ಹೊರಡ|ಹೊರಟು|ಬಿಡ|ಶುರು)\S*)?")

_lock = threading.Lock()
_cache: dict = {}


def has_kannada(text) -> bool:
    return bool(KANNADA.search(str(text or "")))


def normalize(text) -> str:
    """Spaces, ZWNJ/ZWJ and punctuation removed; Kannada vowel signs kept (str.isalnum drops them)."""
    text = unicodedata.normalize("NFC", str(text or "")).translate(_DIGITS).lower()
    return "".join(ch for ch in text if unicodedata.category(ch)[0] in "LMN")


def ensure_table(database, gtfs_zip) -> bool:
    """Copy BMTC's Kannada stop names into the stop database once. True when the table is usable."""
    database = Path(database)
    if not database.exists():
        return False
    with closing(sqlite3.connect(str(database))) as conn:
        try:
            if conn.execute("SELECT count(*) FROM stop_names_kn").fetchone()[0] > 0:
                return True
        except sqlite3.Error:
            pass
        gtfs_zip = Path(gtfs_zip)
        if not gtfs_zip.exists():
            return False
        try:
            with zipfile.ZipFile(gtfs_zip) as archive:
                raw = archive.read("translations.txt").decode("utf-8-sig")
        except (KeyError, OSError, zipfile.BadZipFile):
            return False
        rows = []
        for row in csv.DictReader(io.StringIO(raw)):
            if row.get("table_name") != "stops" or row.get("field_name") != "stop_name" or row.get("language") != "kn":
                continue
            name = re.sub(r"\s+", " ", _TOWARDS.sub("", row.get("translation") or "")).strip()
            if name and row.get("record_id"):
                rows.append((row["record_id"], name, normalize(name)))
        with conn:
            conn.execute("CREATE TABLE IF NOT EXISTS stop_names_kn (stop_id TEXT PRIMARY KEY, name_kn TEXT, key TEXT)")
            conn.executemany("INSERT OR REPLACE INTO stop_names_kn VALUES (?,?,?)", rows)
            conn.execute("CREATE INDEX IF NOT EXISTS stop_names_kn_key ON stop_names_kn(key)")
    _cache.pop(str(database), None)
    return bool(rows)


def _names(database) -> dict:
    """{key: (english name, kannada name, number of stops)} — the most common English name per key."""
    path = str(database)
    with _lock:
        if path in _cache:
            return _cache[path]
        found: dict = {}
        try:
            with closing(sqlite3.connect(path)) as conn:
                rows = conn.execute("SELECT k.key, k.name_kn, s.stop_name, count(*) FROM stop_names_kn k "
                                    "JOIN stops s ON s.stop_id = k.stop_id GROUP BY k.key, s.stop_name").fetchall()
        except sqlite3.Error:
            rows = []
        for key, name_kn, english, count in rows:
            if key and (key not in found or count > found[key][2]):
                found[key] = (english, name_kn, count)
        _cache[path] = found
        return found


def kannada_names(database) -> dict:
    """{english stop name: kannada name} for showing both in suggestions."""
    return {english: name_kn for english, name_kn, _ in _names(database).values()}


def find_stop_name(database, text) -> str | None:
    """English BMTC stop name for a Kannada place name, or None when BMTC has no such name."""
    key = normalize(text)
    if not key:
        return None
    if key in ALIASES:
        return ALIASES[key]
    names = _names(database)
    if key in names:
        return names[key][0]
    if len(key) >= 3:
        starts = [value for name, value in names.items() if name.startswith(key)]
        if starts:
            # "ಜಯನಗರ" starts many stop names (Jayanagara 4th Block, Jayanagara Bus Station…): answer with the
            # shared English words, and let the stop search pick the busiest stop of that name.
            size = max(1, len(str(text).split()))
            votes: dict = {}
            for english, _, count in starts:
                head = " ".join(english.split()[:size])
                votes[head] = votes.get(head, 0) + count
            head = max(votes, key=votes.get)
            if len(starts) > 1 and len(head) >= 4:
                return head
            return max(starts, key=lambda value: (value[2], -len(value[0])))[0]
        pool = [value for name, value in names.items() if key in name] if len(key) >= 4 else []
        if pool:
            return max(pool, key=lambda value: (value[2], -len(value[0])))[0]
    close = difflib.get_close_matches(key, list(names), n=1, cutoff=0.8)
    if close:
        return names[close[0]][0]
    alias = difflib.get_close_matches(key, list(ALIASES), n=1, cutoff=0.8)
    return ALIASES[alias[0]] if alias else None


def _place(database, words) -> str | None:
    words = [word for word in words if word and word not in _FILLER_WORDS]
    if not words:
        return None
    text = " ".join(words)
    if not has_kannada(text):
        return text
    key = normalize(text)
    if key in SAVED:
        return SAVED[key]
    return find_stop_name(database, text) or text


def _time(text):
    for match in _TIME.finditer(text):
        period, hour, minute, meridiem, suffix = match.groups()
        if not (period or suffix in ("ಗಂಟೆಗೆ", "ಗಂಟೆ") or minute or meridiem):
            continue                         # a bare number is a route or a stop, not a time
        hour, minute = int(hour), int(minute or 0)
        meridiem = (meridiem or _PERIOD.get(period or "", "")).lower()
        if period == "ರಾತ್ರಿ" and hour < 5:
            meridiem = "am"
        if period == "ಮಧ್ಯಾಹ್ನ" and hour == 12:
            meridiem = "pm"
        if hour > 23 or minute > 59:
            continue
        return f"{hour}:{minute:02d}" + (f" {meridiem}" if meridiem and hour <= 12 else ""), match
    return None, None


_LETTERS = {"ಎ": "A", "ಬಿ": "B", "ಸಿ": "C", "ಡಿ": "D", "ಇ": "E", "ಎಫ್": "F", "ಜಿ": "G", "ಎಚ್": "H", "ಹೆಚ್": "H",
            "ಜೆ": "J", "ಕೆ": "K", "ಎಲ್": "L", "ಎಂ": "M", "ಎನ್": "N", "ಪಿ": "P", "ಆರ್": "R", "ಎಸ್": "S", "ಟಿ": "T",
            "ಯು": "U", "ಐ": "I", "ವಿ": "V", "ಡಬ್ಲ್ಯು": "W", "ಡಬ್ಲ್ಯೂ": "W", "ಎಕ್ಸ್": "X", "ವೈ": "Y", "ಝೆಡ್": "Z"}
_LETTER = "|".join(sorted(map(re.escape, _LETTERS), key=len, reverse=True))
_CODE_TAIL = re.compile(rf"(\d{{1,3}})\s*-?\s*((?:{_LETTER})+)(?![\u0C80-\u0CFF])")
_CODE_HEAD = re.compile(rf"(?<![\u0C80-\u0CFF])((?:{_LETTER})+)\s*-\s*(?=\d)")


def _spell(letters: str) -> str:
    out = ""
    while letters:
        for kn in sorted(_LETTERS, key=len, reverse=True):
            if letters.startswith(kn):
                out, letters = out + _LETTERS[kn], letters[len(kn):]
                break
        else:
            return out
    return out


def route_codes(text: str) -> str:
    """"೫೦೦-ಡಿ" → "500D", "ವಿ-೫೦೦ಡಿ" → "V-500D", "ಕೆಐಎ-೯" → "KIA-9": BMTC route numbers spoken in Kannada letters."""
    text = str(text).translate(_DIGITS)
    text = _CODE_TAIL.sub(lambda m: m.group(1) + _spell(m.group(2)), text)
    return _CODE_HEAD.sub(lambda m: _spell(m.group(1)) + "-", text)


def to_command(database, message) -> str:
    """English command for a Kannada message; unchanged when there is no Kannada in it."""
    text = re.sub(r"\s+", " ", route_codes(unicodedata.normalize("NFC", str(message or "")))).strip()
    if not has_kannada(text):
        return text
    if _GREETING.match(text):
        return "hello"
    if _HELP.match(text):
        return "help"
    code = next((m.group(1) for m in _ROUTE.finditer(text) if not re.fullmatch(r"\d{1,2}", m.group(1))), None)
    if code and _LATE.search(text):
        return f"is {code.upper()} usually late"
    if _LIVE.search(text):
        return f"where is the bus {code.upper()}" if code else "where is my bus"
    parts = []
    if _SWAP.search(text):
        parts.append("swap")
        text = _SWAP.sub(" ", text)
    here = bool(_HERE.search(text))
    text = _HERE.sub(" ", text)
    preference = None
    for name, pattern in _PREFERENCES:
        if pattern.search(text):
            preference = name
            text = pattern.sub(" ", text)
            break
    when, match = _time(text)
    if match:
        text = text[:match.start()] + " " + text[match.end():]
    origin = destination = None
    current: list = []
    loose: list = []
    for word in text.replace(",", " ").split():
        if _FROM.search(word) and word not in _FILLER_WORDS:
            current.append(_FROM.sub("", word))
            origin = _place(database, current) or origin
            current = []
        elif _TO.search(word) and word not in _FILLER_WORDS:
            current.append(_TO.sub("", word))
            destination = _place(database, current) or destination
            current = []
        else:
            current.append(word)
    loose = [word for word in current if word not in _FILLER_WORDS]
    if loose and not destination:
        destination = _place(database, loose)
    elif loose and not origin and not here:
        origin = _place(database, loose)
    if here:
        parts.append("from here")
    if origin and not here:
        parts.append(f"from {origin}")
    if destination:
        parts.append(f"to {destination}")
    if preference:
        parts.append(preference)
    if when:
        parts.append(f"leave at {when}")
    command = ", ".join(parts)
    # "from X to Y, less walking" — keep "from … to …" as one clause for the English parser.
    return re.sub(r"from (.+?), to ", r"from \1 to ", command) or text
