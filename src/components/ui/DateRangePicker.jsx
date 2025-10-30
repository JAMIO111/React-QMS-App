// ./ui/DateRangePicker.jsx
import { useState, useRef, useEffect } from "react";
import { RxCalendar } from "react-icons/rx";
import { IoChevronDown } from "react-icons/io5";
import CTAButton from "../CTAButton";
import { datePresets, normalize } from "@/lib/HelperFunctions";
import { MdErrorOutline } from "react-icons/md";

const daysOfWeek = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"];

function getDaysInMonth(year, month) {
  return new Date(year, month + 1, 0).getDate();
}

function generateCalendar(year, month) {
  const daysInMonth = getDaysInMonth(year, month);
  const firstDay = (new Date(year, month, 1).getDay() + 6) % 7;
  const calendar = [];
  let dayCounter = 1 - firstDay;

  while (dayCounter <= daysInMonth) {
    const week = [];
    for (let i = 0; i < 7; i++) {
      week.push(
        dayCounter < 1 || dayCounter > daysInMonth
          ? null
          : new Date(year, month, dayCounter)
      );
      dayCounter++;
    }
    calendar.push(week);
  }
  return calendar;
}

function formatDate(date) {
  return date
    ? date.toLocaleDateString("en-GB", {
        weekday: "short",
        day: "numeric",
        month: "short",
        year: "2-digit",
      })
    : "";
}

