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

    const APP_BUILD = "2026-10-26-dock-2";   // must match BUILD in app.py

    async function checkHealth() {
        try {
            const result = await fetchJson("/api/health", { cache: "no-store" }, 6000);
            if (!result.ok || !result.data) throw new Error("Health check failed");
            state.health = result.data;
            showAssistantEngine(result.data.assistant);
            if (result.data.build !== APP_BUILD) {
                // The page updated (browser reload) but the black run-local window still runs old server code.
                showBanner("This page is newer than the app server that is running. Close the black run-local window, " +
                    "start run-local.cmd again, then reload this page (Ctrl+F5). Until then some features will not work.");
            } else if (!result.data.database) {
                showBanner("The Bengaluru stop database is missing, so searching and planning will not work. " +
                    "Run: python scripts/import_gtfs.py data/bmtc_gtfs.zip, then restart the app.");
            } else if (!result.data.router) {
                showBanner("The route engine is not running, so journeys cannot be planned yet. Start the app with " +
                    "run-local.cmd, wait for \"Ready\" in its window, then press Check again.");
            } else {
                hideBanner();
            }
            return result.data;
        } catch (error) {
            state.health = null;
            showBanner("Cannot reach the local server on port 8765. Start run-local.cmd, then reload this page.");
            return null;
        }
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
            state.map.on("load", () => {
                state.mapReady = true;
                addMapAccent();
                requestAnimationFrame(() => state.map.resize());
                setTimeout(() => state.map?.resize(), 250);
                setTimeout(() => state.map?.resize(), 1000);
            });

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

    async function waitForMap(timeout = 12000) {
        if (state.mapReady && state.map) return state.map;
        const started = Date.now();
        while (!state.mapReady) {
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
                <span class="suggestion-main">${escapeHtml(stop.name)}</span>
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
            return `<li class="leg bus"><span class="leg-icon" aria-hidden="true">🚌</span><div>` +
                `<div class="leg-main"><strong>${escapeHtml(leg.route_name)}</strong>${leg.headsign ? ` toward ${escapeHtml(leg.headsign)}` : ""}</div>` +
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
            : route.schedule_based === false ? "Live estimate"
            : route.geometry_source === "otp" ? "Scheduled buses · road-based walking"
            : route.geometry_source === "gtfs_shape" ? "Scheduled GTFS route alignment"
            : "Scheduled GTFS stop sequence · road geometry unavailable";

        const busLegs = (route.legs || []).filter((leg) => leg.transit && leg.route_name);
        const detourNote = route.detour === undefined ? routeDetourNote(route) : "";
        const stretchNotes = busLegs.filter(leg => leg.also_served_by?.length).map(leg =>
            `${busLegs.length > 1 ? `${leg.from?.name || "Stop"} → ${leg.to?.name || "stop"}: ` : ""}${leg.also_served_by.join(", ")} also go${leg.also_served_by.length === 1 ? "es" : ""} there`);
        const trackTargets = route.transit === false ? [] : busLegs.length
            ? busLegs.map((leg) => ({ number: leg.route_name, from: leg.from, to: leg.to }))
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

            <div class="route-description">
                <strong>${escapeHtml(numbers.join("  →  "))}</strong>
                <br>${escapeHtml(source)}
                ${detourNote ? `<span class="route-detour-note">${escapeHtml(detourNote)}</span>` : ""}
                ${stretchNotes.length ? `<span class="route-also-lines">🚌 ${escapeHtml(stretchNotes.join(" · "))}</span>` : ""}
            </div>

            <div class="route-metrics">
                <span class="route-metric">🔄 ${escapeHtml(String(transfers))} transfer${transfers === 1 ? "" : "s"}</span>
                <span class="route-metric">🚶 ${escapeHtml(walkingText)}</span>
                ${waitText ? `<span class="route-metric">${escapeHtml(waitText)}</span>` : ""}
            </div>

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
            meta.textContent = routes.length
                ? `${when ? `Leaving ${when.toLowerCase()} · ` : ""}${routes.length} option${routes.length === 1 ? "" : "s"} · from the BMTC timetable, not live arrivals`
                : "";
        }

        routeResults.innerHTML = "";
        clearRouteLayers();
        syncExplainButton();

        if (!routes.length) {
            routeResults.appendChild(createFallbackCard(result));
            return;
        }

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
            routeResults.appendChild(createRouteCard(route, index));
        });

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
                showStatus(`${routes.length} route option${routes.length === 1 ? "" : "s"} found.`);
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

    async function runAssistantCommand(text, { fromMainBar = false } = {}) {
        const command = String(text || "").trim();
        if (!command) return false;
        if (state.chatBusy) {
            showStatus("Still working on your last request. Your new one is kept in the box; press Enter again in a moment.", true);
            return false;
        }

        addChatMessage(command, "user");
        const pending = addChatMessage("", "assistant pending thinking");
        const stopThinking = startThinking(pending);
        state.chatBusy = true;
        $("chatSendBtn")?.setAttribute("disabled", "");

        // The server reads the message with Gemini when it has a key (the key never reaches this page),
        // otherwise with the built-in rule-based helper. Journeys always come from the local planner.
        const history = (state.chatHistory || []).slice(-6);
        const context = (stop) => stop ? { id: stop.id, name: stop.name, lat: stop.lat, lon: stop.lon, is_map_point: !!stop.is_map_point } : null;
        try {
            const result = await fetchJson("/api/assistant", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    message: command,
                    origin: context(state.origin),
                    destination: context(state.destination),
                    preference: state.selectedPreference,
                    depart_at: state.departAt || undefined,
                    history
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
            }
            state.chatHistory = [...(state.chatHistory || []), {role: "user", text: command},
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
        } catch (error) {
            console.error("Assistant error:", error);
            if (pending) pending.textContent = `${explainFailure(error, "The assistant")} You can also use the From and To boxes.`;
            if (!chatPanel.classList.contains("open")) openChat();
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
                say(`Tell me where you are starting (or plan a journey first), so I can check which ${wanted} buses are coming your way.`);
                return;
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

    function setupVoice(button, input) {
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
        recognition.lang = "en-IN";
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
            runAssistantCommand(text);
        };

        button.addEventListener("click", () => {
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

    const stepCache = new WeakMap();

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
                const name = leg.route_name || "bus";
                const count = Number(leg.stop_count);
                steps.push({
                    kind: "board", legIndex, leg, target: leg.from,
                    title: `Board ${name}${leg.headsign ? ` → ${leg.headsign}` : ""}`,
                    short: `Board ${name} at ${leg.from?.name || "the stop"}`,
                    detail: `Be at ${leg.from?.name || "the stop"} before the scheduled ${leg.departure_time || "departure"}. ` +
                        (leg.also_served_by?.length ? `${leg.also_served_by.join(", ")} also go${leg.also_served_by.length === 1 ? "es" : ""} to ${leg.to?.name || "your stop"}, so take whichever comes first. ` : "") +
                        `Check the bus number and destination board. Times are from the timetable, not live.`
                });
                steps.push({
                    kind: "ride", legIndex, leg, target: leg.to,
                    title: `Ride ${name} to ${leg.to?.name || "your stop"}`,
                    short: `Ride ${name} to ${leg.to?.name || "your stop"}`,
                    detail: `${Number.isFinite(count) && count > 0 ? `${count} stop${count === 1 ? "" : "s"} · ` : ""}about ${leg.duration_minutes} min. ` +
                        `Get down at ${leg.to?.name || "your stop"} (scheduled ${leg.arrival_time || "—"}). ` +
                        `You are not told automatically when to get off: watch the stop names.`
                });
            } else if (!leg.trivial) {
                const title = leg.role === "egress_walk" ? "Walk to your destination"
                    : leg.role === "transfer_walk" ? "Walk to your next stop" : "Walk to the boarding stop";
                steps.push({
                    kind: "walk", legIndex, leg, target: leg.to, title,
                    short: `Walk to ${leg.to?.name || "the next stop"}`,
                    detail: leg.instruction || `${leg.from?.name || "Start"} → ${leg.to?.name || "next stop"}. ${leg.duration_minutes} min · ${leg.distance_m} m.`
                });
            }
        });
        if (legs.length) {
            const last = legs[legs.length - 1];
            steps.push({
                kind: "arrive", legIndex: legs.length - 1, leg: last, target: last.to,
                title: "Arrive at your destination",
                short: `Arrive: ${last.to?.name || "destination"}`,
                detail: "Have you reached your destination? Tap Finish to close guidance."
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
        const nextBus = legs.slice(from).find((leg) => leg.transit && leg.route_name);
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
        $("journeyGuide").hidden = true;
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
        if (coordinates?.length > 1) setTimeout(() => { if (!state.liveBus.framed) fitCoordinates(coordinates, 600); }, 120);
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
                if (previous) {
                    previous.marker.setLngLat([bus.lon, bus.lat]);
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
                element.innerHTML = `<span class="bus-dir" aria-hidden="true" hidden></span><span aria-hidden="true">🚌</span><span class="bus-route-label">${escapeHtml(bus.route.split(" ")[0])}</span>`;
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
                frameLivePoints(points, session);
            }
            if (live.selectedBusId) {
                const selected = shown.find(bus => liveBusKey(bus) === live.selectedBusId);
                if (selected) state.map.easeTo({center: [selected.lon, selected.lat], zoom: Math.max(state.map.getZoom(), 15), duration: 500});
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
        const detail = `Step ${stepIndex + 1} of ${steps.length}. ${step.detail}`;
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
        const names = journey.route.route_numbers?.length
            ? journey.route.route_numbers.join(" → ") : "Selected journey";
        const list = steps.map((step, index) =>
            `<li class="${index === journey.stepIndex ? "current" : index < journey.stepIndex ? "done" : ""}">${escapeHtml(step.short)}</li>`).join("");
        $("guideRouteSummary").innerHTML = `<strong>Route: ${escapeHtml(names)}</strong>${list ? `<ol>${list}</ol>` : ""}`;
        const last = steps.length > 0 && journey.stepIndex >= steps.length - 1;
        $("guidePrev").disabled = journey.stepIndex === 0;
        $("guideNext").disabled = steps.length === 0;
        $("guideNext").textContent = last ? "Finish" : "Next step";
        $("guideFollow").textContent = !journey.lastPosition ? "Show my route" : journey.follow ? "Following you" : "Recenter";
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
        renderJourneyGuide();
        focusGuideStep(steps[journey.stepIndex]);
        syncGuideLive();
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

        if (!journey.marker) {
            const element = document.createElement("div");
            element.className = "transit-user-location-marker";
            element.innerHTML = `<div class="transit-user-location-pulse"></div><div class="transit-user-location-dot"></div>`;
            journey.marker = new maplibregl.Marker({ element, anchor: "center" }).setLngLat(point).addTo(state.map);
        }
        journey.marker.setLngLat(point);

        const heading = position.coords.heading;
        if (journey.follow && position.coords.accuracy <= 150 && Date.now() - position.timestamp <= 30000) state.map.easeTo({
            center: point,
            zoom: Math.max(state.map.getZoom(), 16.5),
            bearing: Number.isFinite(heading) && position.coords.speed > 1 ? heading : state.map.getBearing(),
            pitch: 52,
            duration: 700,
            essential: true
        });

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
        state.journey.gpsError = navigator.geolocation ? "Waiting for device location…" : "Device location is unavailable. Use Next step as you travel.";
        hideRoutePanel();
        $("liveBusPanel").classList.remove("with-routes");
        $("networkPanel").hidden = true;
        const session = ++state.journey.session;
        renderJourneyGuide();
        reframeSelectedRoute();

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

        showStatus(guideSteps(route).length
            ? "Journey guidance started. Use Next step to confirm boarding and transfers."
            : "Guidance started, but this option has no step list. Use the card's instructions.");
        if (!navigator.geolocation) return;
        try {
            state.journey.watchId = navigator.geolocation.watchPosition(
                position => { if (state.journey.session === session) updateJourneyProgress(position); },
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
        $("profileBtn")?.addEventListener("click", () => {
            document.querySelector('.quick-chip')?.focus();
            showStatus("Choose Less walking, Fewer transfers or Fastest below Find routes.");
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
        syncPreferenceChips();
        checkHealth();
        try {
            await waitForMap();
            state.map.resize();
            console.log("Bengaluru Transit AI initialized.");
        } catch (error) {
            console.error(error);
        }
    }

    // Read-only inspection hook for manual checks: open the page with ?debug
    try { if (new URLSearchParams(location.search).has("debug")) window.__transit = { state }; } catch (error) { /* not in a browser */ }

    init();
})();
