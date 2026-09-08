import type { PushConfigResponse, PushPayload } from '@shared/types';
import { env } from '@/config/env';
import { fetchJson, postJson } from '@/lib/http';

export type PushSupport =
  | { supported: true }
  | { supported: false; reason: string; iosHint: boolean };

/**
 * Checks whether Web Push can work here.
 *
 * iOS is the interesting case: Safari only exposes `PushManager` once the PWA
 * has been added to the home screen, so a plain Safari tab reports "not
 * supported" and the user needs a specific instruction rather than a generic
 * error.
 */
export function checkPushSupport(): PushSupport {
  if (!('serviceWorker' in navigator)) {
    return {
      supported: false,
      reason: 'Dieser Browser unterstützt keine Service Worker.',
      iosHint: false,
    };
  }
  if (!('Notification' in window)) {
    return {
      supported: false,
      reason: 'Dieser Browser unterstützt keine Benachrichtigungen.',
      iosHint: false,
    };
  }
  if (!('PushManager' in window)) {
    return {
      supported: false,
      reason:
        'Push ist hier nicht verfügbar. Unter iOS muss die App zuerst über ' +
        '„Teilen → Zum Home-Bildschirm“ installiert und von dort geöffnet werden.',
      iosHint: isIos(),
    };
  }
  return { supported: true };
}

export function isIos(): boolean {
  const ua = navigator.userAgent;
  // iPadOS reports itself as a Mac, so the touch-point check is needed too.
  return (
    /iPad|iPhone|iPod/.test(ua) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
  );
}

export function isStandalone(): boolean {
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    // Safari's non-standard flag, still the only signal on older iOS.
    (navigator as { standalone?: boolean }).standalone === true
  );
}

/**
 * VAPID keys are base64url; `applicationServerKey` needs raw bytes.
 *
 * Allocating the `ArrayBuffer` explicitly (rather than letting `new
 * Uint8Array(n)` pick one) keeps the result typed as `ArrayBuffer` rather than
 * `ArrayBufferLike`, which is what `BufferSource` requires.
 */
function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const normalised = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(normalised);
  const output = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) output[i] = raw.charCodeAt(i);
  return output;
}

export async function requestNotificationPermission(): Promise<NotificationPermission> {
  if (!('Notification' in window)) return 'denied';
  if (Notification.permission !== 'default') return Notification.permission;
  return Notification.requestPermission();
}

export interface SubscribeResult {
  ok: boolean;
  message: string;
  endpoint?: string;
}

/**
 * Registers a Web Push subscription with the server.
 *
 * Only needed for notifications that must arrive when the page is not running.
 * While the app is open, the in-app prompt and `showNotification` from the
 * service worker cover the range alerts without any server round-trip.
 */
export async function subscribeToPush(userId?: string): Promise<SubscribeResult> {
  const support = checkPushSupport();
  if (!support.supported) return { ok: false, message: support.reason };

  const permission = await requestNotificationPermission();
  if (permission !== 'granted') {
    return {
      ok: false,
      message:
        permission === 'denied'
          ? 'Benachrichtigungen sind für diese Seite blockiert. Bitte in den Browser-Einstellungen erlauben.'
          : 'Benachrichtigungen wurden nicht erlaubt.',
    };
  }

  let config: PushConfigResponse;
  try {
    config = await fetchJson<PushConfigResponse>(`${env.apiBase}/push/config`, {
      timeoutMs: 6000,
    });
  } catch {
    return { ok: false, message: 'Push-Konfiguration konnte nicht geladen werden.' };
  }
  if (!config.publicKey) {
    return {
      ok: false,
      message:
        'Auf dem Server ist kein VAPID-Schlüsselpaar konfiguriert. ' +
        'In-App-Hinweise funktionieren trotzdem.',
    };
  }

  const registration = await navigator.serviceWorker.ready;
  const existing = await registration.pushManager.getSubscription();
  const subscription =
    existing ??
    (await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(config.publicKey),
    }));

  const json = subscription.toJSON() as {
    endpoint?: string;
    keys?: { p256dh?: string; auth?: string };
  };
  if (!json.endpoint || !json.keys?.p256dh || !json.keys.auth) {
    return { ok: false, message: 'Die Push-Subscription war unvollständig.' };
  }

  try {
    await postJson(`${env.apiBase}/push/subscribe`, {
      subscription: {
        endpoint: json.endpoint,
        keys: { p256dh: json.keys.p256dh, auth: json.keys.auth },
      },
      ...(userId ? { userId } : {}),
    });
  } catch {
    return { ok: false, message: 'Server hat die Subscription nicht angenommen.' };
  }

  return { ok: true, message: 'Push-Benachrichtigungen aktiviert.', endpoint: json.endpoint };
}

export async function unsubscribeFromPush(): Promise<void> {
  if (!('serviceWorker' in navigator)) return;
  const registration = await navigator.serviceWorker.ready;
  const subscription = await registration.pushManager.getSubscription();
  if (!subscription) return;
  const endpoint = subscription.endpoint;
  await subscription.unsubscribe();
  await postJson(`${env.apiBase}/push/unsubscribe`, { endpoint }).catch(() => {});
}

/** Sends a test notification through the full server → push → SW path. */
export async function sendTestPush(): Promise<SubscribeResult> {
  try {
    const payload: PushPayload = {
      title: 'Reichweite',
      body: 'Test: So sieht eine Tank-Erinnerung aus.',
      tag: 'range-test',
      url: '/',
    };
    const result = await postJson<{ sent: number }>(`${env.apiBase}/push/notify`, {
      payload,
    });
    return result.sent > 0
      ? { ok: true, message: 'Testbenachrichtigung verschickt.' }
      : { ok: false, message: 'Kein Gerät hat die Benachrichtigung angenommen.' };
  } catch {
    return { ok: false, message: 'Testbenachrichtigung fehlgeschlagen.' };
  }
}

/**
 * Shows a notification directly through the service worker.
 *
 * This is the primary path for the range prompt: it needs no server, no VAPID
 * keys and no network, and works whenever the page is alive — including with the
 * screen off, as long as the browser has not frozen the tab.
 */
export async function showLocalNotification(payload: PushPayload): Promise<boolean> {
  if (!('serviceWorker' in navigator) || Notification.permission !== 'granted') {
    return false;
  }
  try {
    const registration = await navigator.serviceWorker.ready;
    await registration.showNotification(payload.title, {
      body: payload.body,
      tag: payload.tag ?? 'range',
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
      requireInteraction: true,
      data: { url: payload.url ?? '/', ...(payload.data ?? {}) },
      ...(payload.actions ? { actions: payload.actions } : {}),
    } as NotificationOptions);
    return true;
  } catch {
    return false;
  }
}
