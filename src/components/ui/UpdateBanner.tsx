interface UpdateBannerProps {
  /** Während der Fahrt wird zurückhaltender formuliert — ein Neuladen
   *  verwirft die laufende Navigation. */
  navigating: boolean;
  onApply: () => void;
  onDismiss: () => void;
}

/**
 * Hinweis auf eine bereitstehende neue Fassung.
 *
 * Bewusst kein automatisches Neuladen: Während der Navigation würde das die
 * laufende Fahrt verwerfen. Der Fahrer entscheidet, wann es passt.
 */
export function UpdateBanner({ navigating, onApply, onDismiss }: UpdateBannerProps) {
  return (
    <div
      className="pointer-events-auto px-3 pb-2"
      role="status"
      aria-live="polite"
    >
      <div className="panel flex items-center gap-3 rounded-2xl px-3.5 py-2.5">
        <svg
          viewBox="0 0 24 24"
          className="size-5 shrink-0 text-route-500"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.9}
          aria-hidden="true"
        >
          <path d="M20 12a8 8 0 1 1-2.3-5.6M20 4v4h-4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>

        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-ink-100">Neue Version verfügbar</p>
          <p className="text-xs leading-snug text-ink-400">
            {navigating
              ? 'Wird nach der Fahrt übernommen — Neuladen würde die Navigation beenden.'
              : 'Kurz neu laden, dann ist die App aktuell.'}
          </p>
        </div>

        {!navigating && (
          <button
            type="button"
            onClick={onApply}
            className="touch-target shrink-0 rounded-xl bg-route-500 px-3 text-sm font-bold text-ink-950 active:bg-route-600"
          >
            Neu laden
          </button>
        )}

        <button
          type="button"
          onClick={onDismiss}
          aria-label="Hinweis ausblenden"
          className="touch-target grid shrink-0 place-items-center rounded-full text-ink-400 active:text-ink-100"
        >
          <svg viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth={2}>
            <path d="M6 6l12 12M18 6L6 18" strokeLinecap="round" />
          </svg>
        </button>
      </div>
    </div>
  );
}
