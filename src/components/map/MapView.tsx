import { useEffect, useMemo, useRef, useState } from 'react';
import mapboxgl from 'mapbox-gl';
import type { RankedStop, Position, Stop } from '@shared/types';
import type { StopWaypoint } from '@/types/domain';
import { env, hasMapbox } from '@/config/env';
import { boundsOf, sliceLine, toPosition, type MeasuredLine } from '@/lib/geo';
import type { NavState } from '@/navigation/engine';

/** How the camera behaves. */
export type CameraMode =
  /** Locked behind the car, rotated to the direction of travel. */
  | 'follow'
  /** North-up overview of the whole remaining route. */
  | 'overview'
  /** The driver panned; the camera stays where they left it. */
  | 'free';

export interface MapViewProps {
  line: MeasuredLine | null;
  nav: NavState | null;
  waypoints: StopWaypoint[];
  /** Candidate stops shown while the picker is open. */
  candidates: RankedStop[];
  /** Highlighted candidate, drawn larger. */
  highlightedStopId: string | null;
  cameraMode: CameraMode;
  onCameraModeChange: (mode: CameraMode) => void;
  onStopClick?: (stop: Stop) => void;
}

const SOURCE_ROUTE = 'route';
const SOURCE_DRIVEN = 'route-driven';
const SOURCE_STOPS = 'stops';
const SOURCE_WAYPOINTS = 'waypoints';

const STOP_COLOURS: Record<string, string> = {
  fuel: '#34d399',
  charging: '#a78bfa',
  rest_area: '#fbbf24',
  toilets: '#7688ad',
};

function emptyCollection(): GeoJSON.FeatureCollection {
  return { type: 'FeatureCollection', features: [] };
}

function lineFeature(coordinates: Position[]): GeoJSON.Feature<GeoJSON.LineString> {
  return {
    type: 'Feature',
    properties: {},
    geometry: { type: 'LineString', coordinates },
  };
}

/**
 * The Mapbox layer beneath the app's own UI.
 *
 * Everything here is imperative on purpose. The camera and the route sources are
 * updated on every GPS fix, and routing that through React state would mean a
 * full render pass per second for data React never reads.
 */
