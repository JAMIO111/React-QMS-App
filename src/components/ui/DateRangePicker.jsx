import { useState, useRef, useEffect } from "react";
import { RxCalendar } from "react-icons/rx";
import { IoChevronDown } from "react-icons/io5";
import { createPortal } from "react-dom";
import CTAButton from "../CTAButton";
import { datePresets, normalize } from "@/lib/HelperFunctions";
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
  label,
  onChange,
  defaultStartDate,
  defaultEndDate,
  switchMode = true,
  width = "w-fit",
}) {
  const triggerRef = useRef(null);
  const dropdownRef = useRef(null);
  const [hoverDate, setHoverDate] = useState(null);
  const [isOpen, setIsOpen] = useState(false);
  const [mode, setMode] = useState(switchMode ? "quick" : "static"); // "quick" or "custom"
  const [startDate, setStartDate] = useState(
    defaultStartDate ? normalize(defaultStartDate) : null
  );
  const [endDate, setEndDate] = useState(
    defaultEndDate ? normalize(defaultEndDate) : null
  );

  const [calendarDate, setCalendarDate] = useState({
    year: new Date().getFullYear(),
    month: new Date().getMonth(),
  });
  const containerRef = useRef(null);

  function goToPreviousMonth() {
    setCalendarDate(({ year, month }) => {
      if (month === 0) {
        return { year: year - 1, month: 11 };
      }
      return { year, month: month - 1 };
    });
  }

  function goToNextMonth() {
    setCalendarDate(({ year, month }) => {
      if (month === 11) {
        return { year: year + 1, month: 0 };
      }
      return { year, month: month + 1 };
    });
  }

  useEffect(() => {
    function handleClickOutside(e) {
      if (containerRef.current && !containerRef.current.contains(e.target)) {
        setIsOpen(false);
        setMode("quick");
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const { year, month } = calendarDate;
  const calendar = generateCalendar(year, month);

  function handleDayClick(day) {
    const normalizedDay = new Date(day);
    normalizedDay.setHours(0, 0, 0, 0);

    if (!startDate || (startDate && endDate)) {
      setStartDate(normalizedDay);
      setEndDate(null);
    } else {
      if (normalizedDay < startDate) {
        setEndDate(startDate);
        setStartDate(normalizedDay);
      } else {
        setEndDate(normalizedDay);
      }
    }
  }

  function isInRange(day) {
    if (startDate && !endDate && hoverDate) {
      const min = hoverDate > startDate ? startDate : hoverDate;
      const max = hoverDate > startDate ? hoverDate : startDate;
      return day >= min && day <= max;
    }
    return startDate && endDate && day >= startDate && day <= endDate;
  }

  function isEdge(day) {
    return (
      (startDate && day.getTime() === startDate.getTime()) ||
      (endDate && day.getTime() === endDate.getTime())
    );
  }

  function selectPresetRange(start, end) {
    setStartDate(start);
    setEndDate(end);
    setCalendarDate({
      year: start.getFullYear(),
      month: start.getMonth(),
    });
    setIsOpen(false);
    setMode("quick");
    if (onChange) {
      onChange({ startDate: start, endDate: end });
    }
  }

  function isSameDay(date1, date2) {
    return (
      date1.getFullYear() === date2.getFullYear() &&
      date1.getMonth() === date2.getMonth() &&
      date1.getDate() === date2.getDate()
    );
  }

  function isSameRange(start1, end1, start2, end2) {
    return isSameDay(start1, start2) && isSameDay(end1, end2);
  }

  return (
    <div className={`relative ${width}`} ref={containerRef}>
      {label && (
        <p className="text-lg font-medium text-primary-text">{label}</p>
      )}
      <div
        onClick={() => setIsOpen(!isOpen)}
        className="relative w-full"
        ref={triggerRef}>
        <RxCalendar className="absolute left-2.5 top-2 text-primary-text w-5 h-5" />
        <input
          type="text"
          readOnly
          className="placeholder:normal-case placeholder:text-sm placeholder:text-muted border w-full border-border-color text-primary-text pr-4 pl-11 py-1.5 rounded-lg bg-text-input-color focus:outline-none focus:ring"
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

      {isOpen &&
        createPortal(
          <div
            ref={dropdownRef}
            style={{
              position: "absolute",
              top: triggerRef.current
                ? triggerRef.current.getBoundingClientRect().bottom + 8
                : 0,
              right: triggerRef.current
                ? window.innerWidth -
                  triggerRef.current.getBoundingClientRect().right
                : 0,
              left: triggerRef.current,
            }}
            onMouseDown={(e) => e.stopPropagation()}
            className="absolute top-12 z-50 flex items-stretch border border-border-color bg-secondary-bg rounded-md shadow-lg w-fit">
            {/* Calendar */}
            {mode !== "static" && (
              <div className="flex flex-col flex-1 w-70 p-4">
                <div className="flex justify-between items-center mb-2">
                  <button
                    className="hover:bg-border-color/20 rounded p-1 text-primary-text"
                    onClick={goToPreviousMonth}>
                    <IoChevronDown className="rotate-90" />
                  </button>
                  <span className="font-medium text-primary-text">
                    {new Date(
                      calendarDate.year,
                      calendarDate.month
                    ).toLocaleDateString("en-GB", {
                      month: "long",
                      year: "numeric",
                    })}
                  </span>
                  <button
                    className="hover:bg-border-color/20 rounded text-primary-text p-1"
                    onClick={goToNextMonth}>
                    <IoChevronDown className="rotate-270" />
                  </button>
                </div>
                <div className="grid grid-cols-7 text-center text-xs font-semibold text-secondary-text mb-1">
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
                          className={`h-9 w-9 text-sm transition-colors text-primary-text
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
                    callbackFn={() => {
                      setStartDate(null);
                      setEndDate(null);
                      if (onChange) {
                        onChange({ startDate: null, endDate: null });
                      }
                    }}
                  />
                  {startDate && !endDate && hoverDate && (
                    <div className="font-semibold bg-cta-btn-bg border rounded-lg border-cta-btn-border flex items-center justify-center text-primary-text px-2 py-0.5">
                      {Math.abs(
                        Math.round(
                          (hoverDate - startDate) / (1000 * 60 * 60 * 24)
                        )
                      )}{" "}
                      nights
                    </div>
                  )}
                  <CTAButton
                    disabled={!startDate || !endDate}
                    type="success"
                    text="Apply"
                    title="Apply Date Range"
                    icon={null}
                    callbackFn={() => {
                      if (onChange && startDate && endDate) {
                        onChange({ startDate, endDate });
                      }
                      setIsOpen(false);
                    }}
                  />
                </div>
              </div>
            )}

            {mode === "custom" && (
              <div className="w-0.25 bg-border-color"></div>
            )}

            {/* Sidebar */}
            {mode === "quick" && (
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
                      className={`block w-full text-left cursor-pointer text-sm text-primary-text py-1 px-2 rounded
                  ${
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
                  className="mt-2 block w-full text-left cursor-pointer text-sm py-1 px-2 bg-primary-text text-primary-bg rounded"
                  onClick={() => {
                    setMode("custom");
                  }}>
                  Custom Range
                </button>
              </div>
            )}
          </div>,
          document.body
        )}
    </div>
  );
}
