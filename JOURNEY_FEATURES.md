# Bengaluru Transit Assistant: how it behaves

Free and local: no paid API, no account, no external AI service.

## Run it

1. Double-click `run-local.cmd` (starts the route engine on port 8766, then the app on port 8765). Wait for "Ready".
2. Open http://127.0.0.1:8765/. After updating files, press Ctrl+F5.
3. Close the window to stop everything.

First-time setup only: `python scripts/import_gtfs.py data/bmtc_gtfs.zip` builds the stop database, then `build-otp-graph.cmd` builds the routing graph.
The app shows a banner (with a Check again button) if the database, route engine or local server is not available.
Java 21 is found automatically (JAVA_HOME, Microsoft/Temurin JDK folders, then PATH).

## Journeys

- Routes come from OpenTripPlanner over the imported BMTC GTFS timetable. Every time is **scheduled, never live**.
- "Leave: Now / At hh:mm" chooses the departure. If the time has passed today the search uses tomorrow, and the label says so. The GTFS is a single daily timetable, so night-time service is sparse; searching at midnight gives few or no options.
- Each bus leg lists the boarding stop, every stop in order with scheduled times, and the alighting stop, plus walks, transfers and waiting minutes.
- Test/dummy/AFCS pseudo-routes in the data are excluded. The route engine is asked for later departures too, so several distinct buses are shown instead of repeats of one bus.
- Preferences (Fastest, Fewer transfers, Less walking) re-rank what OTP returns. They do not search beyond it.
- If no bus journey exists the app says so, and shows walking only when it is genuinely short.

## Search and results screen

- Type a stop name and press Find routes even if you did not tap a suggestion: the best matching BMTC stop is used and the From/To box shows which one. Unknown names are never invented.
- The swap button (⇅) exchanges From and To and searches again.
- Results sit in a strip along the bottom so the map stays visible. The ▾ button collapses them to a header (tap the header or ▴ to reopen); they are never discarded by closing. Stopping guidance brings them back.
- On smaller screens the search panel shrinks while results are open, and the Less walking / Fewer transfers / Fastest chips move into the results header.
- Each bus line is joined to its boarding and alighting stops. BMTC's drawn shapes often begin at a station entrance rather than the platform, so a short connector (under 500 m, never longer) is added from the real stop coordinates.
- The map frames the route in the space left between panels, and re-frames when the live panel or guidance opens.

## Live buses (BMTC feed)

- Live tracking is scoped to the selected journey's next boarding step (and re-scopes when you move to a transfer).
- BMTC publishes each route as UP and DOWN branches with ordered stations. A bus is labelled **heading to your stop** only when its branch lists your boarding stop before your alighting stop and the bus has not passed the boarding stop yet.
  Buses already past it, or travelling the other way, are hidden and counted. A matching route number alone is never enough.
- Anything the feed cannot verify (looping routes, no alighting stop, position far from the line) is labelled **Direction not verified**.
- Click a bus (marker or list row) to see **where it is going**: a bold orange line from the bus along its route's own roads (timetable path) to the last stop of its run, marked "🏁 … ends at …". Your boarding stop is marked on it when the bus is coming to you, the planned journey fades while it is shown, and the panels slide away so the whole route is visible ("▲ Show trip panels" brings them back). Click the same bus again to hide it. The line starts where the bus actually is, so it never doubles back to a stop already passed. If no timetable path fits, it joins the stops instead, without passed stops and never across a gap longer than about 2 km; a bus whose position along its route BMTC did not publish gets no line, and the app says so.
- Freshness is shown separately: Fresh (position updated within 2 minutes), Stale (older), No timestamp (not confirmed live).
- If BMTC cannot be reached, journeys and guidance keep working and the panel says so. This depends on BMTC's unofficial mobile API, which can change or block requests.

## Seeing the whole map

Drag or zoom the map and the panels (search, journey options, live buses, guidance) slide off the edges so the whole map is visible. "▲ Show trip panels" at the bottom, or Esc, brings them back; so does any action that needs them (a new search, Check buses, Start journey, opening the chat). The app's own camera moves never hide anything.

## Journey steps and live buses side by side

While guiding (and whenever live buses are shown) the two panels share one column on the right. Drag the handle between them to give either more room (double-click resets it); ▾ folds a panel to its one-line summary and ⤢ gives it the whole column. On a phone they become one bottom sheet with "Journey steps" and "Live buses" tabs: pull the handle up or down (it snaps to peek, half and full height) or tap it to cycle sizes.

## Guidance

Start journey opens a step list (walk, board, ride, transfer, arrive). Next/Previous are your own confirmations; the app never infers that you boarded or arrived. GPS, when allowed, adds distance hints only if accuracy is within 50 m and the fix is under 30 s old. Stop, New, a new search or choosing another route clears guidance, live panels and markers.

