// Everyday features: get-off alert, missed bus, leave reminder, share links, saved places, language.
// Run: node tests/everyday-features.test.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function element() {
    const classes = new Set();
    return {
        textContent: '', innerHTML: '', value: '', disabled: false, hidden: false, style: {}, children: [], dataset: {},
        classList: { add: c => classes.add(c), remove: c => classes.delete(c),
            toggle: (c, on) => { if (on === undefined ? !classes.has(c) : on) classes.add(c); else classes.delete(c); },
            contains: c => classes.has(c) },
        setAttribute() {}, getAttribute() { return ''; }, removeAttribute() {}, addEventListener() {},
        querySelector: () => null, querySelectorAll: () => [], appendChild(c) { this.children.push(c); }, prepend() {}, append() {}, focus() {}
    };
}
const elements = new Map();
const storage = new Map();
const localStorage = { getItem: k => storage.has(k) ? storage.get(k) : null, setItem: (k, v) => storage.set(k, String(v)), removeItem: k => storage.delete(k) };
const context = {
    console, AbortController, URLSearchParams, setTimeout, clearTimeout, setInterval: () => 1, clearInterval() {},
    navigator: { geolocation: {} }, location: { origin: 'https://example.test', search: '', hostname: 'example.test', protocol: 'https:' },
    window: { innerWidth: 1600, innerHeight: 900, localStorage, addEventListener() {} },
    getComputedStyle: () => ({ display: 'block' }),
    document: { getElementById(id) { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); },
        createElement: element, querySelectorAll: () => [], querySelector: () => null, addEventListener() {}, documentElement: {} },
    maplibregl: { Popup: class {}, Marker: class { setLngLat() { return this; } addTo() { return this; } remove() {} }, LngLatBounds: class { extend() {} } },
    fetch: async () => { throw new Error('no network in test'); }
};
vm.createContext(context);
const source = fs.readFileSync('static/app.js', 'utf8');
vm.runInContext(fs.readFileSync('static/i18n.js', 'utf8'), context);
vm.runInContext(source.replace('\n    init();',
    '\n    globalThis.t = {state, alightAlert, missedBusCheck, leaveSchedule, shareUrl, parseShareParams, savePlace, savedPlaces, removeSavedPlace, rememberTrip, recentTrips, savedForAssistant, placeRecord, tr, guideSteps, routeLiveScope, liveComingWithin, journeyGuidance, usualTrip, logTrip, tripHistory, speakableText, chatText, glidePath, pointAlong, positionAge, healthMessage, compareHtml, arrivalWindow, liveArrivalShift, transferGuardian, guardianText, rainAdvice, waitOrWalk, waitOrWalkText, navSummary, navTrip, journeyProgressFeatures, alongLine, autoStep, offRoute, catchBus, previewTrack, nextManeuver, routeAheadBearing, rideStops, liveDelay, rideTrouble};'), context);
const T = context.t;
const same = (actual, expected, message) => assert.equal(JSON.stringify(actual), JSON.stringify(expected), message);
const { state } = T;

const at = (minute) => new Date(Date.UTC(2026, 9, 27, 4, minute)).toISOString();   // 09:30 IST + minute
const stop = (name, lat, lon) => ({ stop_name: name, lat, lon });
// A ride north along a road: stops every ~550 m; the traveller gets off at S5.
const stops = [0, 1, 2, 3, 4, 5].map(i => stop(`S${i}`, 12.95 + i * 0.005, 77.60));
const busLeg = { transit: true, role: 'bus', route_name: '500D', from: { name: 'S0', lat: 12.95, lon: 77.60 },
    to: { name: 'S5', lat: 12.975, lon: 77.60 }, stops, stop_count: 5, duration_minutes: 12,
    departure_time: '09:40', arrival_time: '09:52', departure_iso: at(10), arrival_iso: at(22), from_stop_id: '111' };
const route = { route_numbers: ['500D'], departure_iso: at(5), departure_time: '09:35', arrival_time: '09:55',
    legs: [{ transit: false, role: 'access_walk', from: { name: 'Home' }, to: { name: 'S0', lat: 12.95, lon: 77.60 }, duration_minutes: 5, distance_m: 300 },
        busLeg, { transit: false, role: 'egress_walk', from: { name: 'S5' }, to: { name: 'Office', lat: 12.976, lon: 77.601 }, duration_minutes: 2, distance_m: 120 }] };
const steps = T.guideSteps(route);
const rideIndex = steps.findIndex(s => s.kind === 'ride');
const boardIndex = steps.findIndex(s => s.kind === 'board');
const fix = (lat, lon, accuracy = 20, ageMs = 0) => ({ coords: { latitude: lat, longitude: lon, accuracy }, timestamp: Date.now() - ageMs });

// ---- get-off alert ----
assert.equal(T.alightAlert(route, rideIndex, fix(12.955, 77.60)), null, 'early in the ride: no alert');
assert.equal(T.alightAlert(route, rideIndex, fix(12.970, 77.60)).level, 'soon', 'at the stop before yours: get ready');
assert.equal(T.alightAlert(route, rideIndex, fix(12.9748, 77.60)).level, 'now', 'at your stop: get off');
assert.equal(T.alightAlert(route, rideIndex, fix(12.970, 77.60, 400)), null, 'a weak fix never triggers an alert');
assert.equal(T.alightAlert(route, rideIndex, fix(12.970, 77.60, 20, 120000)), null, 'an old fix never triggers an alert');
assert.equal(T.alightAlert(route, boardIndex, fix(12.970, 77.60)), null, 'only while riding');
assert.equal(T.alightAlert(route, rideIndex, fix(12.970, 77.65)), null, 'far off the bus line (5 km east): no alert');
assert.equal(T.alightAlert(route, rideIndex, fix(12.970, 77.60)).stop, 'S5');

