import { useState, useRef, useEffect } from "react";
import { RxCalendar } from "react-icons/rx";
import { IoChevronDown } from "react-icons/io5";
import { createPortal } from "react-dom";

const daysOfWeek = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];

function getDaysInMonth(year, month) {
  return new Date(year, month + 1, 0).getDate();
}

function generateCalendar(year, month) {
  const daysInMonth = getDaysInMonth(year, month);
  const firstDay = new Date(year, month, 1).getDay();
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

function getStartOfWeek(date, weekStartsOn = 1) {
  const d = new Date(date);
  const day = d.getDay(); // 0 (Sun) - 6 (Sat)
  const diff = (day < weekStartsOn ? 7 : 0) + day - weekStartsOn;
  d.setDate(d.getDate() - diff);
  return normalize(d);
}

function getEndOfWeek(date, weekStartsOn = 1) {
  const start = getStartOfWeek(date, weekStartsOn);
  const end = new Date(start);
  end.setDate(start.getDate() + 6);
  return normalize(end);
}

function getStartOfMonth(date) {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

function getEndOfMonth(date) {
  return new Date(date.getFullYear(), date.getMonth() + 1, 0);
}

function getStartOfYear(date) {
  return new Date(date.getFullYear(), 0, 1);
}

function getEndOfYear(date) {
  return new Date(date.getFullYear(), 11, 31);
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

function normalize(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

export default function DateRangePicker({
  onChange,
  defaultStartDate,
  defaultEndDate,
}) {
  const triggerRef = useRef(null);
  const dropdownRef = useRef(null);
  const [isOpen, setIsOpen] = useState(false);
  const [mode, setMode] = useState("quick");
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

  const presets = [
    {
      label: "Last Week",
      range: () => {
        const startOfThisWeek = getStartOfWeek(new Date(), 1);
        const start = new Date(startOfThisWeek);
        start.setDate(start.getDate() - 7);
        const end = new Date(start);
        end.setDate(start.getDate() + 6);
        return [normalize(start), normalize(end)];
      },
    },
    {
      label: "This Week",
      range: () => [getStartOfWeek(new Date(), 1), getEndOfWeek(new Date(), 1)],
    },
    {
      label: "Last Month",
      range: () => {
        const now = new Date();
        const lastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
        return [getStartOfMonth(lastMonth), getEndOfMonth(lastMonth)];
      },
    },
    {
      label: "This Month",
      range: () => [getStartOfMonth(new Date()), getEndOfMonth(new Date())],
    },
    {
      label: "Last Quarter",
      range: () => {
        const now = new Date();
        const currentQuarter = Math.floor(now.getMonth() / 3);
        const startMonth = ((currentQuarter - 1 + 4) % 4) * 3;
        const year =
          currentQuarter === 0 ? now.getFullYear() - 1 : now.getFullYear();
        const start = new Date(year, startMonth, 1);
        const end = new Date(year, startMonth + 3, 0);
        return [normalize(start), normalize(end)];
      },
    },
    {
      label: "This Quarter",
      range: () => {
        const now = new Date();
        const currentQuarter = Math.floor(now.getMonth() / 3);
        const startMonth = currentQuarter * 3;
        const start = new Date(now.getFullYear(), startMonth, 1);
        const end = new Date(now.getFullYear(), startMonth + 3, 0);
        return [normalize(start), normalize(end)];
      },
    },
    {
      label: "Last Year",
      prevoius: () => {
        const previousYear = new Date().getFullYear() - 2;
        return [new Date(previousYear, 0, 1), new Date(previousYear, 11, 31)];
      },
      range: () => {
        const lastYear = new Date().getFullYear() - 1;
        return [new Date(lastYear, 0, 1), new Date(lastYear, 11, 31)];
      },
    },
    {
      label: "This Year",
      prevoius: "Last Year",
      range: () => [getStartOfYear(new Date()), getEndOfYear(new Date())],
    },
    {
      label: "Rolling 7 Days",
      previous: "Previous 7 Days",
      range: () => {
        const end = normalize(new Date());
        const start = new Date(end);
        start.setDate(end.getDate() - 6);
        return [normalize(start), end];
      },
    },
    {
      label: "Rolling 30 Days",
      previous: "Previous 30 Days",
      range: () => {
        const end = normalize(new Date());
        const start = new Date(end);
        start.setDate(end.getDate() - 29);
        return [normalize(start), end];
      },
    },
    {
      label: "Rolling 90 Days",
      previous: "Previous 90 Days",
      range: () => {
        const end = normalize(new Date());
        const start = new Date(end);
        start.setDate(end.getDate() - 89);
        return [normalize(start), end];
      },
    },
  ];

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
    <div className="relative w-fit" ref={containerRef}>
      <div
        onClick={() => setIsOpen(!isOpen)}
        className="relative"
        ref={triggerRef}>
        <RxCalendar className="absolute left-3 top-2.5 text-icon-color w-5 h-5" />
        <input
          type="text"
          readOnly
          className="border border-border-color text-primary-text pr-4 pl-11 py-2 rounded-lg bg-text-input-color w-80 focus:outline-none focus:ring"
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
            {mode === "custom" && (
              <div className="flex-1 w-70 p-4">
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
                <div className="flex justify-between mt-2">
                  <button
                    className="px-3 py-1 text-sm border rounded hover:bg-gray-100"
                    onClick={() => {
                      setStartDate(null);
                      setEndDate(null);
                      if (onChange) {
                        onChange({ startDate: null, endDate: null });
                      }
                    }}>
                    Clear
                  </button>
                  <button
                    disabled={!startDate || !endDate}
                    className={`px-3 py-1 text-sm text-white rounded ${
                      startDate && endDate
                        ? "bg-blue-600 hover:bg-blue-700"
                        : "bg-gray-300 cursor-not-allowed"
                    }`}
                    onClick={() => {
                      if (onChange && startDate && endDate) {
                        onChange({ startDate, endDate });
                      }
                      setIsOpen(false);
                    }}>
                    Apply
                  </button>
                </div>
              </div>
            )}

            {mode === "custom" && (
              <div className="w-0.25 bg-border-color"></div>
            )}

            {/* Sidebar */}
            <div className="w-40 p-3">
              {presets.map(({ label, range }) => {
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
          </div>,
          document.body
        )}
    </div>
  );
}
