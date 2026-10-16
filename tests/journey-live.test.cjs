// Regression tests for journey guidance, live-bus relevance and clean state. Run: node tests/journey-live.test.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function element() {
    const classes = new Set();
    const listeners = {};
    return {
        textContent: '', innerHTML: '', value: '', disabled: false, hidden: false, style: {}, children: [], dataset: {},
        classList: { add: c => classes.add(c), remove: c => classes.delete(c),
            toggle: (c, on) => { if (on === undefined ? !classes.has(c) : on) classes.add(c); else classes.delete(c); },
            contains: c => classes.has(c) },
        setAttribute() {}, removeAttribute() {}, addEventListener(name, fn) { listeners[name] = fn; },
        querySelector: () => element(), querySelectorAll: () => [], appendChild(c) { this.children.push(c); },
        prepend() {}, append() {}, focus() {}, click() { listeners.click && listeners.click({ stopPropagation() {} }); }
    };
}
const elements = new Map();
const markersCreated = [];
class Popup { setHTML(h) { this.html = h; return this; } setText(t) { this.html = t; return this; } setOffset() { return this; } remove() { return this; } }
class Marker {
    constructor({ element: el } = {}) { this.element = el || element(); markersCreated.push(this); }
    setLngLat(p) { this.point = p; return this; } setPopup(p) { this.popup = p; return this; }
    addTo() { return this; } getPopup() { return this.popup; } getElement() { return this.element; }
    getLngLat() { return { toArray: () => this.point }; } togglePopup() {} remove() { this.removed = true; }
}
let fetchImpl = async () => { throw new Error('no network in test'); };
const fetched = [];
const context = {
    console, AbortController, AbortSignal, URLSearchParams, setTimeout, clearTimeout, setInterval: () => 1, clearInterval() {},
    navigator: {}, window: { innerWidth: 1600, innerHeight: 900 },
    getComputedStyle: () => ({ display: 'block', position: 'fixed' }),
    document: { getElementById(id) { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); },
        createElement: element, querySelectorAll: () => [], querySelector: () => null, addEventListener() {} },
    maplibregl: { Popup, Marker, LngLatBounds: class { extend() {} } },
    fetch: (url, opts) => { fetched.push(String(url)); return fetchImpl(url, opts); }
};
vm.createContext(context);
vm.runInContext(fs.readFileSync('static/app.js', 'utf8').replace('\n    init();',
    '\n    globalThis.t = {state, refreshLiveBuses, stopLiveBusTracking, trackBmtcRoute, trackSearchBuses, startJourney, stopJourneyTracking, goToGuideStep, guideSteps, routeLiveScope, liveKey, applyAssistantResult, busFreshness, setRoutesCollapsed, showRoutePanel, mapPadding, planJourney, swapEndpoints, resolveTypedEndpoints};'), context);
const T = context.t;
const { state } = T;
const camera = [];
state.map = { getZoom: () => 15, easeTo: p => camera.push(p), fitBounds: p => camera.push(p), flyTo: p => camera.push(p),
    getLayer: () => null, getSource: () => null, addSource() {}, addLayer() {}, removeLayer() {}, removeSource() {},
    setPaintProperty() {}, moveLayer() {}, stop() {}, getCanvas: () => ({ style: {} }), getBearing: () => 0 };
state.mapReady = true;

const journey = { route_numbers: ['248', '410'], legs: [
    { transit: false, from: { name: 'Home' }, to: { name: 'Stop A', lat: 13.0, lon: 77.5 }, duration_minutes: 3, distance_m: 200 },
    { transit: true, route_name: '248', headsign: 'Majestic', from: { name: 'Stop A', lat: 13.0, lon: 77.5 }, to: { name: 'Hub', lat: 13.02, lon: 77.52 }, departure_time: '10:00', arrival_time: '10:20' },
    { transit: true, route_name: '410', headsign: 'Yelahanka', from: { name: 'Hub', lat: 13.02, lon: 77.52 }, to: { name: 'Dest', lat: 13.05, lon: 77.55 }, departure_time: '10:26', arrival_time: '10:50' }
], coordinates: [[77.5, 13], [77.55, 13.05]], geometry_source: 'otp' };

const bus = (id, extra = {}) => ({ id, label: `KA-${id}`, route: '248', direction: 'up', lat: 13.001, lon: 77.501,
    age_seconds: 10, relevance: 'approaching', stops_away: 2, ...extra });
const feed = (vehicles, hidden = [], extra = {}) => ({ ok: true, json: async () => ({ available: true, vehicles, hidden,
    direction: { verified: true, note: 'Matched BMTC UP branch.' }, boarding_stop: null, ...extra }) });

