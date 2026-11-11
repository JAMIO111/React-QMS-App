import { Link } from "react-router-dom";
import { ArrowRightIcon } from "@/components/icons";

/**
 * The drawn pieces of the supplier quality dashboard: figures that are a picture as well as a number. Every one of them keeps its figures in words
 * (a legend, a note or a table cell), so nothing is told by colour or by hovering alone. Colours come from the `--chart-*` variables and the theme.
 */
export const ACCENT = "var(--brand-primary)";
const tint = (color, pct) => `color-mix(in srgb, ${color} ${pct}%, transparent)`;
const share = (count, total) => (total > 0 ? Math.round((count / total) * 100) : 0);
/** Words printed on a fill: white, except on the warning yellow. */
const inkOn = (color) => (color === "var(--chart-warning)" ? "#0b0b0b" : "#ffffff");

/** A tile's shell: a link when it leads somewhere, with an arrow that says so. `data-tile` names it for tests. */
export const Tile = ({ to, label, className = "", children }) => {
  const cls = `group relative flex min-w-0 flex-col gap-2 overflow-hidden rounded-2xl border border-border-color bg-secondary-bg p-4 ${className}`;
  if (!to) {
    return (
      <div data-tile={label} className={cls}>
        {children}
      </div>
    );
  }
  return (
    <Link to={to} data-tile={label} className={`${cls} transition-[border-color,transform] duration-200 hover:-translate-y-0.5 hover:border-brand-primary motion-reduce:transform-none`}>
      {children}
      <ArrowRightIcon className="absolute right-3 top-3 h-4 w-4 -rotate-45 text-secondary-text opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100" aria-hidden="true" />
    </Link>
  );
};

/** A headline number on a card with its icon in a tinted square and a soft circle behind it; `alert` turns the tint and the number red. */
export const StatTile = ({ icon: Icon, label, value, note, to, alert = false, children }) => {
  const color = alert ? "var(--color-error-color)" : ACCENT;
  return (
    <Tile to={to} label={label}>
      <span aria-hidden="true" className="pointer-events-none absolute -right-8 -top-10 h-28 w-28 rounded-full" style={{ background: tint(color, 10) }} />
      <span aria-hidden="true" className="pointer-events-none absolute -right-2 top-10 h-12 w-12 rounded-full" style={{ background: tint(color, 8) }} />
      <span className="flex items-center gap-3">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl" style={{ background: tint(color, 16), color }}>
          <Icon className="h-5 w-5" aria-hidden="true" />
        </span>
        <span className="text-sm text-secondary-text">{label}</span>
      </span>
      <p className={`text-3xl font-semibold ${alert ? "text-error-color" : "text-primary-text"}`}>{value}</p>
      {children}
      <p className="min-h-4 text-xs text-secondary-text">{note}</p>
    </Tile>
  );
};

/** A thin bar for one ratio: the fill in the colour, the track a lighter step of the same colour. A part above zero always shows. */
export const Meter = ({ part, whole, color = ACCENT, label }) => {
  const pct = whole > 0 ? Math.min(100, (part / whole) * 100) : 0;
  return (
    <span role="img" aria-label={label} className="block h-2 w-full overflow-hidden rounded-full" style={{ background: tint(color, 18) }}>
      <span className="block h-full rounded-full transition-[width] duration-500 motion-reduce:transition-none" style={{ width: `${pct}%`, minWidth: part > 0 ? 4 : 0, background: color }} />
    </span>
  );
};

/** One percentage as a half-circle gauge with the figure in the middle. `value` is 0–100, or null when there is nothing to measure. */
export const ArcGauge = ({ label, value, display, note }) => {
  const r = 52;
  const length = Math.PI * r;
  const v = value === null || value === undefined ? null : Math.max(0, Math.min(100, value));
  return (
    <Tile label={label} className="items-center bg-primary-bg/50 text-center">
      <span className="text-sm text-secondary-text">{label}</span>
      <span className="relative block w-full max-w-44">
        <svg viewBox="0 0 128 70" className="block w-full" aria-hidden="true">
          <path d="M 12 64 A 52 52 0 0 1 116 64" fill="none" stroke={tint(ACCENT, 18)} strokeWidth="10" strokeLinecap="round" />
          {v !== null && v > 0 && (
            <path
              d="M 12 64 A 52 52 0 0 1 116 64"
              fill="none"
              stroke={ACCENT}
              strokeWidth="10"
              strokeLinecap="round"
              strokeDasharray={`${(length * v) / 100} ${length}`}
              className="transition-[stroke-dasharray] duration-700 motion-reduce:transition-none"
            />
          )}
        </svg>
        <span className="absolute inset-x-0 bottom-0 text-3xl font-semibold leading-none text-primary-text">{display}</span>
      </span>
      <span className="flex w-full max-w-44 justify-between px-1 text-[11px] text-secondary-text" aria-hidden="true">
        <span>0</span>
        <span>100%</span>
      </span>
      <p className="min-h-4 text-xs text-secondary-text">{note}</p>
    </Tile>
  );
};

/**
 * One whole split into its parts: a bar whose blocks are as wide as their counts, with a list beneath that names each part and gives its count and share.
 * `tall` prints the count on a block wide enough to hold it. A part at zero draws no block but stays in the list when `showZero`.
 */
