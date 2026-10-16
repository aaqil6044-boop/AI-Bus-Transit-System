const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function element() {
    const classes = new Set();
    return {
        value: '', innerHTML: '', style: {}, children: [], textContent: '',
        classList: { add: c => classes.add(c), remove: c => classes.delete(c),
            toggle() {}, contains: c => classes.has(c) },
        addEventListener() {}, setAttribute() {}, querySelector: () => null, querySelectorAll: () => [],
        appendChild(child) { this.children.push(child); },
        prepend(child) { this.children.unshift(child); },
        append() {}
    };
}
const elements = new Map();
const sources = new Map(), layers = new Map();
let cameraMoves = 0;
const map = {
    getLayer: id => layers.get(id), getSource: id => sources.get(id),
    removeLayer: id => layers.delete(id), removeSource: id => sources.delete(id),
    addLayer: l => layers.set(l.id, l), addSource: (id, s) => sources.set(id, s),
    setPaintProperty() {}, moveLayer() {}, stop() {},
    fitBounds() { cameraMoves++; }, flyTo() { cameraMoves++; },
    easeTo() { cameraMoves++; }, getZoom: () => 15, getBearing: () => 0,
    getCanvas: () => ({ style: {} })
};
const requests = [];
const context = {
    console, AbortController, URLSearchParams, setTimeout, clearTimeout,
    setInterval: () => 1, clearInterval() {},
    navigator: {}, window: { setTimeout, clearTimeout },
    document: {
        getElementById(id) { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); },
        createElement: element, querySelectorAll: () => [], querySelector: () => null
    },
    maplibregl: {
        LngLatBounds: class { extend() {} },
        Marker: class { setLngLat() { return this; } setPopup() { return this; } setOffset() { return this; } addTo() { return this; } remove() {} getElement() { return element(); } getLngLat() { return { toArray: () => [0, 0] }; } },
        Popup: class { setHTML() { return this; } setText() { return this; } setLngLat() { return this; } addTo() { return this; } remove() {} }
    },
    fetch: () => new Promise(resolve => requests.push(resolve))
};
vm.createContext(context);
const source = fs.readFileSync('static/app.js', 'utf8').replace(
    '\n    init();',
    '\n    globalThis.testApp = {state, planJourney, resetJourney, renderRoutes, routeCoordinates, journeyGuidance, updateJourneyProgress, startJourney, stopJourneyTracking};'
);
vm.runInContext(source, context);
const app = context.testApp;
app.state.map = map;
app.state.mapReady = true;
function endpoints() {
    app.state.origin = { id: 'a', lon: 77.5, lat: 13 };
    app.state.destination = { id: 'b', lon: 77.6, lat: 13.1 };
}
function result(name) {
    return { routes: [{ route_numbers: [name], geometry_source: 'otp',
        coordinates: [[77.5, 13], [77.6, 13.1]], segments: [],
        walking_available: true, walking_minutes: 0, total_elapsed_minutes: 10 }] };
}
function respond(index, data) {
    requests[index]({ ok: true, text: async () => JSON.stringify(data) });
}

