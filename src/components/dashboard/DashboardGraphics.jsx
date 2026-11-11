import { Link } from "react-router-dom";
import { ArrowRightIcon, TrendingDownIcon, TrendingUpIcon } from "@/components/icons";

/**
 * The drawn pieces the dashboards share: figures that are a picture as well as a number. Every one of them keeps its figures in words
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

/** "Up 20% on previous period", green or red by whether up is good. Nothing when there is no earlier figure to compare with. */
export const ChangeNote = ({ change, higherIsWorse = false }) => {
  if (change === null || change === undefined) return null;
  const worse = higherIsWorse ? change > 0 : change < 0;
  return (
    <span className={`inline-flex items-center gap-1 ${change === 0 ? "text-secondary-text" : worse ? "text-error-color" : "text-success-color"}`}>
      {change > 0 ? <TrendingUpIcon aria-hidden="true" /> : change < 0 ? <TrendingDownIcon aria-hidden="true" /> : null}
      {change === 0 ? "No change" : `${change > 0 ? "Up" : "Down"} ${Math.abs(change)}%`} on previous period
    </span>
  );
};

/**
 * A headline number on a card with its icon in a tinted square and a soft circle behind it; `alert` turns the tint and the number red.
 * `change` (a percentage on the previous period) is shown above the note.
 */
export const StatTile = ({ icon: Icon, label, value, note, to, alert = false, change, higherIsWorse = false, children }) => {
  const color = alert ? "var(--color-error-color)" : ACCENT;
  const hasChange = change !== null && change !== undefined;
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
      <p className="min-h-4 text-xs text-secondary-text">
        {hasChange && <ChangeNote change={change} higherIsWorse={higherIsWorse} />}
        {note && <span className="block">{note}</span>}
      </p>
    </Tile>
  );
};

/**
 * The card a dashboard leads with: its one big number over a wash of the theme colour, a note, and room beneath for a picture of what the number
 * is made of. With `to` the whole card is a link (give it nothing that is itself a link); otherwise `action` holds a link in its corner.
 */