// ---- missed bus ----
const due = Date.parse(busLeg.departure_iso);
assert.equal(T.missedBusCheck(route, boardIndex, due + 3 * 60000), null, 'within the grace period');
const missed = T.missedBusCheck(route, boardIndex, due + 8 * 60000);
assert.equal(missed.minutesLate, 8);
assert.equal(missed.line, '500D');
assert.equal(missed.liveKnown, false, 'no live data: wording must not claim BMTC said anything');
assert.equal(T.missedBusCheck(route, boardIndex, due + 8 * 60000, 6), null, 'BMTC shows one coming in 6 min: not missed');
assert.equal(T.missedBusCheck(route, boardIndex, due + 8 * 60000, 'none').liveKnown, true);
assert.ok(T.missedBusCheck(route, 0, due + 8 * 60000), 'also while still walking to the stop');
assert.equal(T.missedBusCheck(route, rideIndex, due + 30 * 60000), null, 'never while already riding');
const metroRoute = JSON.parse(JSON.stringify(route));
metroRoute.legs[1].role = 'metro';
assert.equal(T.missedBusCheck(metroRoute, boardIndex, due + 8 * 60000), null, 'metro has no BMTC live data: no missed-bus logic');
// live data only counts when recent
state.liveBus.lastShown = [{ route: '500D', relevance: 'approaching', board_eta: '2099-01-01 00:00:00', freshness: 'fresh' }];
state.liveBus.lastCheckedAt = Date.now() - 10 * 60000;
assert.equal(T.liveComingWithin(['500D']), null, 'a 10-minute-old check is not used');
state.liveBus.lastCheckedAt = Date.now();
state.liveBus.lastShown = [{ route: '500D', relevance: 'passed', board_eta: '', freshness: 'fresh' }];
assert.equal(T.liveComingWithin(['500D']), 'none');

// ---- leave reminder ----
const plan = T.leaveSchedule(route, Date.parse(at(0)));
assert.equal(plan.leaveAt, Date.parse(at(5)));
assert.equal(plan.remindAt, Date.parse(at(0)), 'reminder 5 min before, never in the past');
assert.equal(plan.possible, true);
assert.equal(T.leaveSchedule(route, Date.parse(at(5))).possible, false, 'leaving now: nothing to remind');
assert.equal(T.leaveSchedule({ legs: [] }), null, 'no time, no reminder');

// ---- share links ----
const origin = { id: '111', name: 'Hope Farm', lat: 12.984, lon: 77.752 };
const destination = { id: 'point-destination', name: 'My flat', lat: 12.95, lon: 77.70, is_map_point: true };
const url = T.shareUrl(origin, destination, { departAt: '09:30', preference: 'less_walking', bus: '500D', base: 'https://x.test' });
const parsed = T.parseShareParams(new URL(url).search);
assert.equal(parsed.origin.name, 'Hope Farm');
assert.equal(parsed.origin.id, '111');
assert.equal(parsed.origin.is_map_point, false);
assert.equal(parsed.destination.is_map_point, true);
assert.equal(parsed.destination.lat, 12.95);
assert.equal(parsed.departAt, '09:30');
assert.equal(parsed.preference, 'less_walking');
assert.equal(parsed.bus, '500D');
assert.equal(T.parseShareParams('?from=28.6,77.2&fromName=Delhi&to=12.9,77.6&toName=X'), null, 'outside Bengaluru: ignored');
assert.equal(T.parseShareParams('?from=abc&fromName=A&to=12.9,77.6&toName=X'), null, 'malformed: ignored');
const odd = T.parseShareParams('?from=12.98,77.75&fromName=A&to=12.9,77.6&toName=B&at=25:99&pref=evil&bus=<script>');
same([odd.departAt, odd.preference, odd.bus], ['', '', ''], 'bad extras are dropped, never guessed');

// ---- saved places and recent trips (this browser only) ----
assert.equal(T.savePlace('Home', destination), true);
assert.equal(T.savePlace('Home', { name: 'Elsewhere', lat: 12.9, lon: 77.6 }), true, 'saving Home again replaces it');
assert.equal(T.savedPlaces().filter(p => p.label === 'Home').length, 1);
assert.equal(T.savePlace('Work', { name: 'Delhi', lat: 28.6, lon: 77.2 }), false, 'outside Bengaluru is refused');
T.savePlace('Work', origin);
assert.deepEqual(JSON.parse(JSON.stringify(T.savedForAssistant().map(p => [p.label, p.id, p.is_map_point]))),
    [['Work', '111', false], ['Home', '', true]]);
