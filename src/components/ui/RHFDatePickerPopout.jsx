import { useState, useRef, useEffect, useId, useLayoutEffect } from "react";
import { createPortal } from "react-dom";
import { format, isValid, parseISO } from "date-fns";
import RHFDatePicker from "./RHFDatePicker";
import { CalendarIcon, CircleAlertIcon, XIcon } from "@/components/icons";

/** Accepts a Date, an ISO date ("2026-11-03") or a timestamp string; ISO dates are read as local days. */
const toDate = (value) => {
  if (!value) return null;
  if (value instanceof Date) return isValid(value) ? value : null;
  const parsed = typeof value === "string" ? parseISO(value) : new Date(value);
  return isValid(parsed) ? parsed : null;
};

const toRange = (value) => ({ from: toDate(value?.from), to: toDate(value?.to) });

/**
 * Date field: a button showing the chosen day (or range) that opens RHFDatePicker. Controlled by `value` /
 * `onChange`, so it works with react-hook-form's Controller. Every option of the calendar is an option here:
 *
 *   mode "single" (default) | "range"     range values are { from, to }
 *   withTime, showSeconds                 ask for a time as well
 *   allowPast, allowFuture                false blocks the days before / after today
 *   minDate, maxDate                      block everything outside them
 *   presets, quickPresets, presetsOpen    shortcuts such as This month or Last year, chosen per field (see lib/datePresets.js)
 *   confirm, markedDates                  Cancel / Done for a single day; dots on days
 *   panelWidth                            CSS width of the calendar (default 22rem)
 *   showMonth "start" | "end"               which month a range opens on
 *   formatValue(value)                    the words shown in the field instead of the dates (return null to show the dates)
 *
 * valueFormat: "date" (default) gives onChange a Date; "iso" gives "yyyy-MM-dd" ("yyyy-MM-dd'T'HH:mm", plus ":ss" with
 * showSeconds, when there is a time; local time, no zone) — use it for date-only API fields so no time zone shifts the day.
 * A range gives { from, to } in the same format. Clearing gives null.
 */