## Assistant box

`POST /api/assistant` understands typed or spoken requests in two ways:

- **Gemini (optional).** When a `GEMINI_API_KEY` is set, Google Gemini reads the message (typos, landmarks, other languages, follow-ups such as "same but at 9 pm" or "the way back") and turns it into one action: plan a journey, swap the trip, or reply in a sentence. Default model: `gemini-3.1-flash-lite` (free tier).
- **Built-in helper (always available).** A rule-based parser for "from Hope Farm to Majestic", "less walking", "leave at 9:30 pm", "swap". It answers whenever Gemini is off, slow, out of free quota or rejects the key, and the chat says so.

Either way, places are looked up in the BMTC stop list and journeys come from the same planner as Find routes. Gemini never supplies bus numbers, times, routes or live positions; its word answers are labelled "Gemini AI answer · may be wrong".
What is sent to Gemini: the typed message, the names of the selected stops, the selected preference/time and up to six recent chat lines. GPS coordinates are never sent. On Google's free tier, Google may use this text to improve its products.

What the chat can do (with Gemini; the built-in helper understands the simpler phrasings too):

- **Plan**: "take me frm whitefeild to majestic, less walking", then follow-ups like "same but at 9 pm" or "the way back".
- **From here**: "take me to Hoodi from here" uses one GPS reading from the browser as the start (the position goes only to this app's planner, never to Gemini).
- **Live buses**: "where is my bus?" or "when will KBS-1K come?" runs the normal live check (BMTC feed) and repeats its headline in the chat.
- **Explain options**: after a search, the "✦ Explain options" button (and Gemini-planned chats) give a two or three sentence comparison. The server rejects any summary that mentions a time, number or bus not in the options shown, so it can only rephrase the real results.

### Turning Gemini on

1. Get a free key at https://aistudio.google.com/apikey.
2. In the project folder, copy `.env.example` to `.env` and put the key after `GEMINI_API_KEY=`.
3. Start the app as usual (`run-local.cmd`). The window prints `Chat assistant: Gemini (...)`, and the chat header says "Gemini AI understands your messages".

Keep `.env` private. The web server only serves `static/`, so `.env` cannot be downloaded from the app. For a hosted deployment, set `GEMINI_API_KEY` as a secret environment variable on the host instead of uploading `.env`.
Optional: `GEMINI_MODEL` picks another Gemini model.

## Places that are not BMTC stop names

The assistant first matches BMTC stop names as written, then a very close spelling ("whitefeild"), and says in its reply what it assumed. A neighbourhood, office park or landmark with no stop of its own ("Brookefield") is looked up on OpenStreetMap (free, Bengaluru only, cached in `data/geocode_cache.json`, at most one look-up per second) and planned from that exact point, naming the nearest real stop. Nothing is guessed: an unknown place is reported as not found. Set `GEOCODER=off` to disable the online look-up.

## Gemini speed and network

Gemini is called only when the built-in reader cannot understand a message; greetings and clear commands answer at once. Calls use IPv4 first (many cloud servers have no working IPv6), allow 6 s to connect and `GEMINI_TIMEOUT` seconds (default 15) for the answer, and stop all retries within 24 s, after which the built-in helper answers. On a server, `sudo python3 scripts/check_gemini.py` checks the key, address lookup, connection, a real Gemini call and the place look-up step by step (it never prints the key).

## Journey and live panels

Both panels have a slim pinned header with a one-line summary; click it (or ▾) to fold, ⤢ to give one panel the room. On desktop, drag the handle between them (a panel squeezed below its header folds; double-click resets; the split is remembered). On phones the panels share a bottom sheet with tabs: pull it by the handle, the tabs or the header; it snaps to small (tabs + summary), half or full height, and a quick flick moves one size.

## Testing live screens without the real feed

`python scripts/simulated_bmtc_feed.py` starts a clearly labelled SIMULATION on port 8790: bus positions are invented, stop order is real. Set `BMTC_API_ROOT=http://127.0.0.1:8790/WebAPI` before `python app.py` to use it. Never use it to judge real bus locations. Opening the page with `?debug` exposes the app state as `window.__transit` for manual inspection.

## Tests

- `python -m unittest discover -s tests` (backend: journeys, departure time, search, assistant, Gemini layer with a faked Gemini, live relevance, HTTP contract and file-serving safety)
- `node tests/map-state.test.cjs`, `node tests/live-buses.test.cjs`, `node tests/journey-live.test.cjs`, `node tests/live-alternates.test.cjs` (frontend state)
- The older `tests/test_bmtc_live.py` is included in that unittest run.

These use fixtures for the BMTC feed. Real vehicle accuracy, GPS movement and the live feed itself are not covered by automated tests.
