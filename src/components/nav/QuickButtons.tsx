import type { StopKind } from '@shared/types';

interface QuickButtonsProps {
  onSelect: (kind: StopKind) => void;
  /** Disabled while a search is already running. */
  busy: boolean;
  /** Charging is only offered to vehicles that can use it. */
  showCharging: boolean;
  showFuel: boolean;
}

interface QuickAction {
  kind: StopKind;
  label: string;
  icon: React.ReactNode;
  accent: string;
}

/**
 * The manual search buttons from the briefing.
 *
 * These are independent of the range threshold: pressing "Toilette" searches
 * forward from the current position whatever the tank says.
 */
export function QuickButtons({
  onSelect,
  busy,
  showCharging,
  showFuel,
}: QuickButtonsProps) {
  const actions: QuickAction[] = [
    ...(showFuel
      ? [
          {
            kind: 'fuel' as const,
            label: 'Tankstelle',
            accent: 'text-go-500',
            icon: (
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9}>
                <path d="M5 21V5a2 2 0 0 1 2-2h5a2 2 0 0 1 2 2v16M4 21h11M7 8h5" strokeLinecap="round" />
                <path d="M14 8h3l2 2v8a1.5 1.5 0 0 0 3 0v-6l-2-2" strokeLinecap="round" />
              </svg>
            ),
          },
        ]
      : []),
    ...(showCharging
      ? [
          {
            kind: 'charging' as const,
            label: 'Ladesäule',
            accent: 'text-charge-500',
            icon: (
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9}>
                <path d="M13 3 6 13h5l-1 8 7-10h-5l1-8Z" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            ),
          },
        ]
      : []),
    {
      kind: 'rest_area',
      label: 'Rastplatz',
      accent: 'text-warn-500',
      icon: (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9}>
          <path d="M4 20V8l8-4 8 4v12M4 20h16M9 20v-5h6v5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      ),
    },
    {
      kind: 'toilets',
      label: 'Toilette',
      accent: 'text-ink-300',
      icon: (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9}>
          <circle cx="8" cy="5" r="2" />
          <path d="M8 9v11M5 12h6M6 20h4" strokeLinecap="round" />
          <circle cx="17" cy="5" r="2" />
          <path d="M17 9 14.5 16h5L17 9ZM17 16v4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      ),
    },
  ];

  return (
    <div className="flex gap-2" role="group" aria-label="Stopp in der Nähe suchen">
      {actions.map((action) => (
        <button
          key={action.kind}
          type="button"
          onClick={() => onSelect(action.kind)}
          disabled={busy}
          className="panel touch-target flex flex-1 flex-col items-center gap-1 rounded-2xl px-2 py-2.5
                     transition-colors active:bg-ink-800 disabled:opacity-50"
        >
          <span className={`size-6 ${action.accent}`}>{action.icon}</span>
          <span className="text-[0.7rem] leading-none font-medium text-ink-200">
            {action.label}
          </span>
        </button>
      ))}
    </div>
  );
}
