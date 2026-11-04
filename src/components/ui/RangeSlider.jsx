import { useId } from "react";

/**
 * Two-handle slider for choosing a range between `min` and `max` (e.g. cost or quantity filters).
 * Controlled: `value` is [low, high] and `onChange([low, high])` fires as either handle moves.
 * The handles cannot cross. Each handle is a native range input, so it works with the keyboard
 * (arrows, Page Up/Down, Home/End) and screen readers.
 *
 * Props: label, min, max, step, value, onChange, format (number → display text, e.g. currency),
 * disabled, hint.
 */
const RangeSlider = ({ label, min = 0, max = 100, step = 1, value, onChange, format = (n) => String(n), disabled = false, hint, className = "" }) => {
  const id = useId();
  const span = Math.max(max - min, step);
  const low = Math.min(Math.max(value?.[0] ?? min, min), max);
  const high = Math.max(Math.min(value?.[1] ?? max, max), low);
  const pct = (n) => ((n - min) / span) * 100;
  const isAll = low <= min && high >= max;

  const thumb =
    "pointer-events-none absolute inset-0 h-full w-full appearance-none bg-transparent " +
    "[&::-webkit-slider-thumb]:pointer-events-auto [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:appearance-none " +
    "[&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:border-2 [&::-webkit-slider-thumb]:border-brand-primary [&::-webkit-slider-thumb]:bg-primary-bg " +
    "[&::-webkit-slider-thumb]:shadow [&::-webkit-slider-thumb]:cursor-pointer " +
    "[&::-moz-range-thumb]:pointer-events-auto [&::-moz-range-thumb]:h-4 [&::-moz-range-thumb]:w-4 [&::-moz-range-thumb]:rounded-full " +
    "[&::-moz-range-thumb]:border-2 [&::-moz-range-thumb]:border-brand-primary [&::-moz-range-thumb]:bg-primary-bg [&::-moz-range-thumb]:cursor-pointer " +
    "focus-visible:outline-none [&:focus-visible::-webkit-slider-thumb]:ring-4 [&:focus-visible::-webkit-slider-thumb]:ring-brand-primary/30 " +
    "disabled:[&::-webkit-slider-thumb]:cursor-not-allowed";

  return (
    <div role="group" aria-labelledby={`${id}-label`} className={`flex min-w-0 flex-col gap-1 ${disabled ? "opacity-60" : ""} ${className}`}>
      <div className="flex items-baseline justify-between gap-2">
        <span id={`${id}-label`} className="text-sm font-medium text-primary-text">
          {label}
        </span>
        <span className="text-xs text-secondary-text" aria-live="polite">
          {isAll ? "Any" : `${format(low)} – ${format(high)}`}
        </span>
      </div>
      <div className="relative h-5">
        <div className="absolute top-1/2 h-1.5 w-full -translate-y-1/2 rounded-full bg-border-color" />
        <div
          className="absolute top-1/2 h-1.5 -translate-y-1/2 rounded-full bg-brand-primary"
          style={{ left: `${pct(low)}%`, width: `${pct(high) - pct(low)}%` }}
        />
        <input
          type="range"
          aria-label={`${label} minimum`}
          aria-valuetext={format(low)}
          min={min}
          max={max}
          step={step}
          value={low}
          disabled={disabled}
          onChange={(e) => onChange([Math.min(Number(e.target.value), high), high])}
          className={`${thumb} ${low >= max - step ? "z-[3]" : "z-[2]"}`}
        />
        <input
          type="range"
          aria-label={`${label} maximum`}
          aria-valuetext={format(high)}
          min={min}
          max={max}
          step={step}
          value={high}
          disabled={disabled}
          onChange={(e) => onChange([low, Math.max(Number(e.target.value), low)])}
          className={`${thumb} z-[2]`}
        />
      </div>
      <div className="flex justify-between text-xs text-secondary-text">
        <span>{format(min)}</span>
        <span>{format(max)}</span>
      </div>
      {hint && <p className="text-xs text-secondary-text">{hint}</p>}
    </div>
  );
};

export default RangeSlider;
