import { useState } from "react";
import { IoChevronDown } from "react-icons/io5";
import {
  startOfMonth,
  endOfMonth,
  eachDayOfInterval,
  getDay,
  format,
  addMonths,
  addYears,
  isSameDay,
  isToday,
  isSameMonth,
  isSameYear,
  setMonth,
  setYear,
} from "date-fns";

const daysOfWeek = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];
const monthsOfYear = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

const RHFDatePicker = ({ value, onChange }) => {
  const today = new Date();
  const [currentMonth, setCurrentMonth] = useState(value || new Date());
  const [currentYear, setCurrentYear] = useState(value || new Date());

  const handleSelectDate = (date) => {
    console.log("Selected date:", date);
    onChange(date);
    setCurrentMonth(date);
    setCurrentYear(date);
  };

  const getCalendarDays = (date) => {
    const start = startOfMonth(date);
    const end = endOfMonth(date);
    const days = eachDayOfInterval({ start, end });
    const padding = Array(getDay(start)).fill(null);
    return [...padding, ...days];
  };

  const handleMonthClick = (monthIndex) => {
    const updated = setMonth(
      setYear(new Date(), currentYear.getFullYear()),
      monthIndex
    );
    setCurrentMonth(updated);
    setCurrentYear(updated);
  };

  const handleYearChange = (amount) => {
    const updated = addYears(currentYear, amount);
    setCurrentYear(updated);
  };

  const handleMonthChange = (amount) => {
    const updated = addMonths(currentMonth, amount);
    setCurrentMonth(updated);
    setCurrentYear(updated);
  };

  const handleGoToToday = () => {
    setCurrentMonth(today);
    setCurrentYear(today);
  };

  const calendarDays = getCalendarDays(currentMonth);

  return (
    <div className="flex bg-text-input-color border border-border-color rounded-xl shadow-md p-4 w-120 max-w-lg gap-4 text-sm text-primary-text">
      {/* Left: Month View */}
      <div className="w-1/2">
        <div className="flex justify-between items-center mb-2">
          <span className="font-semibold">
            {format(currentMonth, "MMMM yyyy")}
          </span>
          <div className="flex gap-1">
            <button
              onClick={() => handleMonthChange(-1)}
              className="hover:bg-border-color px-2 py-1 rounded active:scale-95">
              <IoChevronDown className="w-5 h-5 rotate-180 active:scale-95" />
            </button>
            <button
              onClick={() => handleMonthChange(1)}
              className="hover:bg-border-color px-2 py-1 rounded active:scale-95">
              <IoChevronDown className="w-5 h-5" />
            </button>
          </div>
        </div>

        <div className="grid grid-cols-7 text-center text-primary-text mb-1 font-medium">
          {daysOfWeek.map((d) => (
            <div key={d}>{d}</div>
          ))}
        </div>

        <div className="grid grid-cols-7 text-center gap-1 text-primary-text">
          {calendarDays.map((day, i) => {
            if (!day) return <div key={i} />;
            const isSelected = value && isSameDay(day, value);
            const isCurrentDay = isToday(day);
            const classes = [
              "h-7 w-7 rounded flex items-center justify-center",
              isSelected ? "bg-brand-primary text-white" : "",
              isCurrentDay && !isSelected
                ? "border border-brand-primary hover:bg-border-color/50"
                : "",
              !isSelected && !isCurrentDay ? "hover:bg-border-color/50" : "",
            ].join(" ");

            return (
              <button
                key={i}
                onClick={() => handleSelectDate(day)}
                className={classes}>
                {day.getDate()}
              </button>
            );
          })}
        </div>
      </div>

      {/* Right: Year View */}
      <div className="w-1/2 flex flex-col justify-between">
        <div>
          <div className="flex justify-between items-center mb-1">
            <span className="font-semibold">{format(currentYear, "yyyy")}</span>
            <div className="flex gap-1">
              <button
                onClick={() => handleYearChange(-1)}
                className="hover:bg-border-color px-2 py-1 rounded active:scale-95">
                <IoChevronDown className="w-5 h-5 rotate-180" />
              </button>
              <button
                onClick={() => handleYearChange(1)}
                className="hover:bg-border-color px-2 py-1 rounded active:scale-95">
                <IoChevronDown className="w-5 h-5" />
              </button>
            </div>
          </div>

          <div className="grid grid-cols-4 gap-y-8 gap-x-2 text-center">
            {monthsOfYear.map((month, i) => {
              const monthDate = setMonth(
                setYear(new Date(), currentYear.getFullYear()),
                i
              );
              const isSelectedMonth =
                value &&
                isSameMonth(monthDate, value) &&
                isSameYear(monthDate, value);
              const isTodayMonth =
                isSameMonth(monthDate, today) && isSameYear(monthDate, today);
              const classes = [
                "h-7 w-10 rounded flex items-center justify-center",
                isSelectedMonth ? "bg-brand-primary text-white" : "",
                isTodayMonth && !isSelectedMonth
                  ? "border border-brand-primary hover:bg-border-color/50"
                  : "",
                !isSelectedMonth && !isTodayMonth
                  ? "hover:bg-border-color/50"
                  : "",
              ].join(" ");

              return (
                <button
                  key={month}
                  onClick={() => handleMonthClick(i)}
                  className={classes}>
                  {month}
                </button>
              );
            })}
          </div>
        </div>

        <button
          onClick={handleGoToToday}
          className="mt-4 ml-auto text-brand-primary hover:underline text-sm self-center cursor-pointer">
          Go to today
        </button>
      </div>
    </div>
  );
};

export default RHFDatePicker;
