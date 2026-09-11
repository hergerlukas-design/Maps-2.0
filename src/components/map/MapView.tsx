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
  theme: MapTheme;
}

const SOURCE_ROUTE = 'route';
const SOURCE_DRIVEN = 'route-driven';
const SOURCE_STOPS = 'stops';
const SOURCE_WAYPOINTS = 'waypoints';

/**
 * Kartenfarben je Thema.
 *
 * Die Werte der Oberfläche stehen als CSS-Variablen zur Verfügung, die
 * Mapbox-Paint-Eigenschaften brauchen aber feste Farben. Sie hier zu
 * verdoppeln ist der Preis dafür — dafür lassen sie sich für die Karte eigens
 * abstimmen: Auf hellem Kartengrund trägt ein kräftigeres Cyan als in der
 * Oberfläche, und die gefahrene Strecke muss sich deutlicher absetzen.
 */
const MAP_COLOURS = {
  dark: {
    route: '#22d3ee',
    routeCasing: '#083344',
    driven: '#334666',
    label: '#e6ecf6',
    labelHalo: '#05080f',
    markerStroke: '#05080f',
    origin: '#34d399',
    destination: '#f87171',
    stops: { fuel: '#34d399', charging: '#a78bfa', rest_area: '#fbbf24', toilets: '#7688ad' },
  },
  light: {
    route: '#0891b2',
    routeCasing: '#ffffff',
    driven: '#94a3b8',
    label: '#0d1622',
    labelHalo: '#ffffff',
    markerStroke: '#ffffff',
    origin: '#047857',
    destination: '#b91c1c',
    stops: { fuel: '#047857', charging: '#6d28d9', rest_area: '#b45309', toilets: '#56637b' },
  },
} as const;

