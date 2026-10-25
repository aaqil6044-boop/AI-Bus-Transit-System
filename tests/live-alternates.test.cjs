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
    '\n    globalThis.t = {state, refreshLiveBuses, stopLiveBusTracking, trackBmtcRoute, trackSearchBuses, startJourney, stopJourneyTracking, goToGuideStep, guideSteps, routeLiveScope, liveKey, applyAssistantResult, busFreshness, setRoutesCollapsed, showRoutePanel, mapPadding, planJourney, swapEndpoints, resolveTypedEndpoints, routeAlternates, routeDetourNote, routeLiveScope, liveKey, parseBmtcTime, boardEtaMinutes, setRoutesExpanded, setRoutesCollapsed, showBusHeading, clearBusHeading, busBearing, compassWord, directionChevrons};'), context);
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

    // where a clicked bus is heading: a light line through its next stops, kept in step with refreshes
    const sources = new Map(), layers = new Set();
    Object.assign(state.map, {
        addSource: (id, spec) => sources.set(id, {data: spec.data, setData(d) { this.data = d; }}),
        getSource: id => sources.get(id), removeSource: id => sources.delete(id),
        addLayer: l => layers.add(l.id), getLayer: id => layers.has(id) ? {id} : null, removeLayer: id => layers.delete(id)});
    state.mapReady = true;
    T.stopLiveBusTracking();
    const heading = { stops: [{ name: 'Next A', lat: 13.002, lon: 77.502 }, { name: 'Next B', lat: 13.003, lon: 77.503 }],
        towards: 'Terminus', remaining_stops: 9, direction: 'up' };
    fetchImpl = async () => answer([bus('h1', '500D', 13.001, 77.501, { heading })]);
    T.trackSearchBuses(['500D'], [A], false, { name: 'Stop One', lat: 13, lon: 77.5 }, null, []);
    await new Promise(r => setTimeout(r, 30));
    const headed = state.liveBus.lastShown.find(b => b.id === 'h1');
    assert.equal(T.showBusHeading(headed), true);
    const line = sources.get('bus-heading').data.features[0].geometry.coordinates;
    assert.equal(JSON.stringify(line), JSON.stringify([[77.501, 13.001], [77.502, 13.002], [77.503, 13.003]]), 'starts at the bus, then its next stops');
    assert.ok(layers.has('bus-heading-line') && layers.has('bus-heading-stops'));
    assert.match(state.liveBus.headingEnd.element.textContent, /500D → towards Terminus \(shown to Next B\)/);
    assert.equal(state.liveBus.headingBoard.element.textContent, 'Your stop · Stop One', 'the traveller\'s stop is marked on the line');
    // when the line reaches the bus's final stop, the tag says where it ends
    T.showBusHeading({ ...headed, heading: { ...heading, towards: 'Next B' } }, { frame: false });
    assert.match(state.liveBus.headingEnd.element.textContent, /🏁 500D ends at Next B/);
    T.showBusHeading(headed, { frame: false });
    // the bus moves on the next refresh: the line follows it
    fetchImpl = async () => answer([bus('h1', '500D', 13.002, 77.502, { heading: { ...heading, stops: heading.stops.slice(1) } })]);
    await T.refreshLiveBuses(state.liveBus.session, true);
    assert.equal(sources.get('bus-heading').data.features[0].geometry.coordinates[0][0], 77.502);
    // when the server laid the line along the road, that road path is drawn (not straight stop joins)
    const road = [[77.501, 13.001], [77.5015, 13.0012], [77.502, 13.002], [77.5028, 13.0024], [77.503, 13.003]];
    T.showBusHeading({ ...headed, heading: { ...heading, path: road, path_source: 'road' } }, { frame: false });
    assert.equal(JSON.stringify(sources.get('bus-heading').data.features[0].geometry.coordinates), JSON.stringify(road));
    // a bus without a known position along its route gets no line, and says why
    assert.equal(T.showBusHeading({ ...headed, heading: null }), false);
    assert.equal(sources.has('bus-heading'), false);
    T.showBusHeading(headed);
    T.stopLiveBusTracking();
    assert.equal(sources.has('bus-heading'), false, 'stopping live tracking removes the line');
    assert.equal(state.liveBus.headingEnd, null);

    // which way a bus is driving: from its road path, never guessed
    const at0 = { lat: 13.0, lon: 77.6 };
    const north = T.busBearing({ ...at0, heading: { path: [[77.6, 13.0], [77.6, 13.002], [77.6, 13.004]] } });
    const east = T.busBearing({ ...at0, heading: { path: [[77.6, 13.0], [77.602, 13.0]] } });
    const southWest = T.busBearing({ ...at0, heading: { path: [[77.6, 13.0], [77.598, 12.998]] } });
    assert.ok(north < 1 || north > 359, `north ~0, got ${north}`);
    assert.ok(Math.abs(east - 90) < 1, `east ~90, got ${east}`);
    assert.equal(T.compassWord(north), 'north');
    assert.equal(T.compassWord(east), 'east');
    assert.equal(T.compassWord(southWest), 'south-west');
    assert.equal(T.busBearing({ ...at0, heading: null }), null, 'no route path: no arrow');
    assert.equal(T.busBearing({ ...at0, heading: { path: [[77.6, 13.0], [77.60001, 13.00001]] } }), null, 'a few metres is not a direction');
    // it looks ~120 m ahead, so a kink right at the bus does not flip the arrow
    const kink = T.busBearing({ ...at0, heading: { path: [[77.6, 13.0], [77.60005, 12.99997], [77.6, 13.003]] } });
    assert.equal(T.compassWord(kink), 'north');
    const marks = T.directionChevrons([[77.6, 13.0], [77.6, 13.02]]);   // ~2.2 km north
    assert.ok(marks.length >= 3, 'chevrons along the line');
    const [w1, tip, w2] = marks[0].geometry.coordinates;
    assert.ok(tip[1] > w1[1] && tip[1] > w2[1], 'chevrons point the way the bus travels');
    assert.equal(T.directionChevrons([[77.6, 13.0], [77.6, 13.0005]]).length, 0, 'none on a very short line');
    // the bus row says it in words
    T.stopLiveBusTracking();
    fetchImpl = async () => answer([bus('dir1', '500D', 13.0, 77.6, { heading: { path: [[77.6, 13.0], [77.6, 13.003]], stops: [{ name: 'X', lat: 13.003, lon: 77.6 }], towards: 'Terminus' } })]);
    T.trackSearchBuses(['500D'], [A], false, { name: 'Stop One', lat: 13, lon: 77.5 }, null, []);
    await new Promise(r => setTimeout(r, 30));
    assert.match(elements.get('liveBusList').innerHTML, /➤ Heading north · towards Terminus/);
    T.stopLiveBusTracking();

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
