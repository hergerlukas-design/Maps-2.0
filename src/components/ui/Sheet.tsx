import { useEffect, useRef, type ReactNode } from 'react';

interface SheetProps {
  open: boolean;
  title: string;
  children: ReactNode;
  onClose: () => void;
}

/**
 * A modal bottom sheet.
 *
 * Focus moves into the sheet on open and Escape closes it, so the panels are
 * usable with a keyboard as well as a thumb.
 */
export function Sheet({ open, title, children, onClose }: SheetProps) {
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    panelRef.current?.focus();
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-40 flex flex-col justify-end">
      <button
        type="button"
        aria-label="Schließen"
        onClick={onClose}
        className="absolute inset-0 bg-ink-950/70 backdrop-blur-sm"
      />
      <div
        ref={panelRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="panel relative flex max-h-[90vh] flex-col rounded-t-[var(--radius-sheet)] outline-none"
      >
        <div className="flex items-center justify-between gap-3 px-4 pt-4 pb-3">
          <h2 className="text-lg font-bold">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Schließen"
            className="touch-target -mr-1 grid place-items-center rounded-full text-ink-400 active:text-ink-100"
          >
            <svg viewBox="0 0 24 24" className="size-5" fill="none" stroke="currentColor" strokeWidth={2}>
              <path d="M6 6l12 12M18 6L6 18" strokeLinecap="round" />
            </svg>
          </button>
        </div>
        <div
          className="min-h-0 flex-1 overflow-y-auto"
          style={{ paddingBottom: 'var(--safe-bottom)' }}
        >
          {children}
        </div>
      </div>
    </div>
  );
}
