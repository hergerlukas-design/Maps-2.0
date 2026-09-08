interface ManeuverIconProps {
  type: string;
  modifier?: string;
  className?: string;
}

/**
 * Turn arrows drawn as inline SVG paths.
 *
 * Mapbox's maneuver vocabulary is larger than the set of shapes a driver can
 * distinguish at a glance, so several types share an arrow — a "fork right" and
 * a "slight right" mean the same thing behind the wheel.
 */
function pathFor(type: string, modifier: string | undefined): string {
  const key = `${type}:${modifier ?? ''}`;

  // Roundabouts read better as a loop with an exit than as a plain arrow.
  if (type === 'roundabout' || type === 'rotary' || type === 'roundabout turn') {
    return 'M12 30 L12 22 A7 7 0 1 1 22 15 L28 15 M28 15 L24 11 M28 15 L24 19';
  }
  if (type === 'arrive') {
    return 'M12 30 L12 16 M6 16 L18 16 M12 16 L12 8 M12 8 L26 8 L26 16 L12 16';
  }
  if (type === 'depart') {
    return 'M12 30 L12 10 M12 10 L7 15 M12 10 L17 15';
  }

  switch (key) {
    case 'turn:left':
    case 'end of road:left':
      return 'M20 30 L20 16 L8 16 M8 16 L14 10 M8 16 L14 22';
    case 'turn:right':
    case 'end of road:right':
      return 'M12 30 L12 16 L24 16 M24 16 L18 10 M24 16 L18 22';
    case 'turn:sharp left':
      return 'M20 30 L20 18 L10 26 M10 26 L10 18 M10 26 L18 26';
    case 'turn:sharp right':
      return 'M12 30 L12 18 L22 26 M22 26 L22 18 M22 26 L14 26';
    case 'turn:slight left':
    case 'fork:slight left':
    case 'fork:left':
    case 'on ramp:slight left':
    case 'off ramp:slight left':
    case 'off ramp:left':
    case 'merge:slight left':
    case 'merge:left':
      return 'M18 30 L18 18 L9 9 M9 9 L9 16 M9 9 L16 9';
    case 'turn:slight right':
    case 'fork:slight right':
    case 'fork:right':
    case 'on ramp:slight right':
    case 'off ramp:slight right':
    case 'off ramp:right':
    case 'merge:slight right':
    case 'merge:right':
      return 'M14 30 L14 18 L23 9 M23 9 L23 16 M23 9 L16 9';
    case 'turn:uturn':
    case 'continue:uturn':
      return 'M10 30 L10 16 A6 6 0 0 1 22 16 L22 24 M22 24 L18 20 M22 24 L26 20';
    default:
      // "continue", "new name", "notification" and anything unmapped: straight on.
      return 'M16 30 L16 10 M16 10 L11 15 M16 10 L21 15';
  }
}

export function ManeuverIcon({ type, modifier, className }: ManeuverIconProps) {
  return (
    <svg
      viewBox="0 0 32 36"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth={2.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      role="img"
      aria-label={describeManeuver(type, modifier)}
    >
      <path d={pathFor(type, modifier)} />
    </svg>
  );
}

/** German label for screen readers and the accessible fallback. */
export function describeManeuver(type: string, modifier: string | undefined): string {
  const direction =
    modifier === 'left'
      ? 'links'
      : modifier === 'right'
        ? 'rechts'
        : modifier === 'sharp left'
          ? 'scharf links'
          : modifier === 'sharp right'
            ? 'scharf rechts'
            : modifier === 'slight left'
              ? 'leicht links'
              : modifier === 'slight right'
                ? 'leicht rechts'
                : modifier === 'uturn'
                  ? 'wenden'
                  : 'geradeaus';

  switch (type) {
    case 'depart':
      return 'Losfahren';
    case 'arrive':
      return 'Ziel erreicht';
    case 'roundabout':
    case 'rotary':
      return 'Kreisverkehr';
    case 'merge':
      return `Einfädeln ${direction}`;
    case 'on ramp':
      return `Auffahrt ${direction}`;
    case 'off ramp':
      return `Abfahrt ${direction}`;
    case 'fork':
      return `Gabelung ${direction}`;
    default:
      return direction === 'wenden' ? 'Wenden' : `Abbiegen ${direction}`;
  }
}
