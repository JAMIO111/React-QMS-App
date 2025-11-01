import { useEffect, useRef, useState } from "react";
import clsx from "clsx";

export default function SlidingSelector({
  options = [],
  value,
  onChange,
  getLabel = (opt) => opt,
  getValue = (opt) => opt,
  notifications,
}) {
  const containerRef = useRef(null);
  const [indicatorStyle, setIndicatorStyle] = useState({ left: 0, width: 0 });

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const activeButton = container.querySelector(
      `[data-value="${getValue(value)}"]`
    );
    if (activeButton) {
      const { offsetLeft, offsetWidth } = activeButton;
      setIndicatorStyle({ left: offsetLeft, width: offsetWidth });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, options]); // omit getValue

  return (
    <div
      ref={containerRef}
      className="relative bg-secondary-bg shadow-s flex justify-between items-center gap-2 w-full rounded-xl p-1">
      <div
        className="absolute shadow-s bg-border-color top-1 bottom-1 rounded-lg transition-all duration-300 ease-in-out"
        style={{
          left: indicatorStyle.left,
          width: indicatorStyle.width,
        }}
      />

      {options.map((option) => {
        const optionValue = getValue(option);
        const label = getLabel(option);
        const isActive = getValue(value) === optionValue;

        const count =
          option === "All"
            ? notifications?.length
            : option === "New"
            ? notifications?.filter((n) => !n.read).length
            : option === "Read"
            ? notifications?.filter((n) => n.read).length
            : 0;

        return (
          <button
            key={optionValue}
            data-value={optionValue}
            onClick={() => onChange(option)}
            className={clsx(
              "group flex gap-3 justify-center items-center relative z-10 py-1 px-3 text-primary-text transition-colors duration-200 flex-1",
              {
                "text-primary-text": isActive,
                "cursor-pointer": !isActive,
              }
            )}>
            <p className={clsx({ "group-hover:text-cta-color": !isActive })}>
              {label}
            </p>
            {notifications && (
              <div className="flex items-center justify-center bg-cta-color text-white hover:text-white rounded-full w-5 h-5">
                {count ?? 0}
              </div>
            )}
          </button>
        );
      })}
    </div>
  );
}
