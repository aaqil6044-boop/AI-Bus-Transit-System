(() => {
    "use strict";

    const state = {
        map: null,
        mapReady: false,
        origin: null,
        destination: null,
        originMarker: null,
        destinationMarker: null,
        transferMarkers: [],
        routeEntries: [],
        selectedRouteIndex: 0,
        selectedPreference: "fastest",
        pathsVisible: true,
        departAt: "",
        lastPlan: null,
        health: null,
        chatBusy: false,
        chatHistory: [],
        userMarker: null,
        liveBus: { route: "", key: "", timer: null, markers: [], session: 0 },
        originTimer: null,
        destinationTimer: null,
        isListening: false,
        journeyRevision: 0,
        planController: null,
        journey: {
            active: false,
            watchId: null,
            marker: null,
            route: null,
            routeIndex: 0,
            lastPosition: null,
            stepIndex: 0,
            follow: true,
            gpsError: "",
            session: 0
        }
    };

    const $ = (id) => document.getElementById(id);

    const originInput = $("originInput");
    const destinationInput = $("destinationInput");
    const originSuggestions = $("originSuggestions");
    const destinationSuggestions = $("destinationSuggestions");
    const planBtn = $("planBtn");
    const routePanel = $("routePanel");
    const routeResults = $("routeResults");
    const chatPanel = $("chatPanel");
    const layersPanel = $("layersPanel");
    const statusToast = $("statusToast");

    function showStatus(message, isError = false) {
        if (!statusToast) return;
        statusToast.textContent = message;
        statusToast.classList.toggle("error", !!isError);
        statusToast.classList.add("visible");
        clearTimeout(showStatus.timer);
        // Errors stay long enough to read and act on.
        showStatus.timer = setTimeout(() => {
            statusToast.classList.remove("visible");
        }, isError ? 8000 : 3200);
    }

    class ApiError extends Error {
        constructor(message, status, data) {
            super(message);
            this.name = "ApiError";
            this.status = status;
            this.data = data;
        }
    }

    // fetch + text + JSON parse + timeout. Never throws on a non-JSON body (an HTML
    // error page used to be shown to the traveller verbatim).
    async function fetchJson(url, options = {}, timeoutMs = 15000) {
        const controller = new AbortController();
        const outer = options.signal;
        const relay = () => controller.abort();
        if (outer) {
            if (outer.aborted) controller.abort();
            else outer.addEventListener("abort", relay);
        }
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
            const response = await fetch(url, { ...options, signal: controller.signal });
            const text = await response.text();
            let data = null;
            try { data = text ? JSON.parse(text) : null; } catch (error) { data = null; }
            return { ok: response.ok, status: response.status, data, text };
        } finally {
            clearTimeout(timer);
            if (outer) outer.removeEventListener("abort", relay);
        }
    }

    function apiError(result, fallback) {
        const data = result.data || {};
        const plain = result.text && !result.text.trim().startsWith("<") ? result.text.slice(0, 200) : "";
        return new ApiError(data.error || data.message || plain || `${fallback} (server code ${result.status}).`,
            result.status, data);
    }

    function explainFailure(error, what = "That request") {
        if (error instanceof ApiError) return error.message;
        if (error?.name === "AbortError") return `${what} took too long. Try again, or try different nearby stops.`;
        if (error instanceof TypeError) {
            return "Cannot reach the local server. Make sure the run-local window is still open, then reload this page.";
        }
        return error?.message || `${what} could not be completed.`;
    }

    function showBanner(message, retry = true) {
        const banner = $("systemBanner");
        if (!banner) return;
        $("systemBannerText").textContent = message;
        $("systemBannerRetry").hidden = !retry;
        banner.hidden = false;
    }

    function hideBanner() {
        const banner = $("systemBanner");
        if (banner) banner.hidden = true;
    }

    const APP_BUILD = "2026-11-13-next-service-1";   // must match BUILD in app.py

    async function checkHealth() {
        try {
            const result = await fetchJson("/api/health", { cache: "no-store" }, 6000);
            if (!result.ok || !result.data) throw new Error("Health check failed");
            state.health = result.data;
            showAssistantEngine(result.data.assistant);
            const message = healthMessage(result.data, APP_BUILD, isLocalSite());
            if (message) showBanner(message); else hideBanner();
            scheduleHealthCheck(!!message);
            return result.data;
        } catch (error) {
            state.health = null;
            showBanner(isLocalSite()
                ? "Cannot reach the local server on port 8765. Start run-local.cmd, then reload this page."
                : "The journey planner cannot be reached right now. Check your internet connection; this page will retry by itself.");
            scheduleHealthCheck(true);
            return null;
        }
    }

    const isLocalSite = () => typeof location !== "undefined" && /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname || "");

    // Pure: what (if anything) to tell the traveller about the server's health. On the developer's own
    // computer it says how to fix it; on the public site it says what does not work, in plain words.
    function healthMessage(health, appBuild, local) {
        if (!health) return "";
        if (health.build !== appBuild) {
            return local
                ? "This page is newer than the app server that is running. Close the black run-local window, " +
                  "start run-local.cmd again, then reload this page (Ctrl+F5). Until then some features will not work."
                : "A new version of the app is being installed. Reload this page in a minute.";
        }
        if (!health.database) {
            return local
                ? "The Bengaluru stop database is missing, so searching and planning will not work. " +
                  "Run: python scripts/import_gtfs.py data/bmtc_gtfs.zip, then restart the app."
                : "Stop search and journey planning are temporarily unavailable. Please try again in a few minutes.";
        }
        if (!health.router) {
            return local
                ? "The route engine is not running, so journeys cannot be planned yet. Start the app with " +
                  "run-local.cmd, wait for \"Ready\" in its window, then press Check again."
                : "Journey planning is temporarily unavailable (the route engine is restarting). Stop search still works; " +
                  "this page will retry by itself.";
        }
        if (health.services?.bmtc === "down") {
            return "BMTC's live bus feed is not answering right now, so live positions may be missing. " +
                "Timetable journeys still work.";
        }
        return "";
    }

    // While something is wrong, check again every 20 s and clear the notice once it recovers.
    function scheduleHealthCheck(problem) {
        clearTimeout(state.healthTimer);
        state.healthTimer = setTimeout(() => checkHealth(), problem ? 20000 : 300000);
    }

    function normalizeStop(stop) {
        if (!stop) return null;

        const id = String(
            stop.id ??
            stop.stop_id ??
            ""
        );

        const name = String(
            stop.name ??
            stop.stop_name ??
            ""
        );

        const lat = Number(
            stop.lat ??
            stop.stop_lat ??
            stop.latitude
        );

        const lon = Number(
            stop.lon ??
            stop.stop_lon ??
            stop.lng ??
            stop.longitude
        );

        if (!id || !name || !Number.isFinite(lat) || !Number.isFinite(lon)) {
            return null;
        }

        return {
            ...stop,
            id,
            name,
            stop_id: id,
            stop_name: name,
            lat,
            lon,
            stop_lat: lat,
            stop_lon: lon
        };
    }

    function stopLngLat(stop) {
        const s = normalizeStop(stop);
        return s ? [s.lon, s.lat] : null;
    }

    const OSM_RASTER_STYLE = {
        version: 8,
        sources: {
            "osm-raster": {
                type: "raster",
                tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
                tileSize: 256,
                attribution: "© OpenStreetMap contributors",
                maxzoom: 19
            }
        },
        layers: [
            {
                id: "osm-raster-layer",
                type: "raster",
                source: "osm-raster",
                minzoom: 0,
                maxzoom: 22
            }
        ]
    };

    function initializeMap() {
        if (!window.maplibregl) {
            showStatus("Map engine failed to load. Refresh once and try again.", true);
            return;
        }

        try {
            state.map = new maplibregl.Map({
                container: "map",
                style: OSM_RASTER_STYLE,
                center: [77.5946, 12.9716],
                zoom: 11.7,
                minZoom: 8,
                maxZoom: 19,
                attributionControl: true,
                dragRotate: false,
                pitchWithRotate: false,
                touchZoomRotate: true,
                preserveDrawingBuffer: false
            });

            state.map.addControl(
                new maplibregl.NavigationControl({
                    showCompass: false,
                    visualizePitch: false
                }),
                "bottom-right"
            );

            state.map.on("zoomend", () => spreadBusMarkers());
            state.map.on("rotate", () => state.liveBus.markers.forEach(entry => {
                const element = entry.marker.getElement();
                if (element?.dataset?.bearing) setMarkerDirection(element, Number(element.dataset.bearing));
            }));
            // Remember when the traveller pans or zooms by hand, so automatic framing stops fighting them.
            const handMoved = event => {
                if (!event?.originalEvent) return;   // programmatic camera moves never hide anything
                state.liveBus.userMoved = true;
                enterMapFocus();
            };
            state.map.on("dragstart", handMoved);
            state.map.on("zoomstart", handMoved);
            state.map.on("load", markMapReady);

            state.map.on("click", (event) => {
                if (!state.pickPointType) return;
                const type = state.pickPointType;
                invalidateJourney();
                const point = normalizeStop({
                    id: `point-${type}`, is_map_point: true,
                    name: `${type === "origin" ? "Start" : "Destination"} (${event.lngLat.lat.toFixed(5)}, ${event.lngLat.lng.toFixed(5)})`,
                    lat: event.lngLat.lat, lon: event.lngLat.lng
                });
                state[type] = point;
                (type === "origin" ? originInput : destinationInput).value = point.name;
                updateMarker(type, point);
                state.pickPointType = null;
                state.map.getCanvas().style.cursor = "";
                $("originMapBtn")?.classList.remove("picking");
                $("destinationMapBtn")?.classList.remove("picking");
                showStatus("Map point selected. Choose the other endpoint or find routes.");
            });

            state.map.on("error", (event) => {
                console.error("MapLibre error:", event?.error || event);
                if (!state.mapReady) {
                    showStatus("Map tiles could not be loaded. Check your internet connection.", true);
                }
            });
        } catch (error) {
            console.error("Map initialization failed:", error);
            showStatus("Could not initialize the map.", true);
        }
    }

    function addMapAccent() {
        if (!state.map || state.map.getSource("bengaluru-accent")) return;

        state.map.addSource("bengaluru-accent", {
            type: "geojson",
            data: {
                type: "Feature",
                geometry: {
                    type: "Point",
                    coordinates: [77.5946, 12.9716]
                }
            }
        });

        state.map.addLayer({
            id: "bengaluru-accent",
            type: "circle",
            source: "bengaluru-accent",
            paint: {
                "circle-radius": 180,
                "circle-color": "#62e6a8",
                "circle-opacity": 0.015,
                "circle-stroke-color": "#62e6a8",
                "circle-stroke-width": 1,
                "circle-stroke-opacity": 0.10
            }
        });
    }

    // "load" waits for the first map tiles. Routes only need the map style, so when tiles are slow or
    // blocked the map is treated as ready once its style has loaded (after a short grace period).
    function markMapReady() {
        if (state.mapReady || !state.map) return;
        state.mapReady = true;
        addMapAccent();
        requestAnimationFrame(() => state.map.resize());
        setTimeout(() => state.map?.resize(), 250);
        setTimeout(() => state.map?.resize(), 1000);
    }

    async function waitForMap(timeout = 12000) {
        if (state.mapReady && state.map) return state.map;
        const started = Date.now();
        while (!state.mapReady) {
            if (Date.now() - started > 2500 && state.map?.isStyleLoaded?.()) { markMapReady(); break; }
            if (Date.now() - started > timeout) {
                throw new Error("The map is still loading. Please refresh the page and try again.");
            }
            await new Promise((resolve) => setTimeout(resolve, 50));
        }
        return state.map;
    }

    function createMarker(type, stop) {
        const s = normalizeStop(stop);
        if (!s || !state.map) return null;

        const el = document.createElement("div");
        el.className =
            type === "origin"
                ? "transit-origin-marker"
                : "transit-destination-marker";

        const pulse = document.createElement("div");
        pulse.className = "transit-marker-pulse";

        const dot = document.createElement("div");
        dot.className = "transit-marker-dot";

        el.append(pulse, dot);

        return new maplibregl.Marker({
            element: el,
            anchor: "center"
        })
            .setLngLat([s.lon, s.lat])
            .setPopup(
                new maplibregl.Popup({
                    offset: 18,
                    closeButton: false
                }).setText(s.name)
            )
            .addTo(state.map);
    }

    function updateMarker(type, stop) {
        if (!state.map) return;

        const markerKey = type === "origin" ? "originMarker" : "destinationMarker";

        if (state[markerKey]) {
            state[markerKey].remove();
            state[markerKey] = null;
        }

        state[markerKey] = createMarker(type, stop);
        renderPlaceChips();
    }

    function clearTransferMarkers() {
        state.transferMarkers.forEach((marker) => marker.remove());
        state.transferMarkers = [];
    }

    function addTransferMarkers(route) {
        clearTransferMarkers();
        if (!state.map) return;

        const points = [];
        const busLegs = Array.isArray(route?.legs) ? route.legs.filter((leg) => leg.transit) : [];
        if (busLegs.length) {
            // Boarding and alighting point of every bus, from the exact planned legs.
            busLegs.forEach((leg, index) => {
                points.push({ kind: "board", text: String(index + 1), place: leg.from,
                    label: `${index === 0 ? "Board" : "Change: board"} ${leg.route_name} at ${leg.from?.name}` +
                        (leg.departure_time ? `, scheduled ${leg.departure_time}` : "") });
                points.push({ kind: "alight", text: "↓", place: leg.to,
                    label: `Get down from ${leg.route_name} at ${leg.to?.name}` +
                        (leg.arrival_time ? `, scheduled ${leg.arrival_time}` : "") });
            });
        } else {
            const segments = Array.isArray(route?.segments) ? route.segments : [];
            segments.slice(1).forEach((segment, index) => {
                const first = Array.isArray(segment?.stops) ? segment.stops[0] : null;
                if (!first) return;
                points.push({ kind: "board", text: String(index + 2),
                    place: { lat: first.lat ?? first.stop_lat, lon: first.lon ?? first.stop_lon },
                    label: `Transfer ${index + 1}: ${first.stop_name ?? first.name ?? "Transfer"}` });
            });
        }

        const seen = new Set();
        points.forEach((point) => {
            const lat = Number(point.place?.lat);
            const lon = Number(point.place?.lon);
            if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
            const key = `${point.kind}:${lat.toFixed(5)},${lon.toFixed(5)}`;
            if (seen.has(key)) return;
            seen.add(key);

            const el = document.createElement("div");
            el.className = `transit-step-marker ${point.kind}`;
            el.textContent = point.text;
            el.title = point.label;
            el.setAttribute("aria-label", point.label);

            const marker = new maplibregl.Marker({ element: el, anchor: "center" })
                .setLngLat([lon, lat])
                .setPopup(new maplibregl.Popup({ offset: 16, closeButton: false }).setText(point.label))
                .addTo(state.map);

            state.transferMarkers.push(marker);
        });
    }

    // Space the camera should leave around the map so the route is never hidden behind a panel.
    // Panels are measured where they actually are (not where an animation currently has them).
    // ---- Map focus: when the traveller drags or zooms the map, the panels slide off the edges so the
    // whole map is visible. "Show trip panels" (or Esc, or any action that needs them) brings them back.
    function panelsOnScreen() {
        return !!(routePanel?.classList?.contains("open") || !$("liveBusPanel")?.hidden || !$("journeyGuide")?.hidden ||
            (window.innerWidth || 1600) > 760);
    }

    function enterMapFocus() {
        const body = document.body;
        if (!body?.classList || body.classList.contains("map-focus") || !panelsOnScreen()) return;
        body.classList.add("map-focus");
        const pill = $("showPanelsBtn");
        if (pill) pill.hidden = false;
    }

    function exitMapFocus() {
        const body = document.body;
        if (!body?.classList?.contains("map-focus")) return;
        body.classList.remove("map-focus");
        const pill = $("showPanelsBtn");
        if (pill) pill.hidden = true;
    }

    function mapPadding() {
        const fallback = { top: 120, right: 80, bottom: 220, left: 430 };
        // Panels are slid away: the whole map is free.
        if (document.body?.classList?.contains("map-focus")) return { top: 80, right: 60, bottom: 90, left: 60 };
        try {
            const width = window.innerWidth, height = window.innerHeight;
            if (!width || !height || typeof getComputedStyle !== "function") return fallback;
            const pad = { top: 100, right: 40, bottom: 40, left: 40 };
            const boxes = [];
            const panels = [
                [document.querySelector(".command-panel"), true],
                [routePanel, routePanel.classList.contains("open")],
                [$("journeyGuide"), !$("journeyGuide").hidden],
                [$("liveBusPanel"), !$("liveBusPanel").hidden],
                // Journey mode: a sidebar on wide screens; on phones a banner on top and a sheet at the bottom.
                [$("navCard"), !!$("navCard") && !$("navCard").hidden && window.innerWidth >= 761],
                [$("navHead"), !!$("navCard") && !$("navCard").hidden && window.innerWidth < 761],
                [$("navSheet"), !!$("navCard") && !$("navCard").hidden && window.innerWidth < 761],
                [chatPanel, chatPanel.classList.contains("open")]
            ];
            panels.forEach(([panel, present]) => {
                try {
                if (!panel || !present || getComputedStyle(panel).display === "none") return;
                const fixed = getComputedStyle(panel).position === "fixed";
                const box = fixed
                    ? panel.getBoundingClientRect()
                    : { left: panel.offsetLeft, top: panel.offsetTop, right: panel.offsetLeft + panel.offsetWidth, bottom: panel.offsetTop + panel.offsetHeight, width: panel.offsetWidth, height: panel.offsetHeight };
                if (!(box.width > 0 && box.height > 0)) return;
                const gap = 48;
                if (width < 761) {
                    // Phones: panels are sheets on the top or bottom of the screen.
                    if (box.top > height * 0.45) pad.bottom = Math.max(pad.bottom, height - box.top + gap);
                    else pad.top = Math.max(pad.top, box.bottom + gap);
                } else {
                    boxes.push(box);
                }
                } catch (error) { /* a panel that cannot be measured is simply not counted */ }
            });
            if (width >= 761 && boxes.length) {
                // Desktop/laptop: panels can leave an L-shaped free area, so look for the largest
                // rectangle of map that no panel covers and frame the content inside it.
                const margin = 24, top0 = 96;
                const xs = [...new Set([0, width, ...boxes.flatMap(b => [b.left - margin, b.right + margin])])].filter(x => x >= 0 && x <= width).sort((m, n) => m - n);
                const ys = [...new Set([top0, height, ...boxes.flatMap(b => [b.top - margin, b.bottom + margin])])].filter(y => y >= top0 && y <= height).sort((m, n) => m - n);
                const covered = (x1, y1, x2, y2) => boxes.some(b => b.left - margin < x2 && b.right + margin > x1 && b.top - margin < y2 && b.bottom + margin > y1);
                let best = null;
                for (let i = 0; i < xs.length; i++) for (let j = i + 1; j < xs.length; j++) {
                    const w = xs[j] - xs[i];
                    if (w < 140) continue;
                    for (let k = 0; k < ys.length; k++) for (let l = k + 1; l < ys.length; l++) {
                        const h = ys[l] - ys[k];
                        if (h < 120) continue;
                        // Prefer big areas, but not hair-thin strips.
                        const score = w * h * Math.min(1, Math.min(w, h) / 260);
                        if ((!best || score > best.score) && !covered(xs[i], ys[k], xs[j], ys[l]))
                            best = {score, x1: xs[i], y1: ys[k], x2: xs[j], y2: ys[l]};
                    }
                }
                if (best) Object.assign(pad, {left: best.x1 + 16, top: best.y1 + 16, right: width - best.x2 + 16, bottom: height - best.y2 + 16});
            }
            // Never ask for more padding than the map has room for.
            const horizontal = pad.left + pad.right, vertical = pad.top + pad.bottom;
            if (horizontal > width - 160) { const k = (width - 160) / horizontal; pad.left *= k; pad.right *= k; }
            if (vertical > height - 160) { const k = (height - 160) / vertical; pad.top *= k; pad.bottom *= k; }
            return Object.fromEntries(Object.entries(pad).map(([key, value]) => [key, Math.max(0, Math.round(value))]));
        } catch (error) {
            return fallback;
        }
    }

    // Panel-aware padding plus a margin, shrunk if needed so the free map area never collapses
    // (otherwise MapLibre silently refuses to move and the buses stay hidden under a panel).
    function roomyPadding(extra = 0, extraBottom = extra) {
        const pad = mapPadding();
        const out = {top: pad.top + extra, right: pad.right + extra, bottom: pad.bottom + extraBottom, left: pad.left + extra};
        const width = Number(window.innerWidth) || 0, height = Number(window.innerHeight) || 0;
        const squeeze = (a, b, size) => {
            const room = size - out[a] - out[b];
            const need = Math.min(160, size * 0.3);
            if (!size || room >= need) return;
            const scale = Math.max(0, (size - need) / (out[a] + out[b]));
            out[a] = Math.floor(out[a] * scale); out[b] = Math.floor(out[b] * scale);
        };
        squeeze("left", "right", width);
        squeeze("top", "bottom", height);
        return out;
    }

    function fitCoordinates(coordinates, duration = 900) {
        if (!state.map || !coordinates || coordinates.length < 2) return;

        const bounds = new maplibregl.LngLatBounds();
        coordinates.forEach((point) => bounds.extend(point));

        state.map.fitBounds(bounds, {
            padding: mapPadding(),
            maxZoom: 15,
            pitch: 0,
            bearing: 0,
            duration
        });
    }

    function fitSelectedStops() {
        const origin = stopLngLat(state.origin);
        const destination = stopLngLat(state.destination);
        if (!origin || !destination) return;

        fitCoordinates([origin, destination], 800);
    }

    async function searchStops(query) {
        const response = await fetch(
            `/api/stops?q=${encodeURIComponent(query)}`, { signal: AbortSignal.timeout(8000) }
        );

        if (!response.ok) {
            throw new Error("Stop search failed.");
        }

        const data = await response.json();
        return Array.isArray(data.stops)
            ? data.stops.map(normalizeStop).filter(Boolean)
            : [];
    }

    function renderSuggestions(container, stops, input, type) {
        container.innerHTML = "";

        if (!stops.length) {
            container.innerHTML = '<div class="suggestion-empty">No matching stops. Try another name or pick a point on the map.</div>';
            container.classList.add("visible");
            input.setAttribute("aria-expanded", "true");
            return;
        }

        input.removeAttribute("aria-activedescendant");
        stops.forEach((stop, index) => {
            const button = document.createElement("button");
            button.type = "button";
            button.className = "suggestion-item";
            button.id = `${type}-option-${index}`;
            button.setAttribute("role", "option");
            button.setAttribute("aria-selected", "false");
            button.tabIndex = -1;
            button.innerHTML = `
                <span class="suggestion-main">${escapeHtml(stop.name)}${stop.name_kn && (state.lang === "kn" || /[\u0C80-\u0CFF]/.test(input.value)) ? ` <span class="suggestion-kn" data-no-translate>${escapeHtml(stop.name_kn)}</span>` : ""}</span>
                <span class="suggestion-meta">${Number(stop.route_count) ? `${Number(stop.route_count)} bus routes · ` : ""}stop ${escapeHtml(stop.id)}</span>
            `;

            button.addEventListener("click", () => {
                invalidateJourney();
                input.value = stop.name;

                if (type === "origin") {
                    state.origin = stop;
                    updateMarker("origin", stop);
                } else {
                    state.destination = stop;
                    updateMarker("destination", stop);
                }

                container.classList.remove("visible");
                input.setAttribute("aria-expanded", "false");
                input.removeAttribute("aria-activedescendant");

                if (state.origin && state.destination) {
                    fitSelectedStops();
                }
            });

            container.appendChild(button);
        });

        container.classList.add("visible");
        input.setAttribute("aria-expanded", "true");
    }

    function setupSearch(input, container, type) {
        input.setAttribute("role", "combobox");
        input.setAttribute("aria-autocomplete", "list");
        input.setAttribute("aria-controls", container.id);
        input.setAttribute("aria-expanded", "false");
        input.setAttribute("autocomplete", "off");
        container.setAttribute("role", "listbox");
        input.addEventListener("keydown", event => {
            const options = [...container.querySelectorAll('.suggestion-item')];
            const current = options.findIndex(option => option.getAttribute('aria-selected') === 'true');
            if (event.key === "Escape") {
                container.classList.remove("visible");
                input.setAttribute("aria-expanded", "false");
                return;
            }
            if (!container.classList.contains("visible") || !options.length) return;
            if (event.key === "Enter" && current >= 0) {
                event.preventDefault(); options[current].click();
            } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                event.preventDefault();
                const next = current < 0 ? (event.key === "ArrowDown" ? 0 : options.length - 1) : (current + (event.key === "ArrowDown" ? 1 : -1) + options.length) % options.length;
                options.forEach((option, index) => option.setAttribute("aria-selected", String(index === next)));
                input.setAttribute("aria-activedescendant", options[next].id);
                options[next].scrollIntoView({block: "nearest"});
            }
        });
        input.addEventListener("blur", () => setTimeout(() => {
            if (!container.contains(document.activeElement)) {
                container.classList.remove("visible");
                input.setAttribute("aria-expanded", "false");
            }
        }, 150));
        input.addEventListener("input", () => {
            const query = input.value.trim();
            container.classList.remove("visible");
            input.setAttribute("aria-expanded", "false");
            invalidateJourney();
            state[`${type}Marker`]?.remove();
            state[`${type}Marker`] = null;

            if (type === "origin") state.origin = null;
            else state.destination = null;

            clearTimeout(
                type === "origin"
                    ? state.originTimer
                    : state.destinationTimer
            );

            if (query.length < 2) {
                container.classList.remove("visible");
                return;
            }

            const timer = setTimeout(async () => {
                try {
                    const stops = await searchStops(query);
                    if (input.value.trim() !== query || document.activeElement !== input) return;
                    renderSuggestions(container, stops, input, type);
                } catch (error) {
                    console.error(error);
                    showStatus("Could not search transit stops.", true);
                }
            }, 180);

            if (type === "origin") state.originTimer = timer;
            else state.destinationTimer = timer;
        });

        input.addEventListener("focus", async () => {
            const query = input.value.trim();
            if (query.length < 2) return;

            try {
                const stops = await searchStops(query);
                if (input.value.trim() !== query || document.activeElement !== input) return;
                renderSuggestions(container, stops, input, type);
            } catch (error) {
                console.error(error);
            }
        });
    }

    function normalizeRoutes(result) {
        if (Array.isArray(result)) return result;
        if (Array.isArray(result?.routes)) return result.routes;
        if (Array.isArray(result?.journeys)) return result.journeys;
        if (Array.isArray(result?.options)) return result.options;
        return [];
    }

    function routeCoordinates(route) {
        // OTP's complete geometry includes access, transfer and egress walks.
        if (route?.geometry_source === "otp" && Array.isArray(route.coordinates)) {
            return route.coordinates;
        }
        // For a multi-leg journey, combine the real GTFS geometry from every
        // scheduled leg. This is used for camera fitting and fallback display.
        if (Array.isArray(route?.segments) && route.segments.length) {
            const combined = [];
            for (const segment of route.segments) {
                const segmentCoords = routeCoordinates(segment);
                if (!segmentCoords) continue;
                for (const point of segmentCoords) {
                    if (!combined.length || point[0] !== combined.at(-1)[0] || point[1] !== combined.at(-1)[1]) {
                        combined.push(point);
                    }
                }
            }
            if (combined.length >= 2) return combined;
        }

        const candidates = [
            route?.coordinates,
            route?.geometry?.coordinates,
            route?.path,
            route?.polyline,
            route?.shape,
            Array.isArray(route?.stops) ? route.stops : null
        ];

        for (const value of candidates) {
            if (!Array.isArray(value) || value.length < 2) continue;
            const coordinates = value.map((point) => {
                if (Array.isArray(point) && point.length >= 2) {
                    const lon = Number(point[0]);
                    const lat = Number(point[1]);
                    return Number.isFinite(lon) && Number.isFinite(lat) ? [lon, lat] : null;
                }
                if (point && typeof point === "object") {
                    const lat = Number(point.lat ?? point.latitude ?? point.stop_lat);
                    const lon = Number(point.lon ?? point.lng ?? point.longitude ?? point.stop_lon);
                    return Number.isFinite(lon) && Number.isFinite(lat) ? [lon, lat] : null;
                }
                return null;
            }).filter(Boolean);
            if (coordinates.length >= 2) return coordinates;
        }

        return null;
    }

    function routeSourceId(index) {
        return `transit-route-${index}`;
    }

    function routeLayerId(index) {
        return `transit-route-line-${index}`;
    }

    function routeGlowLayerId(index) {
        return `transit-route-glow-${index}`;
    }

    function routeSegments(route) {
        if (route?.geometry_source === "otp") {
            const coordinates = routeCoordinates(route);
            return coordinates?.length >= 2 ? [{ coordinates }] : [];
        }
        if (Array.isArray(route?.segments) && route.segments.length) {
            return route.segments
                .map((segment) => {
                    const coordinates = routeCoordinates(segment);
                    return coordinates && coordinates.length >= 2
                        ? { ...segment, coordinates }
                        : null;
                })
                .filter(Boolean);
        }

        const coordinates = routeCoordinates(route);
        return coordinates?.length >= 2 ? [{ coordinates }] : [];
    }

    function clearRouteLayers() {
        if (!state.map) return;

        for (let i = 0; i < 32; i += 1) {
            const line = routeLayerId(i);
            const glow = routeGlowLayerId(i);
            const source = routeSourceId(i);

            if (state.map.getLayer(line)) state.map.removeLayer(line);
            if (state.map.getLayer(glow)) state.map.removeLayer(glow);
            if (state.map.getSource(source)) state.map.removeSource(source);
        }

        clearTransferMarkers();
        state.routeEntries = [];
        state.selectedRouteIndex = 0;
    }

    function invalidateJourney() {
        state.journeyRevision += 1;
        state.planController?.abort();
        state.planController = null;
        if (state.journey.active) stopJourneyTracking();
        stopLiveBusTracking();
        state.map?.stop();
        clearRouteLayers();
        routeResults.innerHTML = "";
        hideRoutePanel();
        setPlanningState(false);
    }

    function addRouteToMap(route, index) {
        const segments = routeSegments(route);
        if (!segments.length) return false;

        const sourceId = routeSourceId(index);
        const glowId = routeGlowLayerId(index);
        const lineId = routeLayerId(index);
        const features = segments
            .map((segment, segmentIndex) => {
                const coordinates = (segment.coordinates || [])
                    .map((point) => Array.isArray(point) && point.length >= 2
                        ? [Number(point[0]), Number(point[1])]
                        : null)
                    .filter((point) => point && Number.isFinite(point[0]) && Number.isFinite(point[1]));

                if (coordinates.length < 2) return null;

                return {
                    type: "Feature",
                    properties: {
                        segmentIndex,
                        routeNumber: segment.route_number ?? "",
                        headsign: segment.headsign ?? ""
                    },
                    geometry: {
                        type: "LineString",
                        coordinates
                    }
                };
            })
            .filter(Boolean);

        if (!features.length) return false;

        state.map.addSource(sourceId, {
            type: "geojson",
            lineMetrics: true,
            data: {
                type: "FeatureCollection",
                features
            }
        });

        state.map.addLayer({
            id: glowId,
            type: "line",
            source: sourceId,
            layout: {
                "line-cap": "round",
                "line-join": "round",
                "visibility": state.pathsVisible ? "visible" : "none"
            },
            paint: {
                "line-color": index === 0 ? "#1a73e8" : "#7d8590",
                "line-width": index === 0 ? 14 : 8,
                "line-opacity": index === 0 ? 0.22 : 0.06,
                "line-blur": 1.5
            }
        });

        state.map.addLayer({
            id: lineId,
            type: "line",
            source: sourceId,
            layout: {
                "line-cap": "round",
                "line-join": "round",
                "visibility": state.pathsVisible ? "visible" : "none"
            },
            paint: {
                "line-color": index === 0 ? "#1a73e8" : "#7d8590",
                "line-width": index === 0 ? 7 : 3.5,
                "line-opacity": index === 0 ? 0.99 : 0.3,
                "line-gap-width": 0
            }
        });

        // Keep route layers above the raster map and any accent layer.
        try {
            state.map.moveLayer(glowId);
            state.map.moveLayer(lineId);
        } catch (error) {
            console.debug("Could not move route layers to top:", error);
        }

        state.routeEntries.push({
            index,
            coordinates: features.flatMap((feature) => feature.geometry.coordinates),
            segments,
            sourceId,
            glowId,
            lineId
        });

        return true;
    }

    function updateRouteStyles(selectedIndex) {
        state.routeEntries.forEach((entry) => {
            const selected = entry.index === selectedIndex;
            state.map.setPaintProperty(
                entry.lineId,
                "line-color",
                selected ? "#1a73e8" : "#7d8590"
            );

            state.map.setPaintProperty(
                entry.lineId,
                "line-opacity",
                selected ? 0.99 : 0.38
            );

            state.map.setPaintProperty(
                entry.lineId,
                "line-width",
                selected ? 7 : 3.5
            );

            state.map.setPaintProperty(
                entry.glowId,
                "line-color",
                selected ? "#1a73e8" : "#7d8590"
            );

            state.map.setPaintProperty(
                entry.glowId,
                "line-opacity",
                selected ? 0.22 : 0.04
            );
        });
    }

    function drawRoutes(routes) {
        clearRouteLayers();

        const usable = routes
            .map((route, index) => ({
                route,
                index,
                segments: routeSegments(route),
                coordinates: routeCoordinates(route)
            }))
            .filter((item) => item.segments.length && item.coordinates?.length >= 2);

        if (!usable.length) {
            console.warn("No usable geometry in planner response:", routes);
            return false;
        }

        // Use the card's own index so a card and its map line can never get out of step,
        // even when an earlier option has no drawable geometry.
        const drawn = usable.filter((item) => addRouteToMap(item.route, item.index));
        if (!drawn.length) {
            console.warn("Geometry was present but no map layer could be created.");
            return false;
        }

        updateRouteStyles(drawn[0].index);
        if (!state.liveBus.framed) fitCoordinates(drawn[0].coordinates, 1100);
        return true;
    }

    function minutesText(value) {
        const number = Number(value);
        return Number.isFinite(number) ? `${number} min` : "—";
    }

    function routeBadge(route, index) {
        if (route.transit === false) return "WALK ONLY";
        if (Number(route.leave_in_minutes) > 90 && state.lastPlan?.requested?.is_now !== false) return "LATER SERVICE";
        return index === 0 ? "RECOMMENDED" : "OPTION";
    }

    function legStepsHtml(route, index) {
        const legs = (route.legs || []).filter((leg) => leg.transit || !leg.trivial);
        if (!legs.length) {
            return Array.isArray(route.instructions) && route.instructions.length
                ? `<ol class="journey-instructions">${route.instructions.map((step) => `<li>${escapeHtml(step)}</li>`).join("")}</ol>`
                : "";
        }
        const items = legs.map((leg) => {
            if (!leg.transit) {
                return `<li class="leg walk"><span class="leg-icon" aria-hidden="true">🚶</span><div><div class="leg-main">${escapeHtml(leg.instruction || `Walk ${leg.distance_m} m (${leg.duration_minutes} min).`)}</div></div></li>`;
            }
            const stops = Array.isArray(leg.stops) ? leg.stops : [];
            const count = Number.isFinite(Number(leg.stop_count)) ? Number(leg.stop_count) : Math.max(0, stops.length - 1);
            const wait = Number(leg.wait_before_minutes) > 0 ? `Wait about ${leg.wait_before_minutes} min. ` : "";
            const list = stops.length > 2
                ? `<details class="leg-stops"><summary>All ${stops.length} stops in order</summary><ol>${stops.map((stop) => `<li><span>${escapeHtml(stop.stop_name)}</span><time>${escapeHtml(stop.time || "")}</time></li>`).join("")}</ol></details>`
                : "";
            const metro = leg.role === "metro";
            const color = /^#[0-9A-Fa-f]{6}$/.test(leg.line_color || "") ? leg.line_color : "";
            const reliable = leg.reliability?.text
                ? `<div class="leg-detail leg-reliability" title="${escapeHtml(leg.reliability.source || "")}">📊 ${escapeHtml(leg.reliability.text)}</div>` : "";
            return `<li class="leg ${metro ? "metro" : "bus"}"><span class="leg-icon" aria-hidden="true">${metro ? "🚇" : "🚌"}</span><div>` +
                `<div class="leg-main">${metro ? `<span class="metro-line"${color ? ` style="--line:${color}"` : ""}>${escapeHtml(tr("Metro"))}</span> ` : ""}<strong>${escapeHtml(leg.route_name)}</strong>${leg.headsign ? ` toward ${escapeHtml(leg.headsign)}` : ""}</div>` + reliable +
                `<div class="leg-detail">${escapeHtml(wait)}Board at <b>${escapeHtml(leg.from?.name || "the stop")}</b> · scheduled ${escapeHtml(leg.departure_time || "—")}</div>` +
                `<div class="leg-detail">Get down at <b>${escapeHtml(leg.to?.name || "the stop")}</b> · scheduled ${escapeHtml(leg.arrival_time || "—")} (${escapeHtml(minutesText(leg.duration_minutes))}${count ? `, ${count} stop${count === 1 ? "" : "s"}` : ""})</div>` +
                `${list}</div></li>`;
        });
        return `<details class="card-steps"${index === 0 ? " open" : ""}><summary>Step by step · ${legs.length} step${legs.length === 1 ? "" : "s"}</summary><ol class="journey-legs">${items.join("")}</ol></details>`;
    }

    // Honest heads-up when an option rides much farther than the most direct one (for example out to a
    // highway bus stand and back). It stays listed because the timetable says it arrives earlier.
    function routeDetourNote(route) {
        const busKm = r => (r?.legs || []).filter(leg => leg.transit).reduce((sum, leg) => sum + (Number(leg.distance_m) || 0), 0) / 1000;
        const all = normalizeRoutes(state.lastPlan).filter(r => r.transit !== false && busKm(r) > 0);
        const mine = busKm(route);
        if (!mine || all.length < 2) return "";
        const direct = Math.min(...all.map(busKm));
        if (mine < direct * 1.6 || mine - direct < 8) return "";
        const transfer = (route.legs || []).filter(leg => leg.transit)[1]?.from?.name;
        return `Long way round: about ${Math.round(mine)} km on buses${transfer ? ` (first change at ${transfer})` : ""}, against ${Math.round(direct)} km for the most direct option. Listed because the timetable has it arriving sooner.`;
    }

    function createRouteCard(route, index) {
        const card = document.createElement("article");
        card.className = "route-card journey-route-card";
        if (index === 0) card.classList.add("recommended");

        const requested = state.lastPlan?.requested || {};
        const transfers = route.transfers ?? 0;
        const walking = route.walking_minutes;
        const walkingText = Number.isFinite(Number(walking)) && Number(walking) > 0
            ? `${walking} min walking${route.walking_source === "street_network" ? "" : " (approx.)"}`
            : route.walking_available ? "No walking" : "Walk estimate unavailable";
        const numbers = Array.isArray(route.route_numbers)
            ? route.route_numbers
            : [route.route_name ?? route.route ?? "Transit"];
        const transferText = Array.isArray(route.transfer_stops) && route.transfer_stops.length
            ? `Change at ${route.transfer_stops.join(" → ")}`
            : route.transit === false ? "" : "No change of bus";
        const departure = route.departure_time ?? route.sample_departure ?? route.departure;
        const arrival = route.arrival_time ?? route.sample_arrival ?? route.arrival;
        const trip = route.trip_minutes ?? route.total_elapsed_minutes ?? route.total_minutes ?? route.duration_minutes;
        const leaveIn = Number(route.leave_in_minutes);
        const leaveText = departure
            ? `Leave ${departure}${requested.is_now && Number.isFinite(leaveIn) ? (leaveIn > 0 ? ` (in ${leaveIn} min)` : " (now)") : ""}`
            : "Scheduled";
        const firstWait = Number(route.first_bus_wait_minutes);
        const transferWait = Number(route.transfer_wait_minutes);
        const waitText = Number.isFinite(firstWait) && route.transit !== false
            ? `⏱ ${firstWait} min at first stop${transfers ? `, ${Number.isFinite(transferWait) ? transferWait : 0} min at changes` : ""}`
            : route.scheduled_wait_minutes != null ? `⏱ ${route.scheduled_wait_minutes} min waiting` : "";
        const advisory = Array.isArray(route.advisories) && route.advisories.length
            ? route.advisories.join(" · ")
            : "";
        const finalWalkText = route.final_walk_from && route.final_walk_to
            ? `Get down at ${route.final_walk_from}; the requested stop is about ${route.final_walk_distance_m ?? "?"} m away.`
            : "";
        const source = route.transit === false ? "Walking route · street network"
            : route.uses_metro ? "Scheduled metro and buses · road-based walking"
            : route.schedule_based === false ? "Live estimate"
            : route.geometry_source === "otp" ? "Scheduled buses · road-based walking"
            : route.geometry_source === "gtfs_shape" ? "Scheduled GTFS route alignment"
            : "Scheduled GTFS stop sequence · road geometry unavailable";

        const busLegs = (route.legs || []).filter((leg) => leg.transit && leg.route_name);
        // Measured from BMTC's own data (only present after enough days of live checks).
        const learnedLeg = busLegs.find(leg => leg.reliability?.text);
        const learned = learnedLeg?.reliability;
        const learnedShort = !learned ? "" : Math.abs(learned.typical_delay_minutes) <= 2
            ? tr("{line} usually on time", { line: learned.route })
            : learned.typical_delay_minutes > 0 ? tr("{line} usually ~{min} min late", { line: learned.route, min: learned.typical_delay_minutes })
                : tr("{line} usually ~{min} min early", { line: learned.route, min: -learned.typical_delay_minutes });
        const confidence = route.journey_confidence;
        const confidenceLevel = ["high", "medium", "low"].includes(confidence?.level) ? confidence.level : "";
        const confidenceTransfers = Array.isArray(confidence?.transfers) ? confidence.transfers : [];
        const confidenceHtml = confidenceLevel ? `<div class="journey-confidence ${confidenceLevel}">
            <div class="confidence-heading"><strong>${confidenceLevel === "high" ? "✓" : confidenceLevel === "medium" ? "!" : "⚠"} ${escapeHtml(confidence.label)} connection confidence</strong><span>${escapeHtml(String(confidence.score))}/100</span></div>
            <p>${escapeHtml(confidence.summary)}</p>
            ${confidenceTransfers.length ? `<details><summary>Check ${confidenceTransfers.length} transfer${confidenceTransfers.length === 1 ? "" : "s"}</summary><ol>${confidenceTransfers.map(item =>
                `<li class="${escapeHtml(item.status)}"><b>${escapeHtml(item.label)} at ${escapeHtml(item.stop)}</b><br>${escapeHtml(item.from_route)} → ${escapeHtml(item.to_route)} · ${escapeHtml(item.detail)}</li>`).join("")}</ol></details>` : ""}
            <small>${escapeHtml(confidence.basis || "Connection guidance, not a live arrival guarantee.")}</small>
        </div>` : "";
        const detourNote = route.detour === undefined ? routeDetourNote(route) : "";
        const stretchNotes = busLegs.filter(leg => leg.also_served_by?.length).map(leg =>
            `${busLegs.length > 1 ? `${leg.from?.name || "Stop"} → ${leg.to?.name || "stop"}: ` : ""}${leg.also_served_by.join(", ")} also go${leg.also_served_by.length === 1 ? "es" : ""} there`);
        const liveLegs = busLegs.filter(leg => leg.role !== "metro");     // BMTC's live feed has no metro trains
        const trackTargets = route.transit === false ? [] : busLegs.length
            ? liveLegs.map((leg) => ({ number: leg.route_name, from: leg.from, to: leg.to }))
            : [...new Set(numbers)].map((number) => ({ number, from: null, to: null }));
        const point = (place, prefix) => place && Number.isFinite(Number(place.lat)) && Number.isFinite(Number(place.lon))
            ? `data-${prefix}-lat="${Number(place.lat)}" data-${prefix}-lon="${Number(place.lon)}" data-${prefix}-name="${escapeHtml(place.name || "stop")}"`
            : "";

        card.innerHTML = `
            <div class="route-card-top">
                <span class="route-badge">${escapeHtml(routeBadge(route, index))}</span>
                <span class="route-time">${arrival ? `Arrive ${escapeHtml(String(arrival))}` : `${escapeHtml(minutesText(trip))}`}</span>
            </div>
            <div class="route-subline">${escapeHtml(leaveText)} · ${escapeHtml(minutesText(trip))} door to door</div>
            <button type="button" class="start-journey-button">▶ Start journey</button>
            <div class="card-tools">
                ${leaveSchedule(route)?.possible ? `<button type="button" class="card-tool remind">🔔 ${escapeHtml(tr("Remind me to leave"))}</button>` : ""}
                <button type="button" class="card-tool share">↗ ${escapeHtml(tr("Share"))}</button>
            </div>
            ${arrivalWindowHtml(route)}
            ${walkHintsHtml(route)}
            ${compareHtml(route, state.compare)}

            <div class="route-description">
                <strong>${escapeHtml(numbers.join("  →  "))}</strong>
                <br>${escapeHtml(source)}
                ${detourNote ? `<span class="route-detour-note">${escapeHtml(detourNote)}</span>` : ""}
                ${stretchNotes.length ? `<span class="route-also-lines">🚌 ${escapeHtml(stretchNotes.join(" · "))}</span>` : ""}
            </div>

            <div class="route-metrics">
                <span class="route-metric">🔄 ${escapeHtml(String(transfers))} transfer${transfers === 1 ? "" : "s"}</span>
                <span class="route-metric">🚶 ${escapeHtml(walkingText)}</span>
                ${learned ? `<span class="route-metric reliability" title="${escapeHtml(learned.text)}">📊 ${escapeHtml(learnedShort)}</span>` : ""}
                ${waitText ? `<span class="route-metric">${escapeHtml(waitText)}</span>` : ""}
            </div>

            ${confidenceHtml}

            ${transferText ? `<div class="route-description">${escapeHtml(transferText)}${route.transit !== false && Number.isFinite(Number(route.total_minutes)) ? ` · ${escapeHtml(String(route.total_minutes))} min on buses` : ""}</div>` : ""}
            ${advisory ? `<div class="route-advisory">${escapeHtml(advisory)}</div>` : ""}
            <div class="route-description">${escapeHtml((route.highlights || []).join(" · "))}${(route.highlights || []).length && route.recommendation_reason ? "<br>" : ""}${escapeHtml(route.recommendation_reason || "")}</div>
            ${finalWalkText ? `<div class="route-description">${escapeHtml(finalWalkText)}</div>` : ""}
            ${legStepsHtml(route, index)}
            <div class="route-actions">${trackTargets.map((target) => {
                const from = point(target.from, "stop");
                const to = point(target.to, "alight");
                const label = target.from?.name ? `${target.number} near ${target.from.name}` : `${target.number} buses`;
                return `<button type="button" class="live-bus-button" data-live-route="${escapeHtml(target.number)}" data-live-label="${escapeHtml(label)}" data-live-key="${escapeHtml(liveKey(target.number, target.from))}" ${from} ${to}>◎ Track ${escapeHtml(label)}</button>`;
            }).join("")}</div>
            <p class="schedule-note">${escapeHtml(route.schedule_note || "Scheduled from the BMTC timetable, not a live arrival.")}</p>
            <button type="button" class="card-more" aria-label="Show all details for this option">Details ⤢</button>
        `;

        card.querySelector(".card-more")?.addEventListener("click", (event) => {
            event.stopPropagation();
            setRoutesExpanded(true);
            setTimeout(() => card.scrollIntoView?.({block: "nearest", behavior: "smooth"}), 420);
        });
        card.querySelector(".card-tool.remind")?.addEventListener("click", (event) => { event.stopPropagation(); setReminderFor(route); });
        card.querySelector(".card-tool.share")?.addEventListener("click", (event) => {
            event.stopPropagation();
            const firstBus = (route.legs || []).find(leg => leg.transit && leg.role !== "metro");
            shareTrip(route, { bus: firstBus?.route_name || "" });
        });
        const startButton = card.querySelector(".start-journey-button");
        startButton?.addEventListener("click", (event) => {
            event.stopPropagation();
            if (state.journey.active && state.journey.route === route) {
                stopJourneyTracking();
            } else {
                startJourney(route, index);
            }
        });
        card.querySelectorAll(".live-bus-button").forEach((button) => button.addEventListener("click", (event) => {
            event.stopPropagation();
            const placeFrom = (prefix) => button.dataset[`${prefix}Lat`] && button.dataset[`${prefix}Lon`]
                ? { lat: Number(button.dataset[`${prefix}Lat`]), lon: Number(button.dataset[`${prefix}Lon`]), name: button.dataset[`${prefix}Name`] }
                : null;
            trackBmtcRoute(button.dataset.liveRoute, route, index, placeFrom("stop"), placeFrom("alight"));
        }));

        card.addEventListener("click", () => {
            selectRoute(route, index);
            showStatus("Route selected.");
        });

        return card;
    }

    function createFallbackCard(result) {
        const fallback = result?.fallback;
        const card = document.createElement("article");
        card.className = "route-card fallback-card";

        const title = fallback?.type === "short_local_trip"
            ? "Better for a short local trip"
            : "No practical bus connection";
        const message = fallback?.message || result?.notice ||
            "No practical scheduled bus journey was found between these two stops.";

        card.innerHTML = `
            <div class="route-card-top">
                <span class="route-badge">NEXT BEST STEP</span>
                <span class="route-time">Plan help</span>
            </div>
            <div class="route-description"><strong>${escapeHtml(title)}</strong></div>
            <div class="route-description">${escapeHtml(message)}</div>
        `;

        [
            ["origin", fallback?.origin_alternatives || []],
            ["destination", fallback?.destination_alternatives || []]
        ].forEach(([type, stops]) => {
            if (!stops.length) return;

            const heading = document.createElement("div");
            heading.className = "fallback-heading";
            heading.textContent = type === "origin"
                ? "Try a nearby boarding stop"
                : "Try a nearby destination stop";
            card.appendChild(heading);

            stops.forEach((rawStop) => {
                const stop = normalizeStop(rawStop);
                if (!stop) return;
                const button = document.createElement("button");
                button.type = "button";
                button.className = "fallback-stop-button";
                button.textContent = `${stop.name} · ${rawStop.walk_distance_m} m away`;
                button.addEventListener("click", () => {
                    if (type === "origin") {
                        state.origin = stop;
                        originInput.value = stop.name;
                        updateMarker("origin", stop);
                    } else {
                        state.destination = stop;
                        destinationInput.value = stop.name;
                        updateMarker("destination", stop);
                    }
                    planJourney();
                });
                card.appendChild(button);
            });
        });

        return card;
    }

    function renderRoutes(result) {
        const revision = state.journeyRevision;
        const routes = normalizeRoutes(result);
        const meta = $("routeMeta");
        if (meta) {
            const when = result?.requested?.label;
            const nextService = result?.next_service?.automatic;
            meta.textContent = routes.length
                ? `${nextService ? "Next morning service · " : (when ? `Leaving ${when.toLowerCase()} · ` : "")}${routes.length} option${routes.length === 1 ? "" : "s"} · from the BMTC timetable, not live arrivals`
                : "";
        }

        routeResults.innerHTML = "";
        if ($("rainNote")) { $("rainNote").hidden = true; $("rainNote").innerHTML = ""; }
        state.compare = result?.compare || null;
        clearRouteLayers();
        syncExplainButton();

        if (!routes.length) {
            routeResults.appendChild(createFallbackCard(result));
            return;
        }
        rememberTrip(state.origin, state.destination);
        logTrip(state.origin, state.destination);
        if ($("usualCard")) $("usualCard").hidden = true;

        if (routes.some(route => route.transit !== false && routeLiveScope(route).lines.length)) {
            const liveCard = document.createElement("article");
            liveCard.className = "route-card live-overview-card";
            liveCard.innerHTML = `<span class="route-badge">LIVE CHECK</span><h3>Check live buses</h3><button type="button" class="live-bus-button">🚌 Check buses for this journey</button><p>Buses BMTC reports heading to the highlighted journey's boarding stop, including other bus numbers that go the same way. Other options are listed separately.</p>`;
            liveCard.querySelector("button")?.addEventListener("click", () => {
                const route = routes[state.selectedRouteIndex] || routes[0];
                const scope = routeLiveScope(route);
                if (!scope.lines.length) return showStatus("This journey has no bus leg to track.", true);
                trackSearchBuses(scope.lines, [route], false, scope.boardingStop, scope.alightStop, routeAlternates(route));
            });
            routeResults.appendChild(liveCard);
        }
        routes.slice(0, 8).forEach((route, index) => {
            const card = createRouteCard(route, index);
            card.setAttribute("data-route-index", String(index));
            routeResults.appendChild(card);
        });
        checkRainForTrip(routes.slice(0, 8), revision);

        waitForMap().then(() => {
            if (revision !== state.journeyRevision) return;
            const drawn = drawRoutes(routes.slice(0, 8));

            if (!drawn) {
                // The planner normally supplies full GTFS stop geometry.
                // Keep the map useful even if an older backend omits it.
                const fallback = [stopLngLat(state.origin), stopLngLat(state.destination)].filter(Boolean);
                if (fallback.length >= 2) {
                    fitCoordinates(fallback, 800);
                    showStatus("Route found. Detailed geometry is unavailable from the backend.", true);
                } else {
                    showStatus("Routes were found, but map geometry was unavailable.", true);
                }
                return;
            }

            selectRoute(routes[0], 0, false);
        }).catch((error) => {
            if (revision !== state.journeyRevision) return;
            console.error("Map rendering error:", error);
            showStatus(error.message || "Map rendering failed.", true);
        });
    }

    function selectRoute(route, index, moveCamera = true) {
        if (state.liveBus.route && !state.liveBus.routes && state.liveBus.itinerary !== route) stopLiveBusTracking();
        if (state.journey.active && state.journey.route !== route) stopJourneyTracking();
        const switchLiveRoute = state.liveBus.routes && state.liveBus.journeys?.length === 1 &&
            state.liveBus.journeys[0] !== route && !state.liveBus.autoForJourney;
        state.selectedRouteIndex = index;

        updateRouteStyles(index);
        addTransferMarkers(route);
        if (state.liveBus.journeys?.includes(route)) {
            state.liveBus.journeyIndex = state.liveBus.journeys.indexOf(route);
            updateLiveJourneyChoice();
        }

        const coordinates = routeCoordinates(route);

        if (moveCamera && coordinates?.length >= 2) {
            fitCoordinates(coordinates, 900);
        }
        if (switchLiveRoute) {
            const scope = routeLiveScope(route);
            if (scope.lines.length) trackSearchBuses(scope.lines, [route], false, scope.boardingStop, scope.alightStop, routeAlternates(route));
            else stopLiveBusTracking();
        }
    }

    function setPlanningState(active) {
        planBtn.disabled = active;
        planBtn.classList.toggle("loading", active);

        const span = planBtn.querySelector("span:first-child");
        if (span) span.textContent = active ? "Planning..." : "Find routes";
    }

    // If the traveller typed a name but never tapped a suggestion, use the best matching BMTC stop
    // (and say so) rather than refusing to search.
    async function resolveTypedEndpoints() {
        const notes = [];
        for (const type of ["origin", "destination"]) {
            const input = type === "origin" ? originInput : destinationInput;
            const text = String(input?.value || "").trim();
            if (state[type] || text.length < 2) continue;
            try {
                const stop = (await searchStops(text))[0];
                if (!stop) continue;
                state[type] = stop;
                input.value = stop.name;
                updateMarker(type, stop);
                notes.push(`${type === "origin" ? "From" : "To"}: ${stop.name}`);
            } catch (error) { /* the generic message below explains what is missing */ }
        }
        if (notes.length) showStatus(`Using the best match. ${notes.join(" · ")}`);
    }

    function swapEndpoints() {
        if (!state.origin && !state.destination) return;
        invalidateJourney();
        [state.origin, state.destination] = [state.destination, state.origin];
        const from = originInput.value;
        originInput.value = destinationInput.value;
        destinationInput.value = from;
        ["origin", "destination"].forEach((type) => {
            state[`${type}Marker`]?.remove();
            state[`${type}Marker`] = null;
            if (state[type]) updateMarker(type, state[type]);
        });
        if (state.origin && state.destination) planJourney();
    }

    async function planJourney() {
        if (!state.origin || !state.destination) await resolveTypedEndpoints();
        if (!state.origin || !state.destination) {
            showStatus("Select both your starting point and destination.", true);
            return;
        }

        if (state.origin.id === state.destination.id) {
            showStatus("Choose two different stops.", true);
            return;
        }

        invalidateJourney();
        const revision = state.journeyRevision;
        setPlanningState(true);
        const controller = new AbortController();
        state.planController = controller;

        try {
            const profile = { preference: state.selectedPreference };
            if (state.departAt) profile.depart_at = state.departAt;
            const result = await fetchJson("/api/plan", {
                method: "POST",
                signal: controller.signal,
                headers: {
                    "Content-Type": "application/json"
                },
                body: JSON.stringify({
                    origin_stop_id: state.origin.id,
                    destination_stop_id: state.destination.id,
                    origin_point: state.origin.is_map_point ? state.origin : undefined,
                    destination_point: state.destination.is_map_point ? state.destination : undefined,
                    profile
                })
            }, 28000);
            if (revision !== state.journeyRevision) return;
            if (!result.ok || !result.data) throw apiError(result, "Route search failed");

            state.lastPlan = result.data;
            renderRoutes(result.data);
            showRoutePanel();

            const routes = normalizeRoutes(result.data);
            if (routes.length) {
                showStatus(result.data?.next_service?.automatic
                    ? `${routes.length} next-morning route option${routes.length === 1 ? "" : "s"} found.`
                    : `${routes.length} route option${routes.length === 1 ? "" : "s"} found.`);
            } else {
                showStatus(result.data.fallback?.message || "No connected route was found.", true);
            }
        } catch (error) {
            if (revision !== state.journeyRevision) return;
            console.error("Journey planning error:", error);
            clearRouteLayers();
            if (error instanceof ApiError && error.data?.router_unavailable) showBanner(error.message);
            showStatus(explainFailure(error, "Route search"), true);
        } finally {
            if (revision === state.journeyRevision) {
                state.planController = null;
                setPlanningState(false);
            }
        }
    }

    function openChat() {
        exitMapFocus();
        chatPanel.classList.add("open");
        const input = $("chatInput");
        if (input) input.focus();
    }

    function closeChat() {
        chatPanel.classList.remove("open");
    }

    // Say plainly who reads the chat: Gemini (AI) when the server has a key, otherwise the built-in helper.
    function showAssistantEngine(info) {
        const label = $("chatEngine");
        if (!label) return;
        const ai = info?.engine === "gemini";
        label.textContent = ai ? "Gemini AI understands your messages · routes from BMTC data"
            : "Built-in helper · routes from BMTC data";
        label.title = ai ? `Model: ${info.model || "Gemini"}. Places and journeys are still checked against BMTC data.` : "";
        chatPanel?.classList?.toggle("ai-on", ai);
        syncExplainButton();
    }

    function syncExplainButton() {
        const button = $("explainBtn");
        if (button) button.hidden = !(state.health?.assistant?.engine === "gemini" && normalizeRoutes(state.lastPlan).length > 1);
    }

    function addChatMessage(message, role = "assistant") {
        const messages = $("chatMessages");
        if (!messages) return null;

        const item = document.createElement("div");
        item.className = `chat-message ${role}`;
        item.textContent = message;
        messages.appendChild(item);
        messages.scrollTop = messages.scrollHeight;
        return item;
    }

    function syncPreferenceChips() {
        document.querySelectorAll(".quick-chip").forEach((chip) => {
            chip.setAttribute("aria-pressed", String(chip.dataset.preference === state.selectedPreference));
        });
    }

    function setDepartAt(value, { replan = true } = {}) {
        state.departAt = value || "";
        const input = $("departInput");
        if (input) input.value = state.departAt;
        $("departNow")?.classList.toggle("active", !state.departAt);
        $("departNow")?.setAttribute("aria-pressed", String(!state.departAt));
        $("departHint").textContent = state.departAt
            ? `Leaving at ${state.departAt} (tomorrow if that time has passed). Timetable times, not live arrivals.`
            : "Timetable times, not live arrivals.";
        if (replan && state.origin && state.destination) planJourney();
    }

    // Apply what the assistant resolved to the page, replacing (never layering on) old results.
    function applyAssistantResult(data) {
        const keep = (next, current) => next && current && next.id === current.id ? current : next;
        const nextOrigin = keep(data.origin ? normalizeStop(data.origin) : null, state.origin);
        const nextDestination = keep(data.destination ? normalizeStop(data.destination) : null, state.destination);
        const endpointsChanged = (nextOrigin && nextOrigin !== state.origin) ||
            (nextDestination && nextDestination !== state.destination);

        if (data.preference && data.preference !== state.selectedPreference) {
            state.selectedPreference = data.preference;
            syncPreferenceChips();
        }
        if (data.depart_at && data.depart_at !== state.departAt) setDepartAt(data.depart_at, { replan: false });

        if (endpointsChanged || data.plan) invalidateJourney();
        if (nextOrigin) {
            state.origin = nextOrigin;
            originInput.value = nextOrigin.name;
            updateMarker("origin", nextOrigin);
        }
        if (nextDestination) {
            state.destination = nextDestination;
            destinationInput.value = nextDestination.name;
            updateMarker("destination", nextDestination);
        }
        if (data.plan) {
            state.lastPlan = data.plan;
            renderRoutes(data.plan);
            showRoutePanel();
        } else if (state.origin && state.destination) {
            fitSelectedStops();
        }
    }

    // Visible "thinking" feedback while the assistant works: in the main search box (the chat may be
    // closed) and as an animated message in the chat. Steps advance on a timer because the server
    // answers in one go; they describe what it is doing, never a result.
    function startThinking(pending) {
        const ai = state.health?.assistant?.engine === "gemini";
        const steps = [
            [0, ai ? "Gemini is reading your request" : "Reading your request"],
            [1500, "Finding the stops and buses"],
            [6000, "Still working: the route engine can take a few seconds"],
            [20000, "Taking longer than usual; hang on a little more"]];
        const box = document.querySelector(".ai-command");
        const input = $("aiInput");
        const status = $("aiStatus");
        const placeholder = input?.placeholder;
        box?.classList?.add("thinking");
        if (input) input.placeholder = "Working on your request… (you can type the next one)";
        const show = (text) => {
            if (status) { status.hidden = false; status.textContent = `${text}…`; }
            if (pending) pending.textContent = text;
        };
        const timers = steps.map(([delay, text]) => setTimeout(() => show(text), delay));
        show(steps[0][1]);
        return () => {
            timers.forEach(clearTimeout);
            box?.classList?.remove("thinking");
            if (input) input.placeholder = placeholder;
            if (status) { status.hidden = true; status.textContent = ""; }
        };
    }

    async function runAssistantCommand(text, { fromMainBar = false, endpoint = "/api/assistant", extra = null, label = "" } = {}) {
        const command = String(text || "").trim();
        if (!command) return false;
        if (state.chatBusy) {
            showStatus("Still working on your last request. Your new one is kept in the box; press Enter again in a moment.", true);
            return false;
        }

        addChatMessage(label || command, "user");
        const pending = addChatMessage("", "assistant pending thinking");
        const stopThinking = startThinking(pending);
        state.chatBusy = true;
        $("chatSendBtn")?.setAttribute("disabled", "");

        // The server reads the message with Gemini when it has a key (the key never reaches this page),
        // otherwise with the built-in rule-based helper. Journeys always come from the local planner.
        const history = (state.chatHistory || []).slice(-6);
        const context = (stop) => stop ? { id: stop.id, name: stop.name, lat: stop.lat, lon: stop.lon, is_map_point: !!stop.is_map_point } : null;
        try {
            const result = await fetchJson(endpoint, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    ...(extra || {}),
                    message: command,
                    origin: context(state.origin),
                    destination: context(state.destination),
                    preference: state.selectedPreference,
                    depart_at: state.departAt || undefined,
                    history,
                    saved: savedForAssistant(),
                    lang: state.lang === "kn" ? "kn" : undefined
                })
            }, 40000);
            const data = result.data;
            if (!data || (!result.ok && !data.reply)) throw apiError(result, "The assistant could not answer");
            if (pending) {
                pending.textContent = data.reply || "Done.";
                if (data.intent === "answer" && data.engine === "gemini") {
                    const tag = document.createElement("small");
                    tag.className = "chat-ai-tag";
                    tag.textContent = "Gemini AI answer · may be wrong; bus numbers and times come only from the planner";
                    pending.appendChild(tag);
                }
                if (data.notice) {
                    const note = document.createElement("small");
                    note.className = "chat-ai-tag notice";
                    note.textContent = data.notice;
                    pending.appendChild(note);
                }
                if (data.photo) {
                    const tag = document.createElement("small");
                    tag.className = "chat-ai-tag";
                    tag.textContent = tr("Photo read by Gemini AI · check it matches what you see");
                    pending.appendChild(tag);
                }
            }
            state.chatHistory = [...(state.chatHistory || []), {role: "user", text: label || command},
                {role: "assistant", text: String(data.reply || "").slice(0, 300)}].slice(-6);
            if (data.origin || data.destination || data.plan) applyAssistantResult(data);
            if (data.intent === "live") await liveFromChat(data.route, pending);
            if (data.intent === "use_location") await startFromMyLocation(pending);
            // A Gemini-planned journey also gets a short, fact-checked comparison of the options.
            if (data.plan && data.engine === "gemini" && normalizeRoutes(data.plan).length > 1) explainOptions({quiet: true});
            // A planned journey is the answer: on small screens get the chat out of the way of the routes.
            if (data.plan && (window.innerWidth || 1600) < 1100) {
                closeChat();
                showStatus(data.summary || data.reply || "Routes ready.");
            } else if (fromMainBar && !chatPanel.classList.contains("open")) {
                if (data.plan) showStatus(data.summary || data.reply || "Routes ready."); else openChat();
            }
            speakChatAnswer(pending);
        } catch (error) {
            console.error("Assistant error:", error);
            if (pending) pending.textContent = `${explainFailure(error, "The assistant")} You can also use the From and To boxes.`;
            if (!chatPanel.classList.contains("open")) openChat();
            speakChatAnswer(pending);
        } finally {
            stopThinking();
            state.chatBusy = false;
            $("chatSendBtn")?.removeAttribute("disabled");
            pending?.classList?.remove("pending", "thinking");
        }
        return true;
    }

    function routeFacts(route) {
        const firstBus = (route.legs || []).find(leg => leg.transit);
        return {route_numbers: route.route_numbers, transit: route.transit, departure_time: route.departure_time,
            arrival_time: route.arrival_time, trip_minutes: route.trip_minutes, leave_in_minutes: route.leave_in_minutes,
            transfers: route.transfers, walking_minutes: route.walking_minutes, detour: !!route.detour,
            also_lines: firstBus?.also_served_by || []};
    }

    // Ask the server for a short Gemini comparison of the options on screen. The server discards any
    // answer that mentions a time, number or bus that is not in these results.
    async function explainOptions({quiet = false} = {}) {
        const routes = normalizeRoutes(state.lastPlan);
        if (!routes.length) return;
        const revision = state.journeyRevision;
        const item = quiet ? null : (openChat(), addChatMessage("Comparing the options…", "assistant pending"));
        try {
            const result = await fetchJson("/api/explain", {method: "POST", headers: {"Content-Type": "application/json"},
                body: JSON.stringify({routes: routes.slice(0, 5).map(routeFacts), preference: state.selectedPreference})}, 20000);
            if (revision !== state.journeyRevision) { item?.remove(); return; }
            if (result.data?.ok && result.data.text) {
                const target = item || addChatMessage("", "assistant");
                if (!target) return;
                target.textContent = result.data.text;
                const tag = document.createElement("small");
                tag.className = "chat-ai-tag";
                tag.textContent = "Gemini summary · checked against the options shown";
                target.appendChild(tag);
            } else if (item) {
                item.textContent = result.data?.reason === "ungrounded"
                    ? "Gemini's summary mentioned something that is not in these results, so I left it out. The option cards show the details."
                    : "No summary right now (Gemini is unavailable). The option cards show the details.";
            }
        } catch (error) {
            if (item) item.textContent = "No summary right now. The option cards show the details.";
        } finally {
            item?.classList?.remove("pending");
        }
    }

    // "Where is my bus?" from the chat: run the normal live check and copy its headline into the chat.
    async function liveFromChat(routeName, item) {
        const routes = normalizeRoutes(state.lastPlan);
        const selected = routes[state.selectedRouteIndex] || routes[0] || null;
        const wanted = String(routeName || "").trim().toUpperCase();
        const say = (text) => { if (item) item.textContent = text; };
        if (wanted) {
            const base = name => String(name || "").trim().toUpperCase().split(" ")[0];
            const ordered = selected ? [selected, ...routes.filter(r => r !== selected)] : routes;
            let match = null;
            for (const route of ordered) {
                const leg = (route.legs || []).find(l => l.transit && (base(l.route_name) === base(wanted) ||
                    (l.also_served_by || []).some(n => base(n) === base(wanted))));
                if (leg) { match = {route, leg}; break; }
            }
            if (match) {
                const lines = [wanted, ...[match.leg.route_name, ...(match.leg.also_served_by || [])]
                    .filter(n => base(n) !== base(wanted))].slice(0, 1);
                trackSearchBuses(lines, [match.route], false, placeOf(match.leg.from, "boarding stop"), placeOf(match.leg.to, "alighting stop"), []);
            } else if (state.origin) {
                trackSearchBuses([wanted], [], false, placeOf(state.origin, "your start"),
                    state.destination ? placeOf(state.destination, "your destination") : null, []);
            } else {
                // No start chosen: look for that bus around where the traveller is standing (one GPS fix,
                // used only by this app's own live check).
                const here = await currentPlace();
                if (!here) {
                    say(`Tell me where you are starting (or plan a journey first), so I can check which ${wanted} buses are coming your way.`);
                    return;
                }
                trackSearchBuses([wanted], [], false, here, state.destination ? placeOf(state.destination, "your destination") : null, []);
            }
        } else if (selected) {
            const scope = routeLiveScope(selected);
            if (!scope.lines.length) { say("The selected journey has no bus to track."); return; }
            trackSearchBuses(scope.lines, [selected], false, scope.boardingStop, scope.alightStop, routeAlternates(selected));
        } else {
            say("Plan a journey first (for example \"Whitefield to Majestic\"), then ask me where your bus is.");
            return;
        }
        // Wait for the first answer from the live check, then repeat its headline here.
        const session = state.liveBus.session;
        for (let waited = 0; waited < 20000; waited += 300) {
            await new Promise(resolve => setTimeout(resolve, 300));
            if (session !== state.liveBus.session) return;
            if (state.liveBus.hasResult || (!state.liveBus.loading && waited > 900)) break;
        }
        const headline = $("liveBusStatus")?.textContent || "";
        const meta = ($("liveBusMeta")?.textContent || "").split(" · ")[0] || "";
        say(`${headline}${meta && !meta.startsWith("checked") ? `. ${meta.charAt(0).toUpperCase()}${meta.slice(1)}` : ""}. Details and the bus markers are in the live panel.`);
    }

    // One GPS fix as a place, or null (no permission, no fix, outside Bengaluru, or too rough).
    function currentPlace() {
        if (!navigator.geolocation) return Promise.resolve(null);
        return new Promise(resolve => {
            try {
                navigator.geolocation.getCurrentPosition(position => {
                    const { latitude: lat, longitude: lon, accuracy } = position.coords;
                    const usable = lat >= 12.65 && lat <= 13.45 && lon >= 77.20 && lon <= 78.00 && accuracy <= 1000;
                    resolve(usable ? { id: "point-here", name: tr("your location"), lat, lon } : null);
                }, () => resolve(null), { enableHighAccuracy: true, timeout: 12000, maximumAge: 30000 });
            } catch { resolve(null); }
        });
    }

    // "From here": take one GPS fix in the browser, use it as the start, and plan if a destination is set.
    // The position goes only to this app's own planner, never to Gemini.
    function startFromMyLocation(item) {
        const say = (text) => { if (item) item.textContent = text; };
        if (!navigator.geolocation) {
            say("This browser cannot share your location. Type your starting stop instead.");
            return Promise.resolve();
        }
        say("Getting your location…");
        return new Promise(resolve => navigator.geolocation.getCurrentPosition(async (position) => {
            const {latitude: lat, longitude: lon} = position.coords;
            const accuracy = Math.round(position.coords.accuracy || 0);
            if (!(lat >= 12.65 && lat <= 13.45 && lon >= 77.20 && lon <= 78.00)) {
                say("Your location is outside the Bengaluru routing area, so it cannot be the start. Type your starting stop instead.");
                return resolve();
            }
            const point = normalizeStop({id: "point-origin", is_map_point: true, name: `My location (±${accuracy} m)`, lat, lon});
            invalidateJourney();
            state.origin = point;
            originInput.value = point.name;
            updateMarker("origin", point);
            const rough = accuracy > 300 ? ` Your location is only accurate to about ${accuracy} m; check the marker, or type your stop.` : "";
            if (!state.destination) {
                say(`Start set to your location.${rough} Where do you want to go?`);
                return resolve();
            }
            say(`Start set to your location, going to ${state.destination.name}.${rough} Finding buses…`);
            await planJourney();
            const count = normalizeRoutes(state.lastPlan).length;
            say(count ? `From your location to ${state.destination.name}: ${count} option${count === 1 ? "" : "s"} in the panel below (timetable times, not live).${rough}`
                : `No scheduled journey was found from your location to ${state.destination.name}.${rough}`);
            resolve();
        }, (error) => {
            say(error.code === 1 ? "Location permission was blocked. Allow location for this site, or type your starting stop."
                : "I could not get your location right now. Type your starting stop instead.");
            resolve();
        }, {enableHighAccuracy: true, timeout: 15000, maximumAge: 30000}));
    }

    function setupVoice(button, input, { fromMainBar = false } = {}) {
        if (!button || !input) return;

        const SpeechRecognition =
            window.SpeechRecognition ||
            window.webkitSpeechRecognition;

        if (!SpeechRecognition) {
            // A button that does nothing is worse than no button.
            button.style.display = "none";
            return;
        }

        const recognition = new SpeechRecognition();
        recognition.lang = state.lang === "kn" ? "kn-IN" : "en-IN";
        state.voices = [...(state.voices || []), recognition];
        recognition.interimResults = false;
        recognition.maxAlternatives = 1;

        recognition.onstart = () => {
            state.isListening = true;
            button.classList.add("listening");
        };

        recognition.onend = () => {
            state.isListening = false;
            button.classList.remove("listening");
        };

        recognition.onerror = () => {
            state.isListening = false;
            button.classList.remove("listening");
            showStatus("Voice input could not be completed.", true);
        };

        recognition.onresult = (event) => {
            const text = event.results[0][0].transcript;
            input.value = text;
            input.dispatchEvent(new Event("change"));
            runAssistantCommand(text, { fromMainBar });
        };

        button.addEventListener("click", () => {
            stopSpeaking();                  // never listen to our own voice
            if (state.isListening) recognition.stop();
            else recognition.start();
        });
    }

    function setupPreferences() {
        document.querySelectorAll(".quick-chip").forEach((chip) => {
            chip.addEventListener("click", () => {
                state.selectedPreference = chip.dataset.preference || "fastest";
                syncPreferenceChips();
                showStatus(`Preference: ${chip.textContent.trim()}`);
                if (state.origin && state.destination) planJourney();
            });
        });
        syncPreferenceChips();
    }

    function setupLayers() {
        $("layersBtn")?.addEventListener("click", () => {
            layersPanel.classList.toggle("open");
        });

        $("closeLayersBtn")?.addEventListener("click", () => {
            layersPanel.classList.remove("open");
        });

        const checkboxes = layersPanel?.querySelectorAll("input[type=checkbox]") || [];
        checkboxes.forEach((checkbox, index) => {
            checkbox.addEventListener("change", () => {
                if (!state.map) return;

                // Bus routes is the first option.
                if (index === 0) {
                    state.pathsVisible = checkbox.checked;
                    state.routeEntries.forEach((entry) => {
                        const visibility = checkbox.checked ? "visible" : "none";
                        state.map.setLayoutProperty(entry.lineId, "visibility", visibility);
                        state.map.setLayoutProperty(entry.glowId, "visibility", visibility);
                    });
                }
            });
        });
    }

    // Which way a bus is driving: from its position toward the point ~120 m further along its route's
    // road path (from the server). No path, no direction: a guess would be worse than nothing.
    function busBearing(bus) {
        const path = bus?.heading?.path;
        if (!Array.isArray(path) || path.length < 2) return null;
        const from = [Number(bus.lon), Number(bus.lat)];
        if (!from.every(Number.isFinite)) return null;
        let target = null;
        for (const point of path.slice(1)) {
            const candidate = [Number(point[0]), Number(point[1])];
            if (!candidate.every(Number.isFinite)) continue;
            target = candidate;
            if (haversineMeters(from, candidate) >= 120) break;
        }
        if (!target || haversineMeters(from, target) < 15) return null;
        const toRad = Math.PI / 180;
        const y = Math.sin((target[0] - from[0]) * toRad) * Math.cos(target[1] * toRad);
        const x = Math.cos(from[1] * toRad) * Math.sin(target[1] * toRad) -
            Math.sin(from[1] * toRad) * Math.cos(target[1] * toRad) * Math.cos((target[0] - from[0]) * toRad);
        return (Math.atan2(y, x) / toRad + 360) % 360;
    }

    function compassWord(bearing) {
        return ["north", "north-east", "east", "south-east", "south", "south-west", "west", "north-west"][Math.round(bearing / 45) % 8];
    }

    // Point the arrow on a bus marker; the map can be rotated, so the arrow is relative to the screen.
    function setMarkerDirection(element, bearing) {
        try {
            const arrow = element?.querySelector?.(".bus-dir");
            if (!arrow) return;
            if (bearing === null || bearing === undefined) {
                arrow.hidden = true;
                if (element.dataset) delete element.dataset.bearing;
                return;
            }
            if (element.dataset) element.dataset.bearing = String(bearing);
            arrow.hidden = false;
            const mapBearing = state.map?.getBearing ? state.map.getBearing() : 0;
            if (arrow.style) arrow.style.transform = `rotate(${Math.round(bearing - mapBearing)}deg)`;
        } catch (error) { /* a direction arrow is decoration; never break the bus list for it */ }
    }

    function haversineMeters(a, b) {
        const R = 6371000;
        const lat1 = a[1] * Math.PI / 180;
        const lat2 = b[1] * Math.PI / 180;
        const dLat = (b[1] - a[1]) * Math.PI / 180;
        const dLon = (b[0] - a[0]) * Math.PI / 180;
        const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
        return 2 * R * Math.asin(Math.sqrt(h));
    }

    let stepCache = new WeakMap();

    // Guidance steps derived from the planned legs. A bus is two steps: "board" (wait at the
    // stop) and "ride" (stay on until the alighting stop), so live tracking and GPS hints
    // always refer to the right place.
    function guideSteps(route) {
        if (!route || typeof route !== "object") return [];
        if (stepCache.has(route)) return stepCache.get(route);
        const legs = Array.isArray(route.legs) ? route.legs : [];
        const steps = [];
        legs.forEach((leg, legIndex) => {
            if (leg.transit) {
                const metro = leg.role === "metro";
                const name = leg.route_name || (metro ? "metro" : "bus");
                const count = Number(leg.stop_count);
                const from = leg.from?.name || tr("the stop"), to = leg.to?.name || tr("your stop");
                const vars = { name, from, to, headsign: leg.headsign || "", time: leg.departure_time || "—", arrive: leg.arrival_time || "—",
                    count, min: leg.duration_minutes, also: (leg.also_served_by || []).join(", ") };
                const connection = leg.connection;
                const connectionNote = connection
                    ? ` ${connection.label} connection: ${connection.scheduled_buffer_minutes} min at ${connection.stop}. ${connection.detail}`
                    : "";
                steps.push({
                    kind: "board", legIndex, leg, target: leg.from,
                    title: (metro ? tr("Board the metro: {name}", vars) : tr("Board {name}", vars)) + (leg.headsign ? ` → ${leg.headsign}` : ""),
                    short: metro ? tr("Board the metro {name} at {from}", vars) : tr("Board {name} at {from}", vars),
                    detail: tr("Be at {from} before the scheduled {time}.", vars) + " " +
                        (leg.also_served_by?.length && !metro ? tr("{also} also go to {to}, so take whichever comes first.", vars) + " " : "") +
                        (metro ? tr("Check the line colour and the direction board. Times are from the timetable, not live.")
                            : tr("Check the bus number and destination board. Times are from the timetable, not live.")) + connectionNote
                });
                steps.push({
                    kind: "ride", legIndex, leg, target: leg.to,
                    title: tr("Ride {name} to {to}", vars),
                    short: tr("Ride {name} to {to}", vars),
                    detail: (Number.isFinite(count) && count > 0 ? tr("{count} stops", vars) + " · " : "") + tr("about {min} min.", vars) + " " +
                        tr("Get down at {to} (scheduled {arrive}).", vars)
                });
            } else if (!leg.trivial) {
                const title = leg.role === "egress_walk" ? tr("Walk to your destination")
                    : leg.role === "transfer_walk" ? tr("Walk to your next stop") : tr("Walk to the boarding stop");
                steps.push({
                    kind: "walk", legIndex, leg, target: leg.to, title,
                    short: tr("Walk to {to}", { to: leg.to?.name || tr("the next stop") }),
                    detail: leg.instruction || `${leg.from?.name || "Start"} → ${leg.to?.name || "next stop"}. ${leg.duration_minutes} min · ${leg.distance_m} m.`
                });
            }
        });
        if (legs.length) {
            const last = legs[legs.length - 1];
            steps.push({
                kind: "arrive", legIndex: legs.length - 1, leg: last, target: last.to,
                title: tr("Arrive at your destination"),
                short: tr("Arrive: {to}", { to: last.to?.name || tr("destination") }),
                detail: tr("Have you reached your destination? Tap Finish to close guidance.")
            });
        }
        stepCache.set(route, steps);
        return steps;
    }

    function liveKey(line, stop) {
        return `${line}|${stop && Number.isFinite(Number(stop.lat)) ? `${Number(stop.lat).toFixed(5)},${Number(stop.lon).toFixed(5)}` : ""}`;
    }

    function placeOf(raw, fallbackName) {
        const stop = normalizeStop(raw) || (raw && Number.isFinite(Number(raw.lat)) && Number.isFinite(Number(raw.lon)) &&
            raw.lat != null && raw.lon != null
            ? { id: String(raw.id || raw.stop_id || raw.stopId || raw.name || "stop"), name: String(raw.name || raw.stop_name || fallbackName),
                lat: Number(raw.lat), lon: Number(raw.lon) } : null);
        return stop ? { id: stop.id, name: stop.name, lat: stop.lat, lon: stop.lon } : null;
    }

    // Which bus line, boarding stop and alighting stop live tracking should watch right now.
    // Not guiding: the first bus. Guiding: the bus being boarded, or while riding, the NEXT bus
    // (to prepare a transfer). Never the bus the traveller is already on.
    function routeLiveScope(route) {
        const legs = route?.legs || [];
        let from = 0;
        if (state.journey.active && state.journey.route === route) {
            const step = guideSteps(route)[state.journey.stepIndex];
            if (step) from = step.kind === "ride" ? step.legIndex + 1 : step.kind === "arrive" ? legs.length : step.legIndex;
        }
        const nextBus = legs.slice(from).find((leg) => leg.transit && leg.route_name && leg.role !== "metro");
        if (!nextBus && legs.length) return { lines: [], boardingStop: null, alightStop: null, key: "" };
        const fallback = route?.transit === false ? [] : (route?.route_numbers || []);
        // The planned bus first, then any other bus number the timetable runs over the same stretch
        // (same boarding stop, same alighting stop, same direction): whichever comes first will do.
        const lines = nextBus
            ? [...new Set([nextBus.route_name, ...(Array.isArray(nextBus.also_served_by) ? nextBus.also_served_by : [])])].slice(0, 5)
            : [...new Set(fallback)].slice(0, 1);
        const boardingStop = placeOf(nextBus?.from || state.origin, "boarding stop") ||
            placeOf(state.origin, "boarding stop");
        const alightStop = nextBus ? placeOf(nextBus.to, "alighting stop") : null;
        return { lines, boardingStop, alightStop, key: lines.length ? liveKey(lines[0], boardingStop) : "" };
    }

    // Other journey options the traveller could take instead of the selected one: each with its own
    // first bus line and boarding stop, so their buses can be shown too (clearly labelled as alternates).
    function routeAlternates(selected) {
        const all = normalizeRoutes(state.lastPlan).slice(0, 8);
        const own = routeLiveScope(selected);
        const seen = new Set(own.key ? [own.key] : []);
        const out = [];
        all.forEach((route, index) => {
            if (route === selected || route.transit === false || out.length >= 4) return;
            const scope = routeLiveScope(route);
            if (!scope.lines.length || !scope.key || seen.has(scope.key)) return;
            seen.add(scope.key);
            out.push({line: scope.lines[0], boardingStop: scope.boardingStop, alightStop: scope.alightStop,
                key: scope.key, optionNumber: index + 1});
        });
        return out;
    }

    function stopJourneyTracking() {
        const journey = state.journey;
        journey.session++;
        stopPreview();
        holdScreenOn(false);
        setJourneyMode(false);
        $("journeyGuide").hidden = true;
        hideGuideBanner(true);
        if (journey.watchId !== null) {
            navigator.geolocation?.clearWatch(journey.watchId);
        }
        journey.watchId = null;
        journey.active = false;
        journey.route = null;
        journey.lastPosition = null;
        journey.gpsError = "";
        state.map?.stop();
        state.map?.easeTo?.({pitch: 0, bearing: 0, duration: 400});
        if (journey.marker) {
            journey.marker.remove();
            journey.marker = null;
        }
        journey.markerAt = null;
        showAccuracy(null, 0);
        if ($("navRecenter")) $("navRecenter").hidden = true;
        const button = routeResults.querySelector(".start-journey-button.active");
        if (button) {
            button.classList.remove("active");
            button.textContent = "▶ Start journey";
        }
        if (state.liveBus.autoForJourney) stopLiveBusTracking();
        $("liveJourneyStart").textContent = "▶ Start selected journey";
        // The results were hidden while guiding; bring them back so the traveller is never left with a blank map.
        if (routeResults.children?.length) showRoutePanel();
        showStatus("Journey tracking stopped.");
    }

    // Offset for marker i of n sharing one spot on screen: a small ring, so each bus stays tappable.
    function fanPosition(index, count) {
        if (count < 2) return [0, 0];
        const angle = (2 * Math.PI * index) / count - Math.PI / 2;
        const radius = Math.min(80, Math.max(30, 30 / Math.sin(Math.PI / count)));
        return [Math.round(Math.cos(angle) * radius), Math.round(Math.sin(angle) * radius)];
    }

    // Buses close together on screen (not only at the identical spot) would hide each other at city
    // zoom levels. Group markers whose real positions are within ~44 px and fan each group out.
    // Re-run after every zoom; the bus positions themselves are never altered.
    function spreadBusMarkers() {
        const map = state.map;
        const markers = state.liveBus.markers;
        if (!map?.project || !markers.length) return;
        const items = markers.map(entry => {
            const lngLat = entry.marker.getLngLat?.();
            const point = lngLat ? map.project(lngLat) : null;
            return point ? {entry, x: point.x, y: point.y} : null;
        }).filter(Boolean);
        const groups = [];
        items.forEach(item => {
            const group = groups.find(g => Math.hypot(g[0].x - item.x, g[0].y - item.y) < 44);
            if (group) group.push(item); else groups.push([item]);
        });
        groups.forEach(group => group.forEach((item, index) => item.entry.marker.setOffset?.(fanPosition(index, group.length))));
    }

    // Fit the boarding stop and its buses into the map area no panel covers. Checked once more after
    // the animation: if another camera move (route redraw, panel change) won, frame again, unless
    // the traveller has moved the map themselves.
    function frameLivePoints(points, session, attempt = 0) {
        const map = state.map;
        if (!map || points.length < 2 || session !== state.liveBus.session) return;
        try {
            const bounds = new maplibregl.LngLatBounds();
            points.forEach(point => bounds.extend(point));
            // Extra room so marker icons and route labels are not tucked under a panel edge.
            const padding = roomyPadding(36, 48);
            map.fitBounds(bounds, {padding, maxZoom: 15, duration: 700});
            if (attempt > 0 || !map.project) return;
            setTimeout(() => {
                if (session !== state.liveBus.session || state.liveBus.userMoved || state.liveBus.selectedBusId) return;
                const width = Number(window.innerWidth) || 0, height = Number(window.innerHeight) || 0;
                const outside = points.some(point => {
                    const p = map.project(point);
                    return p.x < padding.left - 30 || p.y < padding.top - 30 || p.x > width - padding.right + 30 || p.y > height - padding.bottom + 30;
                });
                if (outside) frameLivePoints(points, session, 1);
            }, 1100);
        } catch (frameError) { /* framing is a convenience only */ }
    }

    function clearBusMarkers() {
        state.liveBus.markers.forEach(entry => entry.marker.remove());
        state.liveBus.markers = [];
        clearBusHeading();
    }

    // ---- "Where is this bus heading?": a light dashed line through the next stops on its own run.
    // Stops come from BMTC's stop order for that run; the line joins stops, it is not the road path.
    const HEADING_SOURCE = "bus-heading";
    function clearBusHeading() {
        const live = state.liveBus;
        const had = !!live.headingBusId;
        live.headingBusId = null;
        live.headingEnd?.remove();
        live.headingEnd = null;
        live.headingBoard?.remove();
        live.headingBoard = null;
        const map = state.map;
        if (!map?.getLayer) return;
        ["bus-heading-stops", "bus-heading-arrows", "bus-heading-line", "bus-heading-casing"].forEach(id => { if (map.getLayer(id)) map.removeLayer(id); });
        if (map.getSource?.(HEADING_SOURCE)) map.removeSource(HEADING_SOURCE);
        // Give the planned journey its normal look back.
        if (had && state.routeEntries?.length) {
            try { updateRouteStyles(state.selectedRouteIndex); } catch (error) { /* map not ready */ }
        }
    }

    function headingData(bus) {
        const stops = bus.heading?.stops || [];
        // The server lays the line along the route's own roads (timetable path); else join the stops.
        const line = (Array.isArray(bus.heading?.path) && bus.heading.path.length > 1 ? bus.heading.path
            : [[Number(bus.lon), Number(bus.lat)], ...stops.map(stop => [Number(stop.lon), Number(stop.lat)])])
            .map(point => [Number(point[0]), Number(point[1])]).filter(point => point.every(Number.isFinite));
        // Dots for the next few stops only; a whole run of dots would bury the map.
        return {type: "FeatureCollection", features: [
            {type: "Feature", properties: {kind: "line"}, geometry: {type: "LineString", coordinates: line}},
            ...directionChevrons(line),
            ...stops.slice(0, 8).map((stop, index) => ({type: "Feature", properties: {kind: "stop", name: stop.name, order: index + 1},
                geometry: {type: "Point", coordinates: [Number(stop.lon), Number(stop.lat)]}}))]};
    }

    // Small ">" marks along the route line pointing the way the bus travels, spaced by distance.
    function directionChevrons(line) {
        if (line.length < 2) return [];
        let total = 0;
        for (let i = 1; i < line.length; i++) total += haversineMeters(line[i - 1], line[i]);
        if (total < 150) return [];
        const spacing = Math.max(300, total / 28);
        const arm = Math.min(220, Math.max(40, spacing * 0.16));
        const marks = [];
        let next = spacing / 2, walked = 0;
        for (let i = 1; i < line.length && marks.length < 40; i++) {
            const a = line[i - 1], b = line[i];
            const length = haversineMeters(a, b);
            while (length > 0 && walked + length >= next) {
                const t = (next - walked) / length;
                const tip = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
                // local metres -> degrees
                const mLat = 1 / 111320, mLon = 1 / (111320 * Math.cos(tip[1] * Math.PI / 180));
                const dx = (b[0] - a[0]) / mLon, dy = (b[1] - a[1]) / mLat;
                const norm = Math.hypot(dx, dy) || 1;
                const ux = dx / norm, uy = dy / norm;
                const wing = (side) => [tip[0] + (-ux * arm + side * -uy * arm * 0.75) * mLon, tip[1] + (-uy * arm + side * ux * arm * 0.75) * mLat];
                marks.push({type: "Feature", properties: {kind: "chevron"},
                    geometry: {type: "LineString", coordinates: [wing(1), tip, wing(-1)]}});
                next += spacing;
            }
            walked += length;
        }
        return marks;
    }

    // Fade the planned journey while a bus's route is shown, so the two lines cannot be confused.
    function dimJourneyRoutes() {
        const map = state.map;
        (state.routeEntries || []).forEach(entry => {
            try {
                map.setPaintProperty(entry.lineId, "line-opacity", 0.18);
                map.setPaintProperty(entry.glowId, "line-opacity", 0.02);
            } catch (error) { /* layer gone */ }
        });
    }

    // Returns true when a line was drawn.
    function showBusHeading(bus, {frame = true} = {}) {
        const live = state.liveBus;
        const map = state.map;
        if (!map?.addSource || !state.mapReady) return false;
        const id = liveBusKey(bus);
        const stops = bus.heading?.stops || [];
        if (!stops.length) {
            clearBusHeading();
            showStatus(`BMTC did not say how far along its route ${bus.label} is, so where it is going cannot be drawn.`, true);
            return false;
        }
        const data = headingData(bus);
        if (map.getSource(HEADING_SOURCE)) map.getSource(HEADING_SOURCE).setData(data);
        else {
            map.addSource(HEADING_SOURCE, {type: "geojson", data});
            map.addLayer({id: "bus-heading-casing", type: "line", source: HEADING_SOURCE, filter: ["==", ["get", "kind"], "line"],
                layout: {"line-cap": "round", "line-join": "round"},
                paint: {"line-color": "#ffffff", "line-width": 9, "line-opacity": 0.9}});
            map.addLayer({id: "bus-heading-line", type: "line", source: HEADING_SOURCE, filter: ["==", ["get", "kind"], "line"],
                layout: {"line-cap": "round", "line-join": "round"},
                paint: {"line-color": "#f26b1d", "line-width": 5, "line-opacity": 1}});
            map.addLayer({id: "bus-heading-arrows", type: "line", source: HEADING_SOURCE, filter: ["==", ["get", "kind"], "chevron"],
                layout: {"line-cap": "round", "line-join": "round"},
                paint: {"line-color": "#ffffff", "line-width": 3, "line-opacity": 0.95}});
            map.addLayer({id: "bus-heading-stops", type: "circle", source: HEADING_SOURCE, filter: ["==", ["get", "kind"], "stop"],
                paint: {"circle-radius": 4.5, "circle-color": "#ffffff", "circle-stroke-color": "#f26b1d", "circle-stroke-width": 2.5}});
        }
        dimJourneyRoutes();
        const line = data.features[0].geometry.coordinates;
        const end = line[line.length - 1];
        const lastStop = stops[stops.length - 1];
        const towards = bus.heading.towards || lastStop?.name;
        const reachesEnd = lastStop && towards && lastStop.name === towards;
        live.headingEnd?.remove();
        const tag = document.createElement("div");
        tag.className = "bus-heading-end";
        tag.textContent = reachesEnd ? `🏁 ${bus.route.split(" ")[0]} ends at ${towards}`
            : `${bus.route.split(" ")[0]} → towards ${towards} (shown to ${lastStop?.name || "here"})`;
        // Labels open toward the middle of the route so they stay on screen at either end.
        const lons = line.map(point => point[0]);
        const middle = (Math.min(...lons) + Math.max(...lons)) / 2;
        const inward = lon => lon <= middle ? "bottom-left" : "bottom-right";
        live.headingEnd = new maplibregl.Marker({element: tag, anchor: inward(end[0]), offset: [0, -6]})
            .setLngLat(end).addTo(map);
        // Mark the traveller's own boarding stop when this bus is coming to it.
        live.headingBoard?.remove();
        live.headingBoard = null;
        const board = bus.relevance === "approaching" ? (bus.job?.boardingStop || live.boardingStop) : null;
        if (board && Number.isFinite(Number(board.lat)) && Number.isFinite(Number(board.lon))) {
            const pin = document.createElement("div");
            pin.className = "bus-heading-board";
            pin.textContent = `Your stop · ${board.name}`;
            live.headingBoard = new maplibregl.Marker({element: pin, anchor: inward(Number(board.lon)), offset: [0, -8]})
                .setLngLat([Number(board.lon), Number(board.lat)]).addTo(map);
        }
        live.headingBusId = id;
        if (frame) {
            // The traveller asked to see this bus's route: give it the whole screen (panels slide away;
            // "Show trip panels" brings them back).
            enterMapFocus();
            try {
                const bounds = new maplibregl.LngLatBounds();
                line.forEach(point => bounds.extend(point));
                // Extra side room so the end and "your stop" tags are not cut off at the screen edge.
                const width = window.innerWidth || 1200, height = window.innerHeight || 800;
                const side = width < 700 ? 0 : Math.min(170, Math.round(width * 0.12));
                const pad = roomyPadding(width < 700 ? 20 : 50, width < 700 ? 30 : 60);
                const padding = {...pad, left: pad.left + side, right: pad.right + side, top: pad.top + (width < 700 ? 10 : 30)};
                // Never let the padding eat more than 60% of the screen in either direction.
                const squeeze = (a, b, size) => {
                    const total = padding[a] + padding[b];
                    if (total > size * 0.6) { const k = size * 0.6 / total; padding[a] = Math.round(padding[a] * k); padding[b] = Math.round(padding[b] * k); }
                };
                squeeze("left", "right", width);
                squeeze("top", "bottom", height);
                map.fitBounds(bounds, {padding, maxZoom: 15.5, duration: 700});
            } catch (error) { /* framing is a convenience only */ }
        }
        return true;
    }

    function stopLiveBusTracking() {
        const live = state.liveBus;
        live.session++;
        clearInterval(live.timer);
        live.timer = null;
        live.controller?.abort();
        live.controller = null;
        live.loading = false;
        live.route = "";
        live.routes = null;
        live.alternates = [];
        live.itinerary = null;
        live.journeys = null;
        live.journeyIndex = 0;
        live.journeyResultsIndex = 0;
        live.autoForJourney = false;
        live.boardingStop = null;
        live.alightStop = null;
        live.key = "";
        live.selectedBusId = null;
        live.hasResult = false;
        live.framed = false;
        live.userMoved = false;
        live.lastShown = null;
        $("liveBusMeta").textContent = "";
        $("liveJourneyChoice").hidden = true;
        $("liveJourneyStart").hidden = true;
        $("liveBusFollow").hidden = true;
        $("liveBusFit").hidden = true;
        $("liveBusPanel").classList.remove("with-routes");
        clearBusMarkers();
        $("liveBusPanel").hidden = true;
        syncTrackButtons();
    }

    // After a panel opens or closes, frame the selected journey in the space that is really left.
    function reframeSelectedRoute() {
        const route = state.lastPlan ? normalizeRoutes(state.lastPlan)[state.selectedRouteIndex] : null;
        const coordinates = route ? routeCoordinates(route) : null;
        // Once a live check has framed its buses, do not pull the camera back to the whole route.
        // Navigating and following the traveller: the camera stays on them.
        const following = () => state.journey.active && journeyModeOn() && state.journey.follow && state.journey.lastPosition;
        if (coordinates?.length > 1) setTimeout(() => { if (!state.liveBus.framed && !following()) fitCoordinates(coordinates, 600); }, 120);
    }

    function syncTrackButtons() {
        routeResults.querySelectorAll(".live-bus-button[data-live-route]").forEach((button) => {
            const active = !!state.liveBus.key && button.dataset.liveKey === state.liveBus.key;
            button.classList.toggle("active", active);
            button.setAttribute("aria-pressed", String(active));
            button.textContent = `${active ? "■ Stop tracking" : "◎ Track"} ${button.dataset.liveLabel || button.dataset.liveRoute}`;
        });
    }

    function updateLiveJourneyChoice() {
        const live = state.liveBus;
        const route = live.journeys?.[live.journeyIndex];
        const choice = $("liveJourneyChoice");
        const start = $("liveJourneyStart");
        choice.hidden = !route || live.autoForJourney;
        start.hidden = !route || live.autoForJourney;
        if (!route || live.autoForJourney) return;
        const names = route.route_numbers?.length ? route.route_numbers.join(" → ") : route.route_name || "Selected journey";
        const instructions = (route.instructions || []).slice(0, 8);
        choice.innerHTML = `<strong>Selected journey: ${escapeHtml(names)}</strong><span>${route.arrival_time ? `Arrive ${escapeHtml(String(route.arrival_time))} · ` : ""}${escapeHtml(String(route.trip_minutes ?? route.total_elapsed_minutes ?? route.total_minutes ?? "—"))} min · ${escapeHtml(String(route.transfers ?? 0))} transfer(s)</span><span>Follow the blue route on the map.</span>${instructions.length ? `<details><summary>Boarding and transfer steps in order</summary><ol>${instructions.map(step => `<li>${escapeHtml(step)}</li>`).join("")}</ol></details>` : ""}`;
    }

    function chooseLiveBusJourney(bus) {
        const live = state.liveBus;
        if (!live.journeys?.length) return;
        const name = String(bus.route || "").trim().toUpperCase();
        const index = live.journeys.findIndex(route => (route.route_numbers || []).some(number =>
            String(number).trim().toUpperCase() === name));
        if (index < 0) return;
        live.journeyIndex = index;
        selectRoute(live.journeys[index], live.journeys.length === 1 || live.autoForJourney || !live.routes ? live.journeyResultsIndex : index, false);
        updateLiveJourneyChoice();
    }

    function liveBusKey(bus) {
        return bus.id || `${bus.route}:${bus.direction}:${bus.label}`;
    }

    function busFreshness(bus) {
        if (bus.freshness) return bus.freshness;
        if (bus.age_seconds === null || bus.age_seconds === undefined) return "unavailable";
        return bus.age_seconds <= 120 ? "fresh" : "stale";
    }

    // BMTC times come as "YYYY-MM-DD HH:MM:SS" (ETA) or "DD-MM-YYYY HH:MM:SS"; both are Bengaluru local time.
    function parseBmtcTime(text) {
        const match = String(text || "").trim().match(/^(\d{1,4})-(\d{1,2})-(\d{1,4})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?/);
        if (!match) return null;
        let [, a, b, c, h, m, sec] = match;
        const [year, month, day] = a.length === 4 ? [a, b, c] : [c, b, a];
        const date = new Date(Number(year), Number(month) - 1, Number(day), Number(h), Number(m), Number(sec || 0));
        return Number.isNaN(date.getTime()) ? null : date;
    }

    // Minutes until BMTC's estimate for this bus at the boarding stop, only for a fresh position and a
    // sensible estimate (not long past, not hours ahead). Otherwise null: no number is ever made up.
    function boardEtaMinutes(bus, now = Date.now()) {
        if (!bus?.board_eta || busFreshness(bus) !== "fresh") return null;
        const when = parseBmtcTime(bus.board_eta);
        if (!when) return null;
        const minutes = Math.round((when.getTime() - now) / 60000);
        return minutes < -2 || minutes > 180 ? null : Math.max(0, minutes);
    }

    function ageLabel(seconds) {
        return seconds < 60 ? `${seconds}s` : `${Math.round(seconds / 60)} min`;
    }

    function busRow(bus, index, live) {
        const freshness = busFreshness(bus);
        const stale = freshness !== "fresh";
        const id = liveBusKey(bus);
        const age = freshness === "unavailable" ? "No timestamp from BMTC · not confirmed live"
            : freshness === "stale" ? `Position stale · ${Math.round(bus.age_seconds / 60)} min old`
            : `Fresh position · updated ${ageLabel(bus.age_seconds)} ago`;
        const stop = bus.next_stop ? ` · next ${escapeHtml(bus.next_stop)}` : "";
        const boardMinutes = bus.relevance === "approaching" ? boardEtaMinutes(bus) : null;
        const boardTime = boardMinutes === null ? "" : parseBmtcTime(bus.board_eta).toLocaleTimeString([], {hour: "2-digit", minute: "2-digit"});
        const stopForEta = bus.board_stop || bus.job?.boardingStop?.name || live.boardingStop?.name || "your stop";
        const arrival = boardMinutes === null ? ""
            : `<span class="bus-arrival">${boardMinutes === 0 ? "Due now" : `~${boardMinutes} min`} at ${escapeHtml(stopForEta)} <small>(${escapeHtml(boardTime)}, BMTC estimate)</small></span>`;
        const eta = "";
        const distance = bus.distance_m === null || bus.distance_m === undefined ? ""
            : ` · ${bus.distance_m < 1000 ? `${bus.distance_m} m` : `${(bus.distance_m / 1000).toFixed(1)} km`} straight-line from ${live.boardingStop ? "boarding" : "your start"}`;
        const approaching = bus.relevance === "approaching";
        const badge = approaching
            ? `<span class="relevance-badge ok">Heading to ${bus.group === "alternate" ? "that" : "your"} stop${Number.isFinite(bus.stops_away) ? bus.stops_away === 0 ? " · at the stop" : ` · ${bus.stops_away} stop${bus.stops_away === 1 ? "" : "s"} away` : ""}</span>`
            : `<span class="relevance-badge warn">Direction not verified</span>`;
        const fresh = `<span class="fresh-chip ${freshness}">${freshness === "fresh" ? "FRESH" : freshness === "stale" ? "STALE" : "NO TIMESTAMP"}</span>`;
        const optionTag = bus.group === "alternate"
            ? `<span class="bus-option-tag">Alternate option${bus.job?.optionNumber ? ` ${bus.job.optionNumber}` : ""} · boards at ${escapeHtml(bus.job?.boardingStop?.name || "its start")}</span>`
            : bus.job?.sameStretch
                ? `<span class="bus-option-tag same">Also goes ${live.alightStop?.name ? `to ${escapeHtml(live.alightStop.name)}` : "your way"} · same boarding stop</span>` : "";
        const reason = bus.reason && !approaching ? `<span class="bus-reason">${escapeHtml(bus.reason)}</span>` : "";
        const bearing = busBearing(bus);
        const dir = bearing !== null
            ? `<b class="bus-heading-word">➤ Heading ${compassWord(bearing)}${bus.heading?.towards ? ` · towards ${escapeHtml(bus.heading.towards)}` : ""}</b> · `
            : bus.direction ? `${escapeHtml(String(bus.direction).toUpperCase())} direction · ` : "";
        return `<button type="button" data-bus-index="${index}" class="live-bus-vehicle bus-focus${stale ? " stale" : ""}${approaching ? "" : " unverified"}${live.selectedBusId === id ? " following" : ""}"><strong>${escapeHtml(bus.label)} · ${escapeHtml(bus.route)}</strong>${optionTag}${arrival}${badge} ${fresh}<span class="bus-meta">${dir}${age}${stop}${eta}${distance}</span>${reason}<span class="bus-focus-hint">${live.selectedBusId === id ? "Following this bus" : stale ? "Show last known position ↗" : "Show and follow on map ↗"}</span></button>`;
    }

    async function refreshLiveBuses(session, manual = false) {
        const live = state.liveBus;
        if (session !== live.session || !live.route || live.loading) return;
        live.loading = true;
        $("liveBusRefresh").disabled = true;
        $("liveBusRefresh").textContent = "Refreshing…";
        // Keep the last headline on screen while refreshing so the panel does not flicker.
        if (!live.hasResult) $("liveBusStatus").textContent = "Checking BMTC for live bus positions…";
        $("liveBusMeta").textContent = "Refreshing…";
        const controller = new AbortController();
        live.controller = controller;
        const timeout = setTimeout(() => controller.abort(), live.routes ? 45000 : 12000);
        try {
            const routeNames = live.routes || [live.route];
            const mainJobs = routeNames.map((name, index) => ({name, group: "selected", sameStretch: index > 0,
                boardingStop: live.boardingStop, alightStop: live.alightStop}));
            const seenJobs = new Set(mainJobs.map(job => liveKey(job.name, job.boardingStop)));
            const altJobs = (live.alternates || []).filter(alt => !seenJobs.has(liveKey(alt.line, alt.boardingStop))).map(alt => ({
                name: alt.line, group: "alternate", boardingStop: alt.boardingStop, alightStop: alt.alightStop, optionNumber: alt.optionNumber}));
            const jobs = [...mainJobs, ...altJobs];
            const results = [], failures = [];
            let cursor = 0;
            let checked = 0;
            await Promise.all(Array.from({length: Math.min(3, jobs.length)}, async () => {
                while (cursor < jobs.length && !controller.signal.aborted) {
                    const job = jobs[cursor++];
                    const name = job.name;
                    const query = new URLSearchParams({q: name});
                    if (manual) query.set("refresh", "1");
                    if (job.boardingStop) {
                        query.set("stop_lat", String(job.boardingStop.lat));
                        query.set("stop_lon", String(job.boardingStop.lon));
                        if (job.alightStop) {
                            query.set("alight_lat", String(job.alightStop.lat));
                            query.set("alight_lon", String(job.alightStop.lon));
                        }
                    }
                    try {
                        const response = await fetch(`/api/bmtc/route?${query}`, {signal: controller.signal, cache: "no-store"});
                        let item = null;
                        try { item = await response.json(); } catch (parseError) { item = null; }
                        if (!response.ok || !item?.available) throw new Error(item?.error || "Live feed unavailable");
                        item.__job = job;
                        results.push(item);
                    } catch (error) { failures.push({name, message: error.message, group: job.group}); }
                    finally {
                        checked++;
                        if (session === live.session && jobs.length > 1) $("liveBusMeta").textContent =
                            `Checking BMTC routes… ${checked}/${jobs.length}`;
                    }
                }
            }));
            if (session !== live.session) return;
            if (!results.length) throw new Error(controller.signal.aborted ? "BMTC lookup timed out." : failures[0]?.message || "BMTC live positions are unavailable.");
            const mainResults = results.filter(item => item.__job?.group !== "alternate");
            const altResults = results.filter(item => item.__job?.group === "alternate");
            const data = mainResults[0] || results[0];
            const unique = new Map();
            const rank = bus => bus.group === "alternate" ? 2 : bus.job?.sameStretch ? 1 : 0;
            // The selected journey always wins when the same vehicle is reported for both it and an alternate.
            [...mainResults, ...altResults].forEach(item => (item.vehicles || []).forEach(raw => {
                const bus = Object.assign({}, raw, {group: item.__job?.group || "selected", job: item.__job || null});
                const key = liveBusKey(bus);
                const old = unique.get(key);
                if (!old || rank(bus) < rank(old) ||
                    (rank(bus) === rank(old) && (bus.age_seconds ?? Infinity) < (old.age_seconds ?? Infinity))) unique.set(key, bus);
            }));
            const hiddenAll = mainResults.flatMap(item => item.hidden || []);
            const hiddenAlt = altResults.flatMap(item => item.hidden || []);
            const direction = data.direction || null;
            const boardingPoint = live.boardingStop ? [live.boardingStop.lon, live.boardingStop.lat] : stopLngLat(state.origin);
            const scoped = !!(live.routes && live.journeys?.length === 1 && boardingPoint);
            const buses = [...unique.values()];
            const reportedCount = buses.filter(bus => bus.group !== "alternate").length;
            buses.forEach(bus => {
                // A vehicle without a relevance verdict (older server) is never assumed suitable.
                bus.relevance = bus.relevance === "approaching" ? "approaching" : "unverified";
                bus.freshness = busFreshness(bus);
                const point = bus.job?.boardingStop ? [bus.job.boardingStop.lon, bus.job.boardingStop.lat] : boardingPoint;
                bus.distance_m = point && Number.isFinite(Number(bus.lon)) && Number.isFinite(Number(bus.lat))
                    ? Math.round(haversineMeters(point, [Number(bus.lon), Number(bus.lat)])) : null;
            });
            let shownAll = buses;
            if (scoped) {
                // Verified approaching buses are always relevant; anything unverified only counts when close.
                shownAll = buses.filter(bus => bus.relevance === "approaching" ||
                    (bus.distance_m !== null && bus.distance_m <= 4000) || liveBusKey(bus) === live.selectedBusId);
            }
            const etaRank = bus => bus.relevance === "approaching" ? boardEtaMinutes(bus) ?? 999 : 999;
            const order = (a, b) =>
                Number(a.relevance !== "approaching") - Number(b.relevance !== "approaching") ||
                Number(a.freshness !== "fresh") - Number(b.freshness !== "fresh") ||
                etaRank(a) - etaRank(b) ||
                (a.stops_away ?? 999) - (b.stops_away ?? 999) ||
                (a.distance_m ?? Infinity) - (b.distance_m ?? Infinity) ||
                (a.age_seconds ?? Infinity) - (b.age_seconds ?? Infinity);
            let shownMain = shownAll.filter(bus => bus.group !== "alternate").sort(order);
            let shownAlt = shownAll.filter(bus => bus.group === "alternate").sort(order);
            if (scoped) {
                const followed = shownAll.find(bus => liveBusKey(bus) === live.selectedBusId);
                shownMain = shownMain.slice(0, 8);
                shownAlt = shownAlt.slice(0, 6);
                if (followed && !shownMain.includes(followed) && !shownAlt.includes(followed))
                    (followed.group === "alternate" ? shownAlt : shownMain).push(followed);
            }
            const shown = [...shownMain, ...shownAlt];
            const previousMarkers = new Map(live.markers.map(entry => [entry.id, entry]));
            live.markers = [];
            const retained = new Set();
            const approaching = shownMain.filter(bus => bus.relevance === "approaching");
            const unverified = shownMain.filter(bus => bus.relevance !== "approaching");
            const freshCount = shownMain.filter(bus => bus.freshness === "fresh").length;
            const stopName = live.boardingStop?.name || "your boarding stop";
            const hiddenPassed = hiddenAll.filter(bus => bus.relevance === "passed").length;
            const hiddenOpposite = hiddenAll.filter(bus => bus.relevance === "wrong_direction").length;
            const unmatched = results.filter(item => item.message?.includes("No exact BMTC route match"));
            const checkedAt = new Date().toLocaleTimeString([], {hour: "2-digit", minute: "2-digit"});
            const plural = (n, word, many = `${word}es`) => `${n} ${n === 1 ? word : many}`;
            const lineName = routeNames.length === 1 ? routeNames[0] : routeNames.join(", ");
            // One short headline the traveller can read at a glance; everything else goes on a small meta line.
            let status;
            const soonest = approaching.map(bus => ({bus, minutes: boardEtaMinutes(bus)})).filter(item => item.minutes !== null)
                .sort((a, b) => a.minutes - b.minutes)[0];
            if (shownMain.length) {
                status = direction?.verified && approaching.length
                    ? `${plural(approaching.length, "bus")} heading to ${stopName}` +
                        (soonest ? ` · next ${soonest.bus.route.split(" ")[0]} ${soonest.minutes === 0 ? "due now" : `in ~${soonest.minutes} min`}` : "")
                    : `${plural(shownMain.length, "bus")} on ${lineName} near ${stopName} · direction not verified`;
            } else if (live.routes) {
                status = hiddenAll.length ? `No bus is heading to ${stopName} right now.`
                    : scoped && reportedCount ? `No ${lineName} bus within 4 km of ${stopName} right now.`
                    : `No live position for ${lineName} right now.`;
            } else {
                status = data.message || "BMTC did not publish a live bus position for this route.";
            }
            const meta = [];
            if (shownMain.length) meta.push(`${freshCount} of ${shownMain.length} live${freshCount < shownMain.length ? `, ${shownMain.length - freshCount} old or untimed` : ""}`);
            if (shownMain.length && direction?.verified && unverified.length) meta.push(`${unverified.length} direction not verified`);
            if (hiddenAll.length) meta.push(`${hiddenAll.length} not shown (${hiddenPassed} already passed, ${hiddenOpposite} other direction)`);
            if (scoped && reportedCount > shownMain.length && !hiddenAll.length) meta.push(`${reportedCount - shownMain.length} farther than 4 km not shown`);
            if (shownAlt.length) meta.push(`+${plural(shownAlt.length, "bus")} on other options below`);
            else if (altJobs.length) meta.push(`none for the other ${altJobs.length === 1 ? "option" : `${altJobs.length} options`}`);
            if (unmatched.length) meta.push(`${unmatched.length} route code${unmatched.length === 1 ? " has" : "s have"} no exact BMTC match`);
            if (failures.length || cursor < jobs.length) meta.push(`${results.length}/${jobs.length} routes checked · some unavailable, refresh to retry`);
            meta.push(`checked ${checkedAt}`);
            $("liveBusStatus").textContent = status;
            $("liveBusMeta").textContent = meta.join(" · ");
            live.hasResult = true;
            live.lastShown = shown;
            live.lastCheckedAt = Date.now();
            const learned = mainResults.map(item => item.reliability).find(Boolean);
            if ($("liveReliability")) {
                $("liveReliability").textContent = learned?.text ? `📊 ${learned.text}` : "";
                $("liveReliability").hidden = !learned?.text;
            }
            if ($("liveWindow")) {
                const windowHtml = live.itinerary ? arrivalWindowHtml(live.itinerary, liveArrivalShift(live.itinerary, approaching)) : "";
                $("liveWindow").innerHTML = windowHtml;
                $("liveWindow").hidden = !windowHtml;
            }
            if (state.journey.active) { checkMissedBus(); checkTransferGuardian(); checkWaitOrWalk(); }
            $("liveBusFit").hidden = shown.length === 0;
            if (!shown.some(bus => liveBusKey(bus) === live.selectedBusId && bus.freshness === "fresh")) {
                live.selectedBusId = null;
                $("liveBusFollow").hidden = true;
            }
            // Arrival estimates now sit on each bus row. Only warn when NO checked line matched the stop.
            const boardingMatched = mainResults.some(item => item.boarding_stop);
            if (live.boardingStop) {
                $("liveBoarding").innerHTML = boardingMatched || !mainResults.length ? ""
                    : `<div class="live-bus-vehicle stale">BMTC did not confirm a matching route stop within 300 m of ${escapeHtml(live.boardingStop.name)}. Any markers shown are unverified, and stop arrival estimates are hidden.</div>`;
            } else {
                $("liveBoarding").innerHTML = live.routes
                    ? `<details class="live-route-details"><summary>Show ${routeNames.length} scheduled line names checked</summary><p>${escapeHtml(routeNames.join(" · "))}${failures.length ? ` · Feed unavailable: ${escapeHtml(failures.map(item => item.name).join(", "))}` : ""}</p></details>`
                    : "";
            }
            const note = !direction?.note ? ""
                : direction.verified
                    ? `<div class="live-direction-note ok" title="${escapeHtml(direction.note)}">✓ Direction checked against BMTC's stop order</div>`
                    : `<details class="live-direction-note warn"><summary>Direction not verified</summary>${escapeHtml(direction.note)}</details>`;
            const hiddenHtml = hiddenAll.length
                ? `<details class="live-route-details"><summary>${hiddenAll.length} hidden: ${hiddenPassed} already passed your stop, ${hiddenOpposite} going the other way</summary><ul class="hidden-buses">${hiddenAll.map(bus => `<li><b>${escapeHtml(bus.label)}</b> · ${escapeHtml(bus.reason || "")}</li>`).join("")}</ul></details>` : "";
            const rows = list => list.map(bus => busRow(bus, shown.indexOf(bus), live)).join("");
            const linesNote = routeNames.length > 1 && live.alightStop
                ? `<p class="live-lines">Checking <b>${escapeHtml(routeNames[0])}</b> (planned) and ${escapeHtml(routeNames.slice(1).join(", "))}: all stop at ${escapeHtml(stopName)} and then at ${escapeHtml(live.alightStop.name)}.</p>` : "";
            const altHtml = altJobs.length
                ? `<details class="live-route-details live-alternates"${shownMain.length ? "" : " open"}><summary>Alternate options: ${shownAlt.length ? `${shownAlt.length} bus${shownAlt.length === 1 ? "" : "es"}` : "no buses reported"}</summary>${shownAlt.length ? rows(shownAlt) : `<div class="live-bus-vehicle">BMTC reports no bus close to or heading for the other options' boarding stops (${escapeHtml(altJobs.map(job => `${job.name} at ${job.boardingStop?.name || "start"}`).join(" · "))}).</div>`}</details>` : "";
            $("liveBusList").innerHTML = linesNote + (shownMain.length
                ? `${note}${rows(approaching)}${unverified.length ? `<details class="live-route-details"${approaching.length ? "" : " open"}><summary>${unverified.length} on this route, direction not verified</summary>${rows(unverified)}</details>` : ""}${hiddenHtml}${altHtml}`
                : `${note}<div class="live-bus-vehicle">${hiddenAll.length ? "BMTC publishes buses on this route, but none are heading toward your boarding stop right now." : "No bus marker can be shown until BMTC publishes a vehicle position."} The planned route is still on the map, and journey guidance can be started below.</div>${hiddenHtml}${altHtml}`);
            // Buses reported at the same spot (common at depots and terminals) are fanned out a little
            // so every marker can be seen and tapped; the position itself is not changed.
            const spots = new Map();
            shown.forEach(bus => {
                const spot = `${Number(bus.lat).toFixed(4)},${Number(bus.lon).toFixed(4)}`;
                if (!spots.has(spot)) spots.set(spot, []);
                spots.get(spot).push(bus);
            });
            const fanOffset = bus => {
                const group = spots.get(`${Number(bus.lat).toFixed(4)},${Number(bus.lon).toFixed(4)}`) || [bus];
                return fanPosition(group.indexOf(bus), group.length);
            };
            shown.forEach(bus => {
                const id = liveBusKey(bus);
                const offset = fanOffset(bus);
                const stale = bus.freshness !== "fresh";
                const unverifiedBus = bus.relevance !== "approaching";
                const state_ = stale ? "Last known position" : "Live bus";
                const content = `<div class="bus-popup-content"><span class="bus-popup-status">${bus.group === "alternate" ? `Alternate option ${bus.job?.optionNumber || ""} · ` : ""}${unverifiedBus ? "Direction not verified · " : "Heading to the boarding stop · "}${state_}</span><strong>${escapeHtml(bus.route)}</strong><b>${escapeHtml(bus.label)}</b><p>${escapeHtml(String(bus.direction || "").toUpperCase())} direction${bus.next_stop ? `<br>Next: ${escapeHtml(bus.next_stop)}` : ""}${busBearing(bus) !== null ? `<br>Heading ${compassWord(busBearing(bus))}` : ""}${bus.heading?.towards ? `<br>Towards: ${escapeHtml(bus.heading.towards)}` : ""}</p><small>${bus.age_seconds == null ? "Update time unavailable" : `Updated ${Math.round(bus.age_seconds)} seconds ago`}</small></div>`;
                const bearingNow = busBearing(bus);
                const label = `${bus.group === "alternate" ? "alternate option, " : ""}${bus.route}, bus ${bus.label}, ${bearingNow !== null ? `heading ${compassWord(bearingNow)}, ` : ""}${stale ? "last known position" : "live"}, ${unverifiedBus ? "direction not verified" : "heading to your stop"}`;
                const previous = previousMarkers.get(id);
                const reportedAt = Number.isFinite(Number(bus.age_seconds)) ? Date.now() - Number(bus.age_seconds) * 1000 : NaN;
                if (previous) {
                    // Glide from where the marker is to the new REPORTED position (along the road when known).
                    const shownAt = previous.marker.getLngLat?.();
                    const before = (live.lastShown || []).find(item => liveBusKey(item) === id);
                    const points = shownAt ? glidePath([shownAt.lng, shownAt.lat], [bus.lon, bus.lat], before?.heading?.path) : null;
                    if (points) glideMarker(previous.marker, points); else previous.marker.setLngLat([bus.lon, bus.lat]);
                    markReported(previous.marker.getElement(), reportedAt);
                    previous.marker.setOffset?.(offset);
                    previous.marker.getPopup().setHTML(content);
                    previous.marker.getElement().classList.toggle("stale", stale);
                    previous.marker.getElement().classList.toggle("unverified", unverifiedBus);
                    previous.marker.getElement().classList.toggle("alternate", bus.group === "alternate");
                    setMarkerDirection(previous.marker.getElement(), busBearing(bus));
                    previous.marker.getElement().querySelector(".bus-route-label").textContent = bus.route.split(" ")[0];
                    previous.marker.getElement().setAttribute("aria-label", label);
                    live.markers.push(previous);
                    retained.add(id);
                    return;
                }
                const popup = new maplibregl.Popup({offset: 28, className: "bus-popup", maxWidth: "280px"}).setHTML(content);
                const element = document.createElement("button");
                element.type = "button";
                element.className = `live-bus-marker${stale ? " stale" : ""}${unverifiedBus ? " unverified" : ""}${bus.group === "alternate" ? " alternate" : ""}`;
                element.innerHTML = `<span class="bus-dir" aria-hidden="true" hidden></span><span aria-hidden="true">🚌</span><span class="bus-route-label">${escapeHtml(bus.route.split(" ")[0])}</span><span class="bus-age" aria-hidden="true" hidden></span>`;
                markReported(element, reportedAt);
                setMarkerDirection(element, busBearing(bus));
                const marker = new maplibregl.Marker({element, anchor: "center", offset})
                    .setLngLat([bus.lon, bus.lat]).setPopup(popup).addTo(state.map);
                element.addEventListener("click", () => {
                    // Use the latest report for this bus (the marker outlives a single refresh).
                    const current = live.lastShown?.find(item => liveBusKey(item) === id) || bus;
                    chooseLiveBusJourney(current);
                    live.selectedBusId = !stale ? id : null;
                    $("liveBusFollow").hidden = stale;
                    if (!stale) $("liveBusFollow").textContent = `Stop following ${current.label}`;
                    if (live.headingBusId === id) {
                        clearBusHeading();   // second click hides the line again
                        state.map.easeTo({center: [current.lon, current.lat], zoom: Math.max(state.map.getZoom(), 15), duration: 650});
                    } else if (showBusHeading(current)) {
                        // The popup would sit on top of the line; the end tag and the panel row carry the details.
                        setTimeout(() => marker.getPopup()?.remove(), 0);
                    } else {
                        state.map.easeTo({center: [current.lon, current.lat], zoom: Math.max(state.map.getZoom(), 15), duration: 650});
                    }
                });
                element.setAttribute("aria-label", label);
                live.markers.push({id, marker});
            });
            previousMarkers.forEach((entry, id) => { if (!retained.has(id)) entry.marker.remove(); });
            spreadBusMarkers();
            refreshMarkerAges();
            live.lastShown = shown;
            if (live.headingBusId) {
                const headed = shown.find(bus => liveBusKey(bus) === live.headingBusId);
                if (headed?.heading?.stops?.length) showBusHeading(headed, {frame: false});
                else clearBusHeading();   // the bus left the list or lost its position along the route
            }
            $("liveBusList").querySelectorAll("[data-bus-index]").forEach(button => button.addEventListener("click", () => {
                const bus = shown[Number(button.dataset.busIndex)];
                const entry = live.markers.find(item => item.id === liveBusKey(bus));
                if (!entry) return;
                chooseLiveBusJourney(bus);
                const fresh = bus.freshness === "fresh";
                live.selectedBusId = fresh ? entry.id : null;
                $("liveBusFollow").hidden = !fresh;
                if (fresh) $("liveBusFollow").textContent = `Stop following ${bus.label}`;
                $("liveBusList").querySelectorAll("[data-bus-index]").forEach(row => row.classList.toggle("following", row === button && fresh));
                live.markers.forEach(item => item.marker.getPopup().remove());
                if (!showBusHeading(bus)) {
                    state.map.easeTo({center: [bus.lon, bus.lat], zoom: Math.max(state.map.getZoom(), 15), duration: 650});
                    entry.marker.togglePopup();
                }
            }));
            if (!live.framed && !live.selectedBusId && shownMain.length) {
                // First answer for this check: show the boarding stop and the buses coming to it,
                // in the part of the map that no panel covers.
                live.framed = true;
                // The soonest few (list is already ordered by BMTC's arrival estimate) and the stop itself.
                const points = shownMain.slice(0, 3).map(bus => [Number(bus.lon), Number(bus.lat)]);
                if (boardingPoint) points.push(boardingPoint);
                // Navigating and following the traveller: the camera stays on them; the buses show as markers.
                const navigating = state.journey.active && journeyModeOn() && state.journey.follow && state.journey.lastPosition;
                if (!navigating) frameLivePoints(points, session);
            }
            if (live.selectedBusId) {
                const selected = shown.find(bus => liveBusKey(bus) === live.selectedBusId);
                if (selected && !(state.journey.active && state.journey.follow && journeyModeOn())) {
                    state.map.easeTo({center: [selected.lon, selected.lat], zoom: Math.max(state.map.getZoom(), 15), duration: 500});
                }
            }
        } catch (error) {
            if (session !== live.session) return;
            clearBusMarkers();
            $("liveBusList").innerHTML = '<div class="live-bus-vehicle">No live bus information is available right now. Your scheduled journey, the route on the map and step-by-step guidance are not affected.</div>';
            $("liveBoarding").textContent = "";
            $("liveBusFit").hidden = true;
            live.hasResult = false;
            $("liveBusMeta").textContent = "";
            $("liveBusStatus").textContent = error.name === "AbortError"
                ? "BMTC live lookup timed out. It will retry shortly, or press Refresh now."
                : `${error.message} It will retry automatically, or press Refresh now.`;
        } finally {
            clearTimeout(timeout);
            if (session === live.session) {
                live.loading = false;
                live.controller = null;
                $("liveBusRefresh").disabled = false;
                $("liveBusRefresh").textContent = "Refresh now";
            }
        }
    }

    function trackBmtcRoute(routeNumber, itinerary, index, boardingStop = null, alightStop = null) {
        exitMapFocus();
        closeChat();
        const key = liveKey(routeNumber, boardingStop);
        if (state.liveBus.route && state.liveBus.key === key) {
            stopLiveBusTracking();
            return;
        }
        stopLiveBusTracking();
        selectRoute(itinerary, index, true);
        $("liveBusPanel").classList.add("with-routes");
        const live = state.liveBus;
        live.route = routeNumber;
        live.key = key;
        live.itinerary = itinerary;
        live.journeys = [itinerary];
        live.journeyIndex = 0;
        live.journeyResultsIndex = index;
        live.boardingStop = boardingStop;
        live.alightStop = alightStop;
        const session = ++live.session;
        $("liveBusTitle").textContent = `BMTC route ${routeNumber}`;
        $("liveBusStatus").textContent = "Connecting to BMTC live positions…";
        $("liveBusList").textContent = "";
        $("liveBoarding").textContent = "";
        $("liveBusFit").hidden = true;
        $("liveBusPanel").hidden = false;
        updateLiveJourneyChoice();
        syncTrackButtons();
        refreshLiveBuses(session);
        reframeSelectedRoute();
        live.timer = setInterval(() => { if (!document.hidden) refreshLiveBuses(session); }, 25000);
    }

    function trackSearchBuses(routes, journeys = [], autoForJourney = false, boardingStop = null, alightStop = null, alternates = []) {
        if (!autoForJourney) exitMapFocus();
        if (!autoForJourney) closeChat();
        // On laptop-sized screens the options list, search card and live panel together cover the map.
        // Fold the options to their header (▴ brings them back) so the buses can actually be seen.
        const width = Number(window.innerWidth) || 0, height = Number(window.innerHeight) || 0;
        if (!autoForJourney && width > 760 && (height < 820 || width < 1280)) setRoutesCollapsed(true);
        stopLiveBusTracking();
        $("liveBusPanel").classList.add("with-routes");
        const live = state.liveBus;
        live.route = "search-results";
        live.routes = routes;
        live.alternates = autoForJourney ? [] : alternates;
        live.key = routes.length === 1 ? liveKey(routes[0], boardingStop) : "";
        live.journeys = journeys;
        live.journeyIndex = Math.min(state.selectedRouteIndex, Math.max(0, journeys.length - 1));
        live.journeyResultsIndex = state.selectedRouteIndex;
        live.autoForJourney = autoForJourney;
        live.boardingStop = boardingStop;
        live.alightStop = alightStop;
        const session = ++live.session;
        $("liveBusTitle").textContent = routes.length === 1 ? `Buses for ${routes[0]}`
            : alightStop ? `Buses to ${alightStop.name}`
            : "Nearby buses for this journey";
        $("liveBusList").textContent = "";
        $("liveBoarding").textContent = "";
        $("liveBusFit").hidden = true;
        $("liveBusPanel").hidden = false;
        updateLiveJourneyChoice();
        syncTrackButtons();
        refreshLiveBuses(session);
        reframeSelectedRoute();
        live.timer = setInterval(() => { if (!document.hidden) refreshLiveBuses(session); }, (routes.length + live.alternates.length) <= 3 ? 30000 : 60000);
    }

    function journeyGuidance(route, stepIndex, position) {
        const steps = guideSteps(route);
        const step = steps[stepIndex];
        if (!step) return { title: "Follow your journey", detail: "See the route instructions below.", gps: "Waiting for location…" };
        let detail = `${tr("Step {n} of {total}.", { n: stepIndex + 1, total: steps.length })} ${step.detail}`;
        if (step.kind === "ride") {
            detail += " " + (state.journey.alertsOn && navigator.geolocation
                ? tr("You will get an alert one stop before {to} (needs GPS). Keep an eye on the stop names too.", { to: step.leg?.to?.name || tr("your stop") })
                : tr("Stop alerts are off: watch the stop names."));
        }
        let gps = "Waiting for your location…";
        if (position) {
            const accuracy = Number(position.coords.accuracy);
            const age = Math.max(0, Math.round((Date.now() - position.timestamp) / 1000));
            const target = step.target;
            const distance = target && Number.isFinite(Number(target.lon)) && Number.isFinite(Number(target.lat))
                ? haversineMeters([position.coords.longitude, position.coords.latitude], [Number(target.lon), Number(target.lat)])
                : null;
            const reliable = Number.isFinite(accuracy) && accuracy <= 50 && age <= 30;
            gps = `GPS ±${Math.round(accuracy)} m · updated ${age}s ago. `;
            if (age > 30) gps += "Location is stale; waiting for a new fix.";
            else if (accuracy > 150) gps += "Weak GPS; do not use this fix to confirm a stop.";
            else if (distance === null) gps += "This stop has no coordinates, so distance cannot be shown.";
            else gps += `${Math.round(distance)} m straight-line to ${target.name}.`;
            if (reliable && distance !== null && distance < 60) gps += " Near this stop—confirm your next step.";
        }
        return { title: step.title, detail, gps };
    }

    function renderJourneyGuide() {
        const journey = state.journey;
        if (!journey.active) return;
        const steps = guideSteps(journey.route);
        const guidance = journeyGuidance(journey.route, journey.stepIndex, journey.lastPosition);
        $("journeyGuide").hidden = false;
        $("guideTitle").textContent = guidance.title;
        $("guideDetail").textContent = guidance.detail;
        $("guideGps").textContent = journey.gpsError || guidance.gps;
        checkTransferGuardian();
        checkWaitOrWalk();
        if ($("guideWindow")) {
            const windowHtml = arrivalWindowHtml(journey.route);
            if ($("guideWindow").btWindowHtml !== windowHtml) {      // re-render only on change, so an open "why?" stays open
                $("guideWindow").innerHTML = windowHtml;
                $("guideWindow").btWindowHtml = windowHtml;
            }
            $("guideWindow").hidden = !windowHtml;
        }
        const names = journey.route.route_numbers?.length
            ? journey.route.route_numbers.join(" → ") : "Selected journey";
        const list = steps.map((step, index) =>
            `<li class="${index === journey.stepIndex ? "current" : index < journey.stepIndex ? "done" : ""}">${escapeHtml(step.short)}</li>`).join("");
        $("guideRouteSummary").innerHTML = `<strong>${escapeHtml(tr("Route:"))} ${escapeHtml(names)}</strong>${list ? `<ol>${list}</ol>` : ""}`;
        const last = steps.length > 0 && journey.stepIndex >= steps.length - 1;
        $("guidePrev").disabled = journey.stepIndex === 0;
        $("guideNext").disabled = steps.length === 0;
        $("guideNext").textContent = last ? tr("Finish") : tr("Next step");
        $("guideFollow").textContent = !journey.lastPosition ? tr("Show my route") : journey.follow ? tr("Following you") : tr("Recenter");
        renderNavCard();
        speakGuideStep();
    }

    function focusGuideStep(step) {
        const target = step?.target;
        const lat = Number(target?.lat);
        const lon = Number(target?.lon);
        if (!state.map || !Number.isFinite(lat) || !Number.isFinite(lon)) return;
        // While GPS is steering the camera, do not fight it.
        if (state.journey.follow && state.journey.lastPosition) return;
        state.map.easeTo({ center: [lon, lat], zoom: Math.max(state.map.getZoom(), 15.5), duration: 600 });
    }

    // Keep live tracking on the bus that matters for the current step, and remove it when
    // there is none (for example while riding the last bus).
    function syncGuideLive() {
        const journey = state.journey;
        const live = state.liveBus;
        if (!journey.active) return;
        const scope = routeLiveScope(journey.route);
        if (!scope.lines.length) {
            if (live.route) stopLiveBusTracking();
            return;
        }
        if (!live.route || scope.key !== live.key || !live.autoForJourney) {
            trackSearchBuses(scope.lines, [journey.route], true, scope.boardingStop, scope.alightStop);
            $("liveBusTitle").textContent = "Buses for your next boarding";
            $("liveJourneyStart").textContent = "■ Stop journey guidance";
        }
    }

    function goToGuideStep(delta) {
        const journey = state.journey;
        if (!journey.active) return;
        const steps = guideSteps(journey.route);
        const next = journey.stepIndex + delta;
        if (next >= steps.length) {
            // Completion is always the traveller's own confirmation, never inferred from GPS.
            stopJourneyTracking();
            showStatus("Journey guidance finished. Safe travels!");
            return;
        }
        journey.stepIndex = Math.max(0, next);
        if (delta < 0) journey.autoHold = { step: journey.stepIndex, until: Date.now() + 90000 };
        hideGuideBanner();
        renderJourneyGuide();
        if (journeyModeOn() && !(journey.follow && journey.lastPosition)) focusNavCamera("step");
        else focusGuideStep(steps[journey.stepIndex]);
        syncGuideLive();
        checkMissedBus();
    }

    function updateJourneyProgress(position) {
        const journey = state.journey;
        if (!journey.active || !journey.route) return;

        const coordinates = routeCoordinates(journey.route);
        if (!coordinates?.length) return;

        const point = [position.coords.longitude, position.coords.latitude];
        if (!point.every(Number.isFinite) || Math.abs(point[0]) > 180 || Math.abs(point[1]) > 90) return;
        if (journey.lastPosition && position.timestamp < journey.lastPosition.timestamp) return;
        journey.lastPosition = position;
        journey.gpsError = "";
        renderJourneyGuide();
        checkAlightAlert();
        checkMissedBus();
        navigateOnPosition(position);
        checkRideTrouble(position);
        voicePrompts(position);

        const accuracy = Number(position.coords.accuracy);
        const heading = travellerHeading(position, journey.route, journey.stepIndex);
        placeTraveller(point, heading);
        showAccuracy(point, accuracy);
        // Follow like a car navigator. Coarse fixes (Wi-Fi / network location) are followed too, but from higher up
        // and never used to move a step. While the traveller handles the map, GPS moves only the arrow.
        const first = journey.cameraStarted === false;          // set by startJourney: the first fix after Start
        const userBusy = Number(journey.userMovedUntil) > Date.now() || state.map.isZooming?.() || state.map.isRotating?.();
        // A coarse fix (Wi-Fi / network location) only places the map once, at the start, so it never jitters around.
        const usable = accuracy <= 150 || (first && accuracy <= 3000);
        if (journey.follow && (!userBusy || first) && usable && Date.now() - position.timestamp <= 30000) {
            followCamera(point, accuracy, heading, first);
            journey.cameraStarted = true;
        }
        renderRecenter();
    }

    // ---- Journey mode ----
    // Once a journey starts the map gets the screen. One card says what to do now; the full step list,
    // live buses and explanations are one tap away ("Details"). Pure summary first, so it is testable.
    function navSummary(route, stepIndex, position, now = Date.now(), buses = [], tracked = null) {
        const steps = guideSteps(route);
        const step = steps[stepIndex];
        if (!step) return null;
        const leg = step.leg || {};
        const metro = leg.role === "metro";
        const icon = step.kind === "walk" ? "🚶" : step.kind === "board" ? "🚏" : step.kind === "ride" ? (metro ? "🚇" : "🚌") : "🏁";
        const fix = position?.coords;
        const fresh = fix && Number(fix.accuracy) <= 150 && now - Number(position.timestamp) <= 60000;
        const here = fresh ? [Number(fix.longitude), Number(fix.latitude)] : null;
        const target = step.target && [Number(step.target.lon), Number(step.target.lat)];
        const toTarget = here && target?.every(Number.isFinite) ? Math.round(haversineMeters(here, target)) : null;
        let line = "";
        let maneuver = null;
        if (step.kind === "walk" && (maneuver = nextManeuver(leg, fresh ? position : null))) {
            // Turn-by-turn: the next turn is the instruction; the stop you are walking to stays in view.
            const place = step.target?.name || leg.to?.name || "";
            line = [maneuver.meters !== null ? tr("In {m} m", { m: maneuver.meters }) : "",
                    toTarget !== null ? tr("{place}: {m} m · about {min} min", { place, m: toTarget, min: Math.max(1, Math.round(toTarget / 75)) })
                        : tr("To {place}: about {min} min ({m} m)", { place, min: leg.duration_minutes ?? "—", m: leg.distance_m ?? "—" })]
                .filter(Boolean).join(" · ");
        } else if (step.kind === "walk") {
            line = toTarget !== null
                ? tr("{m} m to go · about {min} min", { m: toTarget, min: Math.max(1, Math.round(toTarget / 75)) })
                : tr("About {min} min on foot ({m} m)", { min: leg.duration_minutes ?? "—", m: leg.distance_m ?? "—" });
        } else if (step.kind === "board") {
            line = tr("Scheduled {time}", { time: leg.departure_time || "—" });
            const lines = new Set([leg.route_name, ...(leg.also_served_by || [])].map(name => String(name || "").split(" ")[0].toUpperCase()));
            const sameStop = tracked && String(tracked.name || "").trim().toLowerCase() === String(leg.from?.name || "").trim().toLowerCase();
            if (sameStop && !metro) {
                const next = (buses || []).filter(bus => bus?.relevance === "approaching" && lines.has(String(bus.route || "").split(" ")[0].toUpperCase()))
                    .map(bus => ({ bus, minutes: boardEtaMinutes(bus, now) })).filter(item => item.minutes !== null)
                    .sort((a, b) => a.minutes - b.minutes)[0];
                if (next) line += " · " + tr("BMTC: {line} in about {n} min", { line: next.bus.route, n: Math.max(0, Math.round(next.minutes)) });
            }
            if (toTarget !== null && toTarget > 60) line += " · " + tr("{m} m away", { m: toTarget });
        } else if (step.kind === "ride") {
            const stops = Array.isArray(leg.stops) ? leg.stops : [];
            let left = null;
            if (here && stops.length > 1) {
                let best = null;
                stops.forEach((stop, index) => {
                    const point = [Number(stop.lon), Number(stop.lat)];
                    if (!point.every(Number.isFinite)) return;
                    const meters = haversineMeters(here, point);
                    if (meters <= 300 && (!best || meters < best.meters)) best = { meters, index };
                });
                if (best) left = stops.length - 1 - best.index;
            }
            line = left !== null
                ? (left <= 0 ? tr("Get down here: {to}", { to: leg.to?.name || "" })
                    : left === 1 ? tr("Next stop: get down at {to}", { to: leg.to?.name || "" })
                    : tr("{n} stops to go · get down at {to}", { n: left, to: leg.to?.name || "" }))
                : tr("Get down at {to} · scheduled {time}", { to: leg.to?.name || "", time: leg.arrival_time || "—" });
        } else {
            line = tr("Tap Finish when you are there.");
        }
        const chips = [];
        const catching = state.journey?.preview ? null : catchBus(route, stepIndex, position, now, buses, tracked);
        if (catching) chips.push({ kind: catching.level, text: catchBusText(catching) });
        const guard = transferGuardian(route, stepIndex, position, now, buses, tracked);
        if (guard) chips.push({ kind: guard.level, text: guard.level === "miss" ? tr("⚠ May miss the change") : guard.level === "tight" ? tr("⏱ Tight change") : tr("✓ Change looks fine") });
        const win = arrivalWindow(route);
        if (win) chips.push({ kind: "arrive", text: win.ranged ? tr("Arrive {from}–{to}", { from: win.from, to: win.to }) : tr("Arrive {time}", { time: win.from }) });
        else if (route?.arrival_time) chips.push({ kind: "arrive", text: tr("Arrive {time}", { time: route.arrival_time }) });
        if (!fresh) chips.push({ kind: "gps", text: tr("📍 No GPS fix: use Next step") });
        else if (Number(fix.accuracy) > 60) chips.push({ kind: "gps", text: tr("📍 GPS ±{m} m", { m: Math.round(Number(fix.accuracy)) }) });
        if (fix && !fresh && Number(fix.accuracy) <= 3000 && now - Number(position.timestamp) <= 60000) {
            chips.splice(chips.findIndex(chip => chip.kind === "gps"), 1,
                { kind: "gps", text: tr("📍 Approximate location (±{m} m): steps will not move by themselves", { m: Math.round(Number(fix.accuracy)) }) });
        }
        return { icon: maneuver ? maneuver.icon : icon, title: maneuver ? maneuver.text : (step.short || step.title), line, chips,
                 then: maneuver?.then || "", turn: !!maneuver, step: stepIndex + 1, total: steps.length, last: stepIndex >= steps.length - 1 };
    }

    function journeyModeOn() { return !!document.body?.classList?.contains("journey-mode"); }

    // Pure: arrival, what is left, and the next step for the journey card.
    function navTrip(route, stepIndex, now = Date.now()) {
        const steps = guideSteps(route);
        const step = steps[stepIndex] || null;
        const start = Date.parse(route?.departure_iso || "");
        const end = Date.parse(route?.arrival_iso || "");
        const legs = route?.legs || [];
        const fromLeg = step && Number.isInteger(step.legIndex) ? step.legIndex : legs.length;
        const meters = legs.slice(fromLeg).reduce((sum, leg) => sum + (Number(leg?.distance_m) || 0), 0);
        const km = meters >= 1000 ? `${(meters / 1000).toFixed(1)} km` : `${Math.round(meters)} m`;
        let left;
        if (Number.isFinite(start) && Number.isFinite(end) && now >= start - 60 * 60000 && now <= end + 30 * 60000) {
            left = tr("{n} min · {km} left", { n: Math.max(0, Math.round((end - Math.max(now, start)) / 60000)), km });
        } else if (Number.isFinite(start) && Number.isFinite(end)) {
            left = tr("{n} min trip · {km}", { n: Math.round((end - start) / 60000), km });
        } else {
            left = km;
        }
        const win = arrivalWindow(route);
        const arrive = win?.ranged ? `${win.from}–${win.to}` : (route?.arrival_time || "");
        const next = steps[stepIndex + 1] || null;
        const icon = s => s.kind === "walk" ? "🚶" : s.kind === "board" ? "🚏" : s.kind === "ride" ? (s.leg?.role === "metro" ? "🚇" : "🚌") : "🏁";
        return { arrive, left, then: next ? { icon: icon(next), text: next.short || next.title } : null,
                 steps: steps.map((s, i) => ({ index: i, icon: icon(s), title: s.short || s.title, kind: s.kind,
                     when: s.kind === "board" ? (s.leg?.departure_time || "") : s.kind === "ride" ? (s.leg?.arrival_time || "") : "",
                     note: s.kind === "walk" ? tr("{min} min · {m} m", { min: s.leg?.duration_minutes ?? "—", m: s.leg?.distance_m ?? "—" })
                         : s.kind === "ride" ? (Number(s.leg?.stop_count) === 1 ? tr("1 stop · {min} min", { min: s.leg?.duration_minutes ?? "—" })
                             : tr("{n} stops · {min} min", { n: s.leg?.stop_count ?? "—", min: s.leg?.duration_minutes ?? "—" }))
                         : s.kind === "board" ? tr("Scheduled {time}", { time: s.leg?.departure_time || "—" }) : "",
                     status: i < stepIndex ? "done" : i === stepIndex ? "now" : "next" })) };
    }

    // Pure: the journey drawn Google-Maps style: done legs grey, the current leg bold, walks dotted.
    // Split a line at a distance along it (metres): [travelled part, part still ahead].
    function splitLine(coordinates, meters) {
        const done = [coordinates[0]];
        let walked = 0;
        for (let i = 0; i < coordinates.length - 1; i++) {
            const a = coordinates[i], b = coordinates[i + 1];
            const len = haversineMeters(a, b);
            if (walked + len >= meters) {
                const t = len ? (meters - walked) / len : 0;
                const cut = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
                done.push(cut);
                return [done, [cut, ...coordinates.slice(i + 1)]];
            }
            walked += len;
            done.push(b);
        }
        return [done, [coordinates[coordinates.length - 1], coordinates[coordinates.length - 1]]];
    }

    function journeyProgressFeatures(route, stepIndex, position = null) {
        const steps = guideSteps(route);
        const step = steps[stepIndex];
        const current = step && Number.isInteger(step.legIndex) ? step.legIndex : Infinity;
        const features = (route?.legs || []).map((leg, index) => {
            const coordinates = (leg?.coordinates || []).map(point => [Number(point[0]), Number(point[1])])
                .filter(point => point.every(Number.isFinite));
            if (coordinates.length < 2) return null;
            const status = index < current ? "done" : index === current ? "now" : "next";
            const kind = leg.transit ? (leg.role === "metro" ? "metro" : "bus") : "walk";
            const feature = (status, coords) => ({ type: "Feature", properties: { status, kind, color: leg.line_color || "" }, geometry: { type: "LineString", coordinates: coords } });
            // The part of the current leg already travelled turns grey, like a car navigator.
            const fix = position?.coords;
            if (status === "now" && fix && Number(fix.accuracy) <= 80) {
                const here = [Number(fix.longitude), Number(fix.latitude)];
                const along = alongLine(coordinates, here);
                if (along && along.offset <= 80 && along.along > 5) {
                    const [done, ahead] = splitLine(coordinates, along.along);
                    return [feature("done", done), feature("now", ahead)];
                }
            }
            return [feature(status, coordinates)];
        }).filter(Boolean).flat();
        return { type: "FeatureCollection", features };
    }

    const JOURNEY_SOURCE = "journey-progress";
    function updateJourneyMapLayer(on = true) {
        const map = state.map;
        if (!map?.getStyle?.()) return;
        const visibility = on ? "visible" : "none";
        try {
            if (!map.getSource(JOURNEY_SOURCE)) {
                if (!on) return;
                map.addSource(JOURNEY_SOURCE, { type: "geojson", data: { type: "FeatureCollection", features: [] } });
                const ride = ["!=", ["get", "kind"], "walk"];
                map.addLayer({ id: "journey-casing", type: "line", source: JOURNEY_SOURCE, filter: ride,
                    layout: { "line-cap": "round", "line-join": "round" },
                    paint: { "line-color": "#ffffff", "line-width": ["match", ["get", "status"], "now", 13, "next", 9, 7], "line-opacity": 0.95 } });
                map.addLayer({ id: "journey-line", type: "line", source: JOURNEY_SOURCE, filter: ride,
                    layout: { "line-cap": "round", "line-join": "round" },
                    paint: { "line-color": ["match", ["get", "status"], "done", "#9aa5b1", "now", "#1a73e8", "#5e97f6"],
                             "line-width": ["match", ["get", "status"], "now", 8, "next", 5.5, 4.5] } });
                map.addLayer({ id: "journey-walk", type: "line", source: JOURNEY_SOURCE, filter: ["==", ["get", "kind"], "walk"],
                    layout: { "line-cap": "round", "line-join": "round" },
                    paint: { "line-color": ["match", ["get", "status"], "done", "#9aa5b1", "#1a73e8"],
                             "line-width": ["match", ["get", "status"], "now", 6, 4.5], "line-dasharray": [0.1, 2] } });
            }
            ["journey-casing", "journey-line", "journey-walk"].forEach(id => {
                map.setLayoutProperty(id, "visibility", visibility);
                map.moveLayer(id);
            });
            if (on && state.journey.route) map.getSource(JOURNEY_SOURCE).setData(journeyProgressFeatures(state.journey.route, state.journey.stepIndex, state.journey.lastPosition));
            // The ordinary route lines step back while the journey is drawn on top.
            state.routeEntries.forEach(entry => {
                [entry.lineId, entry.glowId].forEach(id => map.getLayer(id) &&
                    map.setLayoutProperty(id, "visibility", on ? "none" : (state.pathsVisible ? "visible" : "none")));
            });
        } catch (error) {
            console.debug("Journey layer:", error);
        }
    }

    function setJourneyMode(on) {
        const body = document.body;
        if (!body?.classList) return;
        body.classList.toggle("journey-mode", !!on);
        if (!on) body.classList.remove("nav-expanded");
        body.classList.remove("journey-details");
        if ($("navCard")) $("navCard").hidden = !on;
        if ($("navControls")) $("navControls").hidden = !on;
        if ($("navBackToMap")) $("navBackToMap").hidden = true;
        updateJourneyMapLayer(!!on);
        if (!on) { if ($("navAlert")) $("navAlert").hidden = true; return; }
        setNavExpanded(false);
        setNavTab("steps");
        observeNavCard();
    }

    function showJourneyDetails(on) {
        const body = document.body;
        if (!body?.classList || !state.journey.active) return;
        body.classList.toggle("journey-details", !!on);
        $("navCard").hidden = !!on;
        $("navControls").hidden = !!on;
        $("navBackToMap").hidden = !on;
        if (on && phoneLayout()) { setDockTab("guide"); setDockHeight(dockSnapHeights().half); }
        if (!on) setTimeout(() => focusNavCamera("step"), 50);
    }

    // Phone: the sheet opens to show steps, live buses and trip info. Wide screens always show them.
    function setNavExpanded(open) {
        const card = $("navCard");
        if (!card?.classList) return;
        card.classList.toggle("expanded", !!open);
        document.body?.classList?.toggle("nav-expanded", !!open);
        $("navGrab")?.setAttribute("aria-expanded", String(!!open));
        $("navMore")?.setAttribute("aria-expanded", String(!!open));
        if ($("navMore")) $("navMore").textContent = open ? tr("⌄ Map") : tr("⌃ Steps");
        observeNavCard();
    }

    function setNavTab(name) {
        document.querySelectorAll?.(".nav-tab").forEach(tab => tab.classList.toggle("active", tab.dataset.tab === name));
        document.querySelectorAll?.(".nav-pane").forEach(pane => { pane.hidden = pane.dataset.pane !== name; });
        state.journey.navTab = name;
    }

    // The card's height decides how much map is free (map padding and the button stack).
    let navObserved = false;
    function observeNavCard() {
        const card = $("navCard");
        const update = () => {
            const box = card && !card.hidden ? card.getBoundingClientRect?.() : null;
            const phone = phoneLayout();
            const sheet = $("navSheet")?.getBoundingClientRect?.();
            document.documentElement?.style?.setProperty("--nav-space", `${Math.round(phone && sheet ? sheet.height : 0) + 16}px`);
            document.documentElement?.style?.setProperty("--nav-side", `${Math.round(!phone && box ? box.width + 22 : 0)}px`);
            const head = $("navHead")?.getBoundingClientRect?.();
            document.documentElement?.style?.setProperty("--nav-head", `${Math.round(phone && head ? head.bottom : 0) + 10}px`);
        };
        update();
        if (!navObserved && card && typeof ResizeObserver === "function") {
            navObserved = true;
            const observer = new ResizeObserver(update);
            [card, $("navSheet"), $("navHead")].forEach(element => element && observer.observe(element));   // phones: the card itself has no box
        }
    }

    function navLiveHtml(buses, tracked) {
        const list = (buses || []).filter(bus => bus?.relevance === "approaching")
            .map(bus => ({ bus, minutes: boardEtaMinutes(bus) }))
            .sort((a, b) => (a.minutes ?? 999) - (b.minutes ?? 999) || (a.bus.stops_away ?? 999) - (b.bus.stops_away ?? 999)).slice(0, 8);
        const stop = tracked?.name || tr("your stop");
        if (!list.length) {
            return `<p class="nav-empty">${escapeHtml(tr("No bus heading to {stop} is reported by BMTC right now. Buses appear here as soon as BMTC publishes their positions.", { stop }))}</p>`;
        }
        return `<p class="nav-pane-note">${escapeHtml(tr("Heading to {stop} · BMTC live positions", { stop }))}</p>` + list.map(({ bus, minutes }, i) => {
            const fresh = bus.freshness === "fresh";
            const when = minutes === null ? "" : minutes <= 0 ? tr("due now") : tr("~{n} min", { n: Math.round(minutes) });
            const away = Number.isFinite(bus.stops_away) ? (bus.stops_away === 0 ? tr("at the stop") : tr("{n} stops away", { n: bus.stops_away })) : "";
            return `<button type="button" class="nav-bus${fresh ? "" : " stale"}" data-nav-bus="${i}"><span class="nav-bus-route">${escapeHtml(bus.route || "")}</span>` +
                `<span class="nav-bus-info"><b>${escapeHtml(when || away || tr("on its way"))}</b><small>${escapeHtml([when ? away : "", fresh ? tr("live") : tr("position old")].filter(Boolean).join(" · "))}</small></span></button>`;
        }).join("");
    }

    function navInfoHtml(route) {
        const parts = [];
        const windowHtml = arrivalWindowHtml(route);
        if (windowHtml) parts.push(windowHtml.replace("<details ", "<details open "));
        const guard = transferGuardian(route, state.journey.stepIndex, state.journey.lastPosition, Date.now(),
            state.liveBus?.lastShown || [], state.liveBus?.boardingStop || null);
        if (guard) parts.push(`<p class="guide-transfer ${guard.level}">${escapeHtml(guardianText(guard))}</p>`);
        (route?.legs || []).map(leg => waitOrWalk(leg)).filter(Boolean)
            .forEach(advice => parts.push(`<p class="guide-walk">${escapeHtml(waitOrWalkText(advice))}</p>`));
        if (state.rain?.text) parts.push(`<p class="nav-rain">${escapeHtml(state.rain.text)}</p>`);
        const fare = route?.bus_fare;
        if (fare?.total != null) parts.push(`<p class="nav-pane-note">${escapeHtml(tr("Bus fare: {fare}", { fare: `${fare.exact ? "" : "~"}₹${fare.total}` }))}</p>`);
        parts.push(`<p class="nav-pane-note">${escapeHtml(tr("Times are from the BMTC timetable; buses can run early or late. Live positions come from BMTC."))}</p>`);
        if (state.journey.lastPosition && !state.journey.preview) parts.unshift(`<button type="button" class="nav-reroute" data-nav-reroute>${escapeHtml(tr("🔄 Find a new way from here"))}</button>`);
        return parts.join("");
    }

    function renderNavCard() {
        const journey = state.journey;
        if (!journey.active || !$("navCard")) return;
        const live = state.liveBus || {};
        const buses = live.lastShown || [];
        const nav = navSummary(journey.route, journey.stepIndex, journey.lastPosition, Date.now(), buses, live.boardingStop || null);
        if (!nav) return;
        const trip = navTrip(journey.route, journey.stepIndex);
        $("navIcon").textContent = nav.icon;
        $("navTitle").textContent = nav.title;
        $("navLine").textContent = nav.line;
        const thenText = nav.then || trip.then?.text || "";
        $("navThen").hidden = !thenText;
        if (thenText) $("navThen").innerHTML = `<span>${escapeHtml(tr("Then"))}</span> ${nav.then ? "" : trip.then.icon} ${escapeHtml(thenText)}`;
        $("navIcon").classList.toggle("turn", !!nav.turn);
        const delay = journey.preview ? null : liveDelay(journey.route, journey.stepIndex, journey.lastPosition, Date.now(), buses, live.boardingStop || null);
        const plannedEnd = Date.parse(journey.route?.arrival_iso || "");
        if (delay && Math.abs(delay.minutes) >= 2 && Number.isFinite(plannedEnd)) {
            const moved = new Date(plannedEnd + delay.minutes * 60000).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Kolkata" });
            $("navArrive").textContent = tr("Arrive ~{time}", { time: moved });
            $("navLeft").textContent = `${delay.minutes > 0 ? tr("~{n} min late", { n: delay.minutes }) : tr("~{n} min early", { n: -delay.minutes })} · ${delay.source === "gps" ? tr("from your GPS") : tr("BMTC live")} · ${tr("timetable {time}", { time: journey.route.arrival_time || "" })}`;
        } else {
            $("navArrive").textContent = trip.arrive ? tr("Arrive {time}", { time: trip.arrive }) : "";
            $("navLeft").textContent = trip.left;
        }
        renderRideStops();
        $("navProgress").innerHTML = `<span>${escapeHtml(tr("Step {n} of {total}", { n: nav.step, total: nav.total }))}</span>` +
            `<span class="nav-dots">${Array.from({ length: nav.total }, (_, i) => `<i class="${i < nav.step - 1 ? "done" : i === nav.step - 1 ? "now" : ""}"></i>`).join("")}</span>`;
        $("navChips").innerHTML = nav.chips.filter(chip => chip.kind !== "arrive")
            .map(chip => `<span class="nav-chip ${chip.kind}">${escapeHtml(chip.text)}</span>`).join("");
        $("navPrev").disabled = journey.stepIndex === 0;
        $("navNext").textContent = nav.last ? tr("✓ Finish") : tr("Next step ▶");
        const stepsHtml = `<ol class="nav-steps">${trip.steps.map(step => `<li class="${step.status}"><button type="button" data-nav-step="${step.index}">` +
            `<span class="nav-step-icon">${step.status === "done" ? "✓" : step.icon}</span><span class="nav-step-text"><b>${escapeHtml(step.title)}</b>` +
            `<small>${escapeHtml([step.note, step.kind === "ride" && step.when ? tr("arrive {time}", { time: step.when }) : ""].filter(Boolean).join(" · "))}</small></span></button></li>`).join("")}</ol>`;
        if ($("navPaneSteps").btHtml !== stepsHtml) { $("navPaneSteps").innerHTML = stepsHtml; $("navPaneSteps").btHtml = stepsHtml; }
        const liveHtml = navLiveHtml(buses, live.boardingStop || null);
        if ($("navPaneLive").btHtml !== liveHtml) { $("navPaneLive").innerHTML = liveHtml; $("navPaneLive").btHtml = liveHtml; }
        const count = buses.filter(bus => bus?.relevance === "approaching").length;
        $("navLiveCount").textContent = count ? String(count) : "";
        const infoHtml = navInfoHtml(journey.route);
        if ($("navPaneInfo").btHtml !== infoHtml) { $("navPaneInfo").innerHTML = infoHtml; $("navPaneInfo").btHtml = infoHtml; }
        renderNavBuses();
        if ($("navNoGps")) $("navNoGps").hidden = !!journey.lastPosition || !!journey.preview || !journey.gpsWaitedLong;
        const follow = !!journey.follow && !!journey.lastPosition;
        $("navFollow").classList.toggle("active", follow);
        $("navFollow").setAttribute("aria-pressed", String(follow));
        updateJourneyMapLayer(true);
    }

    function showNavAlert(text, kind, action) {
        const box = $("navAlert");
        if (!box) return;
        box.className = `nav-alert ${kind}`;
        box.innerHTML = `<span>${escapeHtml(text)}</span>` +
            (action ? `<button type="button" class="nav-alert-action">${escapeHtml(action.label)}</button>` : "") +
            `<button type="button" class="nav-alert-close" aria-label="${escapeHtml(tr("Dismiss"))}">✕</button>`;
        box.hidden = false;
        box.querySelector?.(".nav-alert-action")?.addEventListener("click", () => { box.hidden = true; action?.run?.(); });
        box.querySelector?.(".nav-alert-close")?.addEventListener("click", () => { box.hidden = true; if ($("guideAlert")) $("guideAlert").hidden = true; });
    }

    // Camera for journey mode: "follow" = GPS, "step" = the current step, "whole" = the whole trip.
    function focusNavCamera(mode) {
        const journey = state.journey;
        if (!journey.active || !state.map) return;
        if (mode === "follow") {
            journey.follow = true;
            journey.zoomChosen = false;
            journey.userMovedUntil = 0;
            renderRecenter();
            if (journey.lastPosition) {
                const fix = journey.lastPosition.coords;
                followCamera([fix.longitude, fix.latitude], Number(fix.accuracy), travellerHeading(journey.lastPosition, journey.route, journey.stepIndex), true);
            }
            else fitCoordinates(routeCoordinates(journey.route), 650);
        } else {
            journey.follow = false;
            renderRecenter();
            const step = guideSteps(journey.route)[journey.stepIndex];
            let points = mode === "whole" ? routeCoordinates(journey.route) : null;
            if (mode === "step" && step) {
                const leg = step.leg || {};
                points = Array.isArray(leg.coordinates) && leg.coordinates.length > 1 && step.kind !== "board"
                    ? leg.coordinates.slice() : [];
                const target = step.target && [Number(step.target.lon), Number(step.target.lat)];
                if (target?.every(Number.isFinite)) points.push(target);
                const fix = journey.lastPosition?.coords;
                if (fix && Number.isFinite(fix.longitude)) points.push([fix.longitude, fix.latitude]);
                if (points.length === 1) {
                    state.map.easeTo({ center: points[0], zoom: 16.5, pitch: 0, bearing: 0, duration: 600 });
                    renderNavCard();
                    return;
                }
            }
            if (points?.length > 1) fitCoordinates(points, 650);
        }
        renderNavCard();
        renderJourneyGuide();
    }

    function setupJourneyMode() {
        const journey = state.journey;
        const zoom = (direction) => {
            if (!state.map) return;
            journey.zoomChosen = true;
            journey.userMovedUntil = Date.now() + 2500;
            direction > 0 ? state.map.zoomIn({ duration: 250 }) : state.map.zoomOut({ duration: 250 });
        };
        $("navZoomIn")?.addEventListener("click", () => zoom(1));
        $("navVoice")?.addEventListener("click", () => $("quickVoiceBtn")?.click());
        const togglePreview = () => (journey.preview ? stopPreview() : startPreview());
        $("navPreviewBtn")?.addEventListener("click", togglePreview);
        $("navNoGpsPreview")?.addEventListener("click", togglePreview);
        $("navPreviewStop")?.addEventListener("click", stopPreview);
        $("navSpeak")?.addEventListener("click", () => {
            setTalkMode(!state.talk);
            $("navSpeak").classList.toggle("active", !!state.talk);
            $("navSpeak").textContent = state.talk ? "🔊" : "🔈";
        });
        document.addEventListener?.("visibilitychange", () => { if (journey.active && document.visibilityState === "visible") holdScreenOn(true); });
        $("navZoomOut")?.addEventListener("click", () => zoom(-1));
        $("navFollow")?.addEventListener("click", () => focusNavCamera("follow"));
        $("navStep")?.addEventListener("click", () => focusNavCamera("step"));
        $("navWhole")?.addEventListener("click", () => focusNavCamera("whole"));
        $("navPrev")?.addEventListener("click", () => goToGuideStep(-1));
        $("navNext")?.addEventListener("click", () => goToGuideStep(1));
        $("navDetails")?.addEventListener("click", () => showJourneyDetails(true));
        $("navBackToMap")?.addEventListener("click", () => showJourneyDetails(false));
        $("navMore")?.addEventListener("click", () => setNavExpanded(!$("navCard").classList.contains("expanded")));
        $("navGrab")?.addEventListener("click", () => setNavExpanded(!$("navCard").classList.contains("expanded")));
        document.querySelectorAll?.(".nav-tab").forEach(tab => tab.addEventListener("click", () => { setNavTab(tab.dataset.tab); setNavExpanded(true); }));
        $("navPaneSteps")?.addEventListener("click", event => {
            const button = event.target?.closest?.("[data-nav-step]");
            if (!button) return;
            const index = Number(button.dataset.navStep);
            if (Number.isInteger(index) && index !== journey.stepIndex) goToGuideStep(index - journey.stepIndex);
            if (phoneLayout()) setNavExpanded(false);
        });
        $("navPaneInfo")?.addEventListener("click", event => {
            if (event.target?.closest?.("[data-nav-reroute]") && journey.lastPosition) rerouteFromHere(journey.lastPosition);
        });
        $("navPaneLive")?.addEventListener("click", event => {
            const button = event.target?.closest?.("[data-nav-bus]");
            if (!button || !state.map) return;
            const bus = (state.liveBus.lastShown || []).filter(item => item?.relevance === "approaching")
                .map(item => ({ bus: item, minutes: boardEtaMinutes(item) }))
                .sort((a, b) => (a.minutes ?? 999) - (b.minutes ?? 999) || (a.bus.stops_away ?? 999) - (b.bus.stops_away ?? 999))[Number(button.dataset.navBus)]?.bus;
            if (!Number.isFinite(Number(bus?.lon))) return;
            journey.follow = false;
            if (phoneLayout()) setNavExpanded(false);
            state.map.easeTo({ center: [Number(bus.lon), Number(bus.lat)], zoom: Math.max(state.map.getZoom(), 15), pitch: 0, duration: 650 });
            renderNavCard();
        });
        // Ending needs a second tap, so a stray touch never drops the guidance mid-trip.
        $("navEnd")?.addEventListener("click", () => {
            const button = $("navEnd");
            if (button.classList.contains("confirm")) { button.classList.remove("confirm"); button.textContent = tr("✕ End journey"); stopJourneyTracking(); return; }
            button.classList.add("confirm");
            button.textContent = tr("Tap again to end");
            setTimeout(() => { button.classList.remove("confirm"); button.textContent = tr("✕ End journey"); }, 3500);
        });
        window.addEventListener?.("resize", () => { if (journeyModeOn()) observeNavCard(); });
        // Pinch, wheel, drag or rotate by the traveller: GPS following must not fight it.
        ["zoomstart", "rotatestart", "pitchstart"].forEach(name => state.map?.on(name, event => {
            if (!event.originalEvent || !journey.active) return;
            journey.userMovedUntil = Date.now() + 8000;
            if (name === "zoomstart") journey.zoomChosen = true;
        }));
        state.map?.on("dragstart", event => {
            if (!event.originalEvent || !journey.active) return;
            journey.userMovedUntil = Date.now() + 8000;
            if (journeyModeOn() && journey.lastPosition) { journey.follow = false; renderRecenter(); renderNavCard(); }
        });
        $("navRecenter")?.addEventListener("click", () => focusNavCamera("follow"));
    }

    // ---- Turn-by-turn walking (router's own steps: left/right onto named streets) ----
    const TURN_ICONS = { LEFT: "↰", HARD_LEFT: "↰", SLIGHTLY_LEFT: "↖", RIGHT: "↱", HARD_RIGHT: "↱", SLIGHTLY_RIGHT: "↗",
        CONTINUE: "↑", DEPART: "↑", UTURN_LEFT: "⤺", UTURN_RIGHT: "⤻", CIRCLE_CLOCKWISE: "⟳", CIRCLE_COUNTERCLOCKWISE: "⟲",
        ELEVATOR: "⇅", ENTER_STATION: "↘", EXIT_STATION: "↗", FOLLOW_SIGNS: "↑" };
    function streetLabel(step) {
        const name = String(step?.street || "").trim();
        return !name || step.named === false ? tr("the path") : name;
    }
    function turnText(step) {
        const street = streetLabel(step);
        switch (step?.direction) {
            case "LEFT": case "HARD_LEFT": return tr("Turn left onto {street}", { street });
            case "RIGHT": case "HARD_RIGHT": return tr("Turn right onto {street}", { street });
            case "SLIGHTLY_LEFT": return tr("Keep left onto {street}", { street });
            case "SLIGHTLY_RIGHT": return tr("Keep right onto {street}", { street });
            case "UTURN_LEFT": case "UTURN_RIGHT": return tr("Turn around onto {street}", { street });
            case "DEPART": return tr("Head along {street}", { street });
            default: return tr("Continue onto {street}", { street });
        }
    }

    // Pure: the next turn on a walking leg, and how far it is from where the traveller is.
    function nextManeuver(leg, position) {
        const steps = Array.isArray(leg?.walk_steps) ? leg.walk_steps : [];
        const coords = leg?.coordinates || [];
        if (!steps.length || coords.length < 2) return null;
        const fix = position?.coords;
        const here = fix && Number(fix.accuracy) <= 150 ? [Number(fix.longitude), Number(fix.latitude)] : null;
        const at = here ? alongLine(coords, here) : null;
        const along = at && at.offset <= 120 ? at.along : null;
        const marks = steps.map(step => ({ step, along: alongLine(coords, [step.lon, step.lat])?.along ?? 0 }));
        const length = alongLine(coords, coords[coords.length - 1])?.length ?? 0;
        const destination = leg.to?.name || "";
        if (along === null) {
            // No usable GPS: the first instruction of the walk.
            const first = marks[0];
            return { icon: TURN_ICONS[first.step.direction] || "↑", text: turnText(first.step), meters: null,
                     then: marks[1] ? turnText(marks[1].step) : tr("Arrive at {place}", { place: destination }) };
        }
        const upcoming = marks.filter((mark, index) => index > 0 && mark.along > along + 8);
        if (!upcoming.length) {
            return { icon: "📍", text: tr("Arrive at {place}", { place: destination }), meters: Math.max(0, Math.round(length - along)), then: "" };
        }
        const next = upcoming[0];
        return { icon: TURN_ICONS[next.step.direction] || "↑", text: turnText(next.step), meters: Math.max(0, Math.round(next.along - along)),
                 then: upcoming[1] ? turnText(upcoming[1].step) : tr("Arrive at {place}", { place: destination }) };
    }

    // ---- Navigation camera and the "you" arrow ----
    // Which way is the traveller facing? Moving: the GPS course. Standing: the phone's compass if it has one,
    // else the direction of the route just ahead (so the map is turned the way you are going, like a navigator).
    function routeAheadBearing(route, stepIndex, point) {
        const step = guideSteps(route)[stepIndex];
        const coords = (step?.leg?.coordinates || []).map(p => [Number(p[0]), Number(p[1])]).filter(p => p.every(Number.isFinite));
        if (coords.length < 2 || !point) return null;
        const at = alongLine(coords, point);
        if (!at || at.offset > 150) return null;
        const [, ahead] = splitLine(coords, at.along);
        const [nearer] = splitLine(ahead, Math.min(40, Math.max(5, at.length - at.along)));
        const from = nearer[0], to = nearer[nearer.length - 1];
        return from && to && (from[0] !== to[0] || from[1] !== to[1]) ? bearingBetween(from, to) : null;
    }

    function travellerHeading(position, route, stepIndex) {
        const fix = position?.coords || {};
        const point = [Number(fix.longitude), Number(fix.latitude)];
        if (Number.isFinite(fix.heading) && fix.heading !== null && Number(fix.speed) > 1) return { deg: Number(fix.heading), from: "course" };
        const compass = state.journey.compass;
        if (compass && Date.now() - compass.at < 3000) return { deg: compass.deg, from: "compass" };
        const ahead = routeAheadBearing(route, stepIndex, point);
        return ahead === null ? null : { deg: ahead, from: "route" };
    }

    function circlePolygon(center, meters, sides = 48) {
        const coords = [];
        const dLat = meters / 111195, dLon = meters / (111195 * Math.cos(center[1] * Math.PI / 180));
        for (let i = 0; i <= sides; i++) {
            const a = (i / sides) * 2 * Math.PI;
            coords.push([center[0] + dLon * Math.cos(a), center[1] + dLat * Math.sin(a)]);
        }
        return { type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: [coords] } };
    }

    function showAccuracy(point, meters) {
        const map = state.map;
        if (!map?.getStyle?.()) return;
        try {
            const data = point && meters > 15 ? { type: "FeatureCollection", features: [circlePolygon(point, Math.min(meters, 3000))] }
                : { type: "FeatureCollection", features: [] };
            if (!map.getSource("journey-accuracy")) {
                map.addSource("journey-accuracy", { type: "geojson", data });
                map.addLayer({ id: "journey-accuracy-fill", type: "fill", source: "journey-accuracy", paint: { "fill-color": "#1a73e8", "fill-opacity": 0.12 } });
                map.addLayer({ id: "journey-accuracy-line", type: "line", source: "journey-accuracy", paint: { "line-color": "#1a73e8", "line-opacity": 0.35, "line-width": 1 } });
            } else {
                map.getSource("journey-accuracy").setData(data);
            }
        } catch (error) { console.debug("Accuracy circle:", error); }
    }

    // The "you" marker: a blue arrow pointing the way you face, gliding between GPS fixes.
    function placeTraveller(point, heading) {
        const journey = state.journey;
        if (!state.map || typeof maplibregl === "undefined") return;
        if (!journey.marker) {
            const element = document.createElement("div");
            element.className = "nav-you";
            element.innerHTML = `<div class="nav-you-halo"></div><svg viewBox="0 0 40 40" aria-hidden="true"><path class="nav-you-arrow" d="M20 4 L33 34 L20 27 L7 34 Z"/></svg><div class="nav-you-dot"></div>`;
            journey.marker = new maplibregl.Marker({ element, anchor: "center", rotationAlignment: "map", pitchAlignment: "map" })
                .setLngLat(point).addTo(state.map);
            journey.markerAt = point;
        }
        const element = journey.marker.getElement?.();
        element?.classList?.toggle("has-heading", heading !== null);
        if (heading !== null) journey.marker.setRotation?.(heading.deg);
        const from = journey.markerAt || point;
        journey.markerAt = point;
        if (typeof requestAnimationFrame !== "function") { journey.marker.setLngLat(point); return; }
        cancelAnimationFrame(journey.glide || 0);
        const start = performance.now();
        const step = now => {
            const t = Math.min(1, (now - start) / 900);
            journey.marker?.setLngLat([from[0] + (point[0] - from[0]) * t, from[1] + (point[1] - from[1]) * t]);
            if (t < 1) journey.glide = requestAnimationFrame(step);
        };
        journey.glide = requestAnimationFrame(step);
    }

    // Camera while following: close, tilted, turned the way you go, with you in the lower part of the free map.
    function followCamera(point, accuracy, heading, first = false) {
        const journey = state.journey;
        const map = state.map;
        if (!map) return;
        const coarse = !(accuracy <= 150);
        const pad = journeyModeOn() ? mapPadding() : { top: 80, right: 40, bottom: 80, left: 40 };
        if (!coarse) {
            const free = Math.max(0, (window.innerHeight || 800) - pad.top - pad.bottom);
            pad.top += Math.round(free * 0.3);                 // you sit below the centre, so more road ahead is visible
        }
        const zoom = coarse ? Math.min(15, Math.max(12, 17 - Math.log2(Math.max(accuracy, 150) / 75))) : (journey.zoomChosen ? map.getZoom() : 17.3);
        map[first ? "flyTo" : "easeTo"]({
            center: point, zoom, padding: pad,
            bearing: coarse || !heading ? (first ? 0 : map.getBearing()) : heading.deg,
            pitch: coarse ? 0 : 55,
            duration: first ? 1400 : 900, essential: true
        });
    }

    function renderRecenter() {
        const journey = state.journey;
        const pill = $("navRecenter");
        if (!pill) return;
        pill.hidden = !(journey.active && journeyModeOn() && journey.lastPosition && !journey.follow);
    }

    // Phones: the compass, for which way you face while standing still (Android: absolute orientation; iOS asks first).
    function startCompass() {
        const journey = state.journey;
        if (journey.compassOn || typeof window === "undefined" || !("DeviceOrientationEvent" in window)) return;
        const handle = event => {
            const deg = Number.isFinite(event.webkitCompassHeading) ? event.webkitCompassHeading
                : event.absolute && Number.isFinite(event.alpha) ? (360 - event.alpha) % 360 : null;
            if (deg === null) return;
            const last = journey.compass;
            journey.compass = { deg, at: Date.now() };
            if (journey.marker && (!last || Math.abs(deg - last.deg) > 4) && !(Number(journey.lastPosition?.coords?.speed) > 1)) {
                journey.marker.setRotation?.(deg);
                journey.marker.getElement?.()?.classList?.add("has-heading");
            }
        };
        const listen = () => {
            window.addEventListener("deviceorientationabsolute", handle);
            window.addEventListener("deviceorientation", handle);
            journey.compassOn = true;
        };
        try {
            if (typeof DeviceOrientationEvent.requestPermission === "function") {
                DeviceOrientationEvent.requestPermission().then(answer => { if (answer === "granted") listen(); }).catch(() => {});
            } else listen();
        } catch { /* no compass */ }
    }

    // ---- On the bus: stop countdown, how late you are running, missed stop / wrong bus ----
    // BMTC buses rarely announce stops, so the app does: which stops are behind you, the next one, and yours.
    function rideStops(route, stepIndex, position, now = Date.now()) {
        const step = guideSteps(route)[stepIndex];
        if (step?.kind !== "ride") return null;
        const leg = step.leg || {};
        const coords = leg.coordinates || [];
        const stops = (Array.isArray(leg.stops) ? leg.stops : []).map(stop => ({ ...stop, lat: Number(stop.lat), lon: Number(stop.lon) }))
            .filter(stop => Number.isFinite(stop.lat) && Number.isFinite(stop.lon));
        if (stops.length < 2) return null;
        const fix = position?.coords;
        const usable = fix && Number(fix.accuracy) <= 120 && now - Number(position.timestamp) <= 45000;
        const here = usable ? [Number(fix.longitude), Number(fix.latitude)] : null;
        const marks = stops.map(stop => alongLine(coords, [stop.lon, stop.lat])?.along ?? null);
        const me = here ? alongLine(coords, here) : null;
        const onLine = me && me.offset <= 150 && marks.every(mark => mark !== null);
        const passedCount = onLine ? marks.filter((mark, index) => index > 0 && mark < me.along - 25).length + 1 : 0;
        // Lateness: when you passed the last stop behind you, against its timetabled time.
        let late = null;
        if (onLine && passedCount > 1) {
            const last = stops[passedCount - 1];
            const at = stopClock(leg, last.time);
            if (Number.isFinite(at)) late = Math.round((now - at) / 60000);
        }
        const list = stops.map((stop, index) => ({
            name: stop.stop_name || stop.name || "", time: stop.time || "",
            status: index === stops.length - 1 ? (onLine && index < passedCount ? "passed" : "getoff")
                : !onLine ? (index === 0 ? "passed" : "later")
                : index < passedCount ? "passed" : index === passedCount ? "next" : "later"
        }));
        const left = onLine ? Math.max(0, stops.length - passedCount) : null;
        return { stops: list, left, late: late !== null && late >= -5 && late <= 90 ? late : null, onLine: !!onLine, getOff: leg.to?.name || "" };
    }

    // Where the trip really is: arrival moved by how late you are running (GPS on the bus, else BMTC's
    // live estimate for the bus you are waiting for). null when there is no evidence.
    function liveDelay(route, stepIndex, position, now = Date.now(), buses = [], tracked = null) {
        const steps = guideSteps(route);
        const step = steps[stepIndex];
        if (!step) return null;
        if (step.kind === "ride") {
            const ride = rideStops(route, stepIndex, position, now);
            if (ride?.late !== null && ride?.late !== undefined) return { minutes: ride.late, source: "gps" };
        }
        const board = step.kind === "board" ? step : step.kind === "walk" && steps[stepIndex + 1]?.kind === "board" ? steps[stepIndex + 1] : null;
        const leg = board?.leg;
        if (leg && tracked && String(tracked.name || "").trim().toLowerCase() === String(leg.from?.name || "").trim().toLowerCase()) {
            const planned = Date.parse(leg.departure_iso || "");
            const lines = new Set([leg.route_name, ...(leg.also_served_by || [])].map(name => String(name || "").split(" ")[0].toUpperCase()));
            const soonest = (buses || []).filter(bus => bus?.relevance === "approaching" && lines.has(String(bus.route || "").split(" ")[0].toUpperCase()))
                .map(bus => parseBmtcTime(bus.board_eta)?.getTime()).filter(Number.isFinite)
                .filter(at => Math.abs(at - planned) <= 60 * 60000).sort((a, b) => Math.abs(a - planned) - Math.abs(b - planned))[0];
            if (Number.isFinite(soonest) && Number.isFinite(planned)) return { minutes: Math.round((soonest - planned) / 60000), source: "live" };
        }
        return null;
    }

    // Riding: past your stop, or on a bus that has left your route.
    function rideTrouble(route, stepIndex, position) {
        const step = guideSteps(route)[stepIndex];
        const fix = position?.coords;
        if (step?.kind !== "ride" || !fix || !(Number(fix.accuracy) <= 80)) return null;
        const leg = step.leg || {};
        const here = [Number(fix.longitude), Number(fix.latitude)];
        const line = alongLine(leg.coordinates, here);
        if (!line) return null;
        const stop = leg.to && [Number(leg.to.lon), Number(leg.to.lat)];
        const fromStop = stop?.every(Number.isFinite) ? haversineMeters(here, stop) : Infinity;
        if (line.along >= line.length - 30 && fromStop > 250 && fromStop < 3000) return { kind: "passed", stop: leg.to?.name || "", meters: Math.round(fromStop) };
        if (line.offset > 400) return { kind: "off", meters: line.offset, line: leg.route_name || "" };
        return null;
    }

    function renderRideStops() {
        const box = $("navStops");
        if (!box) return;
        const journey = state.journey;
        const ride = rideStops(journey.route, journey.stepIndex, journey.lastPosition);
        if (!ride) { box.hidden = true; return; }
        if (journey.preview) ride.late = null;              // simulated position: no lateness claims
        const upcoming = ride.stops.map((stop, index) => ({ ...stop, index })).filter(stop => stop.status !== "passed");
        const shown = upcoming.slice(0, 3);
        const lastShown = shown[shown.length - 1];
        if (lastShown && lastShown.status !== "getoff") shown.push(upcoming[upcoming.length - 1]);
        const hiddenCount = Math.max(0, upcoming.length - shown.length);
        const label = ride.left === null ? tr("Stops on this ride (timetable times)")
            : ride.left <= 1 ? tr("Your stop is next") : tr("{n} stops to your stop", { n: ride.left });
        const html = `<div class="nav-stops-head">${escapeHtml(label)}${ride.late !== null && Math.abs(ride.late) >= 2
                ? ` · <b>${escapeHtml(ride.late > 0 ? tr("running ~{n} min late", { n: ride.late }) : tr("running ~{n} min early", { n: -ride.late }))}</b>` : ""}</div>` +
            `<ol class="nav-stop-list">${shown.map((stop, i) => (i === shown.length - 1 && hiddenCount && stop.status === "getoff"
                ? `<li class="more">${escapeHtml(hiddenCount === 1 ? tr("… 1 more stop") : tr("… {n} more stops", { n: hiddenCount }))}</li>` : "") +
                `<li class="${stop.status}"><i></i><span>${escapeHtml(stop.name)}${stop.status === "getoff" ? " 🏁" : ""}</span><small>${escapeHtml(stop.time)}</small></li>`).join("")}</ol>`;
        box.hidden = false;
        if (box.btHtml !== html) { box.innerHTML = html; box.btHtml = html; }
    }

    // ---- Spoken directions (🔊): each prompt once, at the right moment ----
    function announce(key, text, urgent = false) {
        const journey = state.journey;
        if (!state.talk || !journey.active || !text) return;
        journey.spoken = journey.spoken || new Set();
        const full = `${journey.session}:${key}`;
        if (journey.spoken.has(full)) return;
        journey.spoken.add(full);
        speak(text, { urgent });
    }

    function voicePrompts(position) {
        const journey = state.journey;
        if (!state.talk || !journey.active) return;
        const steps = guideSteps(journey.route);
        const step = steps[journey.stepIndex];
        if (!step) return;
        if (step.kind === "walk") {
            const turn = nextManeuver(step.leg, position);
            if (turn && turn.meters !== null) {
                const id = `turn:${journey.stepIndex}:${turn.text}`;
                if (turn.meters <= 30) announce(`${id}:now`, turn.text, true);
                else if (turn.meters <= 130) announce(`${id}:soon`, tr("In {m} metres, {turn}", { m: Math.round(turn.meters / 10) * 10, turn: turn.text.charAt(0).toLowerCase() + turn.text.slice(1) }));
            }
            const catching = catchBus(journey.route, journey.stepIndex, position, Date.now(), state.liveBus?.lastShown || [], state.liveBus?.boardingStop || null);
            if (catching?.level === "miss") announce(`hurry:${journey.stepIndex}`, tr("Hurry: your bus is due in about {n} minutes.", { n: catching.due }));
        }
        if (step.kind === "board") {
            const live = state.liveBus || {};
            const lines = new Set([step.leg?.route_name, ...(step.leg?.also_served_by || [])].map(name => String(name || "").split(" ")[0].toUpperCase()));
            const near = (live.lastShown || []).filter(bus => bus?.relevance === "approaching" && lines.has(String(bus.route || "").split(" ")[0].toUpperCase()))
                .sort((a, b) => (a.stops_away ?? 99) - (b.stops_away ?? 99))[0];
            if (near && Number(near.stops_away) <= 2) {
                announce(`bus-near:${journey.stepIndex}`, Number(near.stops_away) === 0
                    ? tr("Your bus {line} is at the stop.", { line: near.route }) : tr("Your bus {line} is {n} stops away.", { line: near.route, n: near.stops_away }));
            }
        }
        if (step.kind === "ride") {
            const ride = rideStops(journey.route, journey.stepIndex, position);
            if (ride?.left !== null && ride?.left !== undefined && ride.left >= 2 && ride.left <= 3) {
                announce(`left:${journey.stepIndex}:${ride.left}`, tr("{n} stops to {stop}.", { n: ride.left, stop: ride.getOff }));
            }
        }
    }

    function checkRideTrouble(position) {
        const journey = state.journey;
        const trouble = rideTrouble(journey.route, journey.stepIndex, position);
        if (!trouble) { journey.offCount = 0; return; }
        journey.navNotes = journey.navNotes || new Set();
        // Two readings in a row, so a single GPS jump never raises the alarm.
        journey.offCount = (journey.offCount || 0) + 1;
        if (journey.offCount < 2) return;
        const key = `${trouble.kind}:${journey.stepIndex}`;
        if (journey.navNotes.has(key)) return;
        journey.navNotes.add(key);
        const text = trouble.kind === "passed"
            ? tr("You may have passed {stop} (about {m} m back). Get off at the next stop.", { stop: trouble.stop, m: trouble.meters })
            : tr("This bus seems to have left your route (about {m} m away). Check the bus number.", { m: trouble.meters });
        showGuideBanner(text, "urgent", { label: tr("Find a new way from here"), run: () => rerouteFromHere(position) });
        announce(key, text, true);
        if (!journey.preview) notify(tr("Check your bus"), text, { urgent: true, tag: "bt-trouble" });
    }

    // ---- Navigation engine ----
    // With a good GPS fix the journey moves on by itself, the way a car navigator does:
    //  walk → reached the stop; board → the phone is moving along the bus's road away from the stop;
    //  ride → at the get-off stop. Every automatic move says so and can be undone; weak or old GPS never moves a step.
    function alongLine(coordinates, point) {
        const coords = (coordinates || []).map(p => [Number(p[0]), Number(p[1])]).filter(p => p.every(Number.isFinite));
        if (coords.length < 2 || !point?.every?.(Number.isFinite)) return null;
        const lat0 = point[1] * Math.PI / 180, my = 6371000 * Math.PI / 180, mx = my * Math.cos(lat0);   // same scale as haversineMeters
        const xy = p => [(p[0] - point[0]) * mx, (p[1] - point[1]) * my];
        let walked = 0, best = null;
        for (let i = 0; i < coords.length - 1; i++) {
            const [ax, ay] = xy(coords[i]), [bx, by] = xy(coords[i + 1]);
            const dx = bx - ax, dy = by - ay, len = Math.hypot(dx, dy);
            const t = len ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / (len * len))) : 0;
            const offset = Math.hypot(ax + t * dx, ay + t * dy);
            if (!best || offset < best.offset) best = { offset, along: walked + t * len };
            walked += len;
        }
        return { offset: Math.round(best.offset), along: Math.round(best.along), length: Math.round(walked) };
    }

    function autoStep(route, stepIndex, position, now = Date.now()) {
        const steps = guideSteps(route);
        const step = steps[stepIndex];
        const fix = position?.coords;
        if (!step || !fix || step.kind === "arrive" || stepIndex >= steps.length - 1) return null;
        const accuracy = Number(fix.accuracy);
        if (!(accuracy <= (step.kind === "ride" ? 80 : 50)) || now - Number(position.timestamp) > 20000) return null;
        const here = [Number(fix.longitude), Number(fix.latitude)];
        const leg = step.leg || {};
        const at = place => {
            const p = place && [Number(place.lon), Number(place.lat)];
            return p?.every(Number.isFinite) ? haversineMeters(here, p) : Infinity;
        };
        if (step.kind === "walk") {
            const near = Math.max(25, Math.min(accuracy, 40));
            return at(step.target) <= near ? { to: stepIndex + 1, reason: "reached", place: step.target?.name || "" } : null;
        }
        const line = alongLine(leg.coordinates, here);
        if (step.kind === "board") {
            if (!line || line.offset > 50 || line.along < 200 || at(leg.from) < 150) return null;
            // Walking along the bus's road is not riding it: when the phone reports a walking speed, wait longer.
            if (fix.speed !== null && fix.speed !== undefined && Number(fix.speed) < 2.5 && line.along < 600) return null;
            return { to: stepIndex + 1, reason: "onboard", place: leg.route_name || "" };
        }
        if (step.kind === "ride") {
            const stop = at(leg.to);
            if (stop <= 35 || (line && line.offset <= 60 && line.along >= line.length - 25 && stop <= 80)) {
                return { to: stepIndex + 1, reason: "alighted", place: leg.to?.name || "" };
            }
        }
        return null;
    }

    // Walking: far off the walking path (with a good fix) means the traveller has taken another way.
    function offRoute(route, stepIndex, position) {
        const step = guideSteps(route)[stepIndex];
        const fix = position?.coords;
        if (step?.kind !== "walk" || !fix || !(Number(fix.accuracy) <= 40)) return null;
        const line = alongLine(step.leg?.coordinates, [Number(fix.longitude), Number(fix.latitude)]);
        return line && line.offset > 80 ? line.offset : null;
    }

    // Walking to a stop: will you make the bus? BMTC's live estimate when there is one, else the timetable.
    function catchBus(route, stepIndex, position, now = Date.now(), buses = [], tracked = null) {
        const steps = guideSteps(route);
        const step = steps[stepIndex], next = steps[stepIndex + 1];
        if (step?.kind !== "walk" || next?.kind !== "board" || next.leg?.role === "metro") return null;
        const fix = position?.coords;
        const target = step.target && [Number(step.target.lon), Number(step.target.lat)];
        const fresh = fix && Number(fix.accuracy) <= 100 && now - Number(position.timestamp) <= 60000 && target?.every(Number.isFinite);
        const walk = fresh ? Math.max(1, Math.round(haversineMeters([Number(fix.longitude), Number(fix.latitude)], target) / 75))
            : Number(step.leg?.duration_minutes) || null;
        if (!walk) return null;
        const leg = next.leg;
        const lines = new Set([leg.route_name, ...(leg.also_served_by || [])].map(name => String(name || "").split(" ")[0].toUpperCase()));
        const sameStop = tracked && String(tracked.name || "").trim().toLowerCase() === String(leg.from?.name || "").trim().toLowerCase();
        let due = null, line = leg.route_name, source = "timetable";
        if (sameStop) {
            const live = (buses || []).filter(bus => bus?.relevance === "approaching" && lines.has(String(bus.route || "").split(" ")[0].toUpperCase()))
                .map(bus => ({ bus, minutes: boardEtaMinutes(bus, now) })).filter(item => item.minutes !== null)
                .sort((a, b) => a.minutes - b.minutes);
            const catchable = live.find(item => item.minutes >= walk - 1) || live[0];
            if (catchable) { due = Math.round(catchable.minutes); line = catchable.bus.route; source = "live"; }
        }
        if (due === null) {
            const planned = Date.parse(leg.departure_iso || "");
            if (!Number.isFinite(planned)) return null;
            due = Math.round((planned - now) / 60000);
            if (due < -2 || due > 90) return null;              // not today / long gone: nothing useful to say
        }
        const spare = due - walk;
        return { level: spare < 0 ? "miss" : spare < 2 ? "tight" : "ok", due: Math.max(0, due), walk, spare, line, source };
    }

    function catchBusText(c) {
        const source = c.source === "live" ? tr("BMTC live") : tr("timetable");
        if (c.level === "miss") return tr("🏃 {line} due in ~{due} min, {walk} min walk: hurry or take the next one ({source})", { ...c, source });
        if (c.level === "tight") return tr("⏱ {line} in ~{due} min, {walk} min walk: keep going ({source})", { ...c, source });
        return tr("✓ {line} in ~{due} min, {walk} min walk: you will make it ({source})", { ...c, source });
    }

    function navigateOnPosition(position) {
        const journey = state.journey;
        if (!journey.active || !journey.route) return;
        const steps = guideSteps(journey.route);
        const hold = journey.autoHold;
        const held = hold && hold.step === journey.stepIndex && Date.now() < hold.until;
        const move = held ? null : autoStep(journey.route, journey.stepIndex, position);
        if (move) {
            const from = journey.stepIndex;
            journey.stepIndex = move.to;
            hideGuideBanner();
            renderJourneyGuide();
            syncGuideLive();
            const text = move.reason === "reached" ? tr("You reached {place}. Next: {next}", { place: move.place, next: steps[move.to]?.short || "" })
                : move.reason === "onboard" ? tr("You are on the move with {place}. Watch for your stop.", { place: move.place })
                : tr("You are at {place}. Next: {next}", { place: move.place, next: steps[move.to]?.short || "" });
            announce(`auto:${move.to}`, text);
            showGuideBanner(text, "info", { label: tr("Undo"), run: () => {
                journey.stepIndex = from;
                journey.autoHold = { step: from, until: Date.now() + 90000 };
                hideGuideBanner();
                renderJourneyGuide();
                syncGuideLive();
            } });
            try { navigator.vibrate?.([120, 80, 120]); } catch { /* not supported */ }
        }
        // Arrived: say it once and offer Finish.
        const step = steps[journey.stepIndex];
        journey.navNotes = journey.navNotes || new Set();
        if (step?.kind === "arrive" && position?.coords && Number(position.coords.accuracy) <= 60 && step.target &&
            haversineMeters([position.coords.longitude, position.coords.latitude], [Number(step.target.lon), Number(step.target.lat)]) <= 60 &&
            !journey.navNotes.has("arrived")) {
            journey.navNotes.add("arrived");
            announce("arrived", tr("You have arrived at {place}.", { place: step.target.name || "" }));
            showGuideBanner(tr("🏁 You have arrived at {place}.", { place: step.target.name || "" }), "info",
                { label: tr("✓ Finish"), run: () => goToGuideStep(1) });
        }
        const off = offRoute(journey.route, journey.stepIndex, position);
        const offKey = `off:${journey.stepIndex}`;
        if (off && !journey.navNotes.has(offKey) && !journey.preview) {
            journey.navNotes.add(offKey);
            showGuideBanner(tr("You are about {m} m off the walking route.", { m: off }), "warn",
                { label: tr("Re-route from here"), run: () => rerouteFromHere(position) });
        }
    }

    function rerouteFromHere(position) {
        const fix = position?.coords;
        if (!fix) return;
        setEndpoint("origin", { name: tr("My location"), lat: fix.latitude, lon: fix.longitude, is_map_point: true });
        setDepartAt("", { replan: false });
        showStatus(tr("Finding a new way from where you are…"));
        planJourney();
    }

    // Keep the screen on while navigating (where the browser allows it).
    async function holdScreenOn(on) {
        const journey = state.journey;
        try {
            if (!on) { await journey.wakeLock?.release?.(); journey.wakeLock = null; return; }
            if (journey.wakeLock || !navigator.wakeLock?.request || document.visibilityState !== "visible") return;
            journey.wakeLock = await navigator.wakeLock.request("screen");
            journey.wakeLock.addEventListener?.("release", () => { journey.wakeLock = null; });
        } catch { journey.wakeLock = null; }
    }

    // ---- Preview: ride the trip with a simulated position (for a computer without GPS, or to see what is coming) ----
    const PREVIEW_SPEED = 15;
    function previewTrack(route) {
        const track = [];
        (route?.legs || []).forEach((leg, legIndex) => {
            const coords = (leg?.coordinates || []).map(p => [Number(p[0]), Number(p[1])]).filter(p => p.every(Number.isFinite));
            if (coords.length < 2) return;
            const speed = !leg.transit ? 1.4 : leg.role === "metro" ? 11 : 6.5;
            if (leg.transit) track.push({ point: coords[0], wait: 6, legIndex, speed: 0 });
            for (let i = 0; i < coords.length - 1; i++) {
                const meters = haversineMeters(coords[i], coords[i + 1]);
                const pieces = Math.max(1, Math.ceil(meters / (speed * PREVIEW_SPEED)));
                for (let k = 0; k < pieces; k++) {
                    const t = k / pieces;
                    track.push({ point: [coords[i][0] + (coords[i + 1][0] - coords[i][0]) * t, coords[i][1] + (coords[i + 1][1] - coords[i][1]) * t],
                                 heading: bearingBetween(coords[i], coords[i + 1]), speed, legIndex });
                }
            }
            track.push({ point: coords[coords.length - 1], speed: 0, legIndex });
        });
        return track;
    }

    function bearingBetween(a, b) {
        const toRad = d => d * Math.PI / 180;
        const y = Math.sin(toRad(b[0] - a[0])) * Math.cos(toRad(b[1]));
        const x = Math.cos(toRad(a[1])) * Math.sin(toRad(b[1])) - Math.sin(toRad(a[1])) * Math.cos(toRad(b[1])) * Math.cos(toRad(b[0] - a[0]));
        return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
    }

    function startPreview() {
        const journey = state.journey;
        if (!journey.active) return;
        stopPreview();
        const track = previewTrack(journey.route);
        if (!track.length) { showStatus(tr("This journey has no map path to preview.")); return; }
        journey.stepIndex = 0;
        journey.follow = true;
        journey.zoomChosen = false;
        journey.navNotes = new Set();
        journey.alerted = new Set();
        journey.autoHold = null;
        let index = 0, waiting = 0;
        journey.preview = { timer: null };
        const tick = () => {
            if (!journey.active || !journey.preview) return;
            const item = track[index];
            if (!item) { stopPreview(); showStatus(tr("Preview finished.")); return; }
            if (item.wait && waiting < item.wait) waiting++;
            else { waiting = 0; index++; }
            updateJourneyProgress({ coords: { latitude: item.point[1], longitude: item.point[0], accuracy: 8,
                heading: Number.isFinite(item.heading) ? item.heading : null, speed: item.speed || 0 }, timestamp: Date.now() });
        };
        journey.preview.timer = setInterval(tick, 1000);
        renderPreviewState();
        tick();
    }

    function stopPreview() {
        const journey = state.journey;
        if (!journey.preview) return;
        clearInterval(journey.preview.timer);
        journey.preview = null;
        journey.lastPosition = null;
        journey.marker?.remove?.();
        journey.marker = null;
        renderPreviewState();
        if (journey.active) renderJourneyGuide();
    }

    function renderPreviewState() {
        const on = !!state.journey.preview;
        if ($("navPreviewBar")) $("navPreviewBar").hidden = !on;
        if ($("navPreviewBtn")) $("navPreviewBtn").textContent = on ? tr("■ Stop preview") : tr("▶ Preview the trip");
        document.body?.classList?.toggle("nav-preview", on);
    }

    function renderNavBuses() {
        const box = $("navBuses");
        if (!box) return;
        const journey = state.journey;
        const steps = guideSteps(journey.route);
        const step = steps[journey.stepIndex];
        const boardStep = step?.kind === "board" ? step : step?.kind === "walk" && steps[journey.stepIndex + 1]?.kind === "board" ? steps[journey.stepIndex + 1] : null;
        const leg = boardStep?.leg;
        if (!leg || leg.role === "metro" || journey.preview) { box.hidden = true; return; }
        const live = state.liveBus || {};
        const lines = new Set([leg.route_name, ...(leg.also_served_by || [])].map(name => String(name || "").split(" ")[0].toUpperCase()));
        const sameStop = String(live.boardingStop?.name || "").trim().toLowerCase() === String(leg.from?.name || "").trim().toLowerCase();
        const buses = sameStop ? (live.lastShown || []).filter(bus => bus?.relevance === "approaching" && lines.has(String(bus.route || "").split(" ")[0].toUpperCase()))
            .map(bus => ({ bus, minutes: boardEtaMinutes(bus) })).sort((a, b) => (a.minutes ?? 999) - (b.minutes ?? 999)).slice(0, 3) : [];
        const html = buses.length
            ? `<span class="nav-buses-label">${escapeHtml(tr("Live at {stop}", { stop: leg.from?.name || "" }))}</span>` + buses.map(({ bus, minutes }) =>
                `<span class="nav-bus-pill${bus.freshness === "fresh" ? "" : " stale"}"><b>${escapeHtml(bus.route || "")}</b> ${escapeHtml(minutes === null
                    ? (Number.isFinite(bus.stops_away) ? tr("{n} stops away", { n: bus.stops_away }) : tr("on its way"))
                    : minutes <= 0 ? tr("due now") : tr("~{n} min", { n: Math.round(minutes) }))}</span>`).join("")
            : `<span class="nav-buses-label">${escapeHtml(tr("No live position yet for {line} at {stop}; timetable {time}.", { line: leg.route_name || "", stop: leg.from?.name || "", time: leg.departure_time || "—" }))}</span>`;
        box.hidden = false;
        if (box.btHtml !== html) { box.innerHTML = html; box.btHtml = html; }
    }

    function startJourney(route, index) {
        exitMapFocus();
        closeChat();
        if (state.journey.active) stopJourneyTracking();

        state.selectedRouteIndex = index;
        selectRoute(route, index, true);
        state.journey.active = true;
        state.journey.route = route;
        state.journey.routeIndex = 0;
        state.journey.stepIndex = 0;
        state.journey.follow = true;
        state.journey.alerted = new Set();
        {
            const firstBus = (route.legs || []).find(leg => leg.transit && leg.role !== "metro");
            logTrip(state.origin, state.destination, { started: true, line: firstBus?.route_name || "",
                board: firstBus?.from ? { name: firstBus.from.name, lat: Number(firstBus.from.lat), lon: Number(firstBus.from.lon) } : null });
        }
        hideGuideBanner(true);
        if (state.journey.alertsOn) askNotificationPermission();
        state.journey.gpsError = navigator.geolocation ? "Waiting for device location…" : "Device location is unavailable. Use Next step as you travel.";
        hideRoutePanel();
        $("liveBusPanel").classList.remove("with-routes");
        $("networkPanel").hidden = true;
        state.journey.zoomChosen = false;
        state.journey.userMovedUntil = 0;
        state.journey.autoHold = null;
        state.journey.navNotes = new Set();
        state.journey.lastPosition = null;
        state.journey.cameraStarted = false;
        setJourneyMode(true);
        startCompass();
        holdScreenOn(true);
        const session = ++state.journey.session;
        state.journey.gpsWaitedLong = false;
        renderJourneyGuide();
        setTimeout(() => { if (state.journey.session === session && !state.journey.lastPosition) focusNavCamera("step"); }, 150);
        setTimeout(() => { if (state.journey.session === session) { state.journey.gpsWaitedLong = true; renderNavCard(); } }, 8000);

        routeResults.querySelectorAll(".start-journey-button").forEach((button) => {
            button.classList.remove("active");
            button.textContent = "▶ Start journey";
        });
        const activeButton = routeResults.querySelectorAll(".journey-route-card")[index]?.querySelector(".start-journey-button");
        if (activeButton) {
            activeButton.classList.add("active");
            activeButton.textContent = "■ Stop journey guidance";
        }
        syncGuideLive();
        checkMissedBus();

        showStatus(guideSteps(route).length
            ? tr("Navigation started. With GPS, steps move on by themselves as you travel; Next step works too.")
            : "Guidance started, but this option has no step list. Use the card's instructions.");
        if (!navigator.geolocation) return;
        // A quick first fix (a recent one is fine) so the map can zoom to you straight away; the watch refines it.
        try {
            navigator.geolocation.getCurrentPosition(
                position => { if (state.journey.session === session && !state.journey.preview && !state.journey.lastPosition) updateJourneyProgress(position); },
                () => {}, { enableHighAccuracy: false, timeout: 8000, maximumAge: 60000 });
        } catch { /* the watch below still runs */ }
        try {
            state.journey.watchId = navigator.geolocation.watchPosition(
                position => { if (state.journey.session === session && !state.journey.preview) updateJourneyProgress(position); },
                (error) => {
                    if (state.journey.session !== session) return;
                    state.journey.gpsError = error?.code === 1
                        ? "Location permission is blocked. Journey steps remain available; use Next step as you travel."
                        : "GPS unavailable or timed out. Use Next step as you travel; location will retry.";
                    renderJourneyGuide();
                    if (error?.code === 1) showStatus("Location permission is blocked. Journey steps remain available.", true);
                },
                { enableHighAccuracy: true, timeout: 10000, maximumAge: 2000 }
            );
        } catch (error) {
            state.journey.gpsError = "Device location is unavailable. Use Next step as you travel.";
            renderJourneyGuide();
        }
    }

    function locateUser() {
        if (!navigator.geolocation) {
            showStatus("Geolocation is not available in this browser. Use Pick on map or type a stop name.", true);
            return;
        }

        showStatus("Finding your location…");
        navigator.geolocation.getCurrentPosition(
            (position) => {
                const { latitude: lat, longitude: lon } = position.coords;
                const accuracy = Math.round(position.coords.accuracy || 0);
                if (!state.map) return;

                state.userMarker?.remove();
                const element = document.createElement("div");
                element.className = "transit-user-location-marker";
                element.innerHTML = `
                    <div class="transit-user-location-pulse"></div>
                    <div class="transit-user-location-dot"></div>
                `;
                state.userMarker = new maplibregl.Marker({ element, anchor: "center" })
                    .setLngLat([lon, lat])
                    .setPopup(new maplibregl.Popup({ offset: 18, closeButton: false })
                        .setText(`Your current location (±${accuracy} m)`))
                    .addTo(state.map);

                state.map.flyTo({ center: [lon, lat], zoom: 15, duration: 900 });

                const inside = lat >= 12.65 && lat <= 13.45 && lon >= 77.20 && lon <= 78.00;
                if (!inside) {
                    showStatus("Your location is outside the Bengaluru routing area, so it cannot be used as a start.", true);
                    return;
                }
                const rough = accuracy > 500 ? " This location is rough (desktop/Wi-Fi); check the marker before using it." : "";
                if (!state.origin) {
                    invalidateJourney();
                    const point = normalizeStop({
                        id: "point-origin", is_map_point: true,
                        name: `My location (±${accuracy} m)`, lat, lon
                    });
                    state.origin = point;
                    originInput.value = point.name;
                    updateMarker("origin", point);
                    showStatus(`Start set to your location. Now choose a destination.${rough}`, !!rough);
                } else {
                    showStatus(`Your location is marked on the map. Clear the From box to use it as your start.${rough}`);
                }
            },
            (error) => {
                console.error(error);
                showStatus(error?.code === 1
                    ? "Location permission is blocked. Allow location for this site in the browser, or use Pick on map."
                    : "Your location could not be determined right now. Try again, or use Pick on map.", true);
            },
            {
                enableHighAccuracy: true,
                timeout: 10000,
                maximumAge: 30000
            }
        );
    }

    function resetJourney() {
        invalidateJourney();
        clearTimeout(state.originTimer);
        clearTimeout(state.destinationTimer);
        originSuggestions.classList.remove("visible");
        destinationSuggestions.classList.remove("visible");
        state.pickPointType = null;
        if (state.map) state.map.getCanvas().style.cursor = "";
        originInput.value = "";
        destinationInput.value = "";
        state.origin = null;
        state.destination = null;
        state.lastPlan = null;
        renderPlaceChips();
        syncExplainButton();
        if ($("routeMeta")) $("routeMeta").textContent = "";

        if (state.originMarker) {
            state.originMarker.remove();
            state.originMarker = null;
        }

        if (state.destinationMarker) {
            state.destinationMarker.remove();
            state.destinationMarker = null;
        }

        clearRouteLayers();
        routeResults.innerHTML = "";
        hideRoutePanel();

        if (state.map) {
            state.map.flyTo({
                center: [77.5946, 12.9716],
                zoom: 11.7,
                bearing: 0,
                pitch: 0,
                duration: 900
            });
        }

        showStatus("New journey started.");
    }

    function showRoutePanel() {
        exitMapFocus();
        routePanel.classList.add("open");
        setRoutesCollapsed(false);
    }

    function hideRoutePanel() {
        routePanel.classList.remove("open");
        setRoutesCollapsed(false);
    }

    // Journey options panel sizes: standard (one row of cards, sideways scrolling only), expanded
    // (tall, cards wrap, every detail visible), or folded to its header. Height changes animate in CSS.
    function setRoutesExpanded(expanded) {
        const on = !!expanded;
        if (on) routePanel.classList.remove("collapsed");
        routePanel.classList.toggle("expanded", on);
        routePanel.style?.removeProperty?.("--rp-h");
        const button = $("expandRoutesBtn");
        if (button) {
            button.textContent = on ? "⤡" : "⤢";
            button.title = on ? "Back to standard size" : "Expand";
            button.setAttribute?.("aria-label", on ? "Return journey options to standard size" : "Expand journey options");
            button.setAttribute?.("aria-pressed", String(on));
        }
        if (on) routeResults.scrollLeft = 0;
        else if (routeResults) routeResults.scrollTop = 0;
    }

    function setRoutesCollapsed(collapsed) {
        if (collapsed && routePanel.classList.contains("expanded")) setRoutesExpanded(false);
        routePanel.classList.toggle("collapsed", !!collapsed);
        const button = $("closeRoutesBtn");
        if (button) {
            button.textContent = collapsed ? "▴" : "▾";
            button.setAttribute?.("aria-label", collapsed ? "Show journey options" : "Hide journey options");
            button.setAttribute?.("aria-expanded", String(!collapsed));
        }
    }

    // ---- Side dock: journey steps and live buses share one column (desktop: drag the handle between
    // them; phone: one bottom sheet with tabs and a pull handle). Fold (▾) and make-big (⤢) per panel.
    function phoneLayout() { return (window.innerWidth || 1600) <= 760; }

    function setDockTab(tab) {
        const dock = $("sideDock");
        if (!dock?.classList) return;
        dock.classList.toggle("tab-guide", tab === "guide");
        dock.classList.toggle("tab-live", tab === "live");
        dock.querySelectorAll?.(".dock-tab").forEach(button => button.setAttribute("aria-selected", String(button.dataset.tab === tab)));
    }

    function syncDock({ guideOpened = false, liveOpened = false } = {}) {
        const dock = $("sideDock");
        if (!dock?.classList) return;
        const guide = $("journeyGuide"), live = $("liveBusPanel");
        const guideOn = !!guide && !guide.hidden, liveOn = !!live && !live.hidden;
        dock.classList.toggle("has-panel", guideOn || liveOn);
        dock.classList.toggle("both", guideOn && liveOn);
        // A panel that opens starts at its top (and starting a journey from the bottom of the live list
        // must not leave that list scrolled to its end).
        if (guideOpened) { guide.classList.remove("folded"); guide.scrollTop = 0; if (live) live.scrollTop = 0; }
        if (liveOpened) { live.classList.remove("folded"); live.scrollTop = 0; }
        // Which tab a phone shows: the panel the traveller just asked for. Live buses opened automatically
        // by guidance do not steal the screen from the journey steps.
        if (liveOpened && !state.liveBus.autoForJourney) setDockTab("live");
        else if (guideOpened || !liveOn) setDockTab("guide");
        else if (!guideOn) setDockTab("live");
        else if (!dock.classList.contains("tab-guide") && !dock.classList.contains("tab-live")) setDockTab("guide");
    }

    function setDockHeight(px) {
        const dock = $("sideDock");
        if (!dock?.style) return;
        if (px === null) dock.style.removeProperty("--dock-h");
        else dock.style.setProperty("--dock-h", `${Math.round(px)}px`);
        // The smallest size shows only the tabs and a one-line summary.
        dock.classList?.toggle("peek", px !== null && phoneLayout() && px <= dockSnapHeights().peek + 12);
    }

    function dockSnapHeights() {
        const height = window.innerHeight || 800;
        const dock = $("sideDock");
        // Peek = handle + tabs + the slim header of the panel on show (measured, so it always fits exactly).
        let peek = 150;
        try {
            const grip = dock?.querySelector?.(".dock-grip"), tabs = dock?.querySelector?.(".dock-tabs");
            const shown = [$("journeyGuide"), $("liveBusPanel")].find(panel => panel && !panel.hidden && panel.offsetHeight > 0);
            const head = shown?.querySelector?.(".dock-head");
            const measured = (grip?.offsetHeight || 0) + (tabs?.offsetHeight || 0) + (head?.offsetHeight || 0) + 6;
            if (measured > 60) peek = Math.max(110, Math.min(220, measured));
        } catch { /* keep the default */ }
        return { peek, half: Math.round(height * 0.5), full: Math.round(height - 80) };
    }

    // Summary line in each slim header, mirrored from the panel's own title / headline.
    function syncDockSummaries() {
        const pairs = [["guideSum", "guideTitle"], ["liveSum", "liveBusStatus"]];
        pairs.forEach(([target, source]) => {
            const out = $(target), from = $(source);
            if (out && from) out.textContent = (from.textContent || "").replace(/\s+/g, " ").trim();
        });
    }

    // Header shadow once scrolled; "More below" hint while content continues out of sight.
    function updateDockScrollHints(panel) {
        if (!panel?.classList) return;
        const top = panel.scrollTop || 0;
        const below = (panel.scrollHeight || 0) - top - (panel.clientHeight || 0);
        panel.classList.toggle("scrolled", top > 36);
        panel.classList.toggle("more-below", !panel.classList.contains("folded") && below > 28);
    }

    function updateDockSpace() {
        const dock = $("sideDock");
        const open = !!dock?.classList?.contains("has-panel");
        document.body?.classList?.toggle("dock-open", open);
        if (open && phoneLayout() && dock.getBoundingClientRect) {
            const box = dock.getBoundingClientRect();
            document.documentElement?.style?.setProperty("--dock-space", `${Math.round((window.innerHeight || 0) - box.top)}px`);
        }
    }

    function foldDockPanel(panel, folded) {
        if (!panel?.classList) return;
        panel.classList.toggle("folded", folded);
        if (folded) panel.scrollTop = 0;          // unfolding later starts at the top, never mid-way
        updateDockMaxButtons();
        updateDockScrollHints(panel);
    }

    function updateDockMaxButtons() {
        const guide = $("journeyGuide"), live = $("liveBusPanel");
        [[guide, live], [live, guide]].forEach(([panel, other]) => {
            const button = panel?.querySelector?.(".dock-max");
            if (!button?.setAttribute) return;
            const big = !panel.classList.contains("folded") && !!other && !other.hidden && other.classList.contains("folded");
            button.setAttribute("aria-pressed", String(big));
            button.title = big ? "Share the space again" : "Make this panel big";
        });
    }

    function setupSideDock() {
        const dock = $("sideDock");
        if (!dock?.addEventListener) return;
        const guide = $("journeyGuide"), live = $("liveBusPanel");
        const panels = [guide, live].filter(Boolean);
        const store = {
            get(key) { try { return window.localStorage?.getItem(key); } catch { return null; } },
            set(key, value) { try { window.localStorage?.setItem(key, value); } catch { /* private mode */ } },
        };
        const savedSplit = parseFloat(store.get("dockSplit"));
        if (savedSplit >= 15 && savedSplit <= 85) dock.style.setProperty("--split", `${savedSplit}%`);

        // "More below" hint inside each panel; tapping it scrolls on.
        panels.forEach(panel => {
            if (!panel.querySelector?.(".dock-more") && document.createElement) {
                const more = document.createElement("div");
                more.className = "dock-more";
                more.innerHTML = '<span role="button" tabindex="-1">▾ More</span>';
                more.addEventListener?.("click", () => panel.scrollBy?.({ top: Math.max(120, (panel.clientHeight || 300) * 0.7) }));
                panel.appendChild(more);
            }
            panel.addEventListener("scroll", () => updateDockScrollHints(panel), { passive: true });
        });
        const refreshAll = () => {
            syncDockSummaries();
            panels.forEach(updateDockScrollHints);
            updateDockMaxButtons();
            updateDockSpace();
        };
        let queued = false;
        const refreshSoon = () => {
            if (queued) return;
            queued = true;
            (window.requestAnimationFrame || setTimeout)(() => { queued = false; refreshAll(); });
        };
        // React whenever either panel is shown or hidden, however the rest of the app does it.
        if (typeof MutationObserver === "function") {
            const watch = (panel, key) => new MutationObserver(() => { syncDock({[key]: !panel.hidden}); refreshSoon(); })
                .observe(panel, {attributes: true, attributeFilter: ["hidden"]});
            if (guide) watch(guide, "guideOpened");
            if (live) watch(live, "liveOpened");
            const content = new MutationObserver(refreshSoon);
            panels.forEach(panel => content.observe(panel, { childList: true, characterData: true, subtree: true }));
        }
        if (typeof ResizeObserver === "function") {
            const sizes = new ResizeObserver(refreshSoon);
            sizes.observe(dock);
            panels.forEach(panel => sizes.observe(panel));
        }
        window.addEventListener?.("resize", () => {
            if (!phoneLayout()) { setDockHeight(null); dock.classList.remove("peek"); }
            refreshSoon();
        });
        syncDock();
        refreshAll();

        dock.querySelectorAll(".dock-tab").forEach(button => button.addEventListener("click", () => {
            setDockTab(button.dataset.tab);
            // Choosing a tab from the smallest size opens the sheet enough to read it.
            if (dock.classList.contains("peek")) setDockHeight(dockSnapHeights().half);
            refreshSoon();
        }));

        const toggleFold = (panel) => {
            if (!panel) return;
            if (phoneLayout()) {
                // On a phone, folding means "show me the map": the sheet drops to its smallest size and back.
                const { half } = dockSnapHeights();
                setDockHeight(dock.classList.contains("peek") ? half : dockSnapHeights().peek);
                return;
            }
            foldDockPanel(panel, !panel.classList.contains("folded"));
            reframeSelectedRoute();
        };
        dock.querySelectorAll(".dock-fold").forEach(button => button.addEventListener("click", (event) => {
            event.stopPropagation();
            toggleFold($(button.dataset.target));
        }));
        // The whole header is a big target: click it to fold / unfold (desktop) or open / lower the sheet (phone).
        panels.forEach(panel => panel.querySelector?.(".dock-head")?.addEventListener("click", (event) => {
            if (event.target?.closest?.("button")) return;
            if (dock.dataset.justDragged === "1") return;
            toggleFold(panel);
        }));
        dock.querySelectorAll(".dock-max").forEach(button => button.addEventListener("click", (event) => {
            event.stopPropagation();
            const panel = $(button.dataset.target);
            const other = panel === guide ? live : guide;
            if (!panel) return;
            const already = !panel.classList.contains("folded") && (!other || other.hidden || other.classList.contains("folded"));
            foldDockPanel(panel, false);
            if (other && !other.hidden) foldDockPanel(other, !already);
            reframeSelectedRoute();
        }));

        // Desktop: drag the handle between the panels to share the height. Squeezing a panel below its
        // header folds it (it snaps shut); pulling it open again unfolds it.
        const splitter = $("dockSplitter");
        if (splitter) {
            let dragging = false;
            const SNAP = 130;
            const move = (clientY) => {
                const box = dock.getBoundingClientRect();
                const top = Math.max(0, clientY - box.top);
                const bottom = Math.max(0, box.bottom - clientY - 18);
                foldDockPanel(guide, top < SNAP);
                foldDockPanel(live, bottom < SNAP && top >= SNAP);
                const share = Math.min(85, Math.max(15, (top / Math.max(1, box.height)) * 100));
                dock.style.setProperty("--split", `${share.toFixed(1)}%`);
            };
            splitter.addEventListener("pointerdown", (event) => {
                dragging = true;
                dock.classList.add("dragging");
                splitter.setPointerCapture?.(event.pointerId);
                event.preventDefault();
            });
            splitter.addEventListener("pointermove", (event) => { if (dragging) move(event.clientY); });
            const end = () => {
                if (!dragging) return;
                dragging = false;
                dock.classList.remove("dragging");
                if (!guide?.classList.contains("folded") && !live?.classList.contains("folded")) {
                    store.set("dockSplit", String(parseFloat(dock.style.getPropertyValue("--split")) || 50));
                }
                reframeSelectedRoute();
            };
            splitter.addEventListener("pointerup", end);
            splitter.addEventListener("pointercancel", end);
            splitter.addEventListener("dblclick", () => {
                foldDockPanel(guide, false);
                foldDockPanel(live, false);
                dock.style.setProperty("--split", "50%");
                store.set("dockSplit", "50");
            });
            splitter.addEventListener("keydown", (event) => {
                const now = parseFloat(dock.style.getPropertyValue("--split")) || 50;
                if (event.key === "ArrowUp") dock.style.setProperty("--split", `${Math.max(15, now - 5)}%`);
                if (event.key === "ArrowDown") dock.style.setProperty("--split", `${Math.min(85, now + 5)}%`);
            });
        }

        // Phone: pull the sheet up or down by its handle, the tabs or a panel's header; it follows the
        // finger and snaps to small / half / full height (a quick flick goes one size in that direction).
        // A tap on the handle steps through the sizes.
        let drag = null;
        dock.addEventListener("pointerdown", (event) => {
            if (!phoneLayout() || (event.button !== undefined && event.button > 0)) return;
            const zone = event.target?.closest?.(".dock-grip, .dock-tabs, .dock-head");
            if (!zone || event.target.closest(".dock-panel-actions")) return;
            drag = { y: event.clientY, t: Date.now(), start: dock.getBoundingClientRect().height, moved: false,
                     grip: !!event.target.closest(".dock-grip"), id: event.pointerId };
        });
        window.addEventListener?.("pointermove", (event) => {
            if (!drag || event.pointerId !== drag.id) return;
            const delta = drag.y - event.clientY;
            if (!drag.moved && Math.abs(delta) < 6) return;
            if (!drag.moved) {
                drag.moved = true;
                dock.classList.add("dragging");
            }
            event.preventDefault?.();
            const { peek, full } = dockSnapHeights();
            const height = Math.min(full, Math.max(peek - 30, drag.start + delta));
            dock.style.setProperty("--dock-h", `${Math.round(height)}px`);
            dock.classList.toggle("peek", height <= peek + 12);
            drag.last = { y: event.clientY, t: Date.now() };
        });
        const finish = (event) => {
            if (!drag || (event && event.pointerId !== drag.id)) return;
            const current = drag;
            drag = null;
            dock.classList.remove("dragging");
            const { peek, half, full } = dockSnapHeights();
            const height = dock.getBoundingClientRect().height;
            if (!current.moved) {
                if (current.grip) {
                    // tap on the handle: small -> half -> full -> small
                    setDockHeight(height < (peek + half) / 2 ? half : height < (half + full) / 2 ? full : peek);
                }
                return;
            }
            dock.dataset.justDragged = "1";
            setTimeout(() => { delete dock.dataset.justDragged; }, 350);
            const sizes = [peek, half, full];
            const elapsed = Math.max(1, Date.now() - current.t);
            const speed = (current.y - (current.last?.y ?? current.y)) / elapsed;   // px per ms, + = upwards
            let target;
            if (Math.abs(speed) > 0.6) {
                target = speed > 0 ? sizes.find(size => size > height + 8) ?? full
                                   : [...sizes].reverse().find(size => size < height - 8) ?? peek;
            } else {
                target = sizes.reduce((best, size) => Math.abs(size - height) < Math.abs(best - height) ? size : best);
            }
            setDockHeight(target);
            refreshSoon();
        };
        window.addEventListener?.("pointerup", finish);
        window.addEventListener?.("pointercancel", finish);
        // After a drag the finger lifts over a tab or header: that is not a click.
        dock.addEventListener("click", (event) => {
            if (dock.dataset.justDragged === "1") { event.stopPropagation(); event.preventDefault(); }
        }, true);
    }

    function setupRouteGrip() {
        const grip = $("routeGrip");
        if (!grip?.addEventListener) return;
        let drag = null;
        const standardHeight = () => {
            routePanel.classList.add("resizing");
            const saved = routePanel.style.getPropertyValue("--rp-h");
            const wasExpanded = routePanel.classList.contains("expanded");
            routePanel.style.removeProperty("--rp-h");
            routePanel.classList.remove("expanded");
            const height = routePanel.getBoundingClientRect().height;
            if (wasExpanded) routePanel.classList.add("expanded");
            if (saved) routePanel.style.setProperty("--rp-h", saved);
            return height;
        };
        grip.addEventListener("pointerdown", (event) => {
            if (event.button !== undefined && event.button !== 0) return;
            const start = routePanel.getBoundingClientRect().height;
            drag = {y: event.clientY, start, standard: standardHeight(), moved: false,
                max: Math.max(220, window.innerHeight - 120)};
            routePanel.classList.add("resizing");
            grip.setPointerCapture?.(event.pointerId);
        });
        grip.addEventListener("pointermove", (event) => {
            if (!drag) return;
            const delta = drag.y - event.clientY;
            if (Math.abs(delta) > 4) drag.moved = true;
            if (!drag.moved) return;
            if (routePanel.classList.contains("collapsed")) routePanel.classList.remove("collapsed");
            const height = Math.min(drag.max, Math.max(90, drag.start + delta));
            routePanel.style.setProperty("--rp-h", `${Math.round(height)}px`);
        });
        const finish = () => {
            if (!drag) return;
            const {moved, standard, max} = drag;
            const height = routePanel.getBoundingClientRect().height;
            drag = null;
            // Let the snap animate from wherever the finger/mouse let go.
            requestAnimationFrame(() => {
                routePanel.classList.remove("resizing");
                if (!moved) {
                    if (routePanel.classList.contains("collapsed")) setRoutesCollapsed(false);
                    else setRoutesExpanded(!routePanel.classList.contains("expanded"));
                } else if (height < Math.min(170, standard * 0.6)) {
                    routePanel.style.removeProperty("--rp-h");
                    setRoutesCollapsed(true);
                } else {
                    setRoutesExpanded(height > (standard + max) / 2);
                }
            });
        };
        // Keyboard activation (Enter/Space) arrives as a click with no pointer drag.
        grip.addEventListener("click", (event) => {
            if (event.detail !== 0) return;
            if (routePanel.classList.contains("collapsed")) setRoutesCollapsed(false);
            else setRoutesExpanded(!routePanel.classList.contains("expanded"));
        });
        grip.addEventListener("pointerup", finish);
        grip.addEventListener("pointercancel", finish);
        grip.addEventListener("keydown", (event) => {
            if (event.key === "ArrowUp") { event.preventDefault(); setRoutesExpanded(true); }
            if (event.key === "ArrowDown") {
                event.preventDefault();
                if (routePanel.classList.contains("expanded")) setRoutesExpanded(false); else setRoutesCollapsed(true);
            }
        });
    }

    function cancelMapPick() {
        state.pickPointType = null;
        if (state.map?.getCanvas) state.map.getCanvas().style.cursor = "";
        $("originMapBtn")?.classList.remove("picking");
        $("destinationMapBtn")?.classList.remove("picking");
        showStatus("Map selection cancelled.");
    }

    function setupEvents() {
        $("liveJourneyStart")?.addEventListener("click", () => {
            const live = state.liveBus;
            const route = live.journeys?.[live.journeyIndex];
            if (route && state.journey.active && state.journey.route === route) stopJourneyTracking();
            else if (route) startJourney(route, state.selectedRouteIndex);
        });
        $("liveBusFollow")?.addEventListener("click", () => {
            state.liveBus.selectedBusId = null;
            $("liveBusFollow").hidden = true;
            $("liveBusList").querySelectorAll(".following").forEach(row => row.classList.remove("following"));
        });
        $("liveBusFit")?.addEventListener("click", () => {
            const coordinates = state.liveBus.markers.map(entry => entry.marker.getLngLat().toArray());
            if (coordinates.length === 1) state.map.easeTo({center: coordinates[0], zoom: 15, duration: 650});
            else if (coordinates.length) {
                const bounds = new maplibregl.LngLatBounds();
                coordinates.forEach(point => bounds.extend(point));
                state.map.fitBounds(bounds, {padding: mapPadding(), maxZoom: 15, duration: 650});
            }
        });
        $("guideStop")?.addEventListener("click", stopJourneyTracking);
        $("guideOptions")?.addEventListener("click", () => {
            showRoutePanel();
        });
        $("liveBusStop")?.addEventListener("click", stopLiveBusTracking);
        $("liveBusMeta")?.addEventListener("click", () => $("liveBusMeta").classList.toggle("open"));
        $("liveBusRefresh")?.addEventListener("click", () => {
            if (state.liveBus.route) refreshLiveBuses(state.liveBus.session, true);
        });
        $("guidePrev")?.addEventListener("click", () => goToGuideStep(-1));
        $("guideNext")?.addEventListener("click", () => goToGuideStep(1));
        $("departInput")?.addEventListener("change", (event) => setDepartAt(event.target.value));
        $("departNow")?.addEventListener("click", () => { if (state.departAt) setDepartAt(""); });
        $("systemBannerRetry")?.addEventListener("click", () => checkHealth());
        $("systemBannerClose")?.addEventListener("click", hideBanner);
        document.addEventListener("keydown", (event) => {
            if (event.key === "Escape" && state.pickPointType) cancelMapPick();
        });
        setupJourneyMode();
        $("guideFollow")?.addEventListener("click", () => {
            state.journey.follow = true;
            if (state.journey.lastPosition) updateJourneyProgress(state.journey.lastPosition);
            else fitCoordinates(routeCoordinates(state.journey.route), 650);
            renderJourneyGuide();
        });
        state.map?.on("dragstart", event => {
            if (event.originalEvent && state.journey.active) {
                state.journey.follow = false;
                renderJourneyGuide();
            }
        });
        setInterval(() => { if (state.journey.active) renderJourneyGuide(); }, 10000);
        $("closeNetworkBtn")?.addEventListener("click", () => { $("networkPanel").hidden = true; });
        $("networkBtn")?.addEventListener("click", async () => {
            $("networkPanel").hidden = false;
            $("networkResults").textContent = "Loading scheduled network…";
            try {
                const response = await fetch("/api/network", { signal: AbortSignal.timeout(15000) });
                if (!response.ok) throw new Error("Network information unavailable");
                const data = await response.json();
                $("networkResults").innerHTML = `<div class="network-totals">${Object.entries(data.totals).map(([name, count]) => `<div><strong>${Number(count).toLocaleString()}</strong>${escapeHtml(name)}</div>`).join("")}</div><p>${escapeHtml(data.basis)}</p><h3>Most connected stops in the dataset</h3><ul>${data.interchanges.map(hub => `<li>${escapeHtml(hub.stop_name)} · ${Number(hub.route_count)} routes</li>`).join("")}</ul><p>${escapeHtml(data.optimization)}</p><p>${escapeHtml(data.tracking_status)}</p>`;
            } catch (error) { $("networkResults").textContent = error.message; }
        });
        ["origin", "destination"].forEach(type => {
            $(`${type}MapBtn`)?.addEventListener("click", () => {
                if (state.pickPointType === type) return cancelMapPick();
                state.pickPointType = type;
                state.map?.getCanvas().style.setProperty("cursor", "crosshair");
                $("originMapBtn")?.classList.toggle("picking", type === "origin");
                $("destinationMapBtn")?.classList.toggle("picking", type === "destination");
                showStatus(`Click the map to select your ${type === "origin" ? "starting point" : "destination"}. Press Esc or tap the button again to cancel.`);
            });
        });
        setupSearch(originInput, originSuggestions, "origin");
        setupSearch(destinationInput, destinationSuggestions, "destination");

        planBtn.addEventListener("click", planJourney);
        $("swapBtn")?.addEventListener("click", swapEndpoints);

        $("floatingAiBtn")?.addEventListener("click", openChat);
        $("closeChatBtn")?.addEventListener("click", closeChat);
        $("newJourneyBtn")?.addEventListener("click", resetJourney);
        $("closeRoutesBtn")?.addEventListener("click", () => setRoutesCollapsed(!routePanel.classList.contains("collapsed")));
        $("showPanelsBtn")?.addEventListener("click", exitMapFocus);
        setupSideDock();
        document.addEventListener?.("keydown", (event) => { if (event.key === "Escape") exitMapFocus(); });
        $("explainBtn")?.addEventListener("click", (event) => {
            event.stopPropagation();
            explainOptions();
        });
        $("expandRoutesBtn")?.addEventListener("click", (event) => {
            event.stopPropagation();
            setRoutesExpanded(!routePanel.classList.contains("expanded"));
        });
        setupRouteGrip();
        // Standard size scrolls sideways only: let a normal mouse wheel move the row of cards.
        routeResults?.addEventListener?.("wheel", (event) => {
            if (routePanel.classList.contains("expanded") || Math.abs(event.deltaX) > Math.abs(event.deltaY)) return;
            if (routeResults.scrollWidth <= routeResults.clientWidth + 1) return;
            event.preventDefault();
            routeResults.scrollLeft += event.deltaY;
        }, {passive: false});
        // After the panel finishes growing or shrinking, frame the route in whatever map is left.
        routePanel?.addEventListener?.("transitionend", (event) => {
            if (event.target === routePanel && event.propertyName === "height" && !routePanel.classList.contains("expanded")) reframeSelectedRoute();
        });
        routePanel.querySelector?.(".route-panel-header")?.addEventListener("click", (event) => {
            if (routePanel.classList.contains("collapsed") && !event.target.closest("#closeRoutesBtn")) setRoutesCollapsed(false);
        });
        $("locateBtn")?.addEventListener("click", locateUser);

        $("chatSendBtn")?.addEventListener("click", () => {
            const input = $("chatInput");
            if (!input.value.trim()) return;
            if (state.chatBusy) {
                showStatus("Still working on your last request. Your new one is kept in the box.", true);
                return;
            }
            const text = input.value;
            input.value = "";
            runAssistantCommand(text);
        });

        $("chatInput")?.addEventListener("keydown", (event) => {
            if (event.key === "Enter") {
                event.preventDefault();
                $("chatSendBtn")?.click();
            }
        });

        $("aiInput")?.addEventListener("keydown", (event) => {
            if (event.key === "Enter") {
                event.preventDefault();
                const text = event.target.value;
                if (!text.trim() || state.chatBusy) {
                    if (state.chatBusy) showStatus("Still working on your last request. Press Enter again in a moment.", true);
                    return;   // keep what was typed
                }
                event.target.value = "";
                runAssistantCommand(text, { fromMainBar: true });
            }
        });

        document.addEventListener("click", (event) => {
            if (!event.target.closest(".search-field")) {
                originSuggestions.classList.remove("visible");
                destinationSuggestions.classList.remove("visible");
            }
        });

        setupVoice($("voiceBtn"), $("aiInput"));
        setupVoice($("chatVoiceBtn"), $("chatInput"));
        setupPreferences();
        setupLayers();

        window.addEventListener("resize", () => state.map?.resize());
        // Positions shown from before the tab was hidden are old: refresh as soon as the page is visible again.
        document.addEventListener("visibilitychange", () => {
            if (!document.hidden && state.liveBus.route) refreshLiveBuses(state.liveBus.session);
        });
    }

    // =====================================================================================
    // Everyday features: saved places & recent trips, get-off alerts, leave reminders,
    // "missed it?" re-planning, trip sharing, language, installable app.
    // Everything here keeps the app's rule: timetable times are labelled as timetable times, and a
    // live statement is made only from BMTC's own live data.
    // =====================================================================================

    // ---- Language ----
    function tr(text, vars) {
        let out = String(text);
        if (state.lang === "kn") out = translateKn(out);
        if (vars) Object.keys(vars).forEach(key => { out = out.split(`{${key}}`).join(String(vars[key] ?? "")); });
        return out;
    }

    // Kannada: exact phrase, else a sentence pattern ("Leave {time} (in {n} min)"), else each " · " part.
    // Names and numbers captured by a pattern are kept as they are.
    let knPatterns = null;
    function translateKn(text) {
        const pack = (typeof window !== "undefined" && window.BT_I18N) || {};
        const table = pack.kn || {};
        if (Object.prototype.hasOwnProperty.call(table, text)) return table[text];
        if (!knPatterns) {
            knPatterns = (pack.knPatterns || []).map(([source, replacement]) => {
                try { return [new RegExp(`^${source}$`), replacement]; } catch { return null; }
            }).filter(Boolean);
        }
        for (const [pattern, replacement] of knPatterns) {
            if (pattern.test(text)) return text.replace(pattern, replacement);
        }
        const lead = /^(· |• )/.exec(text);
        if (lead) {
            const rest = translateKn(text.slice(lead[0].length));
            if (rest !== text.slice(lead[0].length)) return lead[0] + rest;
        }
        if (text.includes(" · ")) {
            const parts = text.split(" · ");
            const translated = parts.map(part => translateKn(part));
            if (translated.some((part, i) => part !== parts[i])) return translated.join(" · ");
        }
        const sentences = text.split(/(?<=[.!?…])\s+(?=["“(✓⚠A-Z0-9])/);
        if (sentences.length > 1) {
            const translated = sentences.map(part => translateKn(part));
            if (translated.some((part, i) => part !== sentences[i])) return translated.join(" ");
        }
        if (state.debugUntranslated && /[A-Za-z]{3,}/.test(text) && !/[\u0C80-\u0CFF]/.test(text) && text.length < 400) {
            state.debugUntranslated.add(text);
        }
        return text;
    }

    // In Kannada mode every new or changed piece of interface text is translated where it appears.
    // Typed text, the traveller's own chat messages and anything marked data-no-translate are left alone.
    const knOriginals = new WeakMap();
    const SKIP_TRANSLATE = "script,style,textarea,input,[data-no-translate],.chat-message.user,.maplibregl-ctrl-attrib";
    function translateTextNode(node) {
        if (!node || node.nodeType !== 3) return;
        const parent = node.parentElement;
        if (!parent || parent.closest?.(SKIP_TRANSLATE)) return;
        const original = knOriginals.has(node) && knOriginals.get(node).shown === node.data ? knOriginals.get(node).source : node.data;
        const match = /^(\s*)([\s\S]*?)(\s*)$/.exec(original);
        if (!match[2] || !/[A-Za-z]/.test(match[2])) return;
        let translated = match[2];
        if (state.lang === "kn") {
            translated = translateKn(match[2]);
            if (translated === match[2] && /\s{2,}|\n/.test(match[2])) {
                const flat = translateKn(match[2].replace(/\s+/g, " "));
                if (flat !== match[2].replace(/\s+/g, " ")) translated = flat;
            }
        }
        const shown = match[1] + translated + match[3];
        if (shown !== node.data) node.data = shown;
        if (translated !== match[2]) knOriginals.set(node, { source: original, shown });
    }

    function translateTree(root) {
        if (!root || typeof document === "undefined" || !document.createTreeWalker) return;
        if (root.nodeType === 3) { translateTextNode(root); return; }
        const walker = document.createTreeWalker(root, 4);
        const nodes = [];
        while (walker.nextNode()) nodes.push(walker.currentNode);
        nodes.forEach(translateTextNode);
    }

    function restoreEnglish() {
        if (typeof document === "undefined" || !document.createTreeWalker) return;
        const walker = document.createTreeWalker(document.body, 4);
        while (walker.nextNode()) {
            const node = walker.currentNode, saved = knOriginals.get(node);
            if (saved && saved.shown === node.data) { node.data = saved.source; knOriginals.delete(node); }
        }
    }

    function setupPageTranslation() {
        if (typeof MutationObserver !== "function" || typeof document === "undefined" || !document.body) return;
        if (/[?&]debug\b/.test(location.search || "")) state.debugUntranslated = new Set();
        let busy = false;
        const observer = new MutationObserver(records => {
            if (state.lang !== "kn" || busy) return;
            busy = true;
            try {
                records.forEach(record => {
                    if (record.type === "characterData") translateTextNode(record.target);
                    else record.addedNodes.forEach(node => translateTree(node));
                });
            } finally { busy = false; }
        });
        observer.observe(document.body, { childList: true, subtree: true, characterData: true });
        state.translationObserver = observer;
    }

    function applyLanguage(lang) {
        state.lang = lang === "kn" ? "kn" : "en";
        store.set("bt.lang", state.lang);
        if (typeof document === "undefined" || !document.querySelectorAll) return;
        try { document.documentElement.lang = state.lang; } catch { /* ignore */ }
        document.querySelectorAll("[data-i18n]").forEach(el => {
            if (el.dataset.i18nEn === undefined) el.dataset.i18nEn = el.textContent.trim();
            el.textContent = tr(el.dataset.i18nEn);
        });
        document.querySelectorAll("[data-i18n-ph]").forEach(el => {
            if (el.dataset.i18nPhEn === undefined) el.dataset.i18nPhEn = el.getAttribute("placeholder") || "";
            el.setAttribute("placeholder", tr(el.dataset.i18nPhEn));
        });
        document.querySelectorAll("[data-i18n-title]").forEach(el => {
            if (el.dataset.i18nTitleEn === undefined) el.dataset.i18nTitleEn = el.getAttribute("title") || "";
            el.setAttribute("title", tr(el.dataset.i18nTitleEn));
            el.setAttribute("aria-label", tr(el.dataset.i18nTitleEn));
        });
        (state.voices || []).forEach(recognition => { recognition.lang = state.lang === "kn" ? "kn-IN" : "en-IN"; });
        stepCache = new WeakMap();          // step texts are built in the chosen language
        syncAlertToggle();
        renderPlaceChips();
        state.usualShown = "";
        renderUsualCard();
        if (state.journey.active) renderJourneyGuide();
        if (state.lang === "kn") translateTree(document.body); else restoreEnglish();
    }

    // ---- Small, failure-proof browser storage (per device; never required for the app to work) ----
    const store = {
        get(key, fallback) {
            try { const raw = window.localStorage?.getItem(key); return raw ? JSON.parse(raw) : fallback; } catch { return fallback; }
        },
        set(key, value) {
            try { window.localStorage?.setItem(key, JSON.stringify(value)); return true; } catch { return false; }
        },
        remove(key) { try { window.localStorage?.removeItem(key); } catch { /* ignore */ } }
    };
    const SAVED_KEY = "bt.saved.v1", RECENT_KEY = "bt.recent.v1", REMINDER_KEY = "bt.reminder.v1";
    const inBengaluru = (lat, lon) => lat >= 12.65 && lat <= 13.45 && lon >= 77.20 && lon <= 78.00;

    function placeRecord(stop) {
        const lat = Number(stop?.lat ?? stop?.stop_lat), lon = Number(stop?.lon ?? stop?.stop_lon);
        const name = String(stop?.name ?? stop?.stop_name ?? "").trim().slice(0, 120);
        if (!name || !Number.isFinite(lat) || !Number.isFinite(lon) || !inBengaluru(lat, lon)) return null;
        const id = String(stop?.id ?? stop?.stop_id ?? "");
        const point = !!stop?.is_map_point || !id || id.startsWith("point-");
        return { id: point ? "" : id, name, lat, lon, is_map_point: point };
    }

    function savedPlaces() {
        const list = store.get(SAVED_KEY, []);
        return Array.isArray(list) ? list.filter(item => item && item.label && placeRecord(item)).slice(0, 12) : [];
    }

    function savePlace(label, stop) {
        const record = placeRecord(stop);
        const clean = String(label || "").trim().slice(0, 40);
        if (!record || !clean) return false;
        const others = savedPlaces().filter(item => item.label.toLowerCase() !== clean.toLowerCase());
        store.set(SAVED_KEY, [{ label: clean, ...record }, ...others].slice(0, 12));
        renderPlaceChips();
        return true;
    }

    function removeSavedPlace(label) {
        store.set(SAVED_KEY, savedPlaces().filter(item => item.label !== label));
        renderPlaceChips();
    }

    function recentTrips() {
        const list = store.get(RECENT_KEY, []);
        return Array.isArray(list) ? list.filter(trip => trip && placeRecord(trip.from) && placeRecord(trip.to)).slice(0, 6) : [];
    }

    function rememberTrip(origin, destination) {
        const from = placeRecord(origin), to = placeRecord(destination);
        if (!from || !to) return;
        const same = (a, b) => a.name === b.name && Math.abs(a.lat - b.lat) < 1e-4 && Math.abs(a.lon - b.lon) < 1e-4;
        // A point from GPS ("My location ±20 m") changes every time: keep it out of the list.
        if (/^My location/.test(from.name) || /^My location/.test(to.name)) return;
        const rest = recentTrips().filter(trip => !(same(trip.from, from) && same(trip.to, to)));
        store.set(RECENT_KEY, [{ from, to, at: Date.now() }, ...rest].slice(0, 6));
        renderPlaceChips();
    }

    function savedForAssistant() {
        return savedPlaces().map(item => ({ label: item.label, id: item.is_map_point ? "" : item.id, name: item.name,
            lat: item.lat, lon: item.lon, is_map_point: item.is_map_point }));
    }

    const placeIcon = label => /^home$/i.test(label) ? "🏠" : /^work$/i.test(label) ? "💼" : "⭐";

    function setEndpoint(kind, record) {
        const stop = normalizeStop({ ...record, id: record.id || `point-${kind}`, is_map_point: record.is_map_point });
        if (!stop) return null;
        invalidateJourney();
        state[kind] = stop;
        (kind === "origin" ? originInput : destinationInput).value = stop.name;
        updateMarker(kind, stop);
        return stop;
    }

    function goToSavedPlace(item) {
        if (!setEndpoint("destination", item)) return;
        if (state.origin) { planJourney(); return; }
        // No start yet: like "take me home", start from where the traveller is.
        startFromMyLocation({ set textContent(text) { showStatus(text); } });
    }

    function renderPlaceChips() {
        const box = typeof document !== "undefined" ? $("placeChips") : null;
        if (!box) return;
        const saved = savedPlaces();
        const recent = recentTrips();
        const canSave = !!(placeRecord(state.origin) || placeRecord(state.destination));
        const chips = [`<button type="button" class="place-chip nearby" data-menu-nearby="1">📍 ${escapeHtml(tr("Nearby stops"))}</button>`];
        chips.push(...saved.map((item, index) =>
            `<button type="button" class="place-chip" data-saved="${index}" title="${escapeHtml(tr("Go to {name}", { name: item.name }))}">${placeIcon(item.label)} ${escapeHtml(tr(item.label))}</button>`));
        if (recent.length) chips.push(`<button type="button" class="place-chip" data-menu="recent">🕘 ${escapeHtml(tr("Recent"))}</button>`);
        if (canSave) chips.push(`<button type="button" class="place-chip save" data-menu="save">☆ ${escapeHtml(tr("Save place"))}</button>`);
        if (!saved.length && !recent.length && !canSave) chips.push(`<span class="place-hint">${escapeHtml(tr("Save Home and Work for one-tap trips."))}</span>`);
        box.innerHTML = chips.join("");
        box.hidden = false;
    }

    function closeQuickMenu() {
        const menu = $("quickMenu");
        if (menu) { menu.hidden = true; menu.innerHTML = ""; }
    }

    function openQuickMenu(kind, anchor) {
        const menu = $("quickMenu");
        if (!menu) return;
        let html = "";
        if (kind === "recent") {
            html = `<div class="qm-title">${escapeHtml(tr("Recent trips"))}</div>` + recentTrips().map((trip, index) =>
                `<button type="button" class="qm-item" data-recent="${index}">${escapeHtml(trip.from.name)} → ${escapeHtml(trip.to.name)}</button>`).join("") +
                `<button type="button" class="qm-item subtle" data-clear-recent="1">${escapeHtml(tr("Clear recent trips"))}</button>`;
        } else if (kind === "save") {
            const rows = [["origin", state.origin], ["destination", state.destination]].filter(([, stop]) => placeRecord(stop));
            html = `<div class="qm-title">${escapeHtml(tr("Save a place on this device"))}</div>` + rows.map(([which, stop]) =>
                `<div class="qm-row"><span>${escapeHtml(stop.name)}</span><span class="qm-actions">` +
                ["Home", "Work"].map(label => `<button type="button" data-save="${which}" data-label="${label}">${placeIcon(label)} ${escapeHtml(tr(label))}</button>`).join("") +
                `<button type="button" data-save="${which}" data-label="">⭐ ${escapeHtml(tr("Favourite"))}</button></span></div>`).join("") +
                `<p class="qm-note">${escapeHtml(tr("Saved only in this browser. Say \"take me home\" to the assistant once Home is saved."))}</p>`;
        } else if (kind === "more") {
            const saved = savedPlaces();
            html = `<div class="qm-title">${escapeHtml(tr("Language"))}</div>` +
                `<div class="qm-row"><span class="qm-actions"><button type="button" data-lang="en" aria-pressed="${state.lang !== "kn"}">English</button><button type="button" data-lang="kn" aria-pressed="${state.lang === "kn"}">ಕನ್ನಡ</button></span></div>` +
                (state.installPrompt ? `<button type="button" class="qm-item" data-install="1">📲 ${escapeHtml(tr("Install as an app"))}</button>` : "") +
                `<div class="qm-title">${escapeHtml(tr("Talk mode"))}</div>` +
                `<div class="qm-row"><span>${escapeHtml(tr("Speak answers and guidance aloud"))}</span><span class="qm-actions"><button type="button" data-talk="1" aria-pressed="${!!state.talk}">${escapeHtml(state.talk ? tr("On") : tr("Off"))}</button></span></div>` +
                `<div class="qm-title">${escapeHtml(tr("Saved places"))}</div>` +
                (saved.length ? saved.map(item => `<div class="qm-row"><span>${placeIcon(item.label)} ${escapeHtml(tr(item.label))} · ${escapeHtml(item.name)}</span><span class="qm-actions"><button type="button" data-remove="${escapeHtml(item.label)}" aria-label="${escapeHtml(tr("Remove {label}", { label: item.label }))}">✕</button></span></div>`).join("")
                    : `<p class="qm-note">${escapeHtml(tr("None yet. Choose a place in From or To, then tap ☆ Save place."))}</p>`) +
                (tripHistory().length ? `<button type="button" class="qm-item subtle" data-forget="1">${escapeHtml(tr("Forget my trip history (usual trips)"))}</button>` : "") +
                `<div class="qm-title">${escapeHtml(tr("Travel preference"))}</div><p class="qm-note">${escapeHtml(tr("Choose Less walking, Fewer transfers or Fastest below Find routes."))}</p>`;
        }
        menu.innerHTML = html;
        menu.hidden = false;
        menu.dataset.kind = kind;
        try {
            const box = anchor?.getBoundingClientRect?.();
            if (box && kind === "more") { menu.style.top = `${Math.round(box.bottom + 8)}px`; menu.style.right = "16px"; menu.style.left = "auto"; }
            else if (box) { menu.style.top = `${Math.round(box.bottom + 6)}px`; menu.style.left = `${Math.round(Math.max(8, Math.min(box.left, (window.innerWidth || 400) - 330)))}px`; menu.style.right = "auto"; }
        } catch { /* positioning is cosmetic */ }
    }

    function setupPlaces() {
        const box = $("placeChips"), menu = $("quickMenu");
        box?.addEventListener("click", (event) => {
            const chip = event.target?.closest?.("button");
            if (!chip) return;
            if (chip.dataset.menuNearby) { closeQuickMenu(); showNearbyStops(); }
            else if (chip.dataset.saved !== undefined) { closeQuickMenu(); goToSavedPlace(savedPlaces()[Number(chip.dataset.saved)]); }
            else if (chip.dataset.menu) {
                if (!menu.hidden && menu.dataset.kind === chip.dataset.menu) closeQuickMenu(); else openQuickMenu(chip.dataset.menu, chip);
            }
        });
        menu?.addEventListener("click", (event) => {
            const button = event.target?.closest?.("button");
            if (!button) return;
            event.stopPropagation();
            if (button.dataset.recent !== undefined) {
                const trip = recentTrips()[Number(button.dataset.recent)];
                closeQuickMenu();
                if (trip && setEndpoint("origin", trip.from) && setEndpoint("destination", trip.to)) planJourney();
            } else if (button.dataset.clearRecent) {
                store.set(RECENT_KEY, []); closeQuickMenu(); renderPlaceChips();
            } else if (button.dataset.save) {
                const stop = state[button.dataset.save];
                const label = button.dataset.label || String(stop?.name || "").replace(/\s*\(±.*$/, "").slice(0, 24);
                if (savePlace(label, stop)) showStatus(tr("Saved {name} as {label}.", { name: stop.name, label: tr(label) }));
                closeQuickMenu();
            } else if (button.dataset.remove) {
                removeSavedPlace(button.dataset.remove);
                openQuickMenu("more", $("profileBtn"));
            } else if (button.dataset.talk) {
                setTalkMode(!state.talk);
                openQuickMenu("more", $("profileBtn"));
            } else if (button.dataset.forget) {
                store.set(HISTORY_KEY, []);
                renderUsualCard();
                showStatus(tr("Trip history cleared on this device."));
                openQuickMenu("more", $("profileBtn"));
            } else if (button.dataset.lang) {
                applyLanguage(button.dataset.lang);
                openQuickMenu("more", $("profileBtn"));
            } else if (button.dataset.install && state.installPrompt) {
                const prompt = state.installPrompt;
                state.installPrompt = null;
                closeQuickMenu();
                prompt.prompt?.();
            }
        });
        document.addEventListener?.("click", (event) => {
            if (!menu || menu.hidden) return;
            if (event.target?.closest?.("#quickMenu, #placeChips, #profileBtn")) return;
            closeQuickMenu();
        });
        document.addEventListener?.("keydown", (event) => { if (event.key === "Escape") closeQuickMenu(); });
        renderPlaceChips();
    }

    // ---- Alerts (vibration, system notification when allowed, and an on-screen banner) ----
    async function askNotificationPermission() {
        try {
            if (typeof Notification !== "undefined" && Notification.permission === "default") await Notification.requestPermission();
        } catch { /* some browsers only allow it from a click; the banner still works */ }
    }

    function notify(title, body, { urgent = false, tag = "bt" } = {}) {
        try { navigator.vibrate?.(urgent ? [600, 200, 600, 200, 600] : [300, 150, 300]); } catch { /* not supported */ }
        try {
            if (typeof Notification !== "undefined" && Notification.permission === "granted" && document.hidden !== false) {
                const options = { body, tag, renotify: true, icon: "/static/icons/icon-192.png" };
                if (navigator.serviceWorker?.ready) navigator.serviceWorker.ready.then(reg => reg.showNotification(title, options)).catch(() => new Notification(title, options));
                else new Notification(title, options);
            }
        } catch { /* the banner below is enough */ }
    }

    // ---- Get-off alert: one stop before the alighting stop, and again at it ----
    // Pure: decides from the planned stop list and a GPS fix. Weak or old fixes never trigger it.
    function alightAlert(route, stepIndex, position, now = Date.now()) {
        const step = guideSteps(route)[stepIndex];
        if (!step || step.kind !== "ride" || !position?.coords) return null;
        const accuracy = Number(position.coords.accuracy);
        if (!(accuracy <= 120) || now - Number(position.timestamp) > 45000) return null;
        const leg = step.leg || {};
        const target = leg.to || {};
        const tlat = Number(target.lat), tlon = Number(target.lon);
        if (!Number.isFinite(tlat) || !Number.isFinite(tlon)) return null;
        const here = [Number(position.coords.longitude), Number(position.coords.latitude)];
        const toTarget = haversineMeters(here, [tlon, tlat]);
        const base = { stop: target.name || "your stop", legIndex: step.legIndex, meters: Math.round(toTarget) };
        if (toTarget <= Math.max(120, accuracy)) return { ...base, level: "now" };
        const stops = (Array.isArray(leg.stops) ? leg.stops : []).filter(s => Number.isFinite(Number(s.lat)) && Number.isFinite(Number(s.lon)));
        if (stops.length >= 3) {
            let best = -1, bestDistance = Infinity;
            stops.forEach((s, i) => {
                const d = haversineMeters(here, [Number(s.lon), Number(s.lat)]);
                if (d < bestDistance) { best = i; bestDistance = d; }
            });
            // At (or just past) the stop before yours, and actually on the bus's line.
            if (best >= stops.length - 2 && bestDistance <= Math.max(350, accuracy * 2)) return { ...base, level: "soon" };
            return null;
        }
        return toTarget <= 700 ? { ...base, level: "soon" } : null;
    }

    // ---- Transfer guardian ----
    // While riding a bus that has a change after it: how late is this bus running (from GPS against the stop
    // times, else its usual measured delay), when will the next bus be at the change stop (BMTC live estimate,
    // else its usual delay, else the timetable), and is there still time? Pure; null without evidence.
    function stopClock(leg, hhmm) {
        const base = new Date(leg?.departure_iso || "");
        const match = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || ""));
        if (!match || !Number.isFinite(base.getTime())) return NaN;
        const ist = new Date(base.getTime() + 330 * 60000);                    // Bengaluru wall clock
        const dayStart = Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate()) - 330 * 60000;
        let at = dayStart + (Number(match[1]) * 60 + Number(match[2])) * 60000;
        if (at < base.getTime() - 6 * 3600000) at += 86400000;                // a ride past midnight
        return at;
    }

    function transferGuardian(route, stepIndex, position, now = Date.now(), buses = [], tracked = null) {
        if (state.journey?.preview && state.journey.route === route) return null;   // simulated position: no lateness claims
        const steps = guideSteps(route);
        const step = steps[stepIndex];
        if (!step || step.kind !== "ride") return null;
        const legs = route?.legs || [];
        const leg = step.leg || legs[step.legIndex];
        const nextIndex = legs.findIndex((item, index) => index > step.legIndex && item?.transit);
        if (!leg || nextIndex < 0) return null;
        const next = legs[nextIndex];
        const plannedArrive = Date.parse(leg.arrival_iso || "");
        const plannedLeave = Date.parse(next.departure_iso || "");
        if (!Number.isFinite(plannedArrive) || !Number.isFinite(plannedLeave)) return null;
        const walk = legs.slice(step.legIndex + 1, nextIndex).reduce((sum, item) => sum + (Number(item?.duration_minutes) || 0), 0);

        // 1. How late is this bus?
        let late = null, lateFrom = "";
        const fix = position?.coords;
        if (fix && Number(fix.accuracy) <= 100 && now - Number(position.timestamp) <= 60000) {
            const here = [Number(fix.longitude), Number(fix.latitude)];
            let best = null;
            (leg.stops || []).forEach(stop => {
                const lat = Number(stop.lat), lon = Number(stop.lon);
                if (!Number.isFinite(lat) || !Number.isFinite(lon) || !stop.time) return;
                const meters = haversineMeters(here, [lon, lat]);
                if (meters <= 250 && (!best || meters < best.meters)) best = { meters, stop };
            });
            const at = best ? stopClock(leg, best.stop.time) : NaN;
            if (Number.isFinite(at)) { late = Math.max(-3, Math.round((now - at) / 60000)); lateFrom = "gps"; }
        }
        if (late === null && Number.isFinite(Number(leg.arrival_reliability?.typical_delay_minutes))) {
            late = Math.max(0, Math.round(Number(leg.arrival_reliability.typical_delay_minutes)));
            lateFrom = "usual";
        }

        // 2. When is the next bus at the change stop? Any line BMTC runs over the same stretch will do.
        const lines = new Set([next.route_name, ...(next.also_served_by || [])].map(name => String(name || "").split(" ")[0].toUpperCase()));
        const sameStop = !tracked || String(tracked.name || "").trim().toLowerCase() === String(next.from?.name || "").trim().toLowerCase();
        let due = null, dueFrom = "", dueLine = next.route_name;
        if (sameStop) {
            const ready = plannedArrive + ((late || 0) + walk) * 60000;
            const live = (buses || []).filter(bus => bus?.relevance === "approaching" && bus.group !== "alternate" &&
                    lines.has(String(bus.route || "").split(" ")[0].toUpperCase()) && boardEtaMinutes(bus, now) !== null)
                .map(bus => ({ bus, at: parseBmtcTime(bus.board_eta)?.getTime() }))
                .filter(item => Number.isFinite(item.at) && Math.abs(item.at - plannedLeave) <= 90 * 60000)
                .sort((a, b) => a.at - b.at);
            const catchable = live.find(item => item.at >= ready) || live[live.length - 1];
            if (catchable) { due = catchable.at; dueFrom = "live"; dueLine = catchable.bus.route; }
        }
        if (due === null && Number.isFinite(Number(next.reliability?.typical_delay_minutes))) {
            due = plannedLeave + Math.max(0, Number(next.reliability.typical_delay_minutes)) * 60000;
            dueFrom = "usual";
        }
        if (due === null) { due = plannedLeave; dueFrom = "timetable"; }
        if (late === null && dueFrom !== "live") return null;          // nothing measured: no claim either way

        const arriveAt = plannedArrive + (late || 0) * 60000;
        const spare = Math.round((due - arriveAt) / 60000 - walk);
        const level = spare < 0 ? "miss" : spare < 3 ? "tight" : "ok";
        const clock = ms => new Date(ms).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Kolkata" });
        return { level, spare, late, lateFrom, dueFrom, line: dueLine, plannedLine: next.route_name, stop: next.from?.name || leg.to?.name || "",
                 getOff: leg.to?.name || "", arrive: clock(arriveAt), due: clock(due), walk, legIndex: step.legIndex,
                 replan: leg.to_stop_id && Number.isFinite(Number(leg.to?.lat))
                     ? { stop: { id: String(leg.to_stop_id), name: leg.to.name, lat: Number(leg.to.lat), lon: Number(leg.to.lon) }, at: clock(arriveAt) }
                     : null };
    }

    function guardianText(guard) {
        const how = guard.lateFrom === "gps" ? tr("from your GPS") : guard.lateFrom === "usual" ? tr("its usual delay") : tr("on time");
        const source = guard.dueFrom === "live" ? tr("BMTC live estimate") : guard.dueFrom === "usual" ? tr("its usual delay") : tr("timetable");
        const vars = { line: guard.line, stop: guard.stop, arrive: guard.arrive, due: guard.due, n: Math.abs(guard.spare), how, source,
                       late: delayWords(guard.late || 0) };
        if (guard.level === "miss") return tr("⚠ You may miss the {line} at {stop}: you reach it about {arrive} ({late}, {how}) and it is due at {due} ({source}).", vars);
        if (guard.level === "tight") return tr("⏱ Tight change at {stop}: about {n} min to reach the {line} (due {due}, {source}).", vars);
        return tr("✓ Change at {stop} looks fine: about {n} min to spare for the {line} (due {due}, {source}).", vars);
    }

    function replanFromTransfer(guard) {
        if (!guard?.replan) return;
        setEndpoint("origin", guard.replan.stop);
        setDepartAt(guard.replan.at, { replan: false });
        showStatus(tr("Finding other ways from {stop} at about {time}…", { stop: guard.replan.stop.name, time: guard.replan.at }));
        planJourney();
    }

    function checkTransferGuardian() {
        const journey = state.journey;
        const box = $("guideTransfer");
        if (!journey.active || !box) return;
        const live = state.liveBus || {};
        const guard = transferGuardian(journey.route, journey.stepIndex, journey.lastPosition, Date.now(),
            live.lastShown || [], live.boardingStop || null);
        if (!guard) { box.hidden = true; box.textContent = ""; return; }
        const text = guardianText(guard);
        box.className = `guide-transfer ${guard.level}`;
        box.hidden = false;
        if (box.btText !== text) {
            box.innerHTML = `<span>${escapeHtml(text)}</span>` + (guard.level !== "ok" && guard.replan
                ? `<button type="button" class="guide-transfer-replan">${escapeHtml(tr("Find another way from {stop}", { stop: guard.getOff }))}</button>` : "");
            box.querySelector?.(".guide-transfer-replan")?.addEventListener("click", () => replanFromTransfer(guard));
            box.btText = text;
        }
        // Say it once per change when it turns into a likely miss.
        journey.guarded = journey.guarded || new Set();
        const key = `${guard.legIndex}:${guard.level}`;
        if (guard.level === "miss" && !journey.guarded.has(key)) {
            journey.guarded.add(key);
            showGuideBanner(text, "warn", guard.replan ? { label: tr("Find another way from {stop}", { stop: guard.getOff }), run: () => replanFromTransfer(guard) } : null);
        }
    }

    function checkAlightAlert() {
        const journey = state.journey;
        if (!journey.active || !journey.alertsOn) return;
        const alert = alightAlert(journey.route, journey.stepIndex, journey.lastPosition);
        if (!alert) return;
        journey.alerted = journey.alerted || new Set();
        const key = `${alert.legIndex}:${alert.level}`;
        if (journey.alerted.has(key)) return;
        journey.alerted.add(key);
        if (alert.level === "now") journey.alerted.add(`${alert.legIndex}:soon`);
        const text = alert.level === "now"
            ? tr("Get off here: {stop}.", { stop: alert.stop })
            : tr("Get ready: {stop} is next. Get off there.", { stop: alert.stop });
        showGuideBanner(text, alert.level === "now" ? "urgent" : "info");
        bannerData().key = `alight:${key}`;
        announce(`alight:${key}`, text, alert.level === "now");
        if (!journey.preview) notify(alert.level === "now" ? tr("Your stop") : tr("Next stop is yours"), text, { urgent: alert.level === "now", tag: "bt-alight" });
    }

    function bannerData() {
        const banner = $("guideAlert");
        if (!banner) return {};
        if (!banner.dataset) banner.dataset = {};
        return banner.dataset;
    }

    function hideGuideBanner(forget = false) {
        const banner = $("guideAlert");
        if (!banner) return;
        banner.hidden = true;
        if ($("navAlert")) $("navAlert").hidden = true;
        bannerData().key = "";
        if (forget) bannerData().dismissed = "";
    }

    function showGuideBanner(text, kind = "info", action = null) {
        const banner = $("guideAlert");
        if (!banner) return;
        banner.className = `guide-alert ${kind}`;
        banner.innerHTML = `<span>${escapeHtml(text)}</span>` +
            (action ? `<button type="button" class="guide-alert-action">${escapeHtml(action.label)}</button>` : "") +
            `<button type="button" class="guide-alert-close" aria-label="${escapeHtml(tr("Dismiss"))}">✕</button>`;
        banner.hidden = false;
        speak(text, { urgent: kind !== "info" || /Get ready|ಸಿದ್ಧರಾಗಿ/.test(text) });
        // An alert must be seen: open the journey panel at its top (on a phone: its tab, and lift the sheet).
        const guide = $("journeyGuide");
        if (guide?.classList?.contains("folded")) foldDockPanel(guide, false);
        if (guide) guide.scrollTop = 0;
        if (phoneLayout()) {
            setDockTab("guide");
            if ($("sideDock")?.classList?.contains("peek")) setDockHeight(dockSnapHeights().half);
        }
        banner.querySelector?.(".guide-alert-action")?.addEventListener("click", action?.run || (() => {}));
        showNavAlert(text, kind, action);
        banner.querySelector?.(".guide-alert-close")?.addEventListener("click", () => { banner.hidden = true; bannerData().dismissed = bannerData().key || ""; });
    }

    function syncAlertToggle() {
        const button = $("guideAlertToggle");
        if (!button) return;
        button.textContent = state.journey.alertsOn ? tr("🔔 Stop alerts on") : tr("🔕 Stop alerts off");
        button.setAttribute("aria-pressed", String(!!state.journey.alertsOn));
    }

    // ---- Missed it? ----
    // Pure: the bus the traveller is about to board is past its timetable time by more than the grace
    // period, and BMTC's live data (when we have it) does not show one of those buses coming soon.
    const MISSED_GRACE_MINUTES = 5;
    function missedBusCheck(route, stepIndex, now = Date.now(), comingWithin = null) {
        const steps = guideSteps(route);
        const step = steps[stepIndex];
        if (!step || !(step.kind === "board" || step.kind === "walk")) return null;
        const legs = route?.legs || [];
        const leg = step.kind === "board" ? step.leg : legs.slice(step.legIndex + 1).find(l => l.transit);
        if (!leg || leg.role === "metro") return null;
        const due = Date.parse(leg.departure_iso || "");
        if (!Number.isFinite(due)) return null;
        const minutesLate = Math.floor((now - due) / 60000);
        if (minutesLate < MISSED_GRACE_MINUTES) return null;
        if (Number.isFinite(comingWithin) && comingWithin <= 15) return null;   // BMTC shows one coming: not missed
        return { leg, line: leg.route_name, stop: leg.from?.name || "the stop", scheduled: leg.departure_time,
                 minutesLate, liveKnown: comingWithin === "none" };
    }

    // Minutes until the soonest bus of these lines that BMTC shows heading to the boarding stop, from
    // the last live check (only when it is recent). "none" = checked, nothing coming; null = unknown.
    function liveComingWithin(lines) {
        const live = state.liveBus;
        if (!live.lastShown || !live.lastCheckedAt || Date.now() - live.lastCheckedAt > 180000) return null;
        const wanted = new Set((lines || []).map(name => String(name || "").toUpperCase().split(" ")[0]));
        let soonest = null;
        live.lastShown.forEach(bus => {
            if (bus.group === "alternate" || bus.relevance !== "approaching") return;
            if (!wanted.has(String(bus.route || "").toUpperCase().split(" ")[0])) return;
            const minutes = boardEtaMinutes(bus);
            if (minutes !== null && (soonest === null || minutes < soonest)) soonest = minutes;
        });
        return soonest === null ? "none" : soonest;
    }

    function checkMissedBus() {
        const journey = state.journey;
        if (!journey.active || journey.preview) return;
        const step = guideSteps(journey.route)[journey.stepIndex];
        const leg = step?.kind === "board" ? step.leg : (journey.route?.legs || []).slice((step?.legIndex ?? 0) + 1).find(l => l.transit);
        const lines = leg ? [leg.route_name, ...(leg.also_served_by || [])] : [];
        const missed = missedBusCheck(journey.route, journey.stepIndex, Date.now(), liveComingWithin(lines));
        const banner = $("guideAlert");
        const data = bannerData();
        if (!missed) {
            if (banner && String(data.key || "").startsWith("missed")) hideGuideBanner();
            return;
        }
        const key = `missed:${missed.line}:${missed.scheduled}`;
        if (banner && (data.dismissed === key || (data.key === key && !banner.hidden))) return;
        const text = missed.liveKnown
            ? tr("Missed it? The {time} {line} from {stop} was due {min} min ago, and BMTC shows none of these buses coming soon.", { time: missed.scheduled, line: missed.line, stop: missed.stop, min: missed.minutesLate })
            : tr("Missed it? The {time} {line} from {stop} was due {min} min ago. If it has not come, look at the next options.", { time: missed.scheduled, line: missed.line, stop: missed.stop, min: missed.minutesLate });
        showGuideBanner(text, "warn", { label: tr("Show next options"), run: () => replanAfterMissed(missed) });
        bannerData().key = key;
    }

    // New plan from the boarding stop (or from the traveller's GPS position when it is reliable and
    // away from that stop) to the same destination, leaving now.
    function replanAfterMissed(missed) {
        const journey = state.journey;
        const from = missed?.leg?.from;
        const position = journey.lastPosition;
        let start = null;
        if (position && position.coords.accuracy <= 60 && Date.now() - position.timestamp < 60000 && from &&
            haversineMeters([position.coords.longitude, position.coords.latitude], [Number(from.lon), Number(from.lat)]) > 300) {
            start = { id: "point-origin", is_map_point: true, name: tr("My location"), lat: position.coords.latitude, lon: position.coords.longitude };
        } else if (from) {
            const id = missed.leg.from_stop_id;
            start = { id: id || "point-origin", is_map_point: !id, name: from.name, lat: Number(from.lat), lon: Number(from.lon) };
        }
        stopJourneyTracking();
        if (state.departAt) setDepartAt("", { replan: false });
        if (start) setEndpoint("origin", start);
        showStatus(tr("Finding the next options from {stop}…", { stop: start?.name || tr("your start") }));
        planJourney();
    }

    // ---- Leave-now reminder ----
    // Pure: when to remind for a journey. The journey's start time (= when to start walking) comes
    // from the timetable; a reminder is set a few minutes before it.
    function leaveSchedule(route, now = Date.now(), before = 5) {
        const leaveAt = Date.parse(route?.departure_iso || "");
        if (!Number.isFinite(leaveAt)) return null;
        const firstBus = (route.legs || []).find(leg => leg.transit) || null;
        return { leaveAt, remindAt: Math.max(now, leaveAt - before * 60000), minutesUntil: Math.round((leaveAt - now) / 60000),
                 possible: leaveAt - now > 60000, firstBus };
    }

    function reminderSummary(route) {
        const firstBus = (route.legs || []).find(leg => leg.transit);
        return {
            leaveAt: Date.parse(route.departure_iso || ""), leaveText: route.departure_time,
            line: firstBus?.route_name || "", lines: firstBus ? [firstBus.route_name, ...(firstBus.also_served_by || [])].slice(0, 4) : [],
            stop: firstBus?.from?.name || "", stopLat: Number(firstBus?.from?.lat), stopLon: Number(firstBus?.from?.lon),
            busTime: firstBus?.departure_time || "", metro: firstBus?.role === "metro",
            title: `${state.origin?.name || ""} → ${state.destination?.name || ""}`
        };
    }

    function clearReminder({ silent = false } = {}) {
        (state.reminder?.timers || []).forEach(timer => clearTimeout(timer));
        state.reminder = null;
        store.remove(REMINDER_KEY);
        renderReminderPill();
        if (!silent) showStatus(tr("Reminder cancelled."));
    }

    function armReminder(info) {
        (state.reminder?.timers || []).forEach(timer => clearTimeout(timer));
        const now = Date.now();
        if (!Number.isFinite(info.leaveAt) || info.leaveAt < now - 60000) { clearReminder({ silent: true }); return; }
        const timers = [];
        const before = Math.max(0, info.leaveAt - 5 * 60000 - now);
        timers.push(setTimeout(() => fireReminder(info, false), before));
        timers.push(setTimeout(() => fireReminder(info, true), Math.max(0, info.leaveAt - now)));
        timers.push(setTimeout(() => clearReminder({ silent: true }), Math.max(0, info.leaveAt - now) + 10 * 60000));
        state.reminder = { info, timers };
        store.set(REMINDER_KEY, info);
        renderReminderPill();
    }

    async function liveLineForReminder(info) {
        // Only a statement BMTC's live data supports; otherwise nothing.
        if (info.metro || !info.line || !Number.isFinite(info.stopLat)) return "";
        try {
            const query = new URLSearchParams({ q: info.line, stop_lat: String(info.stopLat), stop_lon: String(info.stopLon) });
            const response = await fetch(`/api/bmtc/route?${query}`, { cache: "no-store" });
            const data = await response.json();
            const coming = (data.vehicles || []).filter(bus => bus.relevance === "approaching")
                .map(bus => boardEtaMinutes(bus)).filter(minutes => minutes !== null).sort((a, b) => a - b);
            return coming.length ? tr(" BMTC live: a {line} is about {min} min from {stop}.", { line: info.line, min: coming[0], stop: info.stop }) : "";
        } catch { return ""; }
    }

    async function fireReminder(info, final) {
        const live = await liveLineForReminder(info);
        const body = final
            ? tr("Time to leave for {line} at {stop} (timetable {time}).", { line: info.line || tr("your journey"), stop: info.stop || tr("your stop"), time: info.busTime || info.leaveText }) + live
            : tr("Leave in about 5 min for {line} at {stop} (timetable {time}).", { line: info.line || tr("your journey"), stop: info.stop || tr("your stop"), time: info.busTime || info.leaveText }) + live;
        notify(final ? tr("Time to leave") : tr("Leave soon"), body, { urgent: final, tag: "bt-leave" });
        speak(body, { urgent: true });
        showStatus(body);
        renderReminderPill(body);
    }

    function setReminderFor(route) {
        const plan = leaveSchedule(route);
        if (!plan?.possible) { showStatus(tr("This journey starts now, so there is nothing to remind you about."), true); return; }
        askNotificationPermission();
        armReminder(reminderSummary(route));
        const at = new Date(Math.max(Date.now(), plan.leaveAt - 5 * 60000)).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
        showStatus(tr("Reminder set for {time}. Keep this page open (phones may pause background pages).", { time: at }));
    }

    function renderReminderPill(latest = "") {
        const pill = typeof document !== "undefined" ? $("reminderPill") : null;
        if (!pill) return;
        const info = state.reminder?.info;
        if (!info) { pill.hidden = true; pill.innerHTML = ""; return; }
        const when = new Date(info.leaveAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
        pill.innerHTML = `<span>🔔 ${escapeHtml(latest || tr("Leave by {time} for {line}", { time: when, line: info.line || tr("your journey") }))}</span><button type="button" aria-label="${escapeHtml(tr("Cancel reminder"))}">✕</button>`;
        pill.hidden = false;
        pill.querySelector("button")?.addEventListener("click", () => clearReminder());
    }

    function restoreReminder() {
        const info = store.get(REMINDER_KEY, null);
        if (info && Number.isFinite(info.leaveAt) && info.leaveAt > Date.now() - 60000) armReminder(info);
        else store.remove(REMINDER_KEY);
    }

    // ---- Share my trip ----
    const SHARE_PREFS = ["fastest", "less_walking", "fewer_transfers", "safer_connections"];
    function shareUrl(origin, destination, { departAt = "", preference = "", bus = "", base = "" } = {}) {
        const from = placeRecord(origin), to = placeRecord(destination);
        if (!from || !to) return "";
        const params = new URLSearchParams();
        const put = (key, place) => {
            params.set(key, `${place.lat.toFixed(6)},${place.lon.toFixed(6)}`);
            params.set(`${key}Name`, place.name);
            if (!place.is_map_point && place.id) params.set(`${key}Id`, place.id);
        };
        put("from", from);
        put("to", to);
        if (/^\d{2}:\d{2}$/.test(departAt || "")) params.set("at", departAt);
        if (preference && preference !== "fastest" && SHARE_PREFS.includes(preference)) params.set("pref", preference);
        if (bus) params.set("bus", String(bus).slice(0, 30));
        return `${base || (typeof location !== "undefined" ? location.origin : "")}/?${params.toString()}`;
    }

    // Pure: read a shared link. Anything malformed is ignored, never guessed.
    function parseShareParams(search) {
        let params;
        try { params = new URLSearchParams(search); } catch { return null; }
        const read = (key) => {
            const match = String(params.get(key) || "").match(/^(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)$/);
            if (!match) return null;
            const lat = Number(match[1]), lon = Number(match[2]);
            const name = String(params.get(`${key}Name`) || "").trim().slice(0, 120);
            if (!inBengaluru(lat, lon) || !name) return null;
            const id = String(params.get(`${key}Id`) || "").trim().slice(0, 80);
            return { id: id || `point-${key === "from" ? "origin" : "destination"}`, name, lat, lon, is_map_point: !id };
        };
        const origin = read("from"), destination = read("to");
        if (!origin || !destination) return null;
        const at = String(params.get("at") || "");
        const pref = String(params.get("pref") || "");
        const bus = String(params.get("bus") || "").trim();
        return { origin, destination, departAt: /^([01]\d|2[0-3]):[0-5]\d$/.test(at) ? at : "",
                 preference: SHARE_PREFS.includes(pref) ? pref : "", bus: /^[A-Za-z0-9][A-Za-z0-9 .-]{0,29}$/.test(bus) ? bus : "" };
    }

    function shareText(route) {
        const numbers = (route?.route_numbers || []).join(" → ");
        return tr("My trip: {from} → {to}. {lines}, leave {leave}, arrive {arrive} (BMTC timetable, not live).", {
            from: state.origin?.name || "", to: state.destination?.name || "", lines: numbers || tr("Bus"),
            leave: route?.departure_time || "—", arrive: route?.arrival_time || "—" });
    }

    async function shareTrip(route, { bus = "" } = {}) {
        const url = shareUrl(state.origin, state.destination, { departAt: state.departAt, preference: state.selectedPreference, bus });
        if (!url) { showStatus(tr("Choose a start and destination first."), true); return; }
        const text = shareText(route);
        try {
            if (navigator.share) { await navigator.share({ title: tr("Bengaluru bus trip"), text, url }); return; }
        } catch (error) { if (error?.name === "AbortError") return; }
        try {
            await navigator.clipboard.writeText(`${text}\n${url}`);
            showStatus(tr("Trip link copied. Paste it in a message."));
        } catch {
            const menu = $("quickMenu");
            if (menu) {
                menu.innerHTML = `<div class="qm-title">${escapeHtml(tr("Copy this link"))}</div><textarea class="qm-link" readonly rows="3">${escapeHtml(url)}</textarea>`;
                menu.hidden = false; menu.dataset.kind = "share";
                menu.querySelector("textarea")?.select?.();
            }
        }
    }

    async function openSharedTrip() {
        if (typeof location === "undefined") return;
        const shared = parseShareParams(location.search);
        if (!shared) return;
        setEndpoint("origin", shared.origin);
        setEndpoint("destination", shared.destination);
        if (shared.preference) { state.selectedPreference = shared.preference; syncPreferenceChips(); }
        if (shared.departAt) setDepartAt(shared.departAt, { replan: false });
        showStatus(tr("Opening a shared trip…"));
        await planJourney();
        if (shared.bus) {
            const base = name => String(name || "").toUpperCase().split(" ")[0];
            const route = normalizeRoutes(state.lastPlan).find(r => (r.legs || []).some(l => l.transit && base(l.route_name) === base(shared.bus)));
            const leg = route?.legs.find(l => l.transit && base(l.route_name) === base(shared.bus));
            if (leg) trackSearchBuses([leg.route_name], [route], false, placeOf(leg.from, "boarding stop"), placeOf(leg.to, "alighting stop"), []);
        }
    }


    // ---- Talk-only mode: spoken answers and guidance, tap-to-talk ----
    const speech = () => (typeof window !== "undefined" && window.speechSynthesis) || null;

    function pickVoice(lang) {
        const synth = speech();
        const voices = synth?.getVoices?.() || [];
        const prefix = lang === "kn" ? "kn" : "en";
        return voices.find(v => v.lang?.toLowerCase().startsWith(`${prefix}-in`)) ||
            voices.find(v => v.lang?.toLowerCase().startsWith(prefix)) || null;
    }

    function hasKannadaVoice() { return !!pickVoice("kn")?.lang?.toLowerCase().startsWith("kn"); }

    // Text to speak: no emoji, no "(BMTC estimate)" style brackets noise is kept short.
    function speakableText(text) {
        return String(text || "").replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, " ")
            .replace(/[→⇄]/g, state.lang === "kn" ? " ನಿಂದ " : " to ").replace(/\s+/g, " ").trim().slice(0, 600);
    }

    function speak(text, { urgent = false } = {}) {
        const synth = speech();
        const words = speakableText(text);
        if (!state.talk || !synth || !words || typeof SpeechSynthesisUtterance === "undefined") return false;
        try {
            if (urgent) synth.cancel();
            const utterance = new SpeechSynthesisUtterance(words);
            const voice = pickVoice(state.lang);
            utterance.lang = state.lang === "kn" ? "kn-IN" : "en-IN";
            if (voice) utterance.voice = voice;
            utterance.rate = 0.98;
            synth.speak(utterance);
            return true;
        } catch { return false; }
    }

    function stopSpeaking() { try { speech()?.cancel(); } catch { /* nothing to stop */ } }

    function chatText(item) {
        if (!item) return "";
        const parts = [...(item.childNodes || [])].filter(node => node.nodeType === 3).map(node => node.textContent);
        return (parts.length ? parts.join(" ") : item.textContent || "").trim();
    }

    function speakChatAnswer(item) { if (state.talk) speak(chatText(item), { urgent: true }); }

    function setTalkMode(on, { announce = true } = {}) {
        state.talk = !!on;
        store.set("bt.talk", state.talk);
        document.body?.classList?.toggle("talk-mode", state.talk);
        const button = $("talkBtn");
        if (button) button.hidden = !state.talk;
        if (!state.talk) { stopSpeaking(); return; }
        if (announce) {
            speak(tr("Talk mode is on. Tap the big microphone and say where you want to go, or ask where your bus is."), { urgent: true });
            if (state.lang === "kn" && !hasKannadaVoice()) {
                showStatus(tr("This device has no Kannada voice. Install one in your phone's text-to-speech settings; until then answers may be read in English."), true);
            }
        }
    }

    // Speak each new guidance step once, in the chosen language.
    function speakGuideStep() {
        const journey = state.journey;
        if (!state.talk || !journey.active) return;
        const key = `${journey.session}:${journey.stepIndex}`;
        if (journey.spokenStep === key) return;
        journey.spokenStep = key;
        const step = guideSteps(journey.route)[journey.stepIndex];
        if (step) speak(`${step.title}. ${String(step.detail || "").split(/(?<=\.)\s/)[0]}`);
    }

    // ---- Snap & go ----
    // Shrink the photo in the browser (faster upload, less data); only the picture goes to the server.
    function shrinkPhoto(file, maxSide = 1280, quality = 0.82) {
        return new Promise((resolve, reject) => {
            if (!file || !/^image\//.test(file.type || "")) { reject(new Error(tr("Choose a photo."))); return; }
            const url = URL.createObjectURL(file);
            const image = new Image();
            image.onload = () => {
                try {
                    const scale = Math.min(1, maxSide / Math.max(image.naturalWidth, image.naturalHeight));
                    const canvas = document.createElement("canvas");
                    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
                    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
                    canvas.getContext("2d").drawImage(image, 0, 0, canvas.width, canvas.height);
                    const data = canvas.toDataURL("image/jpeg", quality);
                    URL.revokeObjectURL(url);
                    resolve(data.slice(data.indexOf(",") + 1));
                } catch (error) { URL.revokeObjectURL(url); reject(error); }
            };
            image.onerror = () => { URL.revokeObjectURL(url); reject(new Error(tr("That file could not be opened as a photo."))); };
            image.src = url;
        });
    }

    async function snapAndGo(file) {
        if (state.chatBusy) { showStatus(tr("Still working on your last request."), true); return; }
        let image;
        try { image = await shrinkPhoto(file); }
        catch (error) { showStatus(error.message || tr("That file could not be opened as a photo."), true); return; }
        if (!chatPanel.classList.contains("open")) openChat();
        await runAssistantCommand("photo", { endpoint: "/api/snap", extra: { image, mime: "image/jpeg" },
            label: tr("📷 Photo sent (bus, stop board or address)"), fromMainBar: true });
    }

    function setupSnap() {
        const input = $("snapInput");
        $("snapBtn")?.addEventListener("click", () => input?.click());
        $("chatSnapBtn")?.addEventListener("click", () => input?.click());
        $("quickSnapBtn")?.addEventListener("click", () => input?.click());
        // Phone top-bar 🎙: open the chat and listen there, so the reply is visible above the routes.
        $("quickVoiceBtn")?.addEventListener("click", () => {
            openChat();
            const voice = $("chatVoiceBtn");
            if (voice && voice.style.display !== "none" && !state.isListening) voice.click();
        });
        input?.addEventListener("change", () => {
            const file = input.files?.[0];
            input.value = "";
            if (file) snapAndGo(file);
        });
    }

    // ---- My usual commute (learned on this device only) ----
    const HISTORY_KEY = "bt.trips.v1";
    const tripKey = (from, to) => `${from.name}|${from.lat.toFixed(3)},${from.lon.toFixed(3)}>${to.name}|${to.lat.toFixed(3)},${to.lon.toFixed(3)}`;
    const istParts = (ms) => {
        const shifted = new Date(ms + 330 * 60000);            // Bengaluru time, whatever the device clock zone
        return { day: shifted.toISOString().slice(0, 10), minute: shifted.getUTCHours() * 60 + shifted.getUTCMinutes(),
                 weekend: [0, 6].includes(shifted.getUTCDay()) };
    };

    function tripHistory() {
        const list = store.get(HISTORY_KEY, []);
        return Array.isArray(list) ? list.filter(item => item && placeRecord(item.from) && placeRecord(item.to) && Number.isFinite(item.at)) : [];
    }

    function logTrip(origin, destination, { line = "", board = null, started = false, at = Date.now() } = {}) {
        const from = placeRecord(origin), to = placeRecord(destination);
        if (!from || !to || /^My location/.test(from.name) || /^My location/.test(to.name)) return;
        const list = tripHistory();
        // One entry per trip per half hour (re-plans and the Start press count once; Start adds the bus).
        const recent = list.find(item => tripKey(item.from, item.to) === tripKey(from, to) && Math.abs(item.at - at) < 30 * 60000);
        if (recent) {
            if (started) { recent.started = true; recent.line = line || recent.line; recent.board = board || recent.board; }
        } else {
            list.push({ from, to, at, line, board, started });
        }
        store.set(HISTORY_KEY, list.slice(-200));
    }

    // Pure: the trip this traveller usually makes around now (weekday/weekend kept apart), or null.
    // Needs the same trip on at least 3 different days at about the same time.
    function usualTrip(history, now = Date.now()) {
        const here = istParts(now);
        const groups = new Map();
        (history || []).forEach(item => {
            if (!placeRecord(item?.from) || !placeRecord(item?.to) || !Number.isFinite(item.at)) return;
            const when = istParts(item.at);
            if (when.weekend !== here.weekend) return;
            const key = tripKey(item.from, item.to);
            if (!groups.has(key)) groups.set(key, []);
            groups.get(key).push({ ...item, when });
        });
        let best = null;
        groups.forEach((items, key) => {
            // The busiest one-hour window of this trip (a morning habit is not moved by one evening trip).
            let near = [];
            items.forEach(centre => {
                const around = items.filter(item => Math.abs(item.when.minute - centre.when.minute) <= 60);
                if (new Set(around.map(item => item.when.day)).size > new Set(near.map(item => item.when.day)).size) near = around;
            });
            const minutes = near.map(item => item.when.minute).sort((a, b) => a - b);
            const middle = minutes.length % 2 ? minutes[(minutes.length - 1) / 2]
                : Math.round((minutes[minutes.length / 2 - 1] + minutes[minutes.length / 2]) / 2);
            near = near.sort((a, b) => a.at - b.at);
            const days = new Set(near.map(item => item.when.day));
            if (days.size < 3) return;
            if (here.minute < middle - 60 || here.minute > middle + 20) return;
            const lines = {};
            near.filter(item => item.line).forEach(item => { lines[item.line] = (lines[item.line] || 0) + (item.started ? 2 : 1); });
            const line = Object.keys(lines).sort((a, b) => lines[b] - lines[a])[0] || "";
            const board = near.filter(item => item.line === line && item.board).slice(-1)[0]?.board || null;
            const latest = near[near.length - 1];
            const candidate = { key, from: latest.from, to: latest.to, usualMinute: middle, days: days.size, line, board };
            if (!best || candidate.days > best.days) best = candidate;
        });
        return best;
    }

    function placeLabel(place) {
        const saved = savedPlaces().find(item => Math.abs(item.lat - place.lat) < 3e-4 && Math.abs(item.lon - place.lon) < 3e-4);
        return saved ? `${placeIcon(saved.label)} ${tr(saved.label)}` : place.name;
    }

    async function renderUsualCard() {
        const box = typeof document !== "undefined" ? $("usualCard") : null;
        if (!box) return;
        const usual = state.journey.active || state.lastPlan ? null : usualTrip(tripHistory());
        const today = istParts(Date.now()).day;
        if (!usual || store.get("bt.usual.dismissed", "") === `${today}|${usual.key}`) {
            box.hidden = true; box.innerHTML = ""; state.usualShown = ""; return;
        }
        const hh = String(Math.floor(usual.usualMinute / 60)).padStart(2, "0"), mm = String(usual.usualMinute % 60).padStart(2, "0");
        const head = `<div class="usual-head"><span class="usual-tag">🔁 ${escapeHtml(tr("Your usual trip"))}</span>` +
            `<button type="button" class="usual-go">${escapeHtml(tr("Plan this trip"))}</button>` +
            `<button type="button" class="usual-close" aria-label="${escapeHtml(tr("Not today"))}">✕</button></div>` +
            `<div class="usual-route">${escapeHtml(placeLabel(usual.from))} → ${escapeHtml(placeLabel(usual.to))}</div>` +
            `<div class="usual-meta">${escapeHtml(tr("You usually go around {time}.", { time: `${hh}:${mm}` }))}</div>`;
        const liveId = `usual-live-${usual.key.length}-${usual.usualMinute}`;
        box.innerHTML = head + `<div class="usual-live" id="${liveId}">${usual.line ? escapeHtml(tr("Checking BMTC for your usual {line}…", { line: usual.line })) : ""}</div>`;
        box.hidden = false;
        box.querySelector(".usual-close")?.addEventListener("click", () => { store.set("bt.usual.dismissed", `${today}|${usual.key}`); box.hidden = true; });
        box.querySelector(".usual-go")?.addEventListener("click", () => {
            box.hidden = true;
            if (setEndpoint("origin", usual.from) && setEndpoint("destination", usual.to)) planJourney();
        });
        if (state.usualShown === usual.key && state.usualLiveText) { $(liveId).textContent = state.usualLiveText; return; }
        state.usualShown = usual.key;
        state.usualLiveText = "";
        const text = await usualLiveText(usual);
        state.usualLiveText = text;
        const target = $(liveId);
        if (target) target.textContent = text;
    }

    // The next live bus for the usual line, only from BMTC's own data; otherwise it says so.
    async function usualLiveText(usual) {
        if (!usual.line || !usual.board || !Number.isFinite(Number(usual.board.lat))) return "";
        try {
            const query = new URLSearchParams({ q: usual.line, stop_lat: String(usual.board.lat), stop_lon: String(usual.board.lon) });
            const response = await fetch(`/api/bmtc/route?${query}`, { cache: "no-store" });
            const data = await response.json();
            if (!response.ok || !data.available) return tr("Live position for {line} is not available right now.", { line: usual.line });
            const coming = (data.vehicles || []).filter(bus => bus.relevance === "approaching")
                .map(bus => boardEtaMinutes(bus)).filter(minutes => minutes !== null).sort((a, b) => a - b);
            return coming.length
                ? tr("Next {line} at {stop}: about {min} min (BMTC live).", { line: usual.line, stop: usual.board.name || tr("your stop"), min: coming[0] })
                : tr("BMTC shows no {line} heading to {stop} right now.", { line: usual.line, stop: usual.board.name || tr("your stop") });
        } catch { return tr("Live position for {line} is not available right now.", { line: usual.line }); }
    }

    function setupTalkSnapUsual() {
        setupSnap();
        const talk = $("talkBtn");
        if (talk) setupVoice(talk, $("aiInput"), { fromMainBar: true });
        setTalkMode(store.get("bt.talk", false) === true, { announce: false });
        try { speech()?.getVoices?.(); speech()?.addEventListener?.("voiceschanged", () => {}); } catch { /* voices load later */ }
        renderUsualCard();
        setInterval(() => renderUsualCard(), 60000);
    }


    // ---- Smooth live buses ----
    // Pure: the points to glide through when a bus moves from one REPORTED position to the next.
    // Along its known road path when both positions lie on it (and the bus moved forward on it);
    // otherwise a straight line; a jump over MAX_GLIDE_METERS is not animated at all (the bus is
    // simply shown at its new position). Nothing is ever extrapolated beyond the last report.
    const MAX_GLIDE_METERS = 1500;
    function glidePath(from, to, roadPath) {
        if (!from || !to) return null;
        const distance = haversineMeters(from, to);
        if (!Number.isFinite(distance) || distance < 3 || distance > MAX_GLIDE_METERS) return null;
        const path = Array.isArray(roadPath) ? roadPath.filter(p => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1])) : [];
        if (path.length >= 2) {
            const nearest = (point) => {
                let best = { index: -1, meters: Infinity };
                path.forEach((p, index) => { const m = haversineMeters(point, p); if (m < best.meters) best = { index, meters: m }; });
                return best;
            };
            const a = nearest(from), b = nearest(to);
            if (a.meters <= 60 && b.meters <= 60 && b.index > a.index) {
                return [from, ...path.slice(a.index + 1, b.index + 1), to];
            }
        }
        return [from, to];
    }

    // Point a fraction t (0..1) of the way along a list of points, by distance.
    function pointAlong(points, t) {
        if (!points?.length) return null;
        if (points.length === 1 || t <= 0) return points[0];
        const lengths = points.slice(1).map((p, i) => haversineMeters(points[i], p));
        const total = lengths.reduce((a, b) => a + b, 0);
        if (!(total > 0) || t >= 1) return points[points.length - 1];
        let left = total * t;
        for (let i = 0; i < lengths.length; i++) {
            if (left <= lengths[i]) {
                const f = lengths[i] ? left / lengths[i] : 0;
                return [points[i][0] + (points[i + 1][0] - points[i][0]) * f, points[i][1] + (points[i + 1][1] - points[i][1]) * f];
            }
            left -= lengths[i];
        }
        return points[points.length - 1];
    }

    function glideMarker(marker, points, duration = 1600) {
        if (!marker) return;
        const reduce = typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;
        if (!points || points.length < 2 || reduce || typeof requestAnimationFrame !== "function") {
            if (points?.length) marker.setLngLat(points[points.length - 1]);
            return;
        }
        marker.__glide = (marker.__glide || 0) + 1;
        const token = marker.__glide, started = performance.now();
        const step = (now) => {
            if (marker.__glide !== token) return;                 // a newer report took over
            const t = Math.min(1, (now - started) / duration);
            const eased = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
            marker.setLngLat(pointAlong(points, eased));
            if (t < 1) requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
    }

    // Pure: how old a reported position is, as a short badge, and how faded the marker should be.
    function positionAge(reportedAt, now = Date.now()) {
        if (!Number.isFinite(reportedAt)) return { badge: "", level: "unknown" };
        const seconds = Math.max(0, Math.round((now - reportedAt) / 1000));
        const badge = seconds < 60 ? `${seconds}s` : seconds < 3600 ? `${Math.floor(seconds / 60)}m` : `${Math.floor(seconds / 3600)}h`;
        const level = seconds <= 90 ? "fresh" : seconds <= 300 ? "aging" : seconds <= 900 ? "old" : "very-old";
        return { badge, level };
    }

    function markReported(element, reportedAt) {
        if (!element) return;
        if (!element.dataset) element.dataset = {};
        element.dataset.reportedAt = String(reportedAt);
    }

    function refreshMarkerAges() {
        (state.liveBus.markers || []).forEach(entry => {
            const element = entry.marker?.getElement?.();
            if (!element) return;
            const age = positionAge(Number(element.dataset?.reportedAt));
            const badge = element.querySelector?.(".bus-age");
            if (badge) { badge.textContent = age.badge; badge.hidden = !age.badge; }
            ["aging", "old", "very-old"].forEach(name => element.classList?.toggle?.(`age-${name}`, age.level === name));
        });
    }


    // ---- Bus vs auto vs cab ----
    // Pure: the comparison row for one journey option. Bus fare from BMTC's fare tables (exact, or
    // "about" when estimated from BMTC's own fares for that distance); auto and cab from the official
    // tariffs with road time at Bengaluru's measured average traffic. Everything is labelled.
    // ---- Wait or walk ----
    // Pure: for one bus ride, is walking the same stretch about as quick? Walk = the bus's own road distance
    // (or 1.3 x straight line when the bus loops) at 75 m a minute; bus = wait (BMTC live estimate when given,
    // else the timetable) + ride. Only short stretches (walk up to 25 min) are considered.
    function waitOrWalk(leg, { now = null, liveAt = null } = {}) {
        if (!leg?.transit || leg.role === "metro") return null;
        const from = leg.from || {}, to = leg.to || {};
        const straight = [from.lat, from.lon, to.lat, to.lon].every(v => Number.isFinite(Number(v)))
            ? haversineMeters([Number(from.lon), Number(from.lat)], [Number(to.lon), Number(to.lat)]) : NaN;
        const road = Number(leg.distance_m);
        let meters = Number.isFinite(road) && road > 0 ? road : straight * 1.3;
        if (Number.isFinite(straight) && Number.isFinite(road) && road > straight * 1.8) meters = straight * 1.3;
        if (!Number.isFinite(meters) || meters <= 0) return null;
        const walk = Math.ceil(meters / 75);
        if (walk > 25) return null;
        const ride = Number(leg.duration_minutes);
        if (!Number.isFinite(ride)) return null;
        let wait = Number(leg.wait_before_minutes) || 0, source = "timetable";
        const planned = Date.parse(leg.departure_iso || "");
        if (Number.isFinite(liveAt) && Number.isFinite(now)) { wait = Math.max(0, Math.round((liveAt - now) / 60000)); source = "live"; }
        else if (Number.isFinite(now) && Number.isFinite(planned) && planned - now <= 45 * 60000 && planned - now >= -10 * 60000) {
            wait = Math.max(0, Math.round((planned - now) / 60000));     // standing at the stop now: the real wait
        }
        const bus = wait + ride;
        const verdict = walk <= bus - 2 ? "walk" : Math.abs(walk - bus) < 2 ? "either" : null;
        if (!verdict) return null;
        return { verdict, walk, bus, wait, ride, source, km: (meters / 1000).toFixed(1), line: leg.route_name || tr("the bus"),
                 fare: leg.fare?.amount ?? null, fareExact: !!leg.fare?.exact, to: to.name || "" };
    }

    function waitOrWalkText(advice) {
        if (!advice) return "";
        const saves = advice.fare != null ? tr(", and saves {fare}", { fare: `${advice.fareExact ? "" : "~"}₹${advice.fare}` }) : "";
        const vars = { walk: advice.walk, km: advice.km, bus: advice.bus, line: advice.line, to: advice.to, saves,
                       source: advice.source === "live" ? tr("BMTC live estimate") : tr("timetable") };
        return advice.verdict === "walk"
            ? tr("🚶 Walking to {to} may be quicker: about {walk} min on foot ({km} km) against about {bus} min waiting for and riding the {line} ({source}){saves}.", vars)
            : tr("🚶 Walking to {to} takes about as long: about {walk} min on foot ({km} km) against about {bus} min waiting for and riding the {line} ({source}){saves}.", vars);
    }

    function walkHintsHtml(route) {
        const hints = (route?.legs || []).map(leg => waitOrWalk(leg)).filter(Boolean).map(waitOrWalkText);
        return hints.length ? `<div class="walk-hints">${hints.map(text => `<p>${escapeHtml(text)}</p>`).join("")}</div>` : "";
    }

    function checkWaitOrWalk() {
        const journey = state.journey;
        const box = $("guideWalk");
        if (!journey.active || !box) return;
        const step = guideSteps(journey.route)[journey.stepIndex];
        const leg = step && (step.kind === "board" || (step.kind === "walk" && step.leg?.role !== "egress_walk"))
            ? (step.kind === "board" ? step.leg : (journey.route.legs || []).slice(step.legIndex + 1).find(item => item?.transit)) : null;
        let liveAt = null;
        const live = state.liveBus || {};
        if (leg && String(live.boardingStop?.name || "").toLowerCase() === String(leg.from?.name || "").toLowerCase()) {
            const lines = new Set([leg.route_name, ...(leg.also_served_by || [])].map(name => String(name || "").split(" ")[0].toUpperCase()));
            const soonest = (live.lastShown || []).filter(bus => bus?.relevance === "approaching" && lines.has(String(bus.route || "").split(" ")[0].toUpperCase())
                && boardEtaMinutes(bus) !== null).map(bus => parseBmtcTime(bus.board_eta)?.getTime()).filter(Number.isFinite).sort((a, b) => a - b)[0];
            if (Number.isFinite(soonest)) liveAt = soonest;
        }
        const text = leg ? waitOrWalkText(waitOrWalk(leg, { now: Date.now(), liveAt })) : "";
        box.hidden = !text;
        if (box.textContent !== text) box.textContent = text;
    }

    // ---- Rain-aware trips ----
    // Pure: what to say when rain is forecast during the trip, and which option keeps you dry longest.
    function rainAdvice(routes, rain) {
        if (!rain?.wet) return null;
        const options = (routes || []).map((route, index) => ({ route, index, walk: Number(route?.walking_minutes) }))
            .filter(item => item.route?.transit !== false && Number.isFinite(item.walk));
        const least = options.sort((a, b) => a.walk - b.walk || a.index - b.index)[0] || null;
        const text = tr("🌧 Rain likely around {hour} ({p}%, up to {mm} mm/h · Open-Meteo forecast).",
            { mm: rain.max_mm, hour: rain.wettest_hour, p: rain.max_probability });
        const tip = least ? tr("☂ Least walking: option {n} ({min} min on foot).", { n: least.index + 1, min: least.walk }) : "";
        return { text, tip, leastIndex: least ? least.index : null, leastWalk: least ? least.walk : null };
    }

    async function checkRainForTrip(routes, revision) {
        const starts = routes.map(route => Date.parse(route.departure_iso || "")).filter(Number.isFinite);
        const ends = routes.map(route => Date.parse(route.arrival_iso || "")).filter(Number.isFinite);
        const from = state.origin, to = state.destination;
        if (!starts.length || !ends.length || !from || !to) return;
        const start = Math.min(...starts), end = Math.min(Math.max(...ends), start + 6 * 3600000);
        const lat = (Number(from.lat) + Number(to.lat)) / 2, lon = (Number(from.lon) + Number(to.lon)) / 2;
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
        const iso = ms => new Date(ms).toISOString().replace("Z", "+00:00");
        let rain = null;
        try {
            const result = await fetchJson(`/api/weather?lat=${lat.toFixed(3)}&lon=${lon.toFixed(3)}&from=${encodeURIComponent(iso(start))}&to=${encodeURIComponent(iso(end))}`, {}, 8000);
            rain = result.ok ? result.data?.rain : null;
        } catch { return; }                         // no forecast: say nothing about rain
        if (revision !== state.journeyRevision) return;
        const advice = rainAdvice(routes, rain);
        state.rain = advice;
        if (!advice) return;
        const note = $("rainNote");
        if (!note) return;
        note.innerHTML = `<span class="rain-text">${escapeHtml(advice.text)}</span>${advice.tip ? ` <span class="rain-tip">${escapeHtml(advice.tip)}</span>` : ""}` +
            // The first option already walks least: nothing to switch to.
            (advice.leastIndex ? `<span class="rain-actions"><button type="button" class="rain-show">☂ ${escapeHtml(tr("Show that option"))}</button>` +
                (state.selectedPreference !== "less_walking" ? `<button type="button" class="rain-replan">🚶 ${escapeHtml(tr("Re-plan with less walking"))}</button>` : "") + `</span>` : "");
        note.hidden = false;
        note.title = `${advice.text} ${advice.tip}`.trim();
        note.querySelector(".rain-show")?.addEventListener("click", () => {
            const target = routeResults.querySelector(`.journey-route-card[data-route-index="${advice.leastIndex}"]`);
            if (target) { target.click(); target.scrollIntoView?.({ behavior: "smooth", block: "nearest", inline: "nearest" }); }
        });
        note.querySelector(".rain-replan")?.addEventListener("click", () => {
            state.selectedPreference = "less_walking";
            syncPreferenceChips();
            planJourney();
        });
        const least = advice.leastIndex ? routeResults.querySelector(`.journey-route-card[data-route-index="${advice.leastIndex}"] .route-subline`) : null;
        if (least && !least.querySelector(".rain-tag")) least.insertAdjacentHTML("beforeend", `<span class="rain-tag">☂ ${escapeHtml(tr("least walking"))}</span>`);
    }

    // ---- Honest arrival window ----
    // A range for when the journey really arrives, from BMTC's own measurements (server: transit/window.py),
    // optionally moved by BMTC's live estimate for the first bus. With no measurements, only the timetable
    // time is shown. Every line of "why" names where its numbers come from.
    function delayWords(minutes) {
        const n = Math.round(Number(minutes));
        if (!Number.isFinite(n)) return "";
        if (Math.abs(n) <= 1) return tr("on time");
        return n > 0 ? tr("{n} min late", { n }) : tr("{n} min early", { n: -n });
    }

    function clockAfter(iso, minutes = 0) {
        const time = new Date(iso).getTime();
        if (!Number.isFinite(time)) return "";
        return new Date(time + minutes * 60000).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Kolkata" });
    }

    function arrivalWindow(route, live = null) {
        const w = route?.arrival_window;
        if (!w || !w.scheduled_iso) return null;
        const period = w.period === "weekends" ? tr("weekends") : tr("weekdays");
        const why = [];
        const shift = live && Number.isFinite(Number(live.shift)) && Math.abs(Number(live.shift)) <= 90 ? Math.round(Number(live.shift)) : null;
        if (shift !== null) {
            why.push(tr("BMTC estimates your {line} at {stop} at {time} ({how} against the timetable). The rest of the trip is taken at its timetabled length.",
                { line: live.line, stop: live.stop, time: live.time, how: delayWords(shift) }));
        }
        if (w.basis === "stop" || w.basis === "route") {
            why.push(tr(w.basis === "stop"
                ? "{line} at {stop}: usually between {a} and {b} around this time on {period} ({n} BMTC measurements over {d} days)."
                : "{line}: usually between {a} and {b} along the route around this time on {period} ({n} BMTC measurements over {d} days). Delays differ by stop.",
                { line: w.line, stop: w.stop, a: delayWords(w.low), b: delayWords(w.high), period, n: w.samples, d: w.days }));
        } else if (w.basis === "city") {
            why.push(tr("No measurements for {line} at this hour yet. Across all measured BMTC buses at this hour, arrivals ran between {a} and {b} ({n} measurements over {d} days).",
                { line: w.line, a: delayWords(w.low), b: delayWords(w.high), n: w.samples, d: w.days }));
        } else if (w.basis === "metro") {
            why.push(tr("The last part is by metro; arrival is from the metro timetable."));
        } else {
            why.push(tr("Timetable arrival {time}. No measured delays for this hour yet, so no range is shown.", { time: w.scheduled }));
        }
        (w.missed || []).forEach(miss => {
            why.push(miss.next
                ? tr("If you miss the {line} at {stop}, the next one is timetabled at {time} (about {n} min later).", { line: miss.line, stop: miss.stop, time: miss.next, n: miss.later_minutes })
                : tr("If you miss the {line} at {stop}, the timetable has no later one within 3 hours.", { line: miss.line, stop: miss.stop }));
        });
        let from, to, ranged = false;
        if (shift !== null) {
            from = to = clockAfter(w.scheduled_iso, shift);
        } else if (w.earliest_iso && w.latest_iso) {
            from = clockAfter(w.earliest_iso);
            to = clockAfter(w.latest_iso);
            ranged = true;
        } else {
            from = to = w.scheduled;
        }
        const label = shift !== null ? tr("Likely around {time} (BMTC live estimate)", { time: from })
            : ranged ? (from === to ? tr("Likely around {time}", { time: from }) : tr("Likely {from}–{to}", { from, to }))
            : tr("Timetable {time} · no measured range yet", { time: from });
        return { from, to, ranged, live: shift !== null, label, why, basis: w.basis };
    }

    function arrivalWindowHtml(route, live = null) {
        const win = arrivalWindow(route, live);
        // Nothing measured, nothing live, no risky change: the card's own "Arrive" time already says it all.
        if (!win || (!win.ranged && !win.live && !(route.arrival_window.missed || []).length)) return "";
        return `<details class="arrival-window ${win.ranged || win.live ? "ranged" : "plain"}"><summary>🕒 ${escapeHtml(win.label)} <span class="aw-why">${escapeHtml(tr("why?"))}</span></summary>` +
            `<ul>${win.why.map(line => `<li>${escapeHtml(line)}</li>`).join("")}</ul></details>`;
    }

    // BMTC's live estimate for the journey's first bus at its boarding stop, as a shift from the timetable.
    function liveArrivalShift(route, buses) {
        const first = (route?.legs || []).find(leg => leg?.transit);
        if (!first?.departure_iso) return null;
        const planned = new Date(first.departure_iso).getTime();
        const line = String(first.route_name || "").split(" ")[0].toUpperCase();
        const candidates = (buses || []).filter(bus => bus?.relevance === "approaching" && bus.group !== "alternate" &&
            String(bus.route || "").split(" ")[0].toUpperCase() === line && boardEtaMinutes(bus) !== null)
            .map(bus => ({ bus, at: parseBmtcTime(bus.board_eta)?.getTime() }))
            .filter(item => Number.isFinite(item.at) && Math.abs(item.at - planned) <= 90 * 60000)
            .sort((a, b) => Math.abs(a.at - planned) - Math.abs(b.at - planned));
        if (!candidates.length || !Number.isFinite(planned)) return null;
        const best = candidates[0];
        return { shift: Math.round((best.at - planned) / 60000), line: first.route_name, stop: first.from?.name || tr("your stop"),
                 time: new Date(best.at).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }) };
    }

    function compareHtml(route, compare) {
        if (!compare || route?.transit === false) return "";
        const fare = route?.bus_fare;
        const minutes = Number(route?.total_elapsed_minutes ?? route?.duration_minutes);
        const busFare = fare?.total == null ? tr("fare not in BMTC data") : `${fare.exact ? "" : "~"}₹${fare.total}`;
        const busTime = Number.isFinite(minutes) ? tr("{min} min", { min: minutes }) : "";
        const cell = (icon, name, price, time, extra = "") =>
            `<div class="cmp-cell"><span class="cmp-name">${icon} ${escapeHtml(name)}</span><b>${escapeHtml(price)}</b><small>${escapeHtml(time)}${extra}</small></div>`;
        const night = compare.auto?.night ? ` · ${escapeHtml(tr("night rate"))}` : "";
        const saving = fare?.total != null && Number.isFinite(compare.auto?.fare) ? compare.auto.fare - fare.total : null;
        return `<details class="compare-row"><summary>` +
            cell("🚌", tr("Bus"), busFare, busTime) +
            cell("🛺", tr("Auto"), `~₹${compare.auto.fare}`, `~${tr("{min} min", { min: compare.auto.minutes })}`, night) +
            cell("🚕", tr("Cab"), `~₹${compare.cab.fare}`, `~${tr("{min} min", { min: compare.cab.minutes })}`) +
            `</summary><div class="cmp-notes">` +
            (saving > 0 ? `<p class="cmp-saving">${escapeHtml(tr("The bus saves about ₹{amount} compared with an auto.", { amount: saving }))}</p>` : "") +
            `<p>${escapeHtml(tr("Road distance {km} km ({kind}). Auto and cab times assume Bengaluru's average traffic (TomTom 2025), not live traffic; bus time is from the timetable.", { km: compare.road_km, kind: compare.road_distance === "road" ? tr("driving route") : tr("estimated") }))}</p>` +
            (fare && !fare.exact && fare.total != null ? `<p>${escapeHtml(tr("~ Bus fare estimated from BMTC's own ordinary fares for the same distance."))}</p>` : "") +
            `<ul>${(compare.sources || []).map(source => `<li>${escapeHtml(source)}</li>`).join("")}</ul></div></details>`;
    }

    // ---- Nearby stops now ----
    async function showNearbyStops() {
        const panel = $("nearbyPanel");
        if (!panel) return;
        panel.hidden = false;
        panel.innerHTML = `<div class="nearby-head"><b>📍 ${escapeHtml(tr("Stops near you"))}</b><button type="button" class="nearby-close" aria-label="${escapeHtml(tr("Close"))}">✕</button></div><p class="nearby-note">${escapeHtml(tr("Finding where you are…"))}</p>`;
        panel.querySelector(".nearby-close")?.addEventListener("click", closeNearby);
        const here = await currentPlace();
        if (!here) {
            panel.querySelector(".nearby-note").textContent = tr("Location is not available. Allow location for this site, or choose a stop with Pick on map.");
            return;
        }
        let data;
        try {
            const result = await fetchJson(`/api/nearby?lat=${here.lat}&lon=${here.lon}&radius=600`, { cache: "no-store" }, 12000);
            if (!result.ok) throw new Error(result.data?.error || "Nearby stops are not available.");
            data = result.data;
        } catch (error) {
            panel.querySelector(".nearby-note").textContent = explainFailure(error, tr("Nearby stops"));
            return;
        }
        renderNearby(panel, data, here);
    }

    function renderNearby(panel, data, here) {
        const stops = data?.stops || [];
        const items = stops.map((stop, index) => {
            const lines = (stop.lines || []).map(line =>
                `<li><span class="nb-route">${escapeHtml(line.route)}</span><span class="nb-to">→ ${escapeHtml(line.headsign || "")}</span>` +
                `<span class="nb-times">${line.times.map((time, i) => `${escapeHtml(time)}${i === 0 ? ` <small>(${escapeHtml(tr("in {min} min", { min: line.minutes[0] }))})</small>` : ""}`).join(" · ")}</span></li>`).join("");
            return `<li class="nb-stop" data-index="${index}"><div class="nb-title"><span class="nb-num">${index + 1}</span><b>${escapeHtml(stop.name)}</b>` +
                `<small>${escapeHtml(tr("{m} m · {min} min walk", { m: stop.meters, min: stop.walk_minutes }))}</small></div>` +
                (stop.towards?.length ? `<div class="nb-towards">${escapeHtml(tr("Towards"))} ${escapeHtml(stop.towards.join(", "))}</div>` : "") +
                (lines ? `<ul class="nb-lines">${lines}</ul>` : `<p class="nb-none">${escapeHtml(tr("No buses timetabled here in the next hour."))}</p>`) +
                `<div class="nb-actions">${stop.lines?.length ? `<button type="button" data-live="${index}">🚌 ${escapeHtml(tr("Live buses here"))}</button>` : ""}` +
                `<button type="button" data-start="${index}">${escapeHtml(tr("Start from this stop"))}</button></div></li>`;
        }).join("");
        panel.innerHTML = `<div class="nearby-head"><b>📍 ${escapeHtml(tr("Stops near you"))}</b><button type="button" class="nearby-close" aria-label="${escapeHtml(tr("Close"))}">✕</button></div>` +
            `<p class="nearby-note">${escapeHtml(tr("Next hour, from the BMTC timetable (not live). Tap Live buses for BMTC's live positions."))}</p>` +
            (items ? `<ol class="nb-list">${items}</ol>` : `<p class="nearby-note">${escapeHtml(tr("No BMTC stop within 600 m."))}</p>`);
        panel.querySelector(".nearby-close")?.addEventListener("click", closeNearby);
        panel.querySelectorAll("[data-live]").forEach(button => button.addEventListener("click", () => {
            const stop = stops[Number(button.dataset.live)];
            const lines = [...new Set(stop.lines.map(line => line.route))].slice(0, 6);
            closeNearby({ keepMarkers: false });
            trackSearchBuses(lines, [], false, { id: stop.id, name: stop.name, lat: stop.lat, lon: stop.lon }, null, []);
        }));
        panel.querySelectorAll("[data-start]").forEach(button => button.addEventListener("click", () => {
            const stop = stops[Number(button.dataset.start)];
            closeNearby();
            setEndpoint("origin", { id: stop.id, name: stop.name, lat: stop.lat, lon: stop.lon });
            if (state.destination) planJourney(); else destinationInput?.focus?.();
        }));
        // Numbered stop markers, and the map framed on you and them.
        clearNearbyMarkers();
        if (typeof maplibregl !== "undefined" && state.map) {
            state.nearbyMarkers = stops.map((stop, index) => {
                const element = document.createElement("div");
                element.className = "nearby-marker";
                element.textContent = String(index + 1);
                element.title = stop.name;
                return new maplibregl.Marker({ element, anchor: "center" }).setLngLat([stop.lon, stop.lat]).addTo(state.map);
            });
            try {
                const bounds = new maplibregl.LngLatBounds([here.lon, here.lat], [here.lon, here.lat]);
                stops.forEach(stop => bounds.extend([stop.lon, stop.lat]));
                state.map.fitBounds(bounds, { padding: 80, maxZoom: 17, duration: 700 });
            } catch { /* framing is cosmetic */ }
        }
    }

    function clearNearbyMarkers() {
        (state.nearbyMarkers || []).forEach(marker => marker.remove?.());
        state.nearbyMarkers = [];
    }

    function closeNearby() {
        const panel = $("nearbyPanel");
        if (panel) { panel.hidden = true; panel.innerHTML = ""; }
        clearNearbyMarkers();
    }

    // ---- Installable app ----
    function setupInstallableApp() {
        if (typeof window === "undefined" || typeof navigator === "undefined") return;
        window.addEventListener?.("beforeinstallprompt", (event) => { event.preventDefault?.(); state.installPrompt = event; });
        const local = /^(localhost|127\.0\.0\.1)$/.test(location.hostname);
        if ("serviceWorker" in navigator && (location.protocol === "https:" || local)) {
            navigator.serviceWorker.register("/sw.js").catch(error => console.warn("Offline support unavailable:", error));
        }
    }

    function setupWhatsNew() {
        const box = $("whatsNew");
        if (!box || store.get("bt.seen.features-2", false)) return;
        box.innerHTML = `<strong>${escapeHtml(tr("New"))}</strong> ` +
            `<span>${escapeHtml(tr("📷 Snap & go: photo a bus, stop board or address · ☰ → Talk mode: spoken answers and guidance · 🔁 your usual trip appears at its usual time · ☆ Save Home/Work · 🔔 Remind & ↗ Share on every journey"))}</span>` +
            `<button type="button" aria-label="${escapeHtml(tr("Dismiss"))}">✕</button>`;
        box.hidden = false;
        box.querySelector("button")?.addEventListener("click", () => { box.hidden = true; store.set("bt.seen.features-2", true); });
    }

    function setupEverydayFeatures() {
        state.lang = store.get("bt.lang", "en") === "kn" ? "kn" : "en";
        setupPageTranslation();
        state.journey.alertsOn = store.get("bt.alerts", true) !== false;
        setupPlaces();
        setupWhatsNew();
        setupTalkSnapUsual();
        setupInstallableApp();
        restoreReminder();
        $("guideAlertToggle")?.addEventListener("click", () => {
            state.journey.alertsOn = !state.journey.alertsOn;
            store.set("bt.alerts", state.journey.alertsOn);
            if (state.journey.alertsOn) askNotificationPermission();
            syncAlertToggle();
            renderJourneyGuide();
        });
        $("guideShare")?.addEventListener("click", () => {
            const step = guideSteps(state.journey.route)[state.journey.stepIndex];
            const leg = step?.kind === "ride" || step?.kind === "board" ? step.leg : null;
            shareTrip(state.journey.route, { bus: leg && leg.role !== "metro" ? leg.route_name : "" });
        });
        $("profileBtn")?.addEventListener("click", (event) => {
            event.stopPropagation();
            const menu = $("quickMenu");
            if (menu && !menu.hidden && menu.dataset.kind === "more") closeQuickMenu(); else openQuickMenu("more", $("profileBtn"));
        });
        syncAlertToggle();
        if (state.lang === "kn") applyLanguage("kn");
        // Missed-bus check while guiding (every 30 s; cheap, no network of its own).
        setInterval(() => { if (state.journey.active) checkMissedBus(); }, 30000);
        setInterval(() => refreshMarkerAges(), 10000);
    }


    function escapeHtml(value) {
        return String(value)
            .replaceAll("&", "&amp;")
            .replaceAll("<", "&lt;")
            .replaceAll(">", "&gt;")
            .replaceAll('"', "&quot;")
            .replaceAll("'", "&#039;");
    }

    async function init() {
        initializeMap();
        setupEvents();
        setupEverydayFeatures();
        syncPreferenceChips();
        checkHealth();
        try {
            await waitForMap();
            state.map.resize();
            openSharedTrip();
            console.log("Bengaluru Transit AI initialized.");
        } catch (error) {
            console.error(error);
        }
    }

    // Read-only inspection hook for manual checks: open the page with ?debug
    try { if (new URLSearchParams(location.search).has("debug")) window.__transit = { state, showGuideBanner, navSummary, navTrip, startPreview, stopPreview, rideStops }; } catch (error) { /* not in a browser */ }

    init();
})();
