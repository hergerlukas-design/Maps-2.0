import type { ReactNode } from 'react';

interface FieldProps {
  label: string;
  hint?: string;
  htmlFor?: string;
  children: ReactNode;
}

export function Field({ label, hint, htmlFor, children }: FieldProps) {
  return (
    <div>
      <label
        htmlFor={htmlFor}
        className="mb-1.5 block text-xs font-medium tracking-wide text-ink-300 uppercase"
      >
        {label}
      </label>
      {children}
      {hint && <p className="mt-1.5 text-xs leading-snug text-ink-400">{hint}</p>}
    </div>
  );
}

interface SliderFieldProps {
  label: string;
  hint?: string;
  value: number;
  min: number;
  max: number;
  step: number;
  unit: string;
  /** Formats the value shown next to the label; defaults to the raw number. */
  format?: (value: number) => string;
  onChange: (value: number) => void;
}

/**
 * A labelled slider with the current value always visible.
 *
 * Sliders are the right control for the range/radius/interval settings because
 * the exact number matters less than "roughly here", and a slider is usable with
 * a thumb in a moving car.
 */
export function SliderField({
  label,
  hint,
  value,
  min,
  max,
  step,
  unit,
  format,
  onChange,
}: SliderFieldProps) {
  const id = `slider-${label.replace(/\s+/g, '-').toLowerCase()}`;
  return (
    <div>
      <div className="mb-1.5 flex items-baseline justify-between gap-2">
        <label htmlFor={id} className="text-xs font-medium tracking-wide text-ink-300 uppercase">
          {label}
        </label>
        <span className="tabular text-sm font-semibold text-route-500">
          {format ? format(value) : value} {unit}
        </span>
      </div>
      <input
        id={id}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
        className="h-6 w-full accent-[var(--color-route-500)]"
      />
      {hint && <p className="mt-1 text-xs leading-snug text-ink-400">{hint}</p>}
    </div>
  );
}

interface ToggleFieldProps {
  label: string;
  hint?: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}

export function ToggleField({
  label,
  hint,
  checked,
  disabled,
  onChange,
}: ToggleFieldProps) {
  return (
    <label
      className={`flex items-start justify-between gap-4 ${
        disabled ? 'opacity-50' : 'cursor-pointer'
      }`}
    >
      <span className="min-w-0">
        <span className="block text-sm font-medium text-ink-100">{label}</span>
        {hint && <span className="mt-0.5 block text-xs leading-snug text-ink-400">{hint}</span>}
      </span>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
        className="mt-0.5 size-5 shrink-0 accent-[var(--color-route-500)]"
      />
    </label>
  );
}
