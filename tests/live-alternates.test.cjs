// Regression tests: "Check buses" shows the selected journey's buses AND alternate options, kept apart. Run: node tests/live-alternates.test.cjs
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
    constructor({ element: el, offset } = {}) { this.element = el || element(); this.offset = offset; markersCreated.push(this); }
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
    '\n    globalThis.t = {state, refreshLiveBuses, stopLiveBusTracking, trackBmtcRoute, trackSearchBuses, startJourney, stopJourneyTracking, goToGuideStep, guideSteps, routeLiveScope, liveKey, applyAssistantResult, busFreshness, setRoutesCollapsed, showRoutePanel, mapPadding, planJourney, swapEndpoints, resolveTypedEndpoints, routeAlternates, routeDetourNote, routeLiveScope, liveKey, parseBmtcTime, boardEtaMinutes, setRoutesExpanded, setRoutesCollapsed};'), context);
const T = context.t;
const { state } = T;
const camera = [];
state.map = { getZoom: () => 15, easeTo: p => camera.push(p), fitBounds: p => camera.push(p), flyTo: p => camera.push(p),
    getLayer: () => null, getSource: () => null, addSource() {}, addLayer() {}, removeLayer() {}, removeSource() {},
    setPaintProperty() {}, moveLayer() {}, stop() {}, getCanvas: () => ({ style: {} }), getBearing: () => 0 };
state.mapReady = true;


const mk = (name, line, fromName, lat, lon) => ({ route_numbers: [line], legs: [
    { transit: true, route_name: line, from: { name: fromName, lat, lon }, to: { name: 'Dest', lat: 13.1, lon: 77.6 } }],
    coordinates: [[lon, lat], [77.6, 13.1]], geometry_source: 'otp' });
const A = mk('A', '500D', 'Stop One', 13.0, 77.5);
const B = mk('B', '335E', 'Stop Two', 13.01, 77.51);
const C = mk('C', '500D', 'Stop One', 13.0, 77.5);      // same line + stop as A: must not be polled twice
const D = mk('D', '201', 'Stop Three', 13.02, 77.52);
const walkOnly = { transit: false, legs: [{ transit: false, from: { name: 'x' }, to: { name: 'y' } }], route_numbers: [] };
state.lastPlan = { routes: [A, B, C, walkOnly, D] };

const bus = (id, route, lat, lon, extra = {}) => ({ id, label: `KA-${id}`, route, direction: 'up', lat, lon,
    age_seconds: 10, relevance: 'approaching', stops_away: 1, ...extra });
const answer = (vehicles, hidden = []) => ({ ok: true, json: async () => ({ available: true, vehicles, hidden,
    direction: { verified: true, note: 'ok' }, boarding_stop: null }) });