export default function DateRangePicker({
  alignment = "left",
  label,
  required = false,
  value = { startDate: null, endDate: null },
  onChange,
  switchMode = true,
  width = "w-fit",
  rangeCounter = true,
  rangeCounterText = "nights",
  error,
}) {
  const triggerRef = useRef(null);
  const containerRef = useRef(null);
  const popupRef = useRef(null);

  const [isOpen, setIsOpen] = useState(false);
  const [hoverDate, setHoverDate] = useState(null);
  const [mode, setMode] = useState(switchMode ? "quick" : "static");
  const [calendarDate, setCalendarDate] = useState({
    year: new Date().getFullYear(),
    month: new Date().getMonth(),
  });

  const startDate = value.startDate ? normalize(value.startDate) : null;
  const endDate = value.endDate ? normalize(value.endDate) : null;

  // ---- Handle clicks outside ----
  useEffect(() => {
    if (!isOpen) return;
    const handleClickOutside = (e) => {
      if (
        containerRef.current &&
        !containerRef.current.contains(e.target) &&
        !triggerRef.current.contains(e.target)
      ) {
        setIsOpen(false);
        switchMode && setMode("quick");
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [isOpen]);

  // ---- Calendar navigation ----
  const goToPreviousMonth = () =>
    setCalendarDate(({ year, month }) =>
      month === 0 ? { year: year - 1, month: 11 } : { year, month: month - 1 }
    );
  const goToNextMonth = () =>
    setCalendarDate(({ year, month }) =>
      month === 11 ? { year: year + 1, month: 0 } : { year, month: month + 1 }
    );

  const { year, month } = calendarDate;
  const calendar = generateCalendar(year, month);

  // ---- Day selection ----
  const handleDayClick = (day) => {
    const normalizedDay = new Date(day);
    normalizedDay.setHours(0, 0, 0, 0);

    if (!startDate || (startDate && endDate)) {
      onChange({ startDate: normalizedDay, endDate: null });
    } else {
      if (normalizedDay < startDate) {
        onChange({ startDate: normalizedDay, endDate: startDate });
      } else {
        onChange({ startDate, endDate: normalizedDay });
      }
    }
  };

  const isInRange = (day) => {
    if (startDate && !endDate && hoverDate) {
      const min = hoverDate > startDate ? startDate : hoverDate;
      const max = hoverDate > startDate ? hoverDate : startDate;
      return day >= min && day <= max;
    }
    return startDate && endDate && day >= startDate && day <= endDate;
  };

  const isEdge = (day) =>
    (startDate && day.getTime() === startDate.getTime()) ||
    (endDate && day.getTime() === endDate.getTime());

  const isSameDay = (d1, d2) =>
    d1?.getFullYear() === d2?.getFullYear() &&
    d1?.getMonth() === d2?.getMonth() &&
    d1?.getDate() === d2?.getDate();

  const isSameRange = (s1, e1, s2, e2) =>
    isSameDay(s1, s2) && isSameDay(e1, e2);

  const selectPresetRange = (start, end) => {
    onChange({ startDate: start, endDate: end });
    setCalendarDate({ year: start.getFullYear(), month: start.getMonth() });
    setIsOpen(false);
    setMode("quick");
  };

  return (
    <div className={`relative ${width}`} ref={containerRef}>
      {label && (
        <div className="flex items-center gap-1 mb-1">
          <label className="font-medium text-primary-text">{label}</label>
          {required && (
            <label className="text-error-color text-sm" title="Required">
              *
            </label>
          )}
        </div>
      )}

      <div
        onMouseDown={(e) => {
          e.stopPropagation();
          setIsOpen((prev) => !prev);
        }}
        title={error && error.message}
        className="relative flex items-center w-full cursor-pointer"
        ref={triggerRef}>
        {error ? (
          <MdErrorOutline className="absolute left-2.5 top-2.5 text-error-color w-5 h-5" />
        ) : (
          <RxCalendar className="absolute left-2.5 top-2.5 text-primary-text w-5 h-5" />
        )}
        <input
          type="text"
          readOnly
          className={`border ${isOpen ? "border-cta-color" : ""} ${
            error ? "border-error-color" : "border-transparent"
          } placeholder:normal-case cursor-pointer placeholder:text-sm placeholder:text-muted w-full shadow-s hover:shadow-m text-primary-text pr-4 pl-11 py-2 rounded-lg bg-text-input-color focus:outline-none`}
          value={
            startDate && endDate
              ? `${formatDate(startDate)} - ${formatDate(endDate)}`
              : startDate
              ? `${formatDate(startDate)} -`
              : ""
          }
          placeholder="Select date range"
        />
      </div>

      {isOpen && (
        <div
          ref={popupRef}
          className={`absolute ${label ? "top-18" : "top-12"} ${
            alignment === "right" ? "right-0" : "left-0"
          } z-50 flex items-stretch bg-secondary-bg rounded-xl shadow-s w-fit`}>
          {/* Calendar */}
          <div className="flex flex-col flex-1 w-70 p-4">
            <div className="flex justify-between items-center mb-2">
              <button
                className="hover:bg-border-color/20 rounded p-1 text-primary-text"
                onClick={goToPreviousMonth}>
                <IoChevronDown className="rotate-90" />
              </button>
              <span className="font-medium text-primary-text">
                {new Date(year, month).toLocaleDateString("en-GB", {
                  month: "long",
                  year: "numeric",
                })}
              </span>
              <button
                className="hover:bg-border-color/20 rounded p-1 text-primary-text"
                onClick={goToNextMonth}>
                <IoChevronDown className="rotate-270" />
              </button>
            </div>

            <div className="grid grid-cols-7 text-center text-xs font-semibold text-secondary-text">
              {daysOfWeek.map((d) => (
                <div key={d}>{d}</div>
              ))}
            </div>

            <div className="grid grid-cols-7 gap-1">
              {calendar.flatMap((week, i) =>
                week.map((day, j) =>
                  day ? (
                    <button
                      key={`${i}-${j}`}
                      onClick={() => handleDayClick(day)}
                      onMouseEnter={() => setHoverDate(day)}
                      onMouseLeave={() => setHoverDate(null)}
                      className={`h-8 w-9 text-sm transition-colors text-primary-text
                        ${
                          isEdge(day)
                            ? startDate &&
                              endDate &&
                              startDate.getTime() === endDate.getTime()
                              ? "bg-cta-color text-white rounded-xl"
                              : day.getTime() === startDate?.getTime()
                              ? "bg-cta-color text-white rounded-l-xl"
                              : "bg-cta-color text-white rounded-r-xl"
                            : isInRange(day)
                            ? "bg-cta-color/20 text-blue-800"
                            : "hover:bg-cta-color/5 rounded-xl"
                        }
                      `}>
                      {day.getDate()}
                    </button>
                  ) : (
                    <div key={`${i}-${j}`} />
                  )
                )
              )}
            </div>

            <div className="flex flex-1 items-end justify-between mt-2">
              <CTAButton
                type="cancel"
                text="Reset"
                title="Reset Date Range"
                icon={null}
                callbackFn={() => onChange({ startDate: null, endDate: null })}
              />
              {rangeCounter && startDate && (
                <div className="font-semibold bg-cta-btn-bg border rounded-lg border-cta-btn-border flex items-center justify-center text-primary-text px-2 py-1">
                  {Math.abs(
                    Math.round(
                      ((endDate || hoverDate || startDate) - startDate) /
                        (1000 * 60 * 60 * 24)
                    )
                  )}{" "}
                  {rangeCounterText}
                </div>
              )}
              <CTAButton
                disabled={!startDate || !endDate}
                type="success"
                text="Apply"
                title="Apply Date Range"
                icon={null}
                callbackFn={() => {
                  if (startDate && endDate) onChange({ startDate, endDate });
                  setIsOpen(false);
                }}
              />
            </div>
          </div>

          {/* Sidebar */}
          {mode !== "static" && (
            <>
              <div className="w-0.25 bg-border-color"></div>
              <div className="w-40 p-3">
                {datePresets.map(({ label, range }) => {
                  const [presetStart, presetEnd] = range();
                  const isSelected =
                    startDate &&
                    endDate &&
                    isSameRange(presetStart, presetEnd, startDate, endDate);

                  return (
                    <button
                      key={label}
                      className={`block w-full text-left text-sm text-primary-text py-1 px-2 rounded ${
                        isSelected
                          ? "bg-cta-color text-white"
                          : "hover:bg-cta-color/10"
                      }`}
                      onClick={() => {
                        const [start, end] = range();
                        selectPresetRange(start, end);
                      }}>
                      {label}
                    </button>
                  );
                })}
                <button
                  className="mt-2 block w-full text-left text-sm py-1 px-2 bg-primary-text text-primary-bg rounded"
                  onClick={() => setMode("custom")}>
                  Custom Range
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