export const HeroCard = ({ label, icon: Icon, value, note, to, action, className = "", children }) => {
  const Root = to ? Link : "section";
  const rootProps = to ? { to } : { "aria-label": label };
  return (
    <Root
      {...rootProps}
      data-tile={label}
      className={`group relative flex min-w-0 flex-col justify-between gap-5 overflow-hidden rounded-3xl border border-border-color bg-secondary-bg p-6 ${to ? "transition-colors hover:border-brand-primary" : ""} ${className}`}
      style={{ backgroundImage: `linear-gradient(135deg, ${tint(ACCENT, 18)}, transparent 62%)` }}>
      <svg aria-hidden="true" viewBox="0 0 200 200" className="pointer-events-none absolute -right-14 -top-16 h-64 w-64" style={{ color: ACCENT }}>
        <circle cx="100" cy="100" r="96" fill="none" stroke="currentColor" strokeOpacity="0.14" strokeWidth="1.5" />
        <circle cx="100" cy="100" r="68" fill="none" stroke="currentColor" strokeOpacity="0.18" strokeWidth="1.5" />
        <circle cx="100" cy="100" r="40" fill="currentColor" fillOpacity="0.08" />
      </svg>
      <div className="relative flex items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <span className="flex items-center gap-2 text-sm text-secondary-text">
            {Icon && <Icon className="h-4 w-4" aria-hidden="true" />}
            {label}
          </span>
          <p className="text-6xl font-semibold leading-none text-primary-text">{value}</p>
          <p className="min-h-5 text-sm text-secondary-text">{note}</p>
        </div>
        {action && <span className="relative">{action}</span>}
      </div>
      {children && <div className="relative flex flex-col gap-2">{children}</div>}
    </Root>
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

/** How many steps sit in a row at each width, and so which connecting lines would cross a row end and are left out. */
const PIPELINE_LAYOUT = {
  eight: { grid: "grid-cols-2 sm:grid-cols-4 2xl:grid-cols-8", hide: (i) => `${i % 4 === 0 ? "sm:max-2xl:hidden" : ""} ${i % 2 === 0 ? "max-sm:hidden" : ""}` },
  six: { grid: "grid-cols-2 sm:grid-cols-3 lg:grid-cols-6", hide: (i) => `${i % 3 === 0 ? "sm:max-lg:hidden" : ""} ${i % 2 === 0 ? "max-sm:hidden" : ""}` },
  four: { grid: "grid-cols-2 sm:grid-cols-4", hide: (i) => (i % 2 === 0 ? "max-sm:hidden" : "") },
};

/** The steps of a process in order, each with how many records wait at it; a step with something in it is filled. `to(step)` makes a step a link. */
export const Pipeline = ({ steps, label, layout = "eight", to }) => {
  const { grid, hide } = PIPELINE_LAYOUT[layout] ?? PIPELINE_LAYOUT.eight;
  return (
    <ol aria-label={label} className={`grid gap-x-2 gap-y-4 ${grid}`}>
      {steps.map((s, i) => {
        const link = to?.(s);
        const Body = link ? Link : "span";
        return (
          <li key={s.key} className="relative">
            {i > 0 && <span aria-hidden="true" className={`absolute top-5 h-px bg-border-color ${hide(i)}`} style={{ left: "calc(-50% + 1.75rem)", right: "calc(50% + 1.75rem)" }} />}
            <Body {...(link ? { to: link } : {})} className={`group/step relative flex flex-col items-center gap-1.5 text-center ${link ? "rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-brand-primary" : ""}`}>
              <span
                className={`flex h-10 w-10 items-center justify-center rounded-full text-sm font-semibold tabular-nums ${s.count > 0 ? "" : "border border-border-color bg-secondary-bg text-secondary-text"} ${link ? "transition-transform group-hover/step:scale-110 motion-reduce:transform-none" : ""}`}
                style={s.count > 0 ? { background: ACCENT, color: "var(--color-cta-btn-text)", boxShadow: `0 0 0 4px ${tint(ACCENT, 18)}` } : undefined}>
                {s.count}
              </span>
              <span className={`text-xs leading-tight ${s.count > 0 ? "text-primary-text" : "text-secondary-text"}`}>{s.label}</span>
            </Body>
          </li>
        );
      })}
    </ol>
  );
};

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

/**
 * A ranked list as bars: one row per item with its name, a bar as long as its count against the largest, the count and its share of the total.
 * Rows keep the order they are given in (the server ranks them). `to(item)` makes the name a link; `format` writes the figure.
 */
export const RankList = ({ items, label, color = ACCENT, colorOf, to, format = (v) => v.toLocaleString("en-GB"), showShare = true }) => {
  const most = Math.max(1, ...items.map((i) => i.count));
  const total = items.reduce((n, i) => n + i.count, 0);
  return (
    <ol aria-label={label} className="flex flex-col gap-2.5 text-sm">
      {items.map((i) => {
        const fill = colorOf ? colorOf(i) : color;
        const link = to?.(i);
        return (
          <li key={i.key} className="grid grid-cols-[minmax(0,2fr)_minmax(0,3fr)_auto] items-center gap-3">
            {link ? (
              <Link to={link} className="truncate text-primary-text hover:underline" title={i.label}>
                {i.label}
              </Link>
            ) : (
              <span className={`truncate ${i.count > 0 ? "text-primary-text" : "text-secondary-text"}`} title={i.label}>
                {i.label}
              </span>
            )}
            <span aria-hidden="true" className="block h-2.5 overflow-hidden rounded-full" style={{ background: tint(fill, 14) }}>
              <span className="block h-full rounded-full transition-[width] duration-500 motion-reduce:transition-none" style={{ width: `${(i.count / most) * 100}%`, minWidth: i.count > 0 ? 4 : 0, background: fill }} />
            </span>
            <span className="flex items-baseline justify-end gap-2 tabular-nums">
              <span className={`font-medium ${i.count > 0 ? "text-primary-text" : "text-secondary-text"}`}>{format(i.count)}</span>
              {showShare && <span className="w-9 text-right text-xs text-secondary-text">{share(i.count, total)}%</span>}
            </span>
          </li>
        );
      })}
    </ol>
  );
};

/** The names of a chart's series beside their colours, for a chart whose figures are on its axis. */
export const SeriesLegend = ({ series, label = "Legend" }) => (
  <ul aria-label={label} className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-secondary-text">
    {series.map((s) => (
      <li key={s.key} className="flex items-center gap-1.5">
        <span className="h-2.5 w-2.5 rounded-[3px]" style={{ background: s.color }} aria-hidden="true" />
        {s.label}
      </li>
    ))}
  </ul>
);

/** Words for a card with nothing in it. */
export const Empty = ({ children }) => <p className="py-6 text-center text-sm text-secondary-text">{children}</p>;
/** A "see all" link in the corner of a card. */
export const cardLink = "inline-flex items-center gap-1 whitespace-nowrap text-sm text-link-color hover:underline";
/** A link in a dashboard's header row, the height of the period picker beside it. */
export const headerLink = "inline-flex min-h-9.5 shrink-0 items-center whitespace-nowrap rounded-lg border border-border-color bg-secondary-bg px-3 py-1.5 text-sm text-primary-text hover:bg-border-color/50";