T.removeSavedPlace('Work');
same(T.savedPlaces().map(p => p.label), ['Home']);
T.rememberTrip(origin, destination);
T.rememberTrip(origin, destination);
assert.equal(T.recentTrips().length, 1, 'the same trip is listed once');
T.rememberTrip({ name: 'My location (±12 m)', lat: 12.97, lon: 77.6, is_map_point: true }, destination);
assert.equal(T.recentTrips().length, 1, 'GPS starting points are not remembered');
storage.set('bt.saved.v1', '{broken json');
same(T.savedPlaces(), [], 'broken storage never breaks the app');

// ---- language ----
assert.equal(T.tr('Find routes'), 'Find routes');
state.lang = 'kn';
assert.equal(T.tr('Find routes'), 'ಮಾರ್ಗಗಳನ್ನು ಹುಡುಕಿ');
assert.equal(T.tr('Get off here: {stop}.', { stop: 'S5' }), 'ಇಲ್ಲಿ ಇಳಿಯಿರಿ: S5.', 'stop names are kept as BMTC writes them');
assert.equal(T.tr('Some text with no translation'), 'Some text with no translation', 'missing text stays English');
state.lang = 'en';
// every tr("...") key and every data-i18n text has a Kannada entry
const kn = context.window.BT_I18N.kn;
const keys = new Set([...source.matchAll(/\btr\("((?:[^"\\]|\\.)*)"/g)].map(m => m[1].replace(/\\"/g, '"')));
const html = fs.readFileSync('static/index.html', 'utf8');
for (const m of html.matchAll(/<([a-z0-9]+)[^>]*\bdata-i18n\b(?!-)[^>]*>([\s\S]*?)<\/\1>/g)) keys.add(m[2].trim().replace(/&amp;/g, '&'));
for (const m of html.matchAll(/(?:placeholder|title)="([^"]*)" data-i18n-(?:ph|title)/g)) keys.add(m[1]);
const missing = [...keys].filter(key => !(key in kn));
assert.deepEqual(missing, [], 'every interface text has a Kannada translation');

// ---- metro legs are never sent to BMTC's bus feed ----
const mixed = { route_numbers: ['Purple', '500D'], legs: [
    { transit: true, role: 'metro', route_name: 'Purple Line', from: { name: 'M1', lat: 12.97, lon: 77.57 }, to: { name: 'M2', lat: 12.98, lon: 77.60 } },
    { transit: true, role: 'bus', route_name: '500D', from: { name: 'B1', lat: 12.98, lon: 77.60 }, to: { name: 'B2', lat: 12.99, lon: 77.62 } }] };
assert.deepEqual(JSON.parse(JSON.stringify(T.routeLiveScope(mixed).lines)), ['500D']);
const metroSteps = T.guideSteps(mixed);
assert.match(metroSteps[0].title, /^Board the metro: Purple Line/);

// ---- guidance text mentions the alert only when it is on ----
state.journey.alertsOn = true;
assert.match(T.journeyGuidance(route, rideIndex, null).detail, /alert one stop before S5/);
state.journey.alertsOn = false;
assert.match(T.journeyGuidance(route, rideIndex, null).detail, /Stop alerts are off/);

// ---- my usual commute ----
const ist = (day, hh, mm) => Date.UTC(2026, 9, day, hh, mm) - 330 * 60000;      // a Bengaluru clock time
const home = { name: 'Hope Farm', lat: 12.984, lon: 77.752 }, work = { name: 'Silk Board', lat: 12.917, lon: 77.623 };
const trip = (day, hh, mm, extra = {}) => ({ from: home, to: work, at: ist(day, hh, mm), line: '', board: null, started: false, ...extra });
const history = [trip(26, 8, 40), trip(27, 8, 35, { line: '500D', started: true, board: { name: 'Hope Farm', lat: 12.984, lon: 77.752 } }),
    trip(28, 8, 50, { line: '500D', started: true, board: { name: 'Hope Farm', lat: 12.984, lon: 77.752 } }), trip(28, 19, 0)];
const usual = T.usualTrip(history, ist(29, 8, 20));                      // Thursday 08:20
assert.ok(usual, 'three weekdays around 08:40: a usual trip');
assert.equal(usual.usualMinute, 8 * 60 + 40);
assert.equal(usual.line, '500D', 'the bus actually taken');
assert.equal(usual.days, 3);
assert.equal(T.usualTrip(history, ist(29, 11, 0)), null, 'not at 11:00');
assert.equal(T.usualTrip(history, ist(31, 8, 20)), null, 'Saturday is kept apart from weekdays');
assert.equal(T.usualTrip(history.slice(1), ist(29, 8, 20)), null, 'two days are not a habit');
assert.equal(T.usualTrip([trip(26, 8, 40), trip(26, 8, 45), trip(26, 8, 50)], ist(29, 8, 20)), null, 'three times on one day is not a habit');
// logging: one entry per trip per half hour; Start adds the bus
storage.delete('bt.trips.v1');
T.logTrip(home, work, { at: ist(29, 8, 30) });
T.logTrip(home, work, { at: ist(29, 8, 35), started: true, line: '500D', board: { name: 'Hope Farm', lat: 12.984, lon: 77.752 } });
same(T.tripHistory().map(item => [item.line, item.started]), [['500D', true]]);
T.logTrip({ name: 'My location (±9 m)', lat: 12.97, lon: 77.6, is_map_point: true }, work);
assert.equal(T.tripHistory().length, 1, 'GPS starts are not stored');

