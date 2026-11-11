import { useEffect, useId, useMemo, useState } from "react";
import {
  addMonths,
  addYears,
  differenceInCalendarDays,
  eachDayOfInterval,
  endOfMonth,
  endOfWeek,
  format,
  isAfter,
  isBefore,
  isSameDay,
  isSameMonth,
  isToday,
  setHours,
  setMinutes,
  setSeconds,
  startOfDay,
  startOfMonth,
  startOfWeek,
} from "date-fns";
import CTAButton from "../CTAButton";
import { ChevronDownIcon, ChevronLeftIcon, ChevronRightIcon, ClockIcon } from "@/components/icons";
import { clampRange, resolvePresets } from "@/lib/datePresets";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const timeText = (date, seconds, fallback) => (date ? format(date, seconds ? "HH:mm:ss" : "HH:mm") : fallback);
/** Puts "HH:mm" or "HH:mm:ss" onto a day. */
const withClock = (day, time) => {
  const [h = "0", m = "0", s = "0"] = String(time || "00:00").split(":");
  return setSeconds(setMinutes(setHours(startOfDay(day), Number(h) || 0), Number(m) || 0), Number(s) || 0);
};

const navButton = "flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-border-color text-primary-text transition-colors hover:bg-border-color/50 active:scale-95 cursor-pointer disabled:cursor-not-allowed disabled:opacity-40";

/** A time box: native time input (so phones and keyboards behave), framed like the app's other fields. */
const TimeBox = ({ label, value, onChange, max, seconds, invalid }) => {
  const id = useId();
  // While someone edits the box it can be empty for a moment; the last complete time stays the value.
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-sm font-medium text-secondary-text">
        {label}
      </label>
      <div
        className={`flex h-9.5 items-center gap-2 rounded-lg border bg-text-input-color px-2 transition-all duration-150 focus-within:border-brand-primary focus-within:ring-3 focus-within:ring-brand-primary/20 ${
          invalid ? "border-error-color" : "border-border-color hover:border-border-dark-color"
        }`}>
        <ClockIcon className="h-5 w-5 shrink-0 text-primary-text" />
        <input
          id={id}
          type="time"
          step={seconds ? 1 : 60}
          value={text}
          max={max}
          onChange={(e) => {
            setText(e.target.value);
            if (e.target.value) onChange(e.target.value);
          }}
          className="min-w-0 flex-1 bg-transparent text-sm text-primary-text outline-none"
        />
      </div>
    </div>
  );
};

/**
 * Inline calendar, usually shown through RHFDatePickerPopout. One component for every kind of date entry:
 *
 *   mode            "single" (default): value is a Date or null · "range": value is { from, to } (Dates or null)
 *   onChange        called with the same shape as `value` — straight away for a single day without a time, otherwise on Done
 *   onCancel        when given, a Cancel button is shown beside Done (the popout closes without saving)
 *   withTime        also asks for a time: "Time" (single) or "Start time" and "End time" (range); showSeconds adds seconds
 *   allowPast       false blocks every day before today · allowFuture false blocks every day after today (both default true)
 *   minDate/maxDate Dates (or null) that block days outside them, on top of the two above
 *   presets         shortcuts: true (a sensible list), "ranges", "dates", or an array of built-in keys and/or your own
 *                   `{ label, range: (today) => [from, to] }` (range) / `{ label, date: (today) => Date }` (single) — see lib/datePresets.js.
 *                   The first `quickPresets` (default 2) sit in a row above the calendar; "More" opens the full list
 *                   (`presetsOpen` starts with it open). A preset is clamped to the days allowed and switched off when none are.
 *   confirm         single day without a time but still wanting Cancel / Done
 *   markedDates     Dates that get a small dot (events, due dates)
 *   weekStartsOn    0–6, default 1 (Monday)
 *   showMonth       which month a range opens on: "start" (default) or "end" (dashboards, where the recent days matter)
 *
 * With a time the chosen time is kept when the day changes. A range's end time defaults to 23:59 so a whole day is covered.
 */
