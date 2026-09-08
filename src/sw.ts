/// <reference lib="webworker" />
import { precacheAndRoute, cleanupOutdatedCaches } from 'workbox-precaching';
import { clientsClaim } from 'workbox-core';
import type { PushPayload } from '@shared/types';

declare const self: ServiceWorkerGlobalScope & {
  __WB_MANIFEST: Array<{ url: string; revision: string | null }>;
};

/* ------------------------------------------------------------------ *
 * Precaching (app shell)
 * ------------------------------------------------------------------ */

cleanupOutdatedCaches();
precacheAndRoute(self.__WB_MANIFEST);

self.addEventListener('message', (event: ExtendableMessageEvent) => {
  // The update prompt in the UI sends this once the driver accepts a new version.
  if ((event.data as { type?: string } | undefined)?.type === 'SKIP_WAITING') {
    void self.skipWaiting();
  }
});

clientsClaim();

/* ------------------------------------------------------------------ *
 * Map tiles
 *
 * Deliberately NOT precached: the tiles for a 600 km route are hundreds of
 * megabytes, and Mapbox's terms restrict caching. A short-lived runtime cache
 * only smooths over brief signal loss — the tunnel case.
 * ------------------------------------------------------------------ */

const TILE_CACHE = 'mapbox-tiles-v1';
const TILE_CACHE_MAX_ENTRIES = 600;

async function trimCache(name: string, maxEntries: number): Promise<void> {
  const cache = await caches.open(name);
  const keys = await cache.keys();
  if (keys.length <= maxEntries) return;
  // Cache keys come back in insertion order, so the oldest are at the front.
  await Promise.all(keys.slice(0, keys.length - maxEntries).map((key) => cache.delete(key)));
}

self.addEventListener('fetch', (event: FetchEvent) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET') return;

  const isTile =
    url.hostname.endsWith('.mapbox.com') &&
    (url.pathname.includes('/tiles/') ||
      url.pathname.includes('/fonts/') ||
      url.pathname.includes('/sprite'));
  if (!isTile) return;

  event.respondWith(
    (async () => {
      const cache = await caches.open(TILE_CACHE);
      const cached = await cache.match(event.request);
      if (cached) return cached;
      try {
        const response = await fetch(event.request);
        // Opaque responses have status 0 and cannot be inspected; skip those.
        if (response.ok) {
          await cache.put(event.request, response.clone());
          void trimCache(TILE_CACHE, TILE_CACHE_MAX_ENTRIES);
        }
        return response;
      } catch (error) {
        // Offline with nothing cached: let Mapbox render the gap itself.
        throw error;
      }
    })(),
  );
});

/* ------------------------------------------------------------------ *
 * Push notifications
 * ------------------------------------------------------------------ */

function parsePayload(event: PushEvent): PushPayload {
  try {
    const data = event.data?.json() as Partial<PushPayload> | undefined;
    return {
      title: data?.title ?? 'Reichweite',
      body: data?.body ?? 'Zeit für einen Stopp?',
      ...(data?.tag ? { tag: data.tag } : {}),
      ...(data?.url ? { url: data.url } : {}),
      ...(data?.actions ? { actions: data.actions } : {}),
      ...(data?.data ? { data: data.data } : {}),
    };
  } catch {
    return { title: 'Reichweite', body: event.data?.text() ?? 'Zeit für einen Stopp?' };
  }
}

self.addEventListener('push', (event: PushEvent) => {
  const payload = parsePayload(event);
  event.waitUntil(
    self.registration.showNotification(payload.title, {
      body: payload.body,
      tag: payload.tag ?? 'range',
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
      // The whole point is that a driver notices; do not auto-dismiss.
      requireInteraction: true,
      // A short pattern so it is felt through a pocket without startling.
      vibrate: [120, 60, 120],
      data: { url: payload.url ?? '/', ...(payload.data ?? {}) },
      actions: payload.actions ?? [
        { action: 'refuel', title: 'Ja, Stopp suchen' },
        { action: 'dismiss', title: 'Später' },
      ],
    } as NotificationOptions),
  );
});

self.addEventListener('notificationclick', (event: NotificationEvent) => {
  event.notification.close();
  if (event.action === 'dismiss') return;

  const data = event.notification.data as { url?: string } | undefined;
  const target = new URL(data?.url ?? '/', self.location.origin);
  // Tell the page which action was taken, so tapping "Ja" opens the stop sheet
  // rather than just bringing the app forward.
  target.searchParams.set('action', event.action || 'open');

  event.waitUntil(
    (async () => {
      const clients = await self.clients.matchAll({
        type: 'window',
        includeUncontrolled: true,
      });
      const existing = clients.find((client) => client.url.startsWith(self.location.origin));
      if (existing) {
        await existing.focus();
        existing.postMessage({
          type: 'NOTIFICATION_ACTION',
          action: event.action || 'open',
          data: event.notification.data,
        });
        return;
      }
      await self.clients.openWindow(target.toString());
    })(),
  );
});
