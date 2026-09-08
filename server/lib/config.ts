function optional(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function int(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export const config = {
  port: int(process.env.PORT, 8787),
  host: process.env.HOST ?? '0.0.0.0',
  nodeEnv: process.env.NODE_ENV ?? 'development',
  /** Directory of the built client bundle; served in production. */
  clientDir: process.env.CLIENT_DIR ?? 'dist',

  tankerkoenig: {
    apiKey: optional(process.env.TANKERKOENIG_API_KEY),
    baseUrl:
      process.env.TANKERKOENIG_BASE_URL ?? 'https://creativecommons.tankerkoenig.de',
    /** Tankerkönig's terms ask for at most one request per query per 5 minutes. */
    cacheTtlMs: int(process.env.TANKERKOENIG_CACHE_TTL_MS, 5 * 60_000),
    /** Hard API limit on the search radius, in km. */
    maxRadiusKm: 25,
  },

  goingElectric: {
    apiKey: optional(process.env.GOINGELECTRIC_API_KEY),
    baseUrl: process.env.GOINGELECTRIC_BASE_URL ?? 'https://api.goingelectric.de',
    cacheTtlMs: int(process.env.GOINGELECTRIC_CACHE_TTL_MS, 10 * 60_000),
    maxRadiusKm: 25,
  },

  openChargeMap: {
    apiKey: optional(process.env.OPENCHARGEMAP_API_KEY),
    baseUrl: process.env.OPENCHARGEMAP_BASE_URL ?? 'https://api.openchargemap.io',
    cacheTtlMs: int(process.env.OPENCHARGEMAP_CACHE_TTL_MS, 10 * 60_000),
    maxRadiusKm: 25,
  },

  overpass: {
    baseUrl: process.env.OVERPASS_BASE_URL ?? 'https://overpass-api.de/api/interpreter',
    cacheTtlMs: int(process.env.OVERPASS_CACHE_TTL_MS, 30 * 60_000),
    /** Overpass is a shared community resource: one request at a time. */
    minIntervalMs: int(process.env.OVERPASS_MIN_INTERVAL_MS, 1200),
    timeoutMs: int(process.env.OVERPASS_TIMEOUT_MS, 25_000),
  },

  push: {
    publicKey: optional(process.env.VAPID_PUBLIC_KEY),
    privateKey: optional(process.env.VAPID_PRIVATE_KEY),
    subject: process.env.VAPID_SUBJECT ?? 'mailto:admin@example.com',
  },

  /** Comma-separated list of allowed origins; empty means same-origin only. */
  corsOrigins: (process.env.CORS_ORIGINS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
} as const;

export const capabilities = {
  fuelPrices: config.tankerkoenig.apiKey !== null,
  charging: {
    goingelectric: config.goingElectric.apiKey !== null,
    // Open Charge Map serves a limited quota without a key.
    openchargemap: true,
  },
  amenities: true,
  push: config.push.publicKey !== null && config.push.privateKey !== null,
};