// ---- talk mode text ----
assert.equal(T.speakableText('🚌 Board 500D → Hebbal'), 'Board 500D to Hebbal');
assert.equal(T.chatText({ childNodes: [{ nodeType: 3, textContent: 'Answer.' }, { nodeType: 1, textContent: 'tag' }], textContent: 'Answer.tag' }), 'Answer.');

// ---- smooth live buses: glide only between reported positions ----
const road = [[77.600, 12.950], [77.602, 12.950], [77.604, 12.950], [77.604, 12.952], [77.604, 12.954]];   // east, then north
const glide = T.glidePath([77.6005, 12.950], [77.604, 12.9535], road);
assert.ok(glide.length > 2, 'follows the road round the corner');
assert.ok(glide.some(p => p[0] === 77.604 && p[1] === 12.950), 'passes the corner, not a diagonal');
same(T.glidePath([77.6005, 12.951], [77.6035, 12.9535], road).length, 2, 'off the road: straight line');
assert.equal(T.glidePath([77.60, 12.95], [77.70, 12.95], road), null, 'a 10 km jump is not animated');
assert.equal(T.glidePath([77.60, 12.95], [77.60, 12.95], road), null, 'no movement, no animation');
same(T.glidePath([77.604, 12.9535], [77.6005, 12.950], road).length, 2, 'moving backwards on the path is not drawn along it');
const mid = T.pointAlong([[77.60, 12.95], [77.62, 12.95]], 0.5);
assert.ok(Math.abs(mid[0] - 77.61) < 1e-9 && mid[1] === 12.95);
same(T.pointAlong([[77.6, 12.9], [77.7, 12.9]], 1), [77.7, 12.9]);
const now = Date.now();
same(T.positionAge(now - 20000, now), { badge: '20s', level: 'fresh' });
same(T.positionAge(now - 4 * 60000, now), { badge: '4m', level: 'aging' });
same(T.positionAge(now - 12 * 60000, now), { badge: '12m', level: 'old' });
same(T.positionAge(now - 2 * 3600000, now), { badge: '2h', level: 'very-old' });
same(T.positionAge(NaN, now), { badge: '', level: 'unknown' });

// ---- outage notices: developer steps locally, plain words on the public site ----
const healthy = { build: 'B1', database: true, router: true, services: { bmtc: 'ok' } };
assert.equal(T.healthMessage(healthy, 'B1', false), '');
assert.match(T.healthMessage({ ...healthy, router: false }, 'B1', true), /run-local\.cmd/);
const publicText = T.healthMessage({ ...healthy, router: false }, 'B1', false);
assert.match(publicText, /temporarily unavailable/);
assert.doesNotMatch(publicText, /run-local|cmd|python/, 'no developer instructions for the public');
assert.match(T.healthMessage({ ...healthy, build: 'B0' }, 'B1', false), /new version/);
assert.match(T.healthMessage({ ...healthy, services: { bmtc: 'down' } }, 'B1', false), /live bus feed/);
assert.equal(T.healthMessage(null, 'B1', false), '');

// ---- bus vs auto vs cab row ----
const cmp = { road_km: 22.1, road_distance: 'road', auto: { fare: 398, minutes: 80, night: false }, cab: { fare: 562, minutes: 80 }, sources: ['Auto: tariff'] };
const exactRow = T.compareHtml({ total_elapsed_minutes: 92, bus_fare: { total: 45, exact: true } }, cmp);
assert.match(exactRow, /₹45/);
assert.doesNotMatch(exactRow, /~₹45/, 'an exact BMTC fare has no ~');
assert.match(exactRow, /~₹398/);
assert.match(exactRow, /saves about ₹353/);
assert.match(T.compareHtml({ bus_fare: { total: 30, exact: false } }, cmp), /~₹30/, 'an estimated fare is marked ~');
assert.match(T.compareHtml({ bus_fare: { total: null } }, cmp), /fare not in BMTC data/);
assert.equal(T.compareHtml({ transit: false }, cmp), '', 'walking-only option: no comparison');
assert.equal(T.compareHtml({ bus_fare: { total: 30 } }, null), '');

// ---- honest arrival window ----
const sched = '2026-11-07T09:40:00+05:30';
const measured = { arrival_window: { scheduled: '09:40', scheduled_iso: sched, line: '500-D', stop: 'Hebbala', basis: 'stop',
    low: -2, high: 9, samples: 30, days: 5, period: 'weekdays', earliest_iso: '2026-11-07T09:38:00+05:30', latest_iso: '2026-11-07T09:49:00+05:30',
    missed: [{ line: 'KIA-9', stop: 'Hebbala', next: '09:55', later_minutes: 20, status: 'risky' }] } };
