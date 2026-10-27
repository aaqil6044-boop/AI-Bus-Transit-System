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
    '\n    globalThis.t = {state, alightAlert, missedBusCheck, leaveSchedule, shareUrl, parseShareParams, savePlace, savedPlaces, removeSavedPlace, rememberTrip, recentTrips, savedForAssistant, placeRecord, tr, guideSteps, routeLiveScope, liveComingWithin, journeyGuidance};'), context);
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

console.log('everyday-features: all checks passed');