const RHFDatePicker = ({
  value,
  onChange,
  onCancel,
  mode = "single",
  withTime = false,
  showSeconds = false,
  minDate,
  maxDate,
  allowPast = true,
  allowFuture = true,
  presets,
  presetsOpen = false,
  quickPresets = 2,
  confirm = false,
  markedDates,
  weekStartsOn = 1,
  showMonth = "start",
  className = "",
}) => {
  const range = mode === "range";
  const today = startOfDay(new Date());

  // Bounds: the tightest of minDate / maxDate and the past / future switches.
  const min = [minDate && startOfDay(minDate), !allowPast && today].filter(Boolean).reduce((a, b) => (isAfter(b, a) ? b : a), null);
  const max = [maxDate && startOfDay(maxDate), !allowFuture && today].filter(Boolean).reduce((a, b) => (a && isBefore(a, b) ? a : b), null);
  const blocked = (day) => (min && isBefore(startOfDay(day), min)) || (max && isAfter(startOfDay(day), max));

  // The draft is what is on screen; it becomes the value on Done (or at once for a plain single day).
  const from = range ? (value?.from ?? null) : (value ?? null);
  const to = range ? (value?.to ?? null) : null;
  const signature = `${from?.getTime() ?? ""}|${to?.getTime() ?? ""}`;
  const [draft, setDraft] = useState({ from, to });
  const [startTime, setStartTime] = useState(timeText(from, showSeconds, showSeconds ? "00:00:00" : "00:00"));
  const [endTime, setEndTime] = useState(timeText(to, showSeconds, showSeconds ? "23:59:59" : "23:59"));
  const shown = showMonth === "end" ? (to ?? from) : from;
  const [month, setMonth] = useState(startOfMonth(shown ?? new Date()));
  const [view, setView] = useState("days"); // days | months | presets
  const [hover, setHover] = useState(null);

  // A value set from outside (a form reset, another control) replaces the draft and shows its month.
  useEffect(() => {
    setDraft({ from, to });
    if (from) {
      setMonth(startOfMonth(shown ?? from));
      setStartTime(timeText(from, showSeconds, showSeconds ? "00:00:00" : "00:00"));
    }
    if (to) setEndTime(timeText(to, showSeconds, showSeconds ? "23:59:59" : "23:59"));
    // `signature` stands for from / to
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature]);

  const list = useMemo(() => resolvePresets(presets, mode), [presets, mode]);
  useEffect(() => {
    if (presetsOpen && list.length) setView("presets");
    // only the first time
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const showFooter = range || withTime || confirm;

  // ---- committing -----------------------------------------------------------------------------
  const now = new Date();
  const clampNow = (d) => (!allowFuture && isAfter(d, now) ? now : d);
  const commit = (next) => {
    if (range) {
      const a = next.from;
      const b = next.to ?? next.from;
      onChange({
        from: withTime ? withClock(a, startTime) : startOfDay(a),
        to: withTime ? clampNow(withClock(b, endTime)) : startOfDay(b),
      });
    } else {
      onChange(withTime ? clampNow(withClock(next.from, startTime)) : startOfDay(next.from));
    }
  };

  // ---- days -----------------------------------------------------------------------------------
  const pickDay = (day) => {
    if (blocked(day)) return;
    if (!isSameMonth(day, month)) setMonth(startOfMonth(day));
    if (!range) {
      const next = { from: day, to: null };
      setDraft(next);
      if (!showFooter) commit(next);
      return;
    }
    setHover(null);
    setDraft((d) => {
      if (!d.from || d.to) return { from: day, to: null };
      return isBefore(day, d.from) ? { from: day, to: d.from } : { from: d.from, to: day };
    });
  };

  const applyPreset = (preset) => {
    let next;
    if (range) {
      const r = clampRange(preset.range(today), min, max);
      if (!r) return;
      next = { from: r[0], to: r[1] };
    } else {
      const d = startOfDay(preset.date(today));
      if (blocked(d)) return;
      next = { from: d, to: null };
    }
    setDraft(next);
    setMonth(startOfMonth(next.from));
    setView("days");
    if (!withTime && (range || !showFooter)) commit(next);
  };
  const presetState = (preset) => {
    if (range) {
      const r = clampRange(preset.range(today), min, max);
      return { disabled: !r, active: !!r && draft.from && draft.to && isSameDay(draft.from, r[0]) && isSameDay(draft.to, r[1]) };
    }
    const d = startOfDay(preset.date(today));
    return { disabled: !!blocked(d), active: !!draft.from && isSameDay(draft.from, d) };
  };
  const titleOf = (preset) => {
    if (range) {
      const r = clampRange(preset.range(today), min, max);
      return r ? `${format(r[0], "d MMM yyyy")} – ${format(r[1], "d MMM yyyy")}` : "No allowed days in this range";
    }
    return format(startOfDay(preset.date(today)), "EEE d MMM yyyy");
  };

  const days = eachDayOfInterval({ start: startOfWeek(startOfMonth(month), { weekStartsOn }), end: endOfWeek(endOfMonth(month), { weekStartsOn }) });
  const weekdays = days.slice(0, 7).map((d) => format(d, "EEEEEE"));
  const marked = (day) => markedDates?.some((m) => isSameDay(m, day));

  // The band between the two ends of a range, including the one being previewed while the end is still to be chosen.
  const bandEnd = draft.to ?? (draft.from && hover && isAfter(hover, draft.from) ? hover : null);

  // ---- time -----------------------------------------------------------------------------------
  const sameDayRange = range && draft.from && (draft.to ? isSameDay(draft.from, draft.to) : true);
  const timeOrderBad = withTime && range && sameDayRange && endTime < startTime;
  const maxToday = !allowFuture ? timeText(now, showSeconds, "") : undefined;
  const startMax = !allowFuture && draft.from && isSameDay(draft.from, now) ? maxToday : undefined;
  const endMax = !allowFuture && (draft.to ?? draft.from) && isSameDay(draft.to ?? draft.from, now) ? maxToday : undefined;

  const dayCount = range && draft.from ? differenceInCalendarDays(draft.to ?? draft.from, draft.from) + 1 : 0;
  const canDone = !!draft.from && !timeOrderBad;

  // ---- render ---------------------------------------------------------------------------------
  const quick = list.slice(0, quickPresets);
  const monthBlocked = (i) => {
    const first = new Date(month.getFullYear(), i, 1);
    const last = endOfMonth(first);
    return (min && isBefore(last, min)) || (max && isAfter(first, max));
  };

  return (
    <div className={`w-[22rem] max-w-[calc(100vw-1rem)] rounded-2xl border border-border-color bg-text-input-color p-4 text-sm text-primary-text shadow-xl ${className}`}>
      {list.length > 0 && (
        <div className="mb-3 flex items-center justify-between border-b border-border-color pb-2">
          {quick.map((p) => {
            const state = presetState(p);
            return (
              <button
                key={p.key}
                type="button"
                disabled={state.disabled}
                title={titleOf(p)}
                onClick={() => applyPreset(p)}
                className={`rounded-md px-2 py-1 font-medium transition-colors cursor-pointer disabled:cursor-not-allowed disabled:opacity-40 ${
                  state.active ? "text-brand-primary" : "text-primary-text hover:bg-border-color/50"
                }`}>
                {p.label}
              </button>
            );
          })}
          {list.length > quick.length && (
            <button
              type="button"
              aria-expanded={view === "presets"}
              onClick={() => setView(view === "presets" ? "days" : "presets")}
              className="ml-auto flex items-center gap-1 rounded-md px-2 py-1 font-medium text-primary-text transition-colors hover:bg-border-color/50 cursor-pointer">
              {quick.length === 0 ? (view === "presets" ? "Custom range" : "Presets") : view === "presets" ? "Calendar" : "More"}
              <ChevronDownIcon className={`h-4 w-4 transition-transform ${view === "presets" ? "rotate-180" : ""}`} />
            </button>
          )}
        </div>
      )}

      {view === "presets" ? (
        <div role="group" aria-label="Preset dates" className="grid grid-cols-2 gap-2">
          {list.map((p) => {
            const state = presetState(p);
            return (
              <button
                key={p.key}
                type="button"
                disabled={state.disabled}
                title={titleOf(p)}
                aria-pressed={!!state.active}
                onClick={() => applyPreset(p)}
                className={`rounded-lg border px-3 py-2 text-left transition-colors cursor-pointer disabled:cursor-not-allowed disabled:opacity-40 ${
                  state.active ? "border-brand-primary bg-brand-primary/10 text-brand-primary" : "border-border-color hover:bg-border-color/50"
                }`}>
                <span className="block font-medium">{p.label}</span>
                <span className="block truncate text-xs text-secondary-text">{titleOf(p)}</span>
              </button>
            );
          })}
        </div>
      ) : view === "months" ? (
        <>
          <div className="mb-3 flex items-center justify-between gap-2">
            <button type="button" aria-label="Previous year" onClick={() => setMonth(addYears(month, -1))} className={navButton}>
              <ChevronLeftIcon className="h-4 w-4" />
            </button>
            <button type="button" aria-label="Back to the days" aria-expanded onClick={() => setView("days")} className="flex items-center gap-1.5 rounded-md px-2 py-1 font-medium hover:bg-border-color/50 cursor-pointer">
              {format(month, "yyyy")}
              <ChevronDownIcon className="h-4 w-4 rotate-180" />
            </button>
            <button type="button" aria-label="Next year" onClick={() => setMonth(addYears(month, 1))} className={navButton}>
              <ChevronRightIcon className="h-4 w-4" />
            </button>
          </div>
          <div className="grid grid-cols-3 gap-x-2 gap-y-3 py-2">
            {MONTHS.map((name, i) => {
              const isSelected = i === month.getMonth();
              const isNow = i === today.getMonth() && month.getFullYear() === today.getFullYear();
              return (
                <button
                  key={name}
                  type="button"
                  disabled={monthBlocked(i)}
                  aria-pressed={isSelected}
                  onClick={() => {
                    setMonth(new Date(month.getFullYear(), i, 1));
                    setView("days");
                  }}
                  className={`h-11 rounded-xl font-medium transition-colors cursor-pointer disabled:cursor-not-allowed disabled:opacity-30 ${
                    isSelected ? "bg-brand-primary text-white" : isNow ? "text-brand-primary hover:bg-border-color/50" : "hover:bg-border-color/50"
                  }`}>
                  {name}
                </button>
              );
            })}
          </div>
        </>
      ) : (
        <>
          <div className="mb-3 flex items-center justify-between gap-2">
            <button type="button" aria-label="Previous month" onClick={() => setMonth(addMonths(month, -1))} className={navButton}>
              <ChevronLeftIcon className="h-4 w-4" />
            </button>
            <button type="button" aria-label="Choose month and year" aria-expanded={false} onClick={() => setView("months")} className="flex items-center gap-1.5 rounded-md px-2 py-1 font-medium hover:bg-border-color/50 cursor-pointer">
              {format(month, "MMMM yyyy")}
              <ChevronDownIcon className="h-4 w-4" />
            </button>
            <button type="button" aria-label="Next month" onClick={() => setMonth(addMonths(month, 1))} className={navButton}>
              <ChevronRightIcon className="h-4 w-4" />
            </button>
          </div>

          <div className="mb-1 grid grid-cols-7 text-center text-secondary-text">
            {weekdays.map((d, i) => (
              <div key={i} className="py-1.5 text-xs font-medium">
                {d}
              </div>
            ))}
          </div>

          <div className="grid grid-cols-7" onMouseLeave={() => setHover(null)}>
            {days.map((day, i) => {
              const outside = !isSameMonth(day, month);
              const isFrom = draft.from && isSameDay(day, draft.from);
              const isTo = draft.to && isSameDay(day, draft.to);
              const isEnd = bandEnd && isSameDay(day, bandEnd);
              const selected = isFrom || isTo;
              const inBand = range && draft.from && bandEnd && isAfter(day, draft.from) && isBefore(day, bandEnd);
              const bandStart = range && isFrom && bandEnd && isAfter(bandEnd, draft.from);
              const bandStop = range && isEnd && draft.from && isAfter(bandEnd, draft.from) && !isFrom;
              const column = i % 7;
              const off = blocked(day);
              return (
                <div key={day.toISOString()} className="relative flex h-10 items-center justify-center">
                  {(inBand || bandStart || bandStop) && (
                    <span
                      aria-hidden="true"
                      className={`absolute inset-y-0.5 bg-brand-primary/15 ${
                        bandStart ? "left-1/2 right-0" : bandStop ? "left-0 right-1/2" : "left-0 right-0"
                      } ${inBand && column === 0 ? "rounded-l-full" : ""} ${inBand && column === 6 ? "rounded-r-full" : ""}`}
                    />
                  )}
                  <button
                    type="button"
                    disabled={off}
                    aria-label={format(day, "EEEE d MMMM yyyy")}
                    aria-pressed={!!selected}
                    onClick={() => pickDay(day)}
                    onMouseEnter={() => range && draft.from && !draft.to && setHover(day)}
                    onFocus={() => range && draft.from && !draft.to && setHover(day)}
                    className={`relative flex h-9 w-9 flex-col items-center justify-center rounded-full transition-colors ${
                      off ? "cursor-not-allowed text-muted opacity-40" : "cursor-pointer"
                    } ${
                      selected
                        ? "bg-brand-primary font-medium text-white"
                        : `${outside ? "text-muted" : isToday(day) ? "font-semibold text-brand-primary" : ""} ${off ? "" : "hover:bg-border-color/60"}`
                    }`}>
                    {day.getDate()}
                    {marked(day) && <span aria-hidden="true" className={`absolute bottom-0.5 h-1 w-1 rounded-full ${selected ? "bg-white" : "bg-brand-primary"}`} />}
                  </button>
                </div>
              );
            })}
          </div>
        </>
      )}

      {withTime && view !== "presets" && (
        <div className="mt-3 flex flex-col gap-3">
          <TimeBox label={range ? "Start time" : "Time"} value={startTime} onChange={setStartTime} max={startMax} seconds={showSeconds} />
          {range && <TimeBox label="End time" value={endTime} onChange={setEndTime} max={endMax} seconds={showSeconds} invalid={timeOrderBad} />}
          {timeOrderBad && (
            <p role="alert" className="-mt-1 text-xs text-error-color">
              The end time must be after the start time.
            </p>
          )}
        </div>
      )}

      {showFooter && (
        <div className="mt-4 flex items-center justify-between gap-3">
          <span className="text-xs text-secondary-text" aria-live="polite">
            {range && dayCount > 0 ? `${dayCount} ${dayCount === 1 ? "day" : "days"}` : ""}
          </span>
          <div className="flex items-center gap-2">
            {onCancel && <CTAButton type="neutral" size="md" text="Cancel" onClick={onCancel} />}
            <CTAButton type="main" size="md" text="Done" disabled={!canDone} onClick={() => commit(draft)} />
          </div>
        </div>
      )}
    </div>
  );
};

export default RHFDatePicker;