const RHFDatePickerPopout = ({
  value,
  onChange,
  onBlur,
  name,
  ref,
  label = "Date",
  placeholder = "Select a Date",
  hint,
  error,
  required = false,
  disabled = false,
  clearable = false,
  valueFormat = "date",
  minDate,
  maxDate,
  mode = "single",
  withTime = false,
  showSeconds = false,
  allowPast = true,
  allowFuture = true,
  presets,
  quickPresets,
  presetsOpen,
  confirm,
  markedDates,
  formatValue,
  showMonth,
  panelWidth,
  className = "",
}) => {
  const range = mode === "range";
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState(null);
  const id = useId();
  const helpId = `${id}-help`;
  const wrapperRef = useRef(null);
  const triggerRef = useRef(null);
  const popRef = useRef(null);

  const date = range ? toRange(value) : toDate(value);
  const hasValue = range ? !!date.from : !!date;
  const errorMessage = typeof error === "string" ? error : error?.message;

  const close = (refocus) => {
    setOpen(false);
    onBlur?.();
    if (refocus) triggerRef.current?.focus();
  };

  useEffect(() => {
    if (!open) return undefined;
    const handleClickOutside = (e) => {
      if (!wrapperRef.current?.contains(e.target) && !popRef.current?.contains(e.target)) close(false);
    };
    const handleKey = (e) => {
      if (e.key === "Escape") close(true);
    };
    // The calendar floats over the page, so it closes rather than drift when something scrolls.
    const handleScroll = (e) => !popRef.current?.contains(e.target) && close(false);
    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleKey);
    window.addEventListener("scroll", handleScroll, true);
    window.addEventListener("resize", handleScroll);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleKey);
      window.removeEventListener("scroll", handleScroll, true);
      window.removeEventListener("resize", handleScroll);
    };
    // close only depends on onBlur
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // The calendar floats over the page, so a scrolling or narrow container (a filter pane, a dialog) cannot cut it off.
  // It is measured once drawn: below the field, above it when there is no room (hanging from its bottom edge, so there is
  // no gap whatever its height), or pinned to the top of the window when it fits in neither.
  useLayoutEffect(() => {
    if (!open || !triggerRef.current || !popRef.current) {
      setPos(null);
      return;
    }
    const rect = triggerRef.current.getBoundingClientRect();
    const width = popRef.current.offsetWidth;
    const height = popRef.current.offsetHeight;
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
    const below = rect.bottom + 8;
    if (below + height <= window.innerHeight - 8) setPos({ top: below, left });
    else if (rect.top - height - 8 >= 8) setPos({ bottom: window.innerHeight - rect.top + 8, left });
    else setPos({ top: Math.max(8, window.innerHeight - height - 8), left });
  }, [open]);

  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  const isoPattern = withTime ? (showSeconds ? "yyyy-MM-dd'T'HH:mm:ss" : "yyyy-MM-dd'T'HH:mm") : "yyyy-MM-dd";
  const one = (d) => (d && valueFormat === "iso" ? format(d, isoPattern) : d);
  const emit = (d) => onChange(d && range ? { from: one(d.from), to: one(d.to) } : one(d));

  const stamp = withTime ? (showSeconds ? "HH:mm:ss" : "HH:mm") : null;
  const show = (d, pattern) => format(d, stamp ? `${pattern}, ${stamp}` : pattern);
  const custom = hasValue ? formatValue?.(value) : null;
  const text = custom ? custom : range
    ? date.from
      ? `${show(date.from, "d MMM yyyy")} – ${date.to ? show(date.to, "d MMM yyyy") : "…"}`
      : null
    : date
      ? show(date, "EEE d MMMM yyyy")
      : null;

  return (
    <div ref={wrapperRef} className={`relative flex h-fit w-full min-w-0 flex-col gap-1 ${className}`}>
      <label htmlFor={id} onClick={(e) => e.preventDefault()} className="text-sm font-medium text-secondary-text" data-required={required || undefined}>
        {label}
      </label>
      <div className="relative">
        <button
          ref={(el) => {
            triggerRef.current = el;
            if (typeof ref === "function") ref(el);
            else if (ref) ref.current = el;
          }}
          id={id}
          name={name}
          type="button"
          disabled={disabled}
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-invalid={error ? true : undefined}
          aria-describedby={hint || errorMessage ? helpId : undefined}
          onClick={() => (open ? close(false) : setOpen(true))}
          // Same frame as TextInput: border, darker on hover, brand border + soft ring when focused or open.
          className={`${
            error
              ? "border-error-color hover:border-error-color focus-visible:ring-3 focus-visible:ring-error-color/20"
              : open
                ? "border-brand-primary ring-3 ring-brand-primary/20"
                : "border-border-color hover:border-border-dark-color focus-visible:border-brand-primary focus-visible:ring-3 focus-visible:ring-brand-primary/20"
          } h-9.5 w-full flex items-center border bg-text-input-color rounded-lg px-2 py-2 text-left outline-none transition-all duration-150 ${
            disabled ? "opacity-60 cursor-not-allowed hover:border-border-color" : "cursor-pointer"
          } ${clearable && hasValue && !disabled ? "pr-9" : ""}`}>
          {!error ? (
            <CalendarIcon className="w-5 h-5 text-primary-text mr-3 flex-shrink-0" />
          ) : (
            <CircleAlertIcon title={errorMessage} className="w-5 h-5 text-error-color mr-3 flex-shrink-0" />
          )}
          <span className={`truncate ${text ? "text-sm text-primary-text" : "text-sm text-muted"}`}>{text ?? placeholder}</span>
        </button>
        {clearable && hasValue && !disabled && (
          <button
            type="button"
            aria-label={`Clear ${label}`}
            onClick={() => emit(null)}
            className="absolute right-2 top-1/2 -translate-y-1/2 rounded-sm p-0.5 text-primary-text hover:bg-secondary-bg cursor-pointer">
            <XIcon className="w-4 h-4" />
          </button>
        )}
      </div>
      {(errorMessage || hint) && (
        <p id={helpId} className={`text-xs ${errorMessage ? "text-error-color" : "text-secondary-text"}`}>
          {errorMessage || hint}
        </p>
      )}

      {open && createPortal(
        <div
          ref={popRef}
          data-popover
          role="dialog"
          aria-label={`Choose ${label.toLowerCase()}`}
          style={pos ?? { visibility: "hidden" }}
          className="fixed z-[9500] w-max max-h-[calc(100vh-1rem)] overflow-y-auto rounded-2xl">
          <RHFDatePicker
            mode={mode}
            value={date}
            withTime={withTime}
            showSeconds={showSeconds}
            minDate={toDate(minDate)}
            maxDate={toDate(maxDate)}
            allowPast={allowPast}
            allowFuture={allowFuture}
            presets={presets}
            quickPresets={quickPresets}
            presetsOpen={presetsOpen}
            confirm={confirm}
            markedDates={markedDates}
            showMonth={showMonth}
            width={panelWidth}
            onCancel={() => close(true)}
            onChange={(d) => {
              emit(d);
              close(true);
            }}
          />
        </div>,
        document.body
      )}
    </div>
  );
};

export default RHFDatePickerPopout;
