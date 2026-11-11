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

## Everyday features

- **Journey Confidence (new)**: every route explains how robust its transfers are. It measures the timetable buffer *after* the transfer walk and, when enough evidence exists, subtracts the incoming route's typical learned delay. Each change is marked Comfortable, Tight or At risk, and the same warning follows the traveller into step-by-step guidance. Choose **🛡 Safer connections** (or ask the assistant for it) to rank robust journeys ahead of a faster but fragile connection. This is connection advice, not a promise that a service will run on time.

- **Get-off alert**: while riding, the phone vibrates and shows "Get ready: <stop> is next" one stop before the alighting stop, and "Get off here" at it (plus a system notification when allowed). It uses the planned stop list and a GPS fix; weak (over 120 m) or old fixes never trigger it. The 🔔 button in the journey panel turns it off.
- **Saved places and recent trips**: ☆ Save place stores Home, Work or a favourite in this browser only (never on the server). One tap on a saved place plans a trip there (from your location when no start is set). The assistant understands "take me home", "home to office" and similar. The last six trips are under 🕘 Recent.
- **Leave reminder**: 🔔 Remind me to leave on a journey card alerts 5 minutes before the journey's start and again at it, using the timetable. If BMTC's live feed then shows one of those buses heading to the stop, the reminder says so; otherwise it says nothing live. Reminders work while the page is open (phones may pause background pages).
- **Missed it?**: while guided to a stop, if the planned bus is more than 5 minutes past its timetable time and BMTC's latest live check (under 3 minutes old) shows none of those buses coming within 15 minutes, a banner offers the next options from that stop (or from your GPS position when you have moved away).
- **Learned reliability**: each live check stores BMTC's own scheduled and actual times at stops buses have passed (`data/reliability.db`, kept 60 days). A route's typical delay at that hour (weekdays and weekends separately) is shown on journey cards, in the live panel and in answers to "is 500D usually late?" only after at least 12 measurements on 3 different days. If BMTC's feed does not include those times, nothing is shown.
- **Share my trip**: ↗ Share sends a link that opens the same journey (and live tracking for its first bus). It carries only the two places, the time and the preference.
- **Kannada**: ☰ → Language switches the interface to Kannada, voice input to kn-IN, and asks Gemini to reply in Kannada. Stop names and bus numbers stay as BMTC writes them. A native speaker should review `static/i18n.js`.
- **Installable app**: the page can be installed from the browser (☰ → Install, or the browser's own menu). The app shell works on a poor connection; journeys, live buses and the assistant always need the server and are never served from a cache.
- **Namma Metro**: the router asks for metro legs, and journey cards, steps and live tracking handle them (metro legs are never sent to BMTC's bus feed). Metro appears in journeys only after adding the official BMRCL timetable from the DULT Transit Data Hub: `python scripts/add_metro.py path\to\bmrcl_gtfs.zip`, then rebuild the route graph (`build-otp-graph.ps1`) and restart.

## Snap & go, talk mode and your usual trip

- **Snap & go** (📷 next to the microphone, also in the chat): photograph a bus, a stop board (English or Kannada) or a written address. The page shrinks the photo and sends it once to Gemini, which reports only the text it can see; the photo is not stored. A bus starts live tracking for that route (around your location when no start is set), a stop board becomes your start, an address becomes your destination (from your location when no start is set). Places are found in the BMTC stop list / OpenStreetMap and journeys come from the normal planner. Anything unreadable is said to be unreadable. Needs GEMINI_API_KEY.
- **Talk mode** (☰ → Talk mode): a big 🎙 button to speak; answers, each journey step, stop alerts, "missed it?" and leave reminders are spoken in English or Kannada (Kannada needs a Kannada text-to-speech voice on the device; the app says so when there is none).
- **Your usual trip**: the app remembers on this device which trips you plan and start. When the same trip has happened on 3 different days at about the same time (weekdays and weekends kept apart), a card appears from an hour before that time with one-tap planning and the next live bus of the line you usually take, only from BMTC's live data. ☰ → "Forget my trip history" clears it.

## Faster, sturdier, nearby stops and costs (Nov 2026)

- **Learned delays, cleaned**: BMTC sometimes pairs a bus with the wrong timetable trip, so a run looks "76 min late" or "30 min early" from its very first stop. Such runs are now left out of every summary (raw data kept). Because delay builds up along a route, the figure for your own boarding stop is used when there is enough data there (BMTC station ids are the timetable's stop ids); the whole-route figure says "depends on the stop". Journey confidence uses the delay where you get off.
- **Smoother live buses**: a bus glides from its previous to its new REPORTED position (along its road when known; never beyond the last report; big jumps are not animated). Each marker shows how old its position is (20s, 4m) and fades as it ages.
- **Faster**: page files and big answers are gzip-compressed (app.js 254 KB -> 65 KB; a journey answer 97 KB -> 5 KB); versioned files are cached by the browser; repeat stop searches (10 min) and the same journey asked again (45 s) answer from memory; the stop index, spelling list and route engine are warmed up at start (first search 2 s -> 0.03 s).
- **Sturdier**: the page re-checks the server every 20 s while something is wrong and clears the notice when it recovers. On the public site notices are plain ("temporarily unavailable"); developer steps (run-local.cmd) appear only on your own computer. BMTC feed outages are announced.
- **Admin status page**: `/status` shows each service (BMTC, Gemini, route engine, OpenStreetMap): working or not, typical time, last error, recent errors, learned-delay data size. Open on the server's own computer; elsewhere only with `?token=` matching `STATUS_TOKEN` (set it in /etc/bengaluru-transit.env on Azure). No keys or traveller data are shown.
- **📍 Nearby stops**: one tap shows BMTC stops within 600 m, each with direction ("towards ...") and the next timetabled departures per line for the coming hour, numbered on the map; "Live buses here" starts BMTC live tracking for those lines at that stop; "Start from this stop" sets it as the start.
- **Bus vs auto vs cab** on every journey: bus fare from BMTC's fare tables (exact for AC routes and listed zone pairs; otherwise "~" = BMTC's median ordinary fare for the same distance; AC without a rule: no fare), auto from the Bengaluru meter tariff (Rs 36 first 2 km, Rs 18/km, 1.5x 22:00-05:00), cab from the Karnataka uniform taxi fare (Rs 100 first 4 km, Rs 24/km, +5% GST, +10% 00:00-06:00), road distance from the route engine's driving route, road time at TomTom 2025's measured Bengaluru average (36 min per 10 km; 41 morning rush, 45 evening rush). All labelled as estimates. The fare tables are copied from data/bmtc_gtfs.zip into the stop database at start-up, so they reach Azure with the database upload.

## Kannada, transfers, rain and honest arrival times (Nov 2026)

- **ಕನ್ನಡ everywhere**: with ☰ → ಕನ್ನಡ, every notice, live-panel line, card and step is shown in Kannada (stop names stay as BMTC writes them; numbers and times are kept exactly). The From/To suggestions also show BMTC's own Kannada stop name (9,503 official names from the timetable feed, copied into the stop database at start-up).
- **The built-in helper understands Kannada** (typed or spoken, kn-IN voice): "ಹೆಬ್ಬಾಳದಿಂದ ಮೆಜೆಸ್ಟಿಕ್‌ಗೆ", "ಇಲ್ಲಿಂದ ಜಯನಗರಕ್ಕೆ ಕಡಿಮೆ ನಡಿಗೆ", "ಸಂಜೆ 6 ಗಂಟೆಗೆ ಮನೆಗೆ", "೫೦೦-ಡಿ ಎಲ್ಲಿದೆ", "ವಿ-೫೦೦ಡಿ ತಡವಾಗಿ ಬರುತ್ತದೆಯೇ", "ವಾಪಸ್". Places are matched only against BMTC's own Kannada names (small spelling differences allowed); an unknown name is never guessed. A Kannada message always gets a Kannada answer.
- **Phone**: while routes, journey steps or live buses cover the assistant box, 🎙 and 📷 sit in the top bar (🎙 opens the chat and listens there).
- **Background delay collector**: the app asks BMTC about the 20 busiest bus numbers in turn, one route a minute, 6:00-22:00, so "usually N min late" fills in within days instead of weeks. It backs off for 10 minutes after any BMTC failure. `COLLECTOR=off` stops it; progress is on `/status`.
- **Honest arrival window**: each journey shows "Likely 10:39-10:43" when BMTC's own scheduled-vs-actual times for the last bus exist around that hour (at your stop when there is enough data, else along the route; else the spread of all measured BMTC buses at that hour). No measurements: no range, just the timetable time. "why?" lists exactly what the range is based on, and, for a risky change, when the next bus on that line is timetabled. With live tracking, BMTC's own estimate for your first bus moves the estimate.
- **Transfer guardian**: while you ride a bus with a change after it, the journey panel checks how late your bus is (GPS against the timetabled stop times, else its usual delay) against when the connecting bus will come (BMTC's live estimate for that stop, else its usual delay, else the timetable). "Looks fine / tight / you may miss it"; on a likely miss it warns once (spoken in talk mode) and offers "Find another way from <your get-off stop>" at the time you will get there. Without GPS or measurements it says nothing.
- **Rain-aware trips**: the free Open-Meteo hourly forecast for the hours of your trip. When rain is likely, a note above the options says when and how much (named as a forecast) and points at the option with the least walking. `WEATHER=off` turns it off; forecasts are cached 30 min.
- **Wait or walk**: for a short bus ride (walk up to 25 min), when walking the same stretch is quicker or about as quick as waiting for and riding the bus (BMTC's live estimate when tracking, else the timetable), the card and the journey step say so, with the fare it saves.

## Journey mode (Nov 2026)

Once a journey starts it becomes a navigation screen, in the style of Google Maps:
- **Green instruction banner**: an icon (🚶 walk, 🚏 board, 🚌 ride, 🚇 metro, 🏁 arrive), what to do now, and one live line ("142 m to go", "Scheduled 18:00 · BMTC: 328-HK in about 6 min", "3 stops to go · get down at Hope Farm", worked out from GPS against the bus's stop list), with a "THEN …" preview of the next step.
- **Arrival and progress**: "Arrive 10:42–10:51" (the honest window when measured, else the timetable time), minutes and kilometres left while the trip is under way, step dots, and chips for the change of bus and GPS trouble.
- **Big buttons**: ◀, Next step ▶ (✓ Finish on the last step).
- **Steps / Live buses / Trip info** tabs: a timeline of every step (tap one to jump to it), the buses BMTC reports heading to your next boarding stop (tap one to see it on the map), and the arrival range with its reasons, the change-of-bus check, wait-or-walk, rain and the fare.
- Wide screens show all of this as a full-height sidebar on the left; phones show the banner at the top and a bottom sheet (tap "⌃ Steps" or the handle to open the tabs, "⌄ Map" to close).
- **"☰ Full guide & live panel"** opens the earlier detailed step guide and live-bus panel; "🗺 Back to map" returns. "✕ End journey" needs a second tap.
- **The map**: the trip is drawn on top: legs already done in grey, the current leg bold blue with a white edge, later legs lighter blue, walks dotted. Buttons on the right: (🎙 on phones), ＋, －, ◎ follow me, 📍 this step, ⤢ whole trip. Pinching, dragging or zooming yourself is respected: GPS updates move only your dot while you handle the map, and a zoom you chose is kept.

## Navigation that moves by itself (Nov 2026)

With a good GPS fix (accuracy 50 m or better, under 20 s old), the journey moves on without pressing anything:
- **Walking** → when you are within ~25-40 m of the stop (or the destination), the next step starts.
- **Waiting at the stop** → when the phone is moving along the bus's own road, 200 m+ past the stop and over 150 m from it (and not at walking pace when the phone reports speed), the ride step starts: "You are on the move with 328-HK. Watch for your stop."
- **Riding** → at the get-off stop, the next step starts. The "Get ready: next stop" and "Get off here" alerts still come first.
- **Arriving** → "You have arrived" with a Finish button. Finishing is always your own tap.
- Every automatic move says what happened and has **Undo**. Going back by hand pauses automatic moves on that step for 90 s. Weak or old GPS never moves a step; Next step always works.
- **Catch the bus** (walking to a stop): "✓ 328-HK in ~8 min, 4 min walk: you will make it", "⏱ keep going" or "🏃 hurry or take the next one", from BMTC's live estimate for that stop when there is one, else the timetable.
- **Live buses at your stop** sit in the main card while you walk to and wait at the stop (route, minutes or stops away).
- **Off route** (walking 80 m+ off the walking path with a good fix): a warning with "Re-route from here", which plans again from where you are.
- The part of the trip already travelled turns grey on the map; the map follows you heading-up while you move.
- **🔈/🔊** on the map buttons turns spoken directions on or off. The screen is kept on during navigation where the browser allows it.
- **▶ Preview the trip**: on a computer without GPS (or to see what is coming), a simulated position travels the route at 15× speed, so the whole flow can be watched. A yellow PREVIEW bar is shown the whole time, notifications and lateness checks are off, and real GPS is ignored until the preview stops.

## Start journey = start navigating (Nov 2026)

Pressing Start journey now behaves like starting navigation in Google Maps:
- The app asks for your location straight away and **flies to you**: zoomed in (17), tilted, and **turned the way you are going** (your movement direction when moving; the phone's compass when standing, where available; otherwise the direction of the route just ahead).
- **You are a blue arrow** pointing the way you face, gliding smoothly between GPS updates, with a light circle showing how accurate the fix is. You sit in the lower part of the map so more of the road ahead is visible.
- **Turn-by-turn walking** from the route engine's own walking directions: "↰ Turn left onto Varthur Road · In 41 m", then "THEN Arrive at Kundalahalli Gate". Unnamed paths are called "the path", never given a made-up name.
- **Drag the map** and following pauses; a white **◎ Re-centre** button appears (bottom centre) to go back. Zooming keeps your chosen zoom while following.
- While following, the live-bus check and panel changes no longer pull the map away from you (the buses still show as markers and in the card).
- A rough network location (no GPS, e.g. a laptop) places the map once, from higher up, with a note "Approximate location (±N m): steps will not move by themselves"; it never jitters the map afterwards. Use ▶ Preview the trip to watch the full navigation on a computer.

## Trip companion (Nov 2026)

- **Stop countdown on the bus** (BMTC buses rarely announce stops): "4 stops to your stop", the next stops with their timetable times, yours marked 🏁, and the stops behind you dropped as you pass them (GPS against the bus's own stop list). Without GPS it is the plain stop list, no countdown.
- **Live arrival time**: on the bus, "Arrive ~21:58 · ~5 min late · from your GPS · timetable 21:53" (worked out from when you passed the last stop against its timetabled time); waiting for a bus, from BMTC's live estimate for it. No evidence: the timetable time.
- **Missed your stop**: more than 250 m past the get-off stop (two readings in a row, good GPS) → "You may have passed Hope Farm… Get off at the next stop" with "Find a new way from here".
- **Wrong bus / off the route**: more than 400 m off the bus's road (two readings in a row) → "This bus seems to have left your route. Check the bus number."
- **Spoken directions (🔊)**: "In 100 metres, turn left onto Varthur Road", "Turn left onto Varthur Road", "Hurry: your bus is due in about 3 minutes", "Your bus 328-HK is 2 stops away", "3 stops to Hope Farm", "Get ready: Hope Farm is next", "Get off here", the automatic step changes, "You have arrived". Each is said once, in English or Kannada.
- **🔄 Find a new way from here** at the top of Trip info, any time during a trip.

## Testing live screens without the real feed

`python scripts/simulated_bmtc_feed.py` starts a clearly labelled SIMULATION on port 8790: bus positions are invented, stop order is real. Set `BMTC_API_ROOT=http://127.0.0.1:8790/WebAPI` before `python app.py` to use it. Never use it to judge real bus locations. Opening the page with `?debug` exposes the app state as `window.__transit` for manual inspection.

## Tests

- `python -m unittest discover -s tests` (backend: journeys, departure time, search, assistant, Gemini layer with a faked Gemini, live relevance, HTTP contract and file-serving safety)
- `node --test tests/*.cjs` (frontend: map state, live buses, journey steps, everyday features, arrival window, transfer guardian, rain, wait-or-walk, Kannada page text)
- The older `tests/test_bmtc_live.py` is included in that unittest run.

These use fixtures for the BMTC feed. Real vehicle accuracy, GPS movement and the live feed itself are not covered by automated tests.
