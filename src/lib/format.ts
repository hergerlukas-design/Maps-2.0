const kmFormatter = new Intl.NumberFormat('de-DE', { maximumFractionDigits: 0 });
const kmFineFormatter = new Intl.NumberFormat('de-DE', {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});
const priceFormatter = new Intl.NumberFormat('de-DE', {
  style: 'currency',
  currency: 'EUR',
  minimumFractionDigits: 3,
  maximumFractionDigits: 3,
});
const clockFormatter = new Intl.DateTimeFormat('de-DE', {
  hour: '2-digit',
  minute: '2-digit',
});

/** Distances the way a nav app shows them: metres up close, km further out. */
export function formatDistance(meters: number): string {
  if (!Number.isFinite(meters)) return '–';
  if (meters < 20) return 'jetzt';
  if (meters < 1000) return `${Math.round(meters / 10) * 10} m`;
  if (meters < 10_000) return `${kmFineFormatter.format(meters / 1000)} km`;
  return `${kmFormatter.format(meters / 1000)} km`;
}

export function formatKm(km: number): string {
  if (!Number.isFinite(km)) return '–';
  return `${kmFormatter.format(Math.round(km))} km`;
}

export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '–';
  const total = Math.round(seconds / 60);
  const hours = Math.floor(total / 60);
  const minutes = total % 60;
  if (hours === 0) return `${minutes} min`;
  return `${hours} h ${String(minutes).padStart(2, '0')} min`;
}

/** Arrival clock time, e.g. "14:35". */
export function formatEta(seconds: number, now = Date.now()): string {
  if (!Number.isFinite(seconds)) return '–';
  return clockFormatter.format(new Date(now + seconds * 1000));
}

export function formatPrice(euro: number | null | undefined): string {
  if (euro == null || !Number.isFinite(euro)) return '–';
  return priceFormatter.format(euro);
}

export function formatPower(kw: number | null | undefined): string {
  if (kw == null || !Number.isFinite(kw)) return '–';
  return `${kmFormatter.format(kw)} kW`;
}

/** "in 12 km" / "in 350 m" — used in the maneuver banner. */
export function formatIn(meters: number): string {
  const d = formatDistance(meters);
  return d === 'jetzt' ? 'jetzt' : `in ${d}`;
}