export function MapView({
  line,
  nav,
  waypoints,
  candidates,
  highlightedStopId,
  cameraMode,
  onCameraModeChange,
  onStopClick,
}: MapViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<mapboxgl.Map | null>(null);
  const puckRef = useRef<mapboxgl.Marker | null>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Suppresses the "driver panned" detection while we move the camera. */
  const programmaticMoveRef = useRef(false);
  const cameraModeRef = useRef(cameraMode);
  cameraModeRef.current = cameraMode;

  /* ---------------------------------------------------------------- *
   * Map lifecycle
   * ---------------------------------------------------------------- */

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    if (!hasMapbox) {
      setError(
        'Kein Mapbox-Token konfiguriert. Bitte VITE_MAPBOX_TOKEN setzen, ' +
          'dann erscheint hier die Karte.',
      );
      return;
    }

    mapboxgl.accessToken = env.mapboxToken!;
    const map = new mapboxgl.Map({
      container: containerRef.current,
      style: env.mapboxStyle,
      center: [10.4515, 51.1657], // Geographic centre of Germany.
      zoom: 5.4,
      pitch: 0,
      attributionControl: true,
      // The app draws its own gestures hints; the compass/zoom controls are hidden.
      logoPosition: 'bottom-right',
      // Keeps label rendering crisp without the cost of a full 3D globe.
      projection: { name: 'mercator' },
      fadeDuration: 120,
    });
    mapRef.current = map;

    map.on('load', () => {
      map.addSource(SOURCE_ROUTE, { type: 'geojson', data: emptyCollection() });
      map.addSource(SOURCE_DRIVEN, { type: 'geojson', data: emptyCollection() });
      map.addSource(SOURCE_STOPS, { type: 'geojson', data: emptyCollection() });
      map.addSource(SOURCE_WAYPOINTS, { type: 'geojson', data: emptyCollection() });

      // A casing beneath the route line keeps it legible over motorway shields
      // and dense city labels.
      map.addLayer({
        id: 'route-casing',
        type: 'line',
        source: SOURCE_ROUTE,
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': '#083344',
          'line-width': ['interpolate', ['linear'], ['zoom'], 6, 6, 12, 14, 16, 22],
          'line-opacity': 0.9,
        },
      });
      map.addLayer({
        id: 'route-line',
        type: 'line',
        source: SOURCE_ROUTE,
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': '#22d3ee',
          'line-width': ['interpolate', ['linear'], ['zoom'], 6, 3, 12, 8, 16, 14],
        },
      });
      // The part already driven, dimmed so progress is visible at a glance.
      map.addLayer({
        id: 'route-driven-line',
        type: 'line',
        source: SOURCE_DRIVEN,
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': '#334666',
          'line-width': ['interpolate', ['linear'], ['zoom'], 6, 3, 12, 8, 16, 14],
        },
      });

      map.addLayer({
        id: 'waypoint-circles',
        type: 'circle',
        source: SOURCE_WAYPOINTS,
        paint: {
          'circle-radius': 7,
          'circle-color': ['get', 'colour'],
          'circle-stroke-width': 2.5,
          'circle-stroke-color': '#05080f',
        },
      });

      map.addLayer({
        id: 'stop-circles',
        type: 'circle',
        source: SOURCE_STOPS,
        paint: {
          'circle-radius': ['case', ['get', 'highlighted'], 13, 9],
          'circle-color': ['get', 'colour'],
          'circle-opacity': 0.95,
          'circle-stroke-width': 2,
          'circle-stroke-color': '#05080f',
        },
      });
      map.addLayer({
        id: 'stop-labels',
        type: 'symbol',
        source: SOURCE_STOPS,
        layout: {
          'text-field': ['get', 'label'],
          'text-size': 11,
          'text-offset': [0, 1.6],
          'text-anchor': 'top',
          'text-allow-overlap': false,
        },
        paint: {
          'text-color': '#e6ecf6',
          'text-halo-color': '#05080f',
          'text-halo-width': 1.4,
        },
      });

      map.on('click', 'stop-circles', (event) => {
        // Mapbox types queried features without their properties bag, so the
        // JSON payload attached above has to be read through a narrow cast.
        const feature = event.features?.[0] as
          | { properties?: Record<string, unknown> }
          | undefined;
        const raw = feature?.properties?.['stop'];
        if (typeof raw !== 'string') return;
        try {
          onStopClick?.(JSON.parse(raw) as Stop);
        } catch {
          // A malformed property is not worth crashing the map over.
        }
      });
      map.on('mouseenter', 'stop-circles', () => {
        map.getCanvas().style.cursor = 'pointer';
      });
      map.on('mouseleave', 'stop-circles', () => {
        map.getCanvas().style.cursor = '';
      });

      setReady(true);
    });

    map.on('error', (event) => {
      const message = event.error?.message ?? 'Unbekannter Kartenfehler.';
      // Missing tiles during signal loss are normal; only surface real failures.
      if (/token|unauthorized|forbidden/i.test(message)) {
        setError(`Karte konnte nicht geladen werden: ${message}`);
      }
    });

    /** Any drag/zoom the driver initiates drops the camera out of follow mode. */
    const onUserInteraction = () => {
      if (programmaticMoveRef.current) return;
      if (cameraModeRef.current !== 'free') onCameraModeChange('free');
    };
    map.on('dragstart', onUserInteraction);
    map.on('zoomstart', onUserInteraction);
    map.on('rotatestart', onUserInteraction);

    return () => {
      map.remove();
      mapRef.current = null;
      setReady(false);
    };
    // Mount once: re-creating the map on a prop change would reset the camera.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ---------------------------------------------------------------- *
   * Route geometry
   * ---------------------------------------------------------------- */

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const source = map.getSource(SOURCE_ROUTE) as mapboxgl.GeoJSONSource | undefined;
    if (!source) return;
    source.setData(
      line && line.coordinates.length > 1
        ? lineFeature(line.coordinates)
        : emptyCollection(),
    );
  }, [line, ready]);

  // Progress is redrawn on each fix; slicing the line is cheap because the
  // cumulative distances are precomputed.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const source = map.getSource(SOURCE_DRIVEN) as mapboxgl.GeoJSONSource | undefined;
    if (!source) return;
    if (!line || !nav || nav.progressM <= 0) {
      source.setData(emptyCollection());
      return;
    }
    source.setData(lineFeature(sliceLine(line, 0, nav.progressM)));
  }, [line, nav, ready]);

  /* ---------------------------------------------------------------- *
   * Markers
   * ---------------------------------------------------------------- */

  const stopFeatures = useMemo<GeoJSON.FeatureCollection>(
    () => ({
      type: 'FeatureCollection',
      features: candidates.map((ranked) => ({
        type: 'Feature' as const,
        properties: {
          label: ranked.stop.name,
          colour: STOP_COLOURS[ranked.stop.kind] ?? '#22d3ee',
          highlighted: ranked.stop.id === highlightedStopId,
          stop: JSON.stringify(ranked.stop),
        },
        geometry: {
          type: 'Point' as const,
          coordinates: toPosition(ranked.stop.location),
        },
      })),
    }),
    [candidates, highlightedStopId],
  );

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const source = map.getSource(SOURCE_STOPS) as mapboxgl.GeoJSONSource | undefined;
    source?.setData(stopFeatures);
  }, [stopFeatures, ready]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const source = map.getSource(SOURCE_WAYPOINTS) as mapboxgl.GeoJSONSource | undefined;
    source?.setData({
      type: 'FeatureCollection',
      features: waypoints.map((waypoint) => ({
        type: 'Feature' as const,
        properties: {
          colour:
            waypoint.kind === 'destination'
              ? '#f87171'
              : waypoint.kind === 'origin'
                ? '#34d399'
                : (STOP_COLOURS[waypoint.kind] ?? '#22d3ee'),
        },
        geometry: { type: 'Point' as const, coordinates: toPosition(waypoint.location) },
      })),
    });
  }, [waypoints, ready]);

  /* ---------------------------------------------------------------- *
   * The puck
   * ---------------------------------------------------------------- */

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;

    if (!nav) {
      puckRef.current?.remove();
      puckRef.current = null;
      return;
    }

    if (!puckRef.current) {
      const element = document.createElement('div');
      element.className = 'nav-puck';
      element.innerHTML = `
        <svg viewBox="0 0 40 40" width="40" height="40" aria-hidden="true">
          <circle cx="20" cy="20" r="17" fill="#22d3ee" fill-opacity="0.18" />
          <circle cx="20" cy="20" r="11" fill="#0b1120" stroke="#22d3ee" stroke-width="2.5" />
          <path d="M20 10 L26 24 L20 21 L14 24 Z" fill="#22d3ee" />
        </svg>`;
      puckRef.current = new mapboxgl.Marker({
        element,
        rotationAlignment: 'map',
        pitchAlignment: 'map',
      })
        .setLngLat(nav.snapped)
        .addTo(map);
    }

    puckRef.current.setLngLat(nav.snapped);
    puckRef.current.setRotation(nav.courseDeg);
  }, [nav, ready]);

  /* ---------------------------------------------------------------- *
   * Camera
   * ---------------------------------------------------------------- */

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;

    if (cameraMode === 'follow' && nav) {
      programmaticMoveRef.current = true;
      map.easeTo({
        center: nav.snapped,
        bearing: nav.courseDeg,
        // A driver needs to see further ahead the faster they go.
        zoom: nav.speedMps > 25 ? 15 : nav.speedMps > 8 ? 16 : 16.8,
        pitch: 55,
        // Offset the centre downwards so most of the screen shows the road ahead.
        padding: { top: 220, bottom: 0, left: 0, right: 0 },
        duration: 900,
        easing: (t) => t,
      });
      // `easeTo` fires movestart synchronously; clear the flag after it settles.
      const timer = setTimeout(() => {
        programmaticMoveRef.current = false;
      }, 950);
      return () => clearTimeout(timer);
    }

    if (cameraMode === 'overview' && line && line.coordinates.length > 1) {
      const remaining = nav
        ? sliceLine(line, nav.progressM, line.totalLengthM)
        : line.coordinates;
      const bounds = boundsOf(remaining, 0.12);
      if (!bounds) return;
      programmaticMoveRef.current = true;
      map.fitBounds(bounds, {
        padding: { top: 160, bottom: 220, left: 48, right: 48 },
        bearing: 0,
        pitch: 0,
        duration: 900,
      });
      const timer = setTimeout(() => {
        programmaticMoveRef.current = false;
      }, 950);
      return () => clearTimeout(timer);
    }
    return;
  }, [cameraMode, nav, line, ready]);

  /* ---------------------------------------------------------------- *
   * Fit the whole route once, when it first appears
   * ---------------------------------------------------------------- */

  const fittedRouteRef = useRef<MeasuredLine | null>(null);
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready || !line || line.coordinates.length < 2) return;
    if (fittedRouteRef.current === line) return;
    fittedRouteRef.current = line;
    const bounds = boundsOf(line.coordinates, 0.1);
    if (!bounds) return;
    programmaticMoveRef.current = true;
    map.fitBounds(bounds, {
      padding: { top: 120, bottom: 300, left: 40, right: 40 },
      duration: 800,
    });
    const timer = setTimeout(() => {
      programmaticMoveRef.current = false;
    }, 850);
    return () => clearTimeout(timer);
  }, [line, ready]);

  return (
    <div className="absolute inset-0">
      <div ref={containerRef} className="h-full w-full" />
      {error && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center p-6">
          {/* `break-words`: Mapbox errors quote the failing URL, which has no
              spaces to wrap at and would otherwise overflow the panel. */}
          <p className="panel max-w-sm rounded-2xl p-4 text-sm break-words text-ink-200">
            {error}
          </p>
        </div>
      )}
    </div>
  );
}
