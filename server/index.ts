import express from 'express';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { CapabilitiesResponse } from '../shared/types.js';
import { capabilities, config } from './lib/config.js';
import { stopsRouter } from './routes/stops.js';
import { pushRouter } from './routes/push.js';

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true);

app.use(express.json({ limit: '256kb' }));

/** Only needed when the client is served from a different origin than the API. */
if (config.corsOrigins.length > 0) {
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin && config.corsOrigins.includes(origin)) {
      res.set('access-control-allow-origin', origin);
      res.set('vary', 'Origin');
      res.set('access-control-allow-headers', 'content-type');
      res.set('access-control-allow-methods', 'GET,POST,OPTIONS');
    }
    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    next();
  });
}

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, uptimeS: Math.round(process.uptime()) });
});

app.get('/api/capabilities', (_req, res) => {
  const body: CapabilitiesResponse = capabilities;
  res.json(body);
});

app.use('/api/stops', stopsRouter);
app.use('/api/push', pushRouter);

app.use('/api', (_req, res) => {
  res.status(404).json({
    error: { code: 'bad_request', message: 'Unbekannter API-Endpunkt.' },
  });
});

/* ------------------------------------------------------------------ *
 * Static client (production). In dev, Vite serves the client and
 * proxies /api here, so this block simply finds nothing to serve.
 * ------------------------------------------------------------------ */

const clientDir = path.resolve(process.cwd(), config.clientDir);
if (existsSync(clientDir)) {
  // Hashed assets are immutable; the shell and the service worker are not.
  app.use(
    express.static(clientDir, {
      index: false,
      setHeaders(res, filePath) {
        if (filePath.includes(`${path.sep}assets${path.sep}`)) {
          res.set('cache-control', 'public, max-age=31536000, immutable');
        } else if (filePath.endsWith('sw.js') || filePath.endsWith('.webmanifest')) {
          res.set('cache-control', 'no-cache');
        }
      },
    }),
  );
  // SPA fallback: every non-API path renders the app shell.
  app.get('/*splat', (_req, res) => {
    res.set('cache-control', 'no-cache').sendFile(path.join(clientDir, 'index.html'));
  });
} else {
  console.warn(
    `[server] Kein Client-Build unter ${clientDir} gefunden – es wird nur die API bedient.`,
  );
}

function readVersion(): string {
  try {
    const raw = readFileSync(path.resolve(process.cwd(), 'package.json'), 'utf8');
    return (JSON.parse(raw) as { version?: string }).version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

const server = app.listen(config.port, config.host, () => {
  console.log(
    `[server] reichweite-nav v${readVersion()} lauscht auf http://${config.host}:${config.port}`,
  );
  console.log(
    `[server] Quellen: Tankerkönig=${capabilities.fuelPrices ? 'ja' : 'nein'}, ` +
      `GoingElectric=${capabilities.charging.goingelectric ? 'ja' : 'nein'}, ` +
      `Overpass=ja, Push=${capabilities.push ? 'ja' : 'nein'}`,
  );
});

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    console.log(`[server] ${signal} empfangen, fahre herunter.`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 8000).unref();
  });
}
