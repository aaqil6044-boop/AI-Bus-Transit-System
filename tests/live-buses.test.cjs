const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
function element() {
    return {textContent: '', innerHTML: '', disabled: false, style: {},
        classList: {toggle() {}, remove() {}, add() {}}, setAttribute() {}, addEventListener() {},
        querySelector: () => ({textContent: ''}), querySelectorAll: () => []};
}
const elements = new Map();
class Popup {
    setHTML(html) { this.html = html; return this; }
    remove() { return this; }
}
class Marker {
    constructor({element}) { this.element = element; }
    setLngLat(point) { this.point = point; return this; }
    setPopup(popup) { this.popup = popup; return this; }
    addTo() { return this; }
    getPopup() { return this.popup; }
    getElement() { return this.element; }
    remove() { this.removed = true; }
}
let request;
const context = {console, AbortController, URLSearchParams, setTimeout, clearTimeout,
    setInterval, clearInterval, navigator: {}, window: {},
    document: {getElementById(id) { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); },
        createElement: element}, maplibregl: {Popup, Marker}, fetch: (...args) => request(...args)};
vm.createContext(context);
vm.runInContext(fs.readFileSync('static/app.js', 'utf8').replace('\n    init();',
    '\n    globalThis.testApp = {state, refreshLiveBuses, stopLiveBusTracking, chooseLiveBusJourney, routeLiveScope};'), context);
const {state, refreshLiveBuses, stopLiveBusTracking, chooseLiveBusJourney, routeLiveScope} = context.testApp;
const bus = (id, age = 10) => ({id, label: `BUS-${id}`, route: '248', direction: 'up',
    lat: 13, lon: 77.5, age_seconds: age, next_stop: '<unsafe>'});
const response = vehicles => ({ok: true, json: async () => ({available: true, vehicles})});
(async () => {
    const camera = [];
    state.map = {getZoom: () => 15, easeTo: position => camera.push(position)};
    state.origin = {lat: 13, lon: 77.5};
    const journey = {legs: [
        {transit: false},
        {transit: true, route_name: '248', from: {name: 'First boarding', lat: 13, lon: 77.5}},
        {transit: true, route_name: '410', from: {name: 'Transfer', lat: 13.02, lon: 77.52}}
    ]};
    assert.equal(routeLiveScope(journey).lines[0], '248', 'live tracking starts with the first bus leg');
    assert.equal(routeLiveScope(journey).boardingStop.name, 'First boarding');
    state.journey.active = true;
    state.journey.route = journey;
    state.journey.stepIndex = 2;
    assert.equal(routeLiveScope(journey).lines[0], '410', 'live tracking moves to the transfer bus');
    state.journey.active = false;
    Object.assign(state.liveBus, {session: 1, route: 'search-results', routes: ['248', '410', '500']});
    const urls = [];
    request = async url => {
        urls.push(url);
        if (url.includes('410')) throw new Error('Temporarily unavailable');
        return response(url.includes('500') ? [bus('a', 30), bus('b')] : [bus('a')]);
    };
    await refreshLiveBuses(1, true);
    assert.equal(urls.length, 3, 'queries every displayed route');
    assert.ok(urls.every(url => url.includes('refresh=1')), 'manual refresh bypasses every route cache');
    assert.equal(state.liveBus.markers.length, 2, 'deduplicates shared vehicles and retains successful routes');
    assert.match(elements.get('liveBusMeta').textContent, /2\/3 routes checked/);
    const marker = state.liveBus.markers[0].marker;
    const popup = marker.getPopup();
    assert.match(popup.html, /&lt;unsafe&gt;/, 'escapes external feed text');
    state.liveBus.selectedBusId = 'a';
    request = async () => response([bus('a')]);
    await refreshLiveBuses(1);
    assert.equal(state.liveBus.markers.length, 1, 'removes vanished buses without accumulating markers');
    assert.equal(state.liveBus.markers[0].marker, marker, 'reuses existing marker');
    assert.equal(marker.getPopup(), popup, 'keeps selected popup during refresh');
    assert.equal(camera.length, 1, 'selected fresh bus stays in view on refresh');
    assert.equal(elements.get('liveBusRefresh').disabled, false);
    assert.match(elements.get('liveBusMeta').textContent, /live/);
    state.liveBus.journeys = [{route_numbers: ['248']}, {route_numbers: ['500']}];
    chooseLiveBusJourney({...bus('route'), route: '500'});
    assert.equal(state.liveBus.journeyIndex, 1, 'clicking a bus selects its matching journey');
    assert.equal(state.selectedRouteIndex, 1, 'matching journey is selected on the map');
    assert.match(elements.get('liveJourneyChoice').innerHTML, /Selected journey: 500/);
    state.liveBus.journeys = [{route_numbers: ['248']}];
    state.liveBus.routes = ['248'];
    state.liveBus.boardingStop = {id: 'boarding', name: 'Boarding stop', lat: 13, lon: 77.5};
    request = async () => response([bus('near'), {...bus('far'), lon: 77.65}]);
    await refreshLiveBuses(1);
    assert.equal(state.liveBus.markers.length, 1, 'shows only buses near the selected boarding stop');
    assert.equal(state.liveBus.markers[0].id, 'near');
    assert.match(elements.get('liveBusMeta').textContent, /1 farther than 4 km not shown/);
    let resolve;
    request = () => new Promise(r => {resolve = r;});
    state.liveBus.routes = null;
    const pending = refreshLiveBuses(1);
    stopLiveBusTracking();
    resolve(response([bus('late')]));
    await pending;
    assert.equal(state.liveBus.markers.length, 0, 'late response cannot redraw buses after stop');
    console.log('PASS: route aggregation, partial failure, refresh, deduplication, popup persistence, stale response');
})().catch(error => {console.error(error); process.exitCode = 1;});
