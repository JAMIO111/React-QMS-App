import { useState, useRef, useEffect, useId } from "react";
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

/**
 * Date field: a button showing the chosen day that opens RHFDatePicker. Controlled by `value` /
 * `onChange`, so it works with react-hook-form's Controller.
 *
 * valueFormat: "date" (default) gives onChange a Date; "iso" gives "yyyy-MM-dd" — use it for
 * date-only API fields so no time zone shifts the day.
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
  className = "",
}) => {
  const [open, setOpen] = useState(false);
  const [alignRight, setAlignRight] = useState(false);
  const id = useId();
  const helpId = `${id}-help`;
  const wrapperRef = useRef(null);
  const triggerRef = useRef(null);

  const date = toDate(value);
  const errorMessage = typeof error === "string" ? error : error?.message;

  const close = (refocus) => {
    setOpen(false);
    onBlur?.();
    if (refocus) triggerRef.current?.focus();
  };

  useEffect(() => {
    if (!open) return undefined;
    const handleClickOutside = (e) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target)) close(false);
    };
    const handleKey = (e) => {
      if (e.key === "Escape") close(true);
    };
    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleKey);
    };
    // close only depends on onBlur
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (open && wrapperRef.current) {
      // The calendar is about 30rem wide; open it to the left when there is no room on the right.
      const rect = wrapperRef.current.getBoundingClientRect();
      setAlignRight(window.innerWidth - rect.left < 500 && rect.right > 500);
    }
  }, [open]);

  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  const emit = (d) => onChange(d && valueFormat === "iso" ? format(d, "yyyy-MM-dd") : d);

  return (
    <div ref={wrapperRef} className={`relative flex h-fit w-full min-w-0 flex-col gap-1 ${className}`}>
      <label htmlFor={id} className="text-sm font-medium text-primary-text">
        {label}
        {required && (
          <span className="text-error-color" title="Required">
            {" "}*
          </span>
        )}
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
          className={`${error ? "border-error-color hover:border-error-color/70" : open ? "border-brand-primary" : "border-border-color hover:border-border-dark-color"} h-10.5 w-full flex items-center border bg-text-input-color rounded-lg px-2 py-2 text-left shadow-s ${
            disabled ? "opacity-60 cursor-not-allowed" : "cursor-pointer"
          } ${clearable && date && !disabled ? "pr-9" : ""}`}>
          {!error ? (
            <CalendarIcon className="w-5 h-5 text-primary-text mr-2 flex-shrink-0" />
          ) : (
            <CircleAlertIcon title={errorMessage} className="w-5 h-5 text-error-color mr-2 flex-shrink-0" />
          )}
          <span className={`truncate ${date ? "text-primary-text" : "text-sm text-muted"}`}>
            {date ? format(date, "EEE d MMMM yyyy") : placeholder}
          </span>
        </button>
        {clearable && date && !disabled && (
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

      {open && (
        <div role="dialog" aria-label={`Choose ${label.toLowerCase()}`} className={`absolute top-full z-50 mt-2 w-max ${alignRight ? "right-0" : "left-0"}`}>
          <RHFDatePicker
            value={date}
            minDate={toDate(minDate)}
            maxDate={toDate(maxDate)}
            onChange={(d) => {
              emit(d);
              close(true);
            }}
          />
        </div>
      )}
    </div>
  );
};

export default RHFDatePickerPopout;