(async () => {
    // --- freshness is never assumed
    assert.equal(T.busFreshness({ age_seconds: 30 }), 'fresh');
    assert.equal(T.busFreshness({ age_seconds: 900 }), 'stale');
    assert.equal(T.busFreshness({ age_seconds: null }), 'unavailable');
    assert.equal(T.busFreshness({}), 'unavailable');

    // --- live scope follows the traveller's step
    assert.equal(T.routeLiveScope(journey).lines[0], '248');
    const steps = T.guideSteps(journey);
    assert.ok(steps.length >= 4, 'walk, board, ride, transfer..., arrive');

    // --- relevance rendering: matching number alone is never "suitable"
    state.liveBus.journeys = [journey];
    Object.assign(state.liveBus, { session: 5, route: '248', routes: ['248'], boardingStop: { name: 'Stop A', lat: 13, lon: 77.5 }, alightStop: null, journeyIndex: 0 });
    fetchImpl = async () => feed(
        [bus('ok'), bus('stale', { age_seconds: 900 }), bus('nots', { age_seconds: null }), bus('unv', { relevance: 'unverified', reason: 'Direction unknown' })],
        [{ label: 'KA-passed', relevance: 'passed', reason: 'already passed' }, { label: 'KA-opp', relevance: 'wrong_direction', reason: 'other way' }]);
    await T.refreshLiveBuses(5, true);
    const list = elements.get('liveBusList').innerHTML;
    assert.match(list, /Heading to your stop/);
    assert.match(list, /STALE/); assert.match(list, /NO TIMESTAMP/); assert.match(list, /FRESH/);
    assert.match(list, /Direction not verified/);
    assert.doesNotMatch(list, /<strong>KA-passed/, 'passed/opposite buses are not listed as candidates');
    assert.match(list, /1 already passed|1 hidden|2 hidden/);
    assert.ok(fetched.some(u => u.includes('stop_lat=13') && u.includes('/api/bmtc/route')), 'boarding stop is sent so the server can check direction');
    assert.equal(state.liveBus.markers.length, 4);
    assert.ok(markersCreated.some(m => m.element.className.includes('unverified')), 'unverified marker is styled differently');
    assert.ok(markersCreated.some(m => m.element.className.includes('stale')), 'stale marker is styled differently');

    // --- nothing heading our way: honest message, no markers
    fetchImpl = async () => feed([], [{ label: 'KA-opp', relevance: 'wrong_direction', reason: 'other way' }]);
    await T.refreshLiveBuses(5, true);
    assert.equal(state.liveBus.markers.length, 0, 'markers are removed when no relevant bus remains');
    assert.ok(markersCreated.filter(m => m.removed).length >= 4, 'old markers are removed from the map, not just forgotten');
    assert.match(elements.get('liveBusStatus').textContent, /No bus is heading to Stop A/);

    // --- feed unavailable: app keeps working and says so
    fetchImpl = async () => { throw new Error('BMTC live service could not be reached.'); };
    await T.refreshLiveBuses(5, true);
    assert.match(elements.get('liveBusStatus').textContent, /could not be reached.*retry/);
    assert.match(elements.get('liveBusList').innerHTML, /not affected/);
    assert.equal(state.liveBus.markers.length, 0);
    assert.equal(elements.get('liveBusRefresh').disabled, false, 'refresh button recovers after a failure');

    // --- track toggle
    T.stopLiveBusTracking();
    fetchImpl = async () => feed([]);
    const from = { name: 'Stop A', lat: 13, lon: 77.5 };
    T.trackBmtcRoute('248', journey, 0, from, null);
    assert.equal(state.liveBus.key, T.liveKey('248', from));
    T.trackBmtcRoute('248', journey, 0, from, null);
    assert.ok(!state.liveBus.route, 'pressing Track again stops tracking');
    assert.equal(elements.get('liveBusPanel').hidden, true);

    // --- guidance: stepping to the transfer re-scopes live tracking; finishing cleans everything
    fetchImpl = async () => feed([bus('x')]);
    T.startJourney(journey, 0);
    assert.equal(state.liveBus.routes[0], '248');
    let guard = 0;
    while (state.journey.active && state.liveBus.routes?.[0] === '248' && guard++ < 10) T.goToGuideStep(1);
    assert.equal(state.liveBus.routes?.[0], '410', 'live tracking switches to the transfer bus and its boarding stop');
    assert.equal(state.liveBus.boardingStop.name, 'Hub');
    T.goToGuideStep(-1);
    assert.ok(state.journey.active);
    guard = 0;
    while (state.journey.active && guard++ < 20) T.goToGuideStep(1);
    assert.equal(state.journey.active, false, 'Finish ends guidance');
    assert.ok(!state.liveBus.route, 'automatic live tracking is cleared with guidance');
    assert.equal(state.liveBus.markers.length, 0);
    assert.equal(elements.get('journeyGuide').hidden, true);
    assert.equal(elements.get('liveBusPanel').hidden, true);

    // --- Stop button mid-journey clears guidance, tracking and markers together
    T.startJourney(journey, 0);
    assert.ok(state.liveBus.route, 'journey guidance starts live tracking');
    await new Promise(r => setTimeout(r, 20));
    T.stopJourneyTracking();
    assert.ok(!state.liveBus.route && state.liveBus.markers.length === 0 && elements.get('liveBusPanel').hidden === true,
        'stopping guidance removes its live panel and markers');

    // --- results are never lost: guidance hides them, Stop brings them back, and they collapse rather than close
    const routePanel = elements.get('routePanel');
    elements.get('routeResults').children.push({});
    T.showRoutePanel();
    assert.ok(routePanel.classList.contains('open'));
    T.startJourney(journey, 0);
    assert.ok(!routePanel.classList.contains('open'), 'results make way for guidance');
    T.stopJourneyTracking();
    assert.ok(routePanel.classList.contains('open'), 'stopping guidance restores the results');
    T.setRoutesCollapsed(true);
    assert.ok(routePanel.classList.contains('collapsed') && routePanel.classList.contains('open'), 'collapse keeps the panel (header stays as the way back)');
    assert.equal(elements.get('closeRoutesBtn').textContent, '▴');
    T.showRoutePanel();
    assert.ok(!routePanel.classList.contains('collapsed'), 'showing results always expands them');
    elements.get('routeResults').children.length = 0;
    T.startJourney(journey, 0);
    T.stopJourneyTracking();
    assert.ok(!routePanel.classList.contains('open'), 'no results, nothing to restore');

    // --- typed-but-not-picked names use the best match; swap exchanges both ends and replans
    const reply = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });
    const planned = [];
    fetchImpl = async (url, opts) => {
        if (String(url).startsWith('/api/stops')) return reply({ stops: String(url).includes('Hope') ?
            [{ stop_id: '1', stop_name: 'Hope Farm', stop_lat: 12.98, stop_lon: 77.75, route_count: 100 }] : [] });
        if (String(url).startsWith('/api/plan')) { planned.push(JSON.parse(opts.body)); return reply({ routes: [], fallback: { message: 'none' } }); }
        return reply({});
    };
    state.origin = null; state.destination = null;
    elements.get('originInput').value = 'Hope'; elements.get('destinationInput').value = 'zzzz nowhere';
    await T.planJourney();
    assert.equal(state.origin?.name, 'Hope Farm', 'typed name resolved to the best BMTC stop');
    assert.equal(elements.get('originInput').value, 'Hope Farm');
    assert.equal(state.destination, null, 'an unknown name is never invented');
    assert.equal(planned.length, 0, 'no search without a real destination');
    assert.match(elements.get('statusToast').textContent, /Select both/);
    state.destination = { id: '2', name: 'Majestic', lat: 12.97, lon: 77.57 };
    elements.get('destinationInput').value = 'Majestic';
    T.swapEndpoints();
    await new Promise(r => setTimeout(r, 20));
    assert.equal(state.origin.name, 'Majestic'); assert.equal(state.destination.name, 'Hope Farm');
    assert.equal(elements.get('originInput').value, 'Majestic'); assert.equal(elements.get('destinationInput').value, 'Hope Farm');
    assert.equal(planned.at(-1)?.origin_stop_id, '2', 'swap replans with the exchanged endpoints');
    assert.equal(planned.at(-1)?.destination_stop_id, '1');

    // --- the camera leaves room for the panels that are actually on screen
    const live = elements.get('liveBusPanel');
    live.hidden = false;
    live.getBoundingClientRect = () => ({ left: 1000, top: 100, right: 1573, bottom: 700, width: 573, height: 600 });
    const pad = T.mapPadding();
    assert.ok(pad.right >= 1600 - 1000, `right padding clears the live panel (got ${pad.right})`);
    live.hidden = true;
    assert.ok(T.mapPadding().right < 100, 'padding shrinks again when the panel closes');
    assert.ok(pad.left + pad.right <= 1600 - 160 && pad.top + pad.bottom <= 900 - 160, 'never more padding than the map can hold');

    // --- assistant result replaces, never layers
    let renders = 0;
    T.applyAssistantResult({ origin: { stop_id: '1', stop_name: 'Hope Farm', stop_lat: 12.99, stop_lon: 77.75 },
        destination: { stop_id: '2', stop_name: 'Majestic', stop_lat: 12.97, stop_lon: 77.57 }, preference: 'less_walking', depart_at: '09:30', plan: null });
    assert.equal(state.origin.name, 'Hope Farm');
    assert.equal(state.destination.name, 'Majestic');
    assert.equal(state.selectedPreference, 'less_walking');
    assert.equal(state.departAt, '09:30');
    console.log('PASS: relevance, freshness, feed-down, track toggle, step re-scoping, clean finish, assistant state');
    process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
