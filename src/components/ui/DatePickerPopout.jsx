import { useState, useRef, useEffect } from "react";
import DatePicker from "./DatePicker"; // Your existing component
import { RxCalendar } from "react-icons/rx";

const DatePickerPopout = ({
  value: currentDate,
  onChange,
  label = "Date",
  placeholder = "Select a Date",
}) => {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef(null);
  const popoutRef = useRef(null);

  // Close on click outside
  useEffect(() => {
    const handleClickOutside = (e) => {
      if (
        popoutRef.current &&
        !popoutRef.current.contains(e.target) &&
        !triggerRef.current.contains(e.target)
      ) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  return (
    <div className="relative inline-block h-fit w-full">
      {/* Trigger Input */}
      <span className="text-primary-text">{label}</span>
      <div
        ref={triggerRef}
        className={`h-10.5 ${
          open && "border-brand-primary hover:border-brand-primary"
        } flex items-center border border-border-color bg-text-input-color rounded-lg px-2 py-2 cursor-pointer hover:border-border-dark-color`}
        onClick={() => setOpen((prev) => !prev)}>
        <RxCalendar className="w-5 h-5 text-primary-text mr-2" />
        <span
          className={`${
            currentDate ? "text-primary-text" : "text-sm text-muted"
          }`}>
          {currentDate
            ? currentDate.toLocaleDateString("en-GB", {
                weekday: "long", // Fri
                day: "numeric", // 08
                month: "long", // Sep
                year: "numeric", // 25
              })
            : placeholder}
        </span>
      </div>

      {/* Popout Calendar */}
      {open && (
        <div ref={popoutRef} className="absolute z-50 mt-2 left-0 w-max">
          <DatePicker
            currentDate={currentDate}
            onChange={(date) => {
              onChange(date);
              setOpen(false);
            }}
          />
        </div>
      )}
    </div>
  );
};

export default DatePickerPopout;