const win = T.arrivalWindow(measured);
assert.equal(win.label, 'Likely 09:38–09:49');
assert.ok(win.ranged);
assert.match(win.why[0], /500-D at Hebbala: usually between 2 min early and 9 min late .*30 BMTC measurements over 5 days/);
assert.match(win.why[1], /If you miss the KIA-9 at Hebbala, the next one is timetabled at 09:55 \(about 20 min later\)/);
const bare = T.arrivalWindow({ arrival_window: { scheduled: '09:40', scheduled_iso: sched, line: '500-D', basis: 'timetable', missed: [] } });
assert.equal(bare.label, 'Timetable 09:40 · no measured range yet', 'no measurements: no invented range');
assert.ok(!bare.ranged);
assert.equal(T.arrivalWindow({}), null);
// BMTC's live estimate for the first bus moves the estimate; only an approaching bus on the same line counts.
const firstLeg = { transit: true, route_name: '500-D', departure_iso: '2026-11-07T09:10:00+05:30', from: { name: 'Hope Farm' } };
const realNow = Date.now;
Date.now = () => new Date('2026-11-07T09:05:00+05:30').getTime();
const approachingBus = { relevance: 'approaching', route: '500-D', freshness: 'fresh', board_eta: '2026-11-07 09:17:00' };
const shift = T.liveArrivalShift({ legs: [firstLeg] }, [approachingBus, { ...approachingBus, route: '335-E', board_eta: '2026-11-07 09:11:00' }]);
Date.now = realNow;
if (shift) {           // the test machine's clock zone decides how "2026-11-07 09:17" is read; only check when it is IST
    assert.equal(shift.shift, 7);
    const moved = T.arrivalWindow(measured, shift);
    assert.equal(moved.label, 'Likely around 09:47 (BMTC live estimate)');
    assert.match(moved.why[0], /BMTC estimates your 500-D at Hope Farm at 09:17 \(7 min late against the timetable\)/);
}
assert.equal(T.liveArrivalShift({ legs: [firstLeg] }, [{ ...approachingBus, relevance: 'passed' }]), null, 'a bus past the stop is not an estimate');

// ---- transfer guardian ----
const IST_ = (hm) => `2026-11-07T${hm}:00+05:30`;
const feeder = { transit: true, role: 'bus', route_name: '328-HK', from: { name: 'A', lat: 12.95, lon: 77.60 },
    to: { name: 'Hope Farm', lat: 12.98, lon: 77.60 }, to_stop_id: '20836', departure_iso: IST_('09:00'), arrival_iso: IST_('09:20'),
    stops: [{ time: '09:00', lat: 12.95, lon: 77.60 }, { time: '09:10', lat: 12.965, lon: 77.60 }, { time: '09:20', lat: 12.98, lon: 77.60 }], stop_count: 2 };
const transferWalk = { transit: false, role: 'transfer_walk', duration_minutes: 2, from: { name: 'Hope Farm' }, to: { name: 'Hope Farm' } };
const connecting = { transit: true, role: 'bus', route_name: '304-VB', also_served_by: ['304-V'], from: { name: 'Hope Farm', lat: 12.9801, lon: 77.60 },
    to: { name: 'Tin Factory' }, departure_iso: IST_('09:26'), arrival_iso: IST_('09:50') };
const twoBus = { legs: [feeder, transferWalk, connecting] };
const twoSteps = T.guideSteps(twoBus);
const rideStep = twoSteps.findIndex(s => s.kind === 'ride');
const fixAt = (lat, at) => ({ coords: { latitude: lat, longitude: 77.60, accuracy: 20 }, timestamp: at });
// GPS at the 09:10 stop at 09:18 -> 8 min late -> reach Hope Farm 09:28 + 2 min walk > 09:26: likely miss.
let when = Date.parse(IST_('09:18'));
let guard = T.transferGuardian(twoBus, rideStep, fixAt(12.965, when), when);
assert.equal(guard.level, 'miss');
assert.equal(guard.late, 8);
assert.equal(guard.lateFrom, 'gps');
assert.equal(guard.dueFrom, 'timetable');
assert.equal(guard.arrive, '09:28');
same(guard.replan, { stop: { id: '20836', name: 'Hope Farm', lat: 12.98, lon: 77.60 }, at: '09:28' });
assert.match(T.guardianText(guard), /You may miss the 304-VB at Hope Farm: you reach it about 09:28 \(8 min late, from your GPS\) and it is due at 09:26 \(timetable\)/);
// On time by GPS: 4 min to spare.
when = Date.parse(IST_('09:10'));
guard = T.transferGuardian(twoBus, rideStep, fixAt(12.965, when), when);
assert.equal(guard.level, 'ok');
assert.equal(guard.spare, 4);
// BMTC says the connecting bus (or one running the same stretch) is itself late: the change is saved.
when = Date.parse(IST_('09:18'));
const lateBus = { relevance: 'approaching', route: '304-V', freshness: 'fresh', board_eta: '2026-11-07 09:33:00' };
guard = T.transferGuardian(twoBus, rideStep, fixAt(12.965, when), when, [lateBus], { name: 'Hope Farm' });
if (new Date(2026, 10, 7, 9, 33).getTime() === Date.parse(IST_('09:33'))) {   // only meaningful when the clock zone is IST
    assert.equal(guard.dueFrom, 'live');
    assert.equal(guard.level, 'ok');
}
assert.equal(T.transferGuardian(twoBus, rideStep, fixAt(12.965, when), when, [lateBus], { name: 'Somewhere else' }).dueFrom, 'timetable',
    'live estimates for another stop are not used');
// No GPS and nothing measured: no claim at all.
assert.equal(T.transferGuardian(twoBus, rideStep, null, when), null);
// Usual delay of the feeder at the change stop is used when there is no GPS.
const usualFeeder = { legs: [{ ...feeder, arrival_reliability: { typical_delay_minutes: 6 } }, transferWalk, connecting] };
assert.equal(T.transferGuardian(usualFeeder, rideStep, null, when).level, 'miss');
// Last bus, or not riding: nothing to guard.
assert.equal(T.transferGuardian(route, rideIndex, fix(12.965, 77.60)), null);
assert.equal(T.transferGuardian(twoBus, twoSteps.findIndex(s => s.kind === 'board'), fixAt(12.95, when), when), null);

