// Offline support for the installable app.
// - The page itself (HTML, script, styles, map library, icons) is kept so the app opens on a slow or
//   missing connection. The network is always tried first, so a new version is used as soon as it exists.
// - /api/... (journeys, live buses, the assistant) is NEVER cached: a stored answer could pass old bus
//   positions off as current. Without a connection those requests fail and the page says so.
// - Map tiles come from other sites and are not touched.
const CACHE = "bt-shell-2026-10-27-features-2";
const SHELL = ["/", "/static/styles.css", "/static/app.js", "/static/i18n.js", "/static/vendor/maplibre-gl.js",
    "/static/vendor/maplibre-gl.css", "/static/icons/icon-192.png", "/static/icons/icon-512.png", "/manifest.webmanifest"];

self.addEventListener("install", (event) => {
    event.waitUntil(caches.open(CACHE)
        .then(cache => Promise.all(SHELL.map(url => cache.add(new Request(url, { cache: "reload" })).catch(() => null))))
        .then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
    event.waitUntil(caches.keys()
        .then(keys => Promise.all(keys.filter(key => key.startsWith("bt-shell-") && key !== CACHE).map(key => caches.delete(key))))
        .then(() => self.clients.claim()));
});

function offlinePage() {
    return new Response(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Offline</title><body style="font:16px system-ui;background:#0b1622;color:#e8f4ff;padding:24px">
<h1>You are offline</h1><p>Bengaluru Transit needs a connection to plan journeys and check live buses. Try again when you are back online.</p></body>`,
        { headers: { "Content-Type": "text/html; charset=utf-8" } });
}

self.addEventListener("fetch", (event) => {
    const request = event.request;
    if (request.method !== "GET") return;
    const url = new URL(request.url);
    if (url.origin !== self.location.origin || url.pathname.startsWith("/api/")) return;   // never cached
    const isPage = request.mode === "navigate";
    const isShell = isPage || SHELL.includes(url.pathname) || url.pathname.startsWith("/static/");
    if (!isShell) return;
    event.respondWith(fetch(request).then(response => {
        if (response.ok && response.type === "basic") {
            const copy = response.clone();
            const key = isPage ? "/" : url.pathname;          // ?v=... versions share one entry
            caches.open(CACHE).then(cache => cache.put(key, copy)).catch(() => null);
        }
        return response;
    }).catch(async () => {
        const cached = await caches.match(isPage ? "/" : url.pathname, { ignoreSearch: true });
        return cached || (isPage ? offlinePage() : Response.error());
    }));
});

self.addEventListener("notificationclick", (event) => {
    event.notification.close();
    event.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(list => {
        const open = list.find(client => "focus" in client);
        return open ? open.focus() : self.clients.openWindow("/");
    }));
});
