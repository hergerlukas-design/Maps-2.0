import { Router, type Request, type Response } from 'express';
import type {
  AmenitySearchRequest,
  ChargingSearchRequest,
  ConnectorType,
  FuelKind,
  FuelSearchRequest,
  SearchResponse,
} from '../../shared/types.js';
import { FUEL_KINDS } from '../../shared/types.js';
import { config } from '../lib/config.js';
import {
  dedupeCorridorPoints,
  parseCorridor,
  ValidationError,
} from '../lib/validate.js';
import { ProviderError, searchFuelStops } from '../providers/tankerkoenig.js';
import { searchChargingStops } from '../providers/charging.js';
import { searchAmenityStops } from '../providers/overpass.js';

export const stopsRouter = Router();

function fail(res: Response, error: unknown): void {
  if (error instanceof ValidationError) {
    res.status(400).json({ error: { code: 'bad_request', message: error.message } });
    return;
  }
  if (error instanceof ProviderError) {
    const status =
      error.kind === 'not_configured' ? 503 : error.kind === 'rate_limited' ? 429 : 502;
    const code =
      error.kind === 'not_configured'
        ? 'not_configured'
        : error.kind === 'rate_limited'
          ? 'rate_limited'
          : 'upstream_error';
    res
      .status(status)
      .json({ error: { code, message: error.message, ...(status === 429 ? { retryAfter: 60 } : {}) } });
    return;
  }
  console.error('[stops] unerwarteter Fehler:', error);
  res.status(500).json({
    error: { code: 'internal', message: 'Interner Serverfehler bei der Stopp-Suche.' },
  });
}

/* ------------------------------------------------------------------ *
 * POST /api/stops/fuel
 * ------------------------------------------------------------------ */

stopsRouter.post('/fuel', async (req: Request, res: Response) => {
  try {
    const corridor = parseCorridor(req.body, config.tankerkoenig.maxRadiusKm);
    const body = req.body as Partial<FuelSearchRequest>;
    const fuel = body.fuel;
    if (!fuel || !FUEL_KINDS.includes(fuel as FuelKind)) {
      throw new ValidationError('`fuel` muss e5, e10 oder diesel sein.');
    }

    const points = dedupeCorridorPoints(corridor.points, corridor.radiusKm);
    const result = await searchFuelStops(points, corridor.radiusKm, fuel as FuelKind);

    const payload: SearchResponse = {
      stops: result.stops.slice(0, corridor.limit),
      meta: {
        sources: ['tankerkoenig'],
        queriedPoints: points.length,
        cached: result.cached,
        warnings: result.warnings,
      },
    };
    res.set('cache-control', 'private, max-age=60').json(payload);
  } catch (error) {
    fail(res, error);
  }
});

/* ------------------------------------------------------------------ *
 * POST /api/stops/charging
 * ------------------------------------------------------------------ */

const VALID_CONNECTORS: readonly ConnectorType[] = [
  'ccs',
  'chademo',
  'type2',
  'type2_socket',
  'tesla_supercharger',
  'schuko',
  'other',
];

stopsRouter.post('/charging', async (req: Request, res: Response) => {
  try {
    const corridor = parseCorridor(req.body, config.goingElectric.maxRadiusKm);
    const body = req.body as Partial<ChargingSearchRequest>;

    const requested = Array.isArray(body.connectors) ? body.connectors : [];
    const connectors = requested.filter((c): c is ConnectorType =>
      VALID_CONNECTORS.includes(c),
    );
    const minPowerKw =
      typeof body.minPowerKw === 'number' && Number.isFinite(body.minPowerKw)
        ? Math.max(0, Math.min(400, body.minPowerKw))
        : 0;

    const points = dedupeCorridorPoints(corridor.points, corridor.radiusKm);
    const result = await searchChargingStops(points, corridor.radiusKm, {
      connectors,
      minPowerKw,
      limit: corridor.limit,
    });

    const payload: SearchResponse = {
      stops: result.stops.slice(0, corridor.limit),
      meta: {
        sources: result.sources,
        queriedPoints: points.length,
        cached: result.cached,
        warnings: result.warnings,
      },
    };
    res.set('cache-control', 'private, max-age=120').json(payload);
  } catch (error) {
    fail(res, error);
  }
});

/* ------------------------------------------------------------------ *
 * POST /api/stops/amenities
 * ------------------------------------------------------------------ */

stopsRouter.post('/amenities', async (req: Request, res: Response) => {
  try {
    // Overpass handles the whole corridor in one query, so allow the full radius.
    const corridor = parseCorridor(req.body, 25);
    const body = req.body as Partial<AmenitySearchRequest>;
    const requested = Array.isArray(body.kinds) ? body.kinds : [];
    const kinds = requested.filter(
      (k): k is 'rest_area' | 'toilets' => k === 'rest_area' || k === 'toilets',
    );
    if (kinds.length === 0) {
      throw new ValidationError('`kinds` muss rest_area und/oder toilets enthalten.');
    }

    // Overpass charges by area, so thin the corridor more aggressively.
    const points = dedupeCorridorPoints(corridor.points, corridor.radiusKm).slice(0, 12);
    const result = await searchAmenityStops(points, corridor.radiusKm, kinds);

    const payload: SearchResponse = {
      stops: result.stops.slice(0, corridor.limit),
      meta: {
        sources: ['overpass'],
        queriedPoints: points.length,
        cached: result.cached,
        warnings: result.warnings,
      },
    };
    res.set('cache-control', 'private, max-age=600').json(payload);
  } catch (error) {
    fail(res, error);
  }
});