// ---- rain-aware trips ----
const wet = { wet: true, max_mm: 3.2, max_probability: 80, wettest_hour: '18:00' };
const rainy = T.rainAdvice([{ route_numbers: ['500-D'], walking_minutes: 14 }, { route_numbers: ['KIA-9', '335-E'], walking_minutes: 4 },
    { transit: false, walking_minutes: 0 }], wet);
assert.equal(rainy.leastIndex, 1, 'the bus option with the least walking (a walk-only option does not count)');
assert.match(rainy.text, /Rain likely around 18:00 \(80%, up to 3.2 mm\/h · Open-Meteo forecast\)/);
assert.match(rainy.tip, /Least walking: option 2 \(4 min on foot\)/);
assert.equal(T.rainAdvice([{ walking_minutes: 3 }], { wet: false }), null, 'dry: nothing to say');
assert.equal(T.rainAdvice([{ walking_minutes: 3 }], null), null, 'no forecast: nothing to say');

// ---- wait or walk ----
const hop = { transit: true, role: 'bus', route_name: '328-HK', from: { name: 'White Field Post Office', lat: 12.9706, lon: 77.75 },
    to: { name: 'Hope Farm', lat: 12.9838, lon: 77.7519 }, distance_m: 1556, duration_minutes: 6, wait_before_minutes: 18,
    departure_iso: '2026-11-07T09:09:00+05:30', fare: { amount: 6, exact: false } };
const hopAdvice = T.waitOrWalk(hop);
assert.equal(hopAdvice.verdict, 'walk', '21 min on foot beats 18 min wait + 6 min ride');
assert.equal(hopAdvice.walk, 21);
assert.equal(hopAdvice.bus, 24);
assert.match(T.waitOrWalkText(hopAdvice), /Walking to Hope Farm may be quicker: about 21 min on foot \(1.6 km\) against about 24 min waiting for and riding the 328-HK \(timetable\), and saves ~₹6/);
assert.equal(T.waitOrWalk({ ...hop, wait_before_minutes: 2 }), null, 'the bus is clearly quicker: say nothing');
assert.equal(T.waitOrWalk({ ...hop, distance_m: 9000 }), null, 'long stretches are never suggested on foot');
assert.equal(T.waitOrWalk({ ...hop, role: 'metro' }), null);
// BMTC's live estimate replaces the timetable wait.
const liveAdvice = T.waitOrWalk(hop, { now: Date.parse('2026-11-07T09:00:00+05:30'), liveAt: Date.parse('2026-11-07T09:16:00+05:30') });
assert.equal(liveAdvice.source, 'live');
assert.equal(liveAdvice.bus, 22);
assert.equal(liveAdvice.verdict, 'either');
// A bus that loops: the walk uses 1.3 x the straight line, not the bus's long road distance.
const loop = T.waitOrWalk({ ...hop, to: { name: 'Near', lat: 12.979, lon: 77.75 }, distance_m: 6000, wait_before_minutes: 25 });
assert.equal(loop.km, '1.2');
assert.equal(loop.verdict, 'walk');

// ---- journey mode card ----
let nav = T.navSummary(twoBus, rideStep, fixAt(12.965, Date.parse(IST_('09:10'))), Date.parse(IST_('09:10')));
assert.equal(nav.icon, '🚌');
assert.equal(nav.title, 'Ride 328-HK to Hope Farm');
assert.equal(nav.line, 'Next stop: get down at Hope Farm', 'GPS at the middle stop: one stop left');
assert.ok(nav.chips.some(chip => chip.kind === 'ok' && /Change looks fine/.test(chip.text)), 'transfer guardian shows as a chip');
assert.equal(nav.step, rideStep + 1);
nav = T.navSummary(twoBus, rideStep, null, Date.parse(IST_('09:10')));
assert.equal(nav.line, 'Get down at Hope Farm · scheduled —', 'no GPS: the timetable stop, never a guessed count');
assert.ok(nav.chips.some(chip => chip.kind === 'gps'), 'no GPS fix is said plainly');
const boardStep = twoSteps.findIndex(s => s.kind === 'board');
nav = T.navSummary(twoBus, boardStep, null, Date.parse(IST_('08:55')));
assert.equal(nav.icon, '🚏');
assert.match(nav.line, /^Scheduled /);
const lastStep = twoSteps.length - 1;
assert.ok(T.navSummary(twoBus, lastStep, null).last);
assert.equal(T.navSummary(twoBus, 99, null), null);

// ---- journey sidebar / sheet: arrival, what is left, the next step, the step list ----
const tripLegs = { ...twoBus, departure_iso: IST_('09:00'), arrival_iso: IST_('09:50'), arrival_time: '09:50',
    legs: [{ ...feeder, distance_m: 4000, coordinates: [[77.60, 12.95], [77.60, 12.98]] }, { ...transferWalk, to: { name: 'Hope Farm', lat: 12.9801, lon: 77.6001 }, distance_m: 120, coordinates: [[77.60, 12.98], [77.6001, 12.9801]] },
           { ...connecting, distance_m: 8000, coordinates: [[77.6001, 12.9801], [77.65, 13.0]] }] };