export type MapTheme = keyof typeof MAP_COLOURS;

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
  theme,
}: MapViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<mapboxgl.Map | null>(null);
  const puckRef = useRef<mapboxgl.Marker | null>(null);
  const [ready, setReady] = useState(false);
  const themeRef = useRef(theme);
  themeRef.current = theme;
  const appliedStyleRef = useRef<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const cameraModeRef = useRef(cameraMode);
  cameraModeRef.current = cameraMode;
  /**
   * Der zuletzt bekannte Fahrzustand, als Ref statt als Abhängigkeit.
   * Die Überblicksansicht braucht den Fortschritt, darf aber nicht bei jedem
   * GPS-Fix neu einpassen — sonst reißt sie dem Fahrer die Karte aus der Hand.
   */
  const navRef = useRef<NavState | null>(nav);
  navRef.current = nav;

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
    const initialStyle = theme === 'dark' ? env.mapboxStyle : env.mapboxStyleDay;
    // Unbedingt merken: Ohne das hielte der Effekt weiter unten den
    // Anfangsstil für „noch nicht gesetzt", riefe `setStyle` mit demselben
    // Stil auf und legte die Karte still — Mapbox meldet bei identischem Stil
    // kein `style.load`, und `ready` bliebe für immer false.
    appliedStyleRef.current = initialStyle;
    const map = new mapboxgl.Map({
      container: containerRef.current,
      style: initialStyle,
      center: [10.4515, 51.1657], // Geographic centre of Germany.
      zoom: 5.4,
      pitch: 0,
      // Eigene Platzierung weiter unten: Die Standardposition unten rechts läge
      // unter dem Sheet und würde dort eine Schaltfläche überdecken.
      attributionControl: false,
      // The app draws its own gestures hints; the compass/zoom controls are hidden.
      logoPosition: 'bottom-right',
      // Keeps label rendering crisp without the cost of a full 3D globe.
      projection: { name: 'mercator' },
      fadeDuration: 120,
    });
    mapRef.current = map;

    // Die Attribution ist vertraglich gefordert und muss sichtbar bleiben. In
    // kompakter Form oben rechts steht sie nie im Weg — unten rechts läge sie
    // unter dem Ziel-Sheet.
    map.addControl(
      new mapboxgl.AttributionControl({ compact: true }),
      'top-right',
    );

    /**
     * Legt Quellen, Ebenen und Ereignisse an.
     *
     * Bewusst als eigene Funktion: `setStyle` beim Themenwechsel verwirft
     * sämtliche eigenen Quellen und Ebenen. Sie müssen danach vollständig neu
     * angelegt werden, sonst verschwinden Route und Marker.
     */
    const installLayers = (colours: (typeof MAP_COLOURS)[MapTheme]) => {
      // Nach einem Stilwechsel sind die Quellen weg; ein doppelter Aufruf darf
      // aber trotzdem nicht mit „source already exists" abbrechen.
      if (map.getSource(SOURCE_ROUTE)) return;

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
          'line-color': colours.routeCasing,
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
          'line-color': colours.route,
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
          'line-color': colours.driven,
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
          'circle-stroke-color': colours.markerStroke,
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
          'circle-stroke-color': colours.markerStroke,
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
          'text-color': colours.label,
          'text-halo-color': colours.labelHalo,
          'text-halo-width': 1.4,
        },
      });

    };

    /*
     * Ereignisse für die Stopp-Ebene werden genau einmal registriert, nicht in
     * `installLayers`: Sie hängen am Kartenobjekt, nicht am Stil, und
     * überstehen einen Stilwechsel. In `installLayers` würden sie sich mit
     * jedem Wechsel vervielfachen.
     */
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

    /*
     * `style.load` feuert beim ersten Laden UND nach jedem Stilwechsel. Eine
     * einzige Stelle für das Anlegen der Ebenen ist deshalb ausreichend — und
     * verlässlicher als ein zusätzliches `load` mit einem Merker, welcher der
     * beiden Fälle gerade vorliegt.
     */
    map.on('style.load', () => {
      installLayers(MAP_COLOURS[themeRef.current]);
      setReady(true);
    });

    map.on('error', (event) => {
      const message = event.error?.message ?? 'Unbekannter Kartenfehler.';
      // Missing tiles during signal loss are normal; only surface real failures.
      if (/token|unauthorized|forbidden/i.test(message)) {
        setError(`Karte konnte nicht geladen werden: ${message}`);
      }
    });

    /**
     * Eine Geste des Fahrers löst die Kamera aus dem Folgemodus.
     *
     * Entscheidend ist `originalEvent`: Mapbox setzt es nur bei echten
     * Eingaben, nicht bei `easeTo`/`fitBounds`. Ein Zeit-Flag taugt hier
     * nicht — die Folgekamera bewegt sich im Sekundentakt, sodass ein solches
     * Flag dauerhaft gesetzt wäre und jede Geste verschluckte.
     */
    // Mapbox deklariert `originalEvent` nicht auf allen Event-Typen, obwohl es
    // zur Laufzeit bei Eingaben gesetzt ist — deshalb die Prüfung im Helfer.
    const isUserGesture = (event: unknown): boolean =>
      (event as { originalEvent?: unknown } | undefined)?.originalEvent != null;

    const dropToFree = (event: unknown) => {
      if (!isUserGesture(event)) return;
      if (cameraModeRef.current !== 'free') onCameraModeChange('free');
    };

    map.on('dragstart', (event) => dropToFree(event));
    map.on('zoomstart', (event) => dropToFree(event));
    map.on('rotatestart', (event) => dropToFree(event));
    map.on('pitchstart', (event) => dropToFree(event));

    return () => {
      map.remove();
      mapRef.current = null;
      setReady(false);
    };
    // Mount once: re-creating the map on a prop change would reset the camera.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Kartenstil dem Thema folgen lassen.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const wanted = theme === 'dark' ? env.mapboxStyle : env.mapboxStyleDay;
    // Der zuletzt gesetzte Stil wird selbst gemerkt; `getStyle()` taugt nicht
    // als Vergleichswert, weil Mapbox dort die aufgelöste Fassung liefert.
    if (appliedStyleRef.current === wanted) return;
    appliedStyleRef.current = wanted;
    // `ready` kurz zurücknehmen: Nach `style.load` laufen damit alle Effekte
    // erneut, die Daten in die Quellen schreiben, und die Route ist sofort
    // wieder da, ohne eigenen Wiederherstellungs-Code.
    setReady(false);
    map.setStyle(wanted);
  }, [theme]);

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

  const colours = MAP_COLOURS[theme];

  const stopFeatures = useMemo<GeoJSON.FeatureCollection>(
    () => ({
      type: 'FeatureCollection',
      features: candidates.map((ranked) => ({
        type: 'Feature' as const,
        properties: {
          label: ranked.stop.name,
          colour: colours.stops[ranked.stop.kind] ?? colours.route,
          highlighted: ranked.stop.id === highlightedStopId,
          stop: JSON.stringify(ranked.stop),
        },
        geometry: {
          type: 'Point' as const,
          coordinates: toPosition(ranked.stop.location),
        },
      })),
    }),
    [candidates, highlightedStopId, colours],
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
              ? colours.destination
              : waypoint.kind === 'origin'
                ? colours.origin
                : (colours.stops[waypoint.kind] ?? colours.route),
        },
        geometry: { type: 'Point' as const, coordinates: toPosition(waypoint.location) },
      })),
    });
  }, [waypoints, ready, colours]);

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
          <circle cx="20" cy="20" r="17" fill="${colours.route}" fill-opacity="0.18" />
          <circle cx="20" cy="20" r="11" fill="${colours.labelHalo}" stroke="${colours.route}" stroke-width="2.5" />
          <path d="M20 10 L26 24 L20 21 L14 24 Z" fill="${colours.route}" />
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
  }, [nav, ready, colours]);

  /* ---------------------------------------------------------------- *
   * Camera
   * ---------------------------------------------------------------- */

  // Folgekamera: läuft bewusst bei jedem Fix — das ist ihr Zweck.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready || cameraMode !== 'follow' || !nav) return;
    map.easeTo({
      center: nav.snapped,
      bearing: nav.courseDeg,
      // Je schneller gefahren wird, desto weiter muss man nach vorne sehen.
      zoom: nav.speedMps > 25 ? 15 : nav.speedMps > 8 ? 16 : 16.8,
      pitch: 55,
      // Mittelpunkt nach unten versetzt, damit der Großteil des Bildes die
      // Straße voraus zeigt.
      padding: { top: 220, bottom: 0, left: 0, right: 0 },
      duration: 900,
      easing: (t) => t,
    });
  }, [cameraMode, nav, ready]);

  // Überblick: einmal einpassen beim Wechsel in den Modus und bei neuer Route.
  // Bewusst ohne `nav` in den Abhängigkeiten, sonst würde jeder GPS-Fix die
  // Ansicht zurücksetzen und Zoomen unmöglich machen.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready || cameraMode !== 'overview') return;
    if (!line || line.coordinates.length < 2) return;

    const progressM = navRef.current?.progressM ?? 0;
    const remaining =
      progressM > 0 ? sliceLine(line, progressM, line.totalLengthM) : line.coordinates;
    const bounds = boundsOf(remaining, 0.12);
    if (!bounds) return;

    map.fitBounds(bounds, {
      padding: { top: 160, bottom: 220, left: 48, right: 48 },
      bearing: 0,
      pitch: 0,
      duration: 900,
    });
  }, [cameraMode, line, ready]);

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
    // Programmatisch, trägt also kein `originalEvent` und wirft die Kamera
    // nicht in den freien Modus.
    map.fitBounds(bounds, {
      padding: { top: 120, bottom: 300, left: 40, right: 40 },
      duration: 800,
    });
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