(async () => {
    endpoints();
    const oldSearch = app.planJourney();
    app.resetJourney();
    respond(0, result('OLD'));
    await oldSearch;
    await Promise.resolve();
    assert.equal(sources.size, 0, 'reset prevents an old response from drawing');
    assert.equal(elements.get('routePanel').classList.contains('open'), false);

    endpoints();
    const first = app.planJourney();
    const second = app.planJourney();
    respond(2, result('NEW'));
    await second;
    await Promise.resolve();
    assert.equal(sources.size, 1, 'latest route is drawn');
    assert.equal(elements.get('routeResults').children[0].className, 'route-card live-overview-card',
        'live check is a card in the same list');
    assert.equal(elements.get('routeResults').children[1].className, 'route-card journey-route-card',
        'recommended route immediately follows the live card');
    const moves = cameraMoves;
    respond(1, result('STALE'));
    await first;
    await Promise.resolve();
    assert.equal(cameraMoves, moves, 'stale result cannot move the camera');
    assert.equal(sources.size, 1);

    app.renderRoutes(result('DEFERRED'));
    app.resetJourney();
    await Promise.resolve();
    assert.equal(sources.size, 0, 'reset cancels a queued map render');
    assert.equal(layers.size, 0, 'reset removes old route layers');
    assert.equal(app.state.origin, null);
    const complete = { geometry_source: 'otp', coordinates: [[1, 2], [3, 4]],
        segments: [{ coordinates: [[5, 6], [7, 8]] }] };
    assert.equal(app.routeCoordinates(complete), complete.coordinates,
        'walking geometry is retained rather than replaced with bus segments');
    const itinerary = { legs: [
        { transit: false, from: {name: 'Home'}, to: {name: 'Boarding stop', lon: 77.5, lat: 13}, duration_minutes: 3, distance_m: 200 },
        { transit: true, route_name: '401-AM', headsign: 'Jalahalli', from: {name: 'Boarding stop'}, to: {name: 'Jalahalli Cross', lon: 77.51, lat: 13.01}, duration_minutes: 12, departure_time: '10:00', arrival_time: '10:12' }
    ] };
    const fix = { timestamp: Date.now(), coords: { longitude: 77.5, latitude: 13, accuracy: 10 } };
    assert.match(app.journeyGuidance(itinerary, 0, fix).gps, /confirm your next step/);
    assert.match(app.journeyGuidance(itinerary, 1, fix).title, /401-AM.*Jalahalli/);
    fix.coords.accuracy = 500;
    assert.match(app.journeyGuidance(itinerary, 0, fix).gps, /Weak GPS/);
    assert.doesNotMatch(app.journeyGuidance(itinerary, 0, fix).gps, /confirm your next step/);
    fix.coords.accuracy = 10;
    fix.timestamp = Date.now() - 60000;
    assert.match(app.journeyGuidance(itinerary, 0, fix).gps, /stale/);
    itinerary.coordinates = [[77.5, 13], [77.51, 13.01]];
    itinerary.geometry_source = 'otp';
    app.state.journey.active = true;
    app.state.journey.route = itinerary;
    app.state.journey.marker = {setLngLat() {}, remove() {}};
    const beforeGps = cameraMoves;
    app.updateJourneyProgress(fix);
    assert.equal(cameraMoves, beforeGps, 'stale GPS cannot move the camera');
    fix.timestamp = Date.now(); fix.coords.accuracy = 500;
    app.updateJourneyProgress(fix);
    assert.equal(cameraMoves, beforeGps, 'weak GPS cannot move the camera');
    fix.coords.accuracy = 10;
    app.state.journey.follow = false;
    app.updateJourneyProgress(fix);
    assert.equal(cameraMoves, beforeGps, 'manual map browsing is respected');
    app.state.journey.follow = true;
    app.updateJourneyProgress(fix);
    assert.equal(cameraMoves, beforeGps + 1, 'fresh accurate GPS follows the user');
    app.stopJourneyTracking();
    assert.equal(elements.get('journeyGuide').hidden, true);
    app.startJourney(itinerary, 0);
    assert.equal(elements.get('journeyGuide').hidden, false, 'manual journey guidance works without browser GPS');
    assert.match(elements.get('guideGps').textContent, /Next step/);
    assert.equal(app.state.liveBus.routes[0], '401-AM', 'starting a journey tracks its chosen bus line');
    assert.equal(elements.get('liveBusPanel').hidden, false, 'live tracking opens with journey guidance');
    assert.match(elements.get('guideRouteSummary').innerHTML, /Boarding stop/);
    app.stopJourneyTracking();
    assert.equal(elements.get('liveBusPanel').hidden, true, 'stopping guidance also stops automatic live tracking');
    console.log('PASS: map reset/races, complete geometry, leg guidance, weak GPS and stale fixes');
    process.exit(0);
})().catch(error => { console.error(error); process.exit(1); });