let navTripResult = T.navTrip(tripLegs, rideStep, Date.parse(IST_('09:10')));
assert.equal(navTripResult.arrive, '09:50');
assert.equal(navTripResult.left, '40 min · 12.1 km left', 'during the trip: minutes to arrival and distance from this leg on');
assert.ok(navTripResult.then && /Walk|Board/.test(navTripResult.then.text), 'the next step is previewed');
assert.equal(JSON.stringify(navTripResult.steps.map(s => s.status).slice(0, rideStep + 1)), JSON.stringify([...Array(rideStep).fill('done'), 'now']));
navTripResult = T.navTrip(tripLegs, rideStep, Date.parse('2026-11-07T20:00:00+05:30'));
assert.equal(navTripResult.left, '50 min trip · 12.1 km', 'trip not under way: its total length, never a countdown');
const drawn = T.journeyProgressFeatures(tripLegs, rideStep);
assert.equal(JSON.stringify(drawn.features.map(f => [f.properties.status, f.properties.kind])), JSON.stringify([['now', 'bus'], ['next', 'walk'], ['next', 'bus']]));
assert.equal(T.journeyProgressFeatures(tripLegs, twoSteps.length - 1).features.map(f => f.properties.status).join(), 'done,done,now', 'arriving: earlier legs done, the last one still highlighted');

// ---- navigation engine: steps move on by GPS, off-route, catch the bus, preview ----
const line2 = T.alongLine([[77.60, 12.95], [77.60, 12.96]], [77.6005, 12.955]);
assert.ok(Math.abs(line2.along - 556) < 5 && Math.abs(line2.offset - 54) < 3 && Math.abs(line2.length - 1112) < 5, JSON.stringify(line2));
const navSteps = T.guideSteps(tripLegs);
const kinds = navSteps.map(s => s.kind).join(',');
const boardIdx = navSteps.findIndex(s => s.kind === 'board'), rideIdx = navSteps.findIndex(s => s.kind === 'ride');
const walkIdx = navSteps.findIndex(s => s.kind === 'walk');
const gpsAt = (lat, lon, accuracy = 10, ts = Date.now()) => ({ coords: { latitude: lat, longitude: lon, accuracy }, timestamp: ts });
// Board: still at the stop -> stay; moving along the bus road 300 m on -> on board.
assert.equal(T.autoStep(tripLegs, boardIdx, gpsAt(12.9501, 77.60)), null, kinds);
assert.equal(T.autoStep(tripLegs, boardIdx, gpsAt(12.953, 77.60)).reason, 'onboard');
assert.equal(T.autoStep(tripLegs, boardIdx, { coords: { latitude: 12.953, longitude: 77.60, accuracy: 10, speed: 1.3 }, timestamp: Date.now() }), null,
    'walking pace along the bus road: not on the bus yet');
assert.equal(T.autoStep(tripLegs, boardIdx, gpsAt(12.953, 77.60, 120)), null, 'weak GPS never moves a step');
assert.equal(T.autoStep(tripLegs, boardIdx, gpsAt(12.953, 77.60, 10, Date.now() - 60000)), null, 'old GPS never moves a step');
assert.equal(T.autoStep(tripLegs, boardIdx, gpsAt(12.953, 77.605)), null, 'far from the bus road: not on the bus');
// Ride: mid-way -> stay; at the get-off stop -> next step.
assert.equal(T.autoStep(tripLegs, rideIdx, gpsAt(12.965, 77.60)), null);
const off = T.autoStep(tripLegs, rideIdx, gpsAt(12.9799, 77.60));
assert.equal(off.reason, 'alighted');
assert.equal(off.to, rideIdx + 1);
// Walk: at the next stop -> next step; far off the walking path -> off route.
assert.equal(T.autoStep(tripLegs, walkIdx, gpsAt(12.9801, 77.6001)).reason, 'reached');
assert.equal(T.autoStep(tripLegs, walkIdx, gpsAt(12.9798, 77.6000)), null, '~35 m short is not there yet');
assert.ok(T.offRoute(tripLegs, walkIdx, gpsAt(12.982, 77.602)) > 80);
assert.equal(T.offRoute(tripLegs, walkIdx, gpsAt(12.98005, 77.60005)), null);
assert.equal(T.autoStep(tripLegs, navSteps.length - 1, gpsAt(13.0, 77.65)), null, 'arriving is always the traveller\'s own Finish');
// Catch the bus while walking to the stop: timetable when there is no live estimate.
const walkFirst = { ...tripLegs, legs: [{ transit: false, role: 'access_walk', duration_minutes: 6, distance_m: 450, from: { name: 'Home' }, to: { name: 'A' },
    coordinates: [[77.596, 12.95], [77.60, 12.95]] }, ...tripLegs.legs] };
