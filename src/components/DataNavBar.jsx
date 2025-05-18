import { useState } from "react";
import { SlRefresh } from "react-icons/sl";
import { GoArrowLeft } from "react-icons/go";

const DataNavBar = ({ recordCount, onRefresh }) => {
  const [isSpinning, setIsSpinning] = useState(false);

  const handleClick = () => {
    setIsSpinning(true);
    setTimeout(() => setIsSpinning(false), 2000); // stop spin after 2 seconds
    onRefresh(); // trigger the refresh function
  };

  return (
    <div className="flex flex-row justify-between items-center p-2 text-primary-text border-t border-border-color">
      <div className="flex flex-row gap-2 items-center">
        <button className="rounded-lg border border-border-color cursor-pointer p-1.5 hover:border-border-dark-color active:scale-97">
          <GoArrowLeft className="h-4 w-4" />
        </button>
        <span>Page</span>
        <input
          type="text"
          className="w-12 h-7 border border-border-color rounded-md px-2 bg-text-input-color"
          placeholder="1"
        />
        <span>of 10</span>
        <button className="rounded-lg border border-border-color cursor-pointer p-1.5 hover:border-border-dark-color active:scale-97">
          <GoArrowLeft className="rotate-180 h-4 w-4" />
        </button>
        <span className="ml-2">{recordCount} Records</span>
      </div>
      <button
        onClick={handleClick}
        className="flex flex-row items-center gap-2 rounded-lg border border-border-color cursor-pointer py-1 px-2 hover:border-border-dark-color active:scale-97">
        <SlRefresh
          className={isSpinning ? "rotate-90 animate-spin" : "rotate-90"}
        />
        Refresh
      </button>
    </div>
  );
};

export default DataNavBar;
