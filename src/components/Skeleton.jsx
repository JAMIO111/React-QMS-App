import { useEffect, useRef, useState } from "react";

export const SkeletonCard1 = () => {
  return (
    <div className="w-full bg-border-color/50 h-16 rounded-xl px-5 gap-5 flex flex-row items-center p-3 ">
      <div className="w-12 h-10 rounded-full bg-border-dark-color/70 shimmer"></div>
      <div className="flex w-full h-full flex-col justify-between items-center">
        <div className="w-full h-3 bg-border-dark-color/70 rounded-full shimmer"></div>
        <div className="w-full h-3 bg-border-dark-color/70 rounded-full shimmer"></div>
      </div>
    </div>
  );
};

export const SkeletonTable = () => {
  const containerRef = useRef(null);
  const rowHeight = 48; // Tailwind's h-12 (12 * 4px = 48px)
  const [rowCount, setRowCount] = useState(5); // fallback default

  useEffect(() => {
    const updateRowCount = () => {
      if (containerRef.current) {
        const availableHeight = containerRef.current.clientHeight;
        const headerHeight = 56; // h-14 = 56px
        const paddingY = 48; // py-6 = 24px * 2
        const usableHeight = availableHeight - headerHeight - paddingY;
        const count = Math.floor(usableHeight / rowHeight);
        setRowCount(Math.max(1, count));
      }
    };

    updateRowCount();
    window.addEventListener("resize", updateRowCount);
    return () => window.removeEventListener("resize", updateRowCount);
  }, []);

  return (
    <div
      ref={containerRef}
      className="w-full h-full bg-border-color/50 rounded-xl px-5 gap-5 flex flex-col items-start py-6 overflow-hidden">
      {/* Simulated header row */}
      <div className="w-full h-14 bg-border-dark-color/70 rounded-lg shimmer mb-2"></div>

      <div className="flex w-full flex-col gap-3 overflow-hidden">
        {Array.from({ length: rowCount }).map((_, index) => (
          <div key={index} className="w-full flex gap-3">
            {[...Array(5)].map((_, colIndex) => (
              <div
                key={colIndex}
                className="w-full h-10 bg-border-dark-color/70 rounded-lg shimmer"
              />
            ))}
          </div>
        ))}
      </div>
      <div className="w-full h-10 bg-border-dark-color/70 rounded-lg shimmer mt-2"></div>
    </div>
  );
};

export const SkeletonCard2 = () => {
  return (
    <div className="w-full bg-border-color/50 h-64 rounded-xl px-5 gap-5 flex flex-row items-center pt-4 pb-3">
      <div className="flex w-full h-full flex-col justify-between items-center">
        <div className="flex flex-col w-full items-start gap-4">
          <div className="w-full flex justify-between items-center">
            <div className="w-1/3 h-4 bg-border-dark-color/70 rounded-full shimmer"></div>
            <div className="w-1/2 h-4 bg-border-dark-color/70 rounded-full shimmer"></div>
          </div>
          <div className="w-full flex justify-between items-center">
            <div className="w-2/5 h-4 bg-border-dark-color/70 rounded-full shimmer"></div>
            <div className="w-1/3 h-4 bg-border-dark-color/70 rounded-full shimmer"></div>
          </div>
        </div>
        <div className="w-full flex justify-start items-center gap-3">
          <div className="w-1/3 h-4 bg-border-dark-color/70 rounded-full shimmer"></div>
          <div className="w-1/4 h-4 bg-border-dark-color/70 rounded-full shimmer"></div>
          <div className="w-1/4 h-4 bg-border-dark-color/70 rounded-full shimmer"></div>
        </div>
        <div className="w-full flex justify-start items-center gap-3">
          <div className="w-30 h-10 bg-border-dark-color/70 rounded-lg shimmer"></div>
          <div className="w-30 h-10 bg-border-dark-color/70 rounded-lg shimmer"></div>
          <div className="w-20 h-10 bg-border-dark-color/70 rounded-lg shimmer"></div>
        </div>
        <div className="w-full flex justify-between items-center">
          <div className="w-20 h-9 bg-border-dark-color/70 rounded-lg shimmer"></div>
          <div className="w-30 h-9 rounded-lg shimmer"></div>
        </div>
      </div>
    </div>
  );
};
