/**
 * Einordnung von Mapbox-Fehlern für die Anzeige.
 *
 * Bewusst als eigene, reine Funktion: Die Regel ist dünn, aber sie war schon
 * einmal falsch (siehe unten) und lässt sich hier ohne Karte prüfen.
 */

/**
 * Liefert den Hinweis, der dem Fahrer gezeigt werden soll — oder `null`, wenn
 * der Fehler keiner ist, den er sehen muss.
 *
 * Ausschlaggebend ist der HTTP-Status, nicht der Wortlaut. Mapbox schreibt die
 * gescheiterte URL in die Meldung, und in der steht `access_token=`; eine Suche
 * nach „token“ im Text stufte deshalb jede vorübergehend gescheiterte Kachel
 * als Authentifizierungsproblem ein.
 *
 * Der Wortlaut wird außerdem nie zurückgegeben — er enthält das Token im
 * Klartext, das auf einem Bildschirmfoto sonst mitgeht.
 */
export function mapErrorNotice(error: unknown): string | null {
  const status = (error as { status?: number } | null | undefined)?.status;

  // Einzelne Kacheln scheitern bei schwachem Netz ständig. Mapbox holt sie von
  // selbst nach; das ist kein Zustand, der die Karte verstellen darf.
  if (status !== 401 && status !== 403) return null;

  return 'Mapbox verweigert den Zugriff. Bitte Token und dessen URL-Beschränkung prüfen.';
}
