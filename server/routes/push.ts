import { Router, type Request, type Response } from 'express';
import webpush from 'web-push';
import type {
  PushConfigResponse,
  PushPayload,
  PushSubscribeRequest,
} from '../../shared/types.js';
import { capabilities, config } from '../lib/config.js';

export const pushRouter = Router();

let configured = false;
if (config.push.publicKey && config.push.privateKey) {
  webpush.setVapidDetails(
    config.push.subject,
    config.push.publicKey,
    config.push.privateKey,
  );
  configured = true;
}

interface StoredSubscription {
  subscription: webpush.PushSubscription;
  userId: string | null;
  createdAt: number;
}

/**
 * Subscriptions live in memory. That is intentional for now: the range monitor
 * runs in the browser and notifies through the service worker, so the server
 * only needs a subscription for the duration of a session. Persisting them in
 * Supabase is the next step once server-side triggers exist.
 */
const subscriptions = new Map<string, StoredSubscription>();

pushRouter.get('/config', (_req: Request, res: Response) => {
  const body: PushConfigResponse = { publicKey: config.push.publicKey };
  res.json(body);
});

pushRouter.post('/subscribe', (req: Request, res: Response) => {
  if (!configured) {
    res.status(503).json({
      error: {
        code: 'not_configured',
        message: 'Web Push ist nicht konfiguriert (VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY).',
      },
    });
    return;
  }
  const body = req.body as Partial<PushSubscribeRequest>;
  const subscription = body.subscription;
  if (
    !subscription ||
    typeof subscription.endpoint !== 'string' ||
    typeof subscription.keys?.p256dh !== 'string' ||
    typeof subscription.keys?.auth !== 'string'
  ) {
    res.status(400).json({
      error: { code: 'bad_request', message: 'Ungültige Push-Subscription.' },
    });
    return;
  }

  subscriptions.set(subscription.endpoint, {
    subscription: subscription as webpush.PushSubscription,
    userId: typeof body.userId === 'string' ? body.userId : null,
    createdAt: Date.now(),
  });
  res.status(201).json({ ok: true, subscriptions: subscriptions.size });
});

pushRouter.post('/unsubscribe', (req: Request, res: Response) => {
  const endpoint = (req.body as { endpoint?: unknown })?.endpoint;
  if (typeof endpoint === 'string') subscriptions.delete(endpoint);
  res.status(204).end();
});

/**
 * Sends a notification to the caller's subscriptions. The client uses this to
 * verify the whole push path works (Settings → "Test-Benachrichtigung"), and it
 * is the hook a future server-side range watcher would call.
 */
pushRouter.post('/notify', async (req: Request, res: Response) => {
  if (!configured) {
    res.status(503).json({
      error: { code: 'not_configured', message: 'Web Push ist nicht konfiguriert.' },
    });
    return;
  }
  const body = req.body as { payload?: Partial<PushPayload>; endpoint?: string };
  const payload: PushPayload = {
    title: body.payload?.title ?? 'Reichweite',
    body: body.payload?.body ?? 'Testbenachrichtigung',
    ...(body.payload?.tag ? { tag: body.payload.tag } : {}),
    ...(body.payload?.url ? { url: body.payload.url } : {}),
    ...(body.payload?.actions ? { actions: body.payload.actions } : {}),
    ...(body.payload?.data ? { data: body.payload.data } : {}),
  };

  const targets = body.endpoint
    ? [subscriptions.get(body.endpoint)].filter(
        (s): s is StoredSubscription => s !== undefined,
      )
    : [...subscriptions.values()];

  if (targets.length === 0) {
    res.status(404).json({
      error: { code: 'bad_request', message: 'Keine Push-Subscription registriert.' },
    });
    return;
  }

  const results = await Promise.allSettled(
    targets.map((target) =>
      webpush.sendNotification(target.subscription, JSON.stringify(payload), {
        TTL: 300,
        urgency: 'high',
      }),
    ),
  );

  let sent = 0;
  for (const [index, result] of results.entries()) {
    if (result.status === 'fulfilled') {
      sent++;
      continue;
    }
    const statusCode = (result.reason as { statusCode?: number })?.statusCode;
    // 404/410 mean the browser dropped the subscription; stop trying it.
    if (statusCode === 404 || statusCode === 410) {
      const endpoint = targets[index]?.subscription.endpoint;
      if (endpoint) subscriptions.delete(endpoint);
    } else {
      console.error('[push] Versand fehlgeschlagen:', result.reason);
    }
  }

  res.json({ sent, attempted: targets.length });
});

pushRouter.get('/status', (_req: Request, res: Response) => {
  res.json({ configured: capabilities.push, subscriptions: subscriptions.size });
});