(async () => {
    // alternates: other transit options, distinct line+stop, none for the selected one itself
    const alts = T.routeAlternates(A);
    assert.equal(JSON.stringify(alts.map(a => a.line)), JSON.stringify(['335E', '201']), 'dupe of selected and walk-only options are skipped');
    assert.equal(alts[0].boardingStop.name, 'Stop Two');
    assert.equal(alts[0].optionNumber, 2);

    // each line is queried with ITS OWN boarding stop
    fetchImpl = async (url) => {
        const q = new URL(url, 'http://x').searchParams;
        if (q.get('q') === '500D') return answer([bus('m1', '500D', 13.001, 77.501)]);
        if (q.get('q') === '335E') return answer([bus('a1', '335E', 13.011, 77.511), bus('far', '335E', 14.5, 78.5, { relevance: 'unverified' })]);
        throw new Error('down');                                   // '201' feed fails
    };
    T.trackSearchBuses(['500D'], [A], false, { name: 'Stop One', lat: 13.0, lon: 77.5 }, null, alts);
    await new Promise(r => setTimeout(r, 30));
    const urls = fetched.map(u => new URL(u, 'http://x').searchParams);
    const altQuery = urls.find(q => q.get('q') === '335E');
    assert.equal(altQuery.get('stop_lat'), '13.01', 'alternate polled against its own boarding stop');
    assert.equal(urls.find(q => q.get('q') === '500D').get('stop_lat'), '13');
    const html = elements.get('liveBusList').innerHTML;
    assert.match(html, /KA-m1/);
    assert.match(html, /live-alternates/, 'alternates have their own section');
    assert.match(html, /Alternate option 2/);
    assert.match(html, /KA-a1/);
    assert.doesNotMatch(html, /KA-far/, 'a far-away unverified alternate bus is not shown');
    assert.ok(html.indexOf('KA-m1') < html.indexOf('live-alternates'), 'selected journey first');
    const status = elements.get('liveBusStatus').textContent;
    const meta = elements.get('liveBusMeta').textContent;
    assert.equal(status, '1 bus heading to Stop One', 'headline is short and counts only the selected journey');
    assert.match(meta, /\+1 bus on other options/);
    assert.match(meta, /some unavailable/, 'a failing alternate feed is reported, not hidden');
    assert.ok(status.length < 60, 'no wall of text in the headline');
    const altMarker = markersCreated.filter(m => /alternate/.test(m.element.className));
    assert.equal(altMarker.length, 1);

    // same vehicle reported for both: the selected journey keeps it
    T.stopLiveBusTracking();
    fetchImpl = async () => answer([bus('same', 'X', 13.001, 77.501)]);
    T.trackSearchBuses(['500D'], [A], false, { name: 'Stop One', lat: 13, lon: 77.5 }, null, alts.slice(0, 1));
    await new Promise(r => setTimeout(r, 30));
    const h2 = elements.get('liveBusList').innerHTML;
    assert.equal((h2.match(/KA-same/g) || []).length >= 1, true);
    assert.doesNotMatch(h2, /Alternate option 2 · boards/, 'duplicate vehicle is not listed again as an alternate');

    // buses BMTC reports at the same spot are fanned out so each can be seen and tapped
    T.stopLiveBusTracking();
    markersCreated.length = 0;
    fetchImpl = async () => answer([bus('s1', '500D', 13.001, 77.501), bus('s2', '500D', 13.001, 77.501), bus('s3', '500D', 13.001, 77.501)]);
    T.trackSearchBuses(['500D'], [A], false, { name: 'Stop One', lat: 13, lon: 77.5 }, null, []);
    await new Promise(r => setTimeout(r, 30));
    const offsets = markersCreated.filter(m => /live-bus-marker/.test(m.element.className)).map(m => String(m.offset));
    assert.equal(offsets.length, 3);
    assert.equal(new Set(offsets).size, 3, 'stacked buses get distinct offsets');

    // guidance mode never adds alternates; stopping clears them
    T.stopLiveBusTracking();
    T.trackSearchBuses(['500D'], [A], true, { name: 'Stop One', lat: 13, lon: 77.5 }, null, alts);
    assert.equal(state.liveBus.alternates.length, 0);
    T.stopLiveBusTracking();
    assert.equal(state.liveBus.alternates.length, 0);
    // other bus numbers that run the same stretch are checked too, against the SAME stops, and labelled
    T.stopLiveBusTracking();
    const stretch = { route_numbers: ['KBS-1K'], legs: [{ transit: true, route_name: 'KBS-1K', also_served_by: ['333-E', '333-K'],
        from: { name: 'Whitefield', lat: 12.97, lon: 77.75 }, to: { name: 'Majestic', lat: 12.978, lon: 77.572 } }] };
    state.lastPlan = { routes: [stretch] };
    const sc = T.routeLiveScope(stretch);
    assert.equal(sc.lines.join(','), 'KBS-1K,333-E,333-K', 'planned bus first, then the others on the same stretch');
    assert.equal(sc.key, T.liveKey('KBS-1K', sc.boardingStop));
    fetched.length = 0;
    fetchImpl = async (url) => {
        const q = new URL(url, 'http://x').searchParams;
        return answer([bus(`v-${q.get('q')}`, q.get('q'), 12.971, 77.751)]);
    };
    T.trackSearchBuses(sc.lines, [stretch], false, sc.boardingStop, sc.alightStop, []);
    await new Promise(r => setTimeout(r, 30));
    const qs = fetched.map(u => new URL(u, 'http://x').searchParams);
    assert.equal(qs.length, 3);
    assert.ok(qs.every(q => q.get('stop_lat') === '12.97' && q.get('alight_lat') === '12.978'), 'every line checked for the same boarding and alighting stop');
    const h3 = elements.get('liveBusList').innerHTML;
    assert.match(h3, /v-333-E/);
    assert.match(h3, /Also goes to Majestic · same boarding stop/);
    assert.equal(elements.get('liveBusStatus').textContent, '3 buses heading to Whitefield', 'all usable buses count');
    assert.match(h3, /Checking <b>KBS-1K<\/b> \(planned\) and 333-E, 333-K: all stop at Whitefield and then at Majestic/);
    assert.equal(elements.get('liveBusTitle').textContent, 'Buses to Majestic');

    // arrival estimate at the boarding stop: BMTC's own, only for fresh buses, soonest listed first
    const at = T.parseBmtcTime('2026-10-14 19:58:00');
    assert.equal(at.getHours() * 60 + at.getMinutes(), 19 * 60 + 58);
    const at2 = T.parseBmtcTime('14-10-2026 19:58:30');
    assert.equal(at2.getDate(), 14);
    assert.equal(T.parseBmtcTime('garbage'), null);
    const base = new Date(2026, 9, 14, 19, 50, 0).getTime();
    assert.equal(T.boardEtaMinutes({ board_eta: '2026-10-14 19:58:00', age_seconds: 10 }, base), 8);
    assert.equal(T.boardEtaMinutes({ board_eta: '2026-10-14 19:58:00', age_seconds: 900 }, base), null, 'stale position: no ETA shown');
    assert.equal(T.boardEtaMinutes({ board_eta: '2026-10-14 18:00:00', age_seconds: 10 }, base), null, 'long-past ETA ignored');
    assert.equal(T.boardEtaMinutes({ age_seconds: 10 }, base), null, 'no BMTC ETA: nothing invented');
    T.stopLiveBusTracking();
    const soon = new Date(Date.now() + 4 * 60000), later = new Date(Date.now() + 12 * 60000);
    const fmt = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:00`;
    fetchImpl = async () => answer([
        bus('later', '500D', 13.001, 77.501, { stops_away: 1, board_eta: fmt(later), board_stop: 'Stop One' }),
        bus('soon', '500D', 13.01, 77.51, { stops_away: 6, board_eta: fmt(soon), board_stop: 'Stop One' })]);
    T.trackSearchBuses(['500D'], [A], false, { name: 'Stop One', lat: 13, lon: 77.5 }, null, []);
    await new Promise(r => setTimeout(r, 30));
    const h4 = elements.get('liveBusList').innerHTML;
    assert.match(h4, /~[34] min at Stop One/, "ETA is whole minutes, so the seconds can drop it to 3");
    assert.ok(h4.indexOf('KA-soon') < h4.indexOf('KA-later'), 'listed by BMTC arrival estimate, not by stop count');
    assert.match(elements.get('liveBusStatus').textContent, /next 500D in ~[34] min$/);

    // journey options panel: standard / expanded / folded
    const panel = elements.get('routePanel');
    T.setRoutesExpanded(true);
    assert.ok(panel.classList.contains('expanded'));
    assert.equal(elements.get('expandRoutesBtn').textContent, '⤡');
    T.setRoutesCollapsed(true);
    assert.ok(panel.classList.contains('collapsed') && !panel.classList.contains('expanded'), 'folding leaves expanded mode');
    assert.equal(elements.get('expandRoutesBtn').textContent, '⤢');
    T.setRoutesExpanded(true);
    assert.ok(!panel.classList.contains('collapsed'), 'expanding unfolds');
    T.setRoutesExpanded(false);
    assert.ok(!panel.classList.contains('expanded') && !panel.classList.contains('collapsed'), 'back to standard size');
    const panelCss = fs.readFileSync('static/styles.css', 'utf8');
    assert.match(panelCss, /\.route-panel\.open \{ transition: height/, 'size changes animate');
    assert.match(panelCss, /\.route-panel:not\(\.expanded\) #routeResults \{ flex-wrap: nowrap; overflow-x: auto; overflow-y: hidden;/, 'standard size scrolls one way only');
    assert.match(panelCss, /\.route-panel\.expanded #routeResults \{ flex-wrap: wrap; overflow-x: hidden; overflow-y: auto;/, 'expanded scrolls one way only');

    // detour note: shown only for an option riding far more than the most direct one
    const leg = (km, from) => ({ transit: true, route_name: 'X', distance_m: km * 1000, from: { name: from } });
    const far = { legs: [leg(20, 'Whitefield'), leg(24, 'Hoskote Bus Stand')] };
    const direct = { legs: [leg(21, 'Whitefield')] };
    state.lastPlan = { routes: [far, direct] };
    assert.match(T.routeDetourNote(far), /44 km on buses \(first change at Hoskote Bus Stand\), against 21 km/);
    assert.equal(T.routeDetourNote(direct), '');
    state.lastPlan = { routes: [far] };
    assert.equal(T.routeDetourNote(far), '', 'nothing to compare with, no note');

    // static checks for the display fixes
    const css = fs.readFileSync('static/styles.css', 'utf8');
    const page = fs.readFileSync('static/index.html', 'utf8');
    assert.match(css, /\.maplibregl-map \.maplibregl-popup:not\(\.bus-popup\) \.maplibregl-popup-content \{ background: #132738/,
        'map popups must out-rank maplibre-gl.css (loaded later), or they render white-on-white');
    assert.match(page, /id="liveBusMeta"/);
    assert.ok(page.indexOf('id="liveBusList"') < page.indexOf('id="liveJourneyChoice"'), 'buses come before the journey summary');
    console.log('PASS: alternate-option buses are labelled, separate, per-stop, and fail honestly');
})().catch(e => { console.error(e); process.exit(1); });
