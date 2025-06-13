import { useEffect, useRef, useState } from "react";
import clsx from "clsx";

export default function SlidingSelector({ typeFilter, setTypeFilter }) {
  const containerRef = useRef(null);
  const [indicatorStyle, setIndicatorStyle] = useState({ left: 0, width: 0 });

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const activeButton = container.querySelector(
      `[data-value="${typeFilter}"]`
    );
    if (activeButton) {
      const { offsetLeft, offsetWidth } = activeButton;
      setIndicatorStyle({ left: offsetLeft, width: offsetWidth });
    }
  }, [typeFilter]);

  return (
    <div
      ref={containerRef}
      className="relative flex items-center gap-2 rounded-full bg-primary-bg p-1 w-fit">
      <div
        className="absolute top-0 bottom-0 rounded-full bg-cta-color transition-all duration-300 ease-in-out"
        style={{
          left: indicatorStyle.left,
          width: indicatorStyle.width,
        }}
      />

      {["Internal", "Customer", "Supplier"].map((option) => (
        <button
          key={option}
          data-value={option}
          onClick={() => setTypeFilter(option)}
          className={clsx(
            "relative z-10 rounded-full py-0.5 xl:py-1.5 px-5 text-primary-text transition-colors duration-200",
            {
              "text-white": typeFilter === option,
              "hover:text-cta-color cursor-pointer": typeFilter !== option,
            }
          )}>
          {option.charAt(0).toUpperCase() + option.slice(1)}
        </button>
      ))}
    </div>
  );
}