export const SplitBar = ({ parts, label, unit = "supplier", tall = false, showZero = false, columns = 2 }) => {
  const total = parts.reduce((n, p) => n + p.count, 0);
  const listed = parts.filter((p) => showZero || p.count > 0);
  const words = parts.filter((p) => p.count > 0).map((p) => `${p.label} ${p.count}`).join(", ");
  return (
    <div className="flex flex-col gap-3">
      <div role="img" aria-label={`${label}: ${words || "nothing to show"}`} className={`flex w-full gap-0.5 ${tall ? "h-7" : "h-2.5"}`}>
        {total === 0 && <span className="h-full w-full rounded-full bg-border-color" />}
        {parts.filter((p) => p.count > 0).map((p) => (
          <span
            key={p.key}
            title={`${p.label}: ${p.count} of ${total} (${share(p.count, total)}%)`}
            className={`flex h-full min-w-1.5 items-center overflow-visible ${tall ? "rounded-[4px] pl-2 text-xs font-semibold" : "first:rounded-l-full last:rounded-r-full"}`}
            style={{ flexGrow: p.count, flexBasis: 0, background: p.color, color: inkOn(p.color) }}>
            {tall && p.count / total >= 0.1 ? p.count : null}
          </span>
        ))}
      </div>
      <ul aria-label={label} className={`grid gap-x-4 gap-y-1.5 text-sm ${columns === 1 ? "grid-cols-1" : "grid-cols-1 sm:grid-cols-2"}`}>
        {listed.map((p) => (
          <li key={p.key} className="flex items-center gap-2">
            <span className="h-2.5 w-2.5 shrink-0 rounded-[3px]" style={{ background: p.color }} aria-hidden="true" />
            <span className="min-w-0 truncate text-secondary-text">{p.label}</span>
            <span className="ml-auto font-medium tabular-nums text-primary-text">{p.count}</span>
            <span className="w-9 text-right text-xs tabular-nums text-secondary-text">{share(p.count, total)}%</span>
          </li>
        ))}
      </ul>
      <span className="sr-only">
        {total} {total === 1 ? unit : `${unit}s`} in all
      </span>
    </div>
  );
};

/** A score out of 100 as a small ring with the number inside; no score draws an empty ring and a dash. */
export const ScoreRing = ({ score, color }) => {
  const r = 15;
  const length = 2 * Math.PI * r;
  const v = score === null || score === undefined ? null : Math.max(0, Math.min(100, score));
  return (
    <span className="relative inline-flex h-10 w-10 shrink-0 items-center justify-center">
      <svg viewBox="0 0 40 40" className="absolute inset-0 -rotate-90" aria-hidden="true">
        <circle cx="20" cy="20" r={r} fill="none" stroke={tint(color, 20)} strokeWidth="4" />
        {v !== null && v > 0 && <circle cx="20" cy="20" r={r} fill="none" stroke={color} strokeWidth="4" strokeLinecap="round" strokeDasharray={`${(length * v) / 100} ${length}`} />}
      </svg>
      <span className="text-xs font-semibold tabular-nums text-primary-text">{v === null ? "—" : Math.round(v)}</span>
    </span>
  );
};

/** The steps of a process in order, each with how many records wait at it; a step with something in it is filled. */
export const Pipeline = ({ steps, label }) => (
  <ol aria-label={label} className="grid grid-cols-2 gap-x-2 gap-y-4 sm:grid-cols-4 2xl:grid-cols-8">
    {steps.map((s, i) => (
      <li key={s.key} className="relative flex flex-col items-center gap-1.5 text-center">
        {i > 0 && (
          <span
            aria-hidden="true"
            className={`absolute top-5 h-px bg-border-color ${i % 4 === 0 ? "max-2xl:hidden" : ""} ${i % 2 === 0 ? "max-sm:hidden" : ""}`}
            style={{ left: "calc(-50% + 1.75rem)", right: "calc(50% + 1.75rem)" }}
          />
        )}
        <span
          className={`relative flex h-10 w-10 items-center justify-center rounded-full text-sm font-semibold tabular-nums ${s.count > 0 ? "" : "border border-border-color bg-secondary-bg text-secondary-text"}`}
          style={s.count > 0 ? { background: ACCENT, color: "var(--color-cta-btn-text)", boxShadow: `0 0 0 4px ${tint(ACCENT, 18)}` } : undefined}>
          {s.count}
        </span>
        <span className={`text-xs leading-tight ${s.count > 0 ? "text-primary-text" : "text-secondary-text"}`}>{s.label}</span>
      </li>
    ))}
  </ol>
);

/** A person or company as a round badge with its first letter. */
export const Initial = ({ name }) => (
  <span aria-hidden="true" className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-xs font-semibold text-primary-text" style={{ background: tint(ACCENT, 16) }}>
    {(name ?? "?").trim().charAt(0).toUpperCase()}
  </span>
);

/** A short status in a pill: `error` for late or expired, `warning` for soon, `neutral` otherwise. */
export const Chip = ({ tone = "neutral", children }) => {
  const tones = { error: "bg-error-color/15 text-error-color", warning: "bg-warning-color/20 text-primary-text", neutral: "bg-border-color text-secondary-text" };
  return <span className={`inline-flex items-center whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ${tones[tone]}`}>{children}</span>;
};
