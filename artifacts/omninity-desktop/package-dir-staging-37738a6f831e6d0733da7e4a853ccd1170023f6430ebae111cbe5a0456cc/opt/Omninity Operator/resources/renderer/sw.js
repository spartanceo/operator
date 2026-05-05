/**
 * Omninity Operator Mobile — service worker.
 *
 * Tier 1 responsibilities:
 *   - Install / activate lifecycle so the PWA satisfies the
 *     "Add to Home Screen" install criteria.
 *   - Network-first fetch handler scoped to /mobile so the desktop OP
 *     remains the source of truth (no stale cached approvals).
 *   - Web Push handler that displays an approval / status notification
 *     and routes the click back to the right deep link in the PWA.
 */
const CACHE_NAME = "op-mobile-v1";

self.addEventListener("install", (event) => {
  self.skipWaiting();
  event.waitUntil(caches.open(CACHE_NAME));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)),
      );
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  // Only intercept GETs for our own origin under /mobile or static assets.
  if (event.request.method !== "GET") return;
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    (async () => {
      try {
        const fresh = await fetch(event.request);
        if (fresh && fresh.status === 200 && url.pathname.endsWith(".svg")) {
          const cache = await caches.open(CACHE_NAME);
          cache.put(event.request, fresh.clone());
        }
        return fresh;
      } catch (e) {
        const cached = await caches.match(event.request);
        if (cached) return cached;
        throw e;
      }
    })(),
  );
});

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (_e) {
    data = { title: "Omninity Operator", body: event.data?.text() ?? "" };
  }
  const title = data.title || "Omninity Operator";
  const options = {
    body: data.body || "",
    icon: data.icon || "/favicon.svg",
    badge: data.badge || "/favicon.svg",
    tag: data.tag || data.category || "op-notification",
    data: { url: data.url || "/mobile", category: data.category || "general" },
    requireInteraction: data.category === "approval",
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const targetUrl = (event.notification.data && event.notification.data.url) || "/mobile";
  event.waitUntil(
    (async () => {
      const all = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const client of all) {
        if (client.url.includes("/mobile") && "focus" in client) {
          client.navigate(targetUrl);
          return client.focus();
        }
      }
      if (self.clients.openWindow) {
        return self.clients.openWindow(targetUrl);
      }
    })(),
  );
});