const wf = T.guideSteps(walkFirst);
let catching = T.catchBus(walkFirst, 0, gpsAt(12.95, 77.596, 10, Date.parse(IST_('08:55'))), Date.parse(IST_('08:55')));
assert.equal(catching.source, 'timetable');
assert.equal(catching.due, 5);
assert.equal(catching.level, 'miss', '5 min to the bus, 6 min on foot: ' + JSON.stringify(catching));
assert.equal(T.catchBus(walkFirst, 0, null, Date.parse(IST_('08:53'))).level, 'tight', '7 min to the bus, 6 min on foot');
catching = T.catchBus(walkFirst, 0, null, Date.parse(IST_('08:40')));
assert.equal(catching.level, 'ok');
assert.equal(T.catchBus(walkFirst, 0, null, Date.parse(IST_('06:00'))), null, 'hours away: nothing to say');
assert.equal(T.catchBus(walkFirst, 1, null, Date.parse(IST_('08:40'))), null, 'only while walking to a stop');
// Preview: walks slowly, waits at the stop, rides faster; ends at the destination.
const track = T.previewTrack(tripLegs);
assert.ok(track.length > 3);
assert.ok(track.some(item => item.wait), 'waits at the boarding stop');
const lastPoint = track[track.length - 1].point;
assert.ok(Math.abs(lastPoint[0] - 77.65) < 1e-9 && Math.abs(lastPoint[1] - 13.0) < 1e-9);

// Travelled part of the current leg turns grey.
const split = T.journeyProgressFeatures(tripLegs, rideIdx, gpsAt(12.965, 77.60));
assert.equal(split.features.map(f => f.properties.status).join(), 'done,now,next,next');
assert.ok(Math.abs(split.features[0].geometry.coordinates.at(-1)[1] - 12.965) < 1e-6, 'cut where the traveller is');

// ---- turn-by-turn walking ----
const walkLeg = { transit: false, to: { name: 'Hope Farm' }, coordinates: [[77.70, 12.95], [77.70, 12.952], [77.702, 12.952]],
    walk_steps: [{ direction: 'DEPART', street: 'sidewalk', named: false, distance: 222, lat: 12.95, lon: 77.70 },
                 { direction: 'RIGHT', street: 'Whitefield Road', named: true, distance: 217, lat: 12.952, lon: 77.70 }] };
let turn = T.nextManeuver(walkLeg, gpsAt(12.9505, 77.70));
assert.equal(turn.text, 'Turn right onto Whitefield Road');
assert.equal(turn.icon, '↱');
assert.ok(Math.abs(turn.meters - 167) < 5, String(turn.meters));
assert.equal(turn.then, 'Arrive at Hope Farm');
turn = T.nextManeuver(walkLeg, gpsAt(12.952, 77.701));
assert.equal(turn.text, 'Arrive at Hope Farm', 'past the last turn: the destination');
assert.ok(Math.abs(turn.meters - 108) < 5, String(turn.meters));
turn = T.nextManeuver(walkLeg, null);
assert.equal(turn.text, 'Head along the path', 'no GPS: the first instruction; unnamed ways are "the path"');
assert.equal(turn.meters, null);
assert.equal(T.nextManeuver({ ...walkLeg, walk_steps: [] }, null), null);
// Map turned the way you go: walking north on the first part of the leg -> ~0 degrees.
const walkRoute = { legs: [walkLeg] };
const ahead = T.routeAheadBearing(walkRoute, 0, [77.70, 12.9505]);
assert.ok(ahead !== null && (ahead < 3 || ahead > 357), String(ahead));

// ---- on the bus: stop countdown, lateness, missed stop ----
// tripLegs' first ride: stops at 09:00 (12.95), 09:10 (12.965), 09:20 (12.98), along a straight road.
let ride = T.rideStops(tripLegs, rideIdx, gpsAt(12.968, 77.60, 10, Date.parse(IST_('09:16'))), Date.parse(IST_('09:16')));
assert.equal(ride.stops.map(s => s.status).join(), 'passed,passed,getoff', 'past the 09:10 stop: yours is next');
assert.equal(ride.left, 1);
assert.equal(ride.late, 6, 'passed the 09:10 stop by 09:16: about 6 min late');
ride = T.rideStops(tripLegs, rideIdx, gpsAt(12.955, 77.60, 10, Date.parse(IST_('09:03'))), Date.parse(IST_('09:03')));
assert.equal(ride.stops.map(s => s.status).join(), 'passed,next,getoff');
assert.equal(ride.late, null, 'only the first stop behind: no lateness claim');
ride = T.rideStops(tripLegs, rideIdx, null);
assert.equal(ride.left, null, 'no GPS: the stop list with timetable times, no countdown');
assert.equal(T.rideStops(tripLegs, boardIdx, null), null);
assert.equal(T.liveDelay(tripLegs, rideIdx, gpsAt(12.968, 77.60, 10, Date.parse(IST_('09:16'))), Date.parse(IST_('09:16'))).minutes, 6);
assert.equal(T.liveDelay(tripLegs, rideIdx, null), null, 'no evidence: no delay');
assert.equal(T.rideTrouble(tripLegs, rideIdx, gpsAt(12.968, 77.60)), null);
assert.equal(T.rideTrouble(tripLegs, rideIdx, gpsAt(12.9835, 77.60)).kind, 'passed', '~390 m beyond the get-off stop');
assert.equal(T.rideTrouble(tripLegs, rideIdx, gpsAt(12.965, 77.61)).kind, 'off', '~1 km off the bus road');
assert.equal(T.rideTrouble(tripLegs, rideIdx, gpsAt(12.965, 77.61, 300)), null, 'weak GPS: no alarm');

console.log('everyday-features: all checks passed');
