import { useState, useEffect } from "react";
import { SlRefresh } from "react-icons/sl";
import { GoArrowLeft } from "react-icons/go";
import LoadingBar from "./ui/LoadingBar";

const DataNavBar = ({
  isLoading,
  onRefresh,
  page,
  pageSize,
  totalCount,
  onPageChange,
  setPageSize,
}) => {
  const [isSpinning, setIsSpinning] = useState(false);
  const [inputValue, setInputValue] = useState(page);
  const handleClick = () => {
    setIsSpinning(true);
    setTimeout(() => setIsSpinning(false), 2000); // stop spin after 2 seconds
    onRefresh(); // trigger the refresh function
  };

  const maxPage = Math.ceil(totalCount / pageSize);

  const handleSubmit = (e) => {
    e.preventDefault();
    const trimmedValue = inputValue.trim();
    const newPage = parseInt(trimmedValue, 10);

    if (!isNaN(newPage) && newPage >= 1 && newPage <= maxPage) {
      onPageChange(newPage);
    } else {
      setInputValue(String(page)); // Reset input to current valid page
    }
  };

  useEffect(() => {
    setInputValue(page);
  }, [page]);

  return (
    <div className="flex flex-row justify-between items-center p-2 text-primary-text border-t border-border-color">
      <div className="flex flex-row gap-2 items-center">
        <button
          onClick={() => onPageChange(page - 1)}
          disabled={page <= 1}
          className={`${
            page <= 1
              ? "text-border-color"
              : "text-primary-text cursor-pointer active:scale-97 hover:border-border-dark-color"
          } rounded-lg border border-border-color p-1.5`}>
          <GoArrowLeft className="h-4 w-4" />
        </button>
        <span>Page</span>
        <form onSubmit={handleSubmit}>
          <input
            id="page-input"
            name="page-input"
            type="number"
            min="1"
            max={String(maxPage)}
            className="w-12 h-7 border border-border-color rounded-md px-2 bg-text-input-color appearance-none [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
            placeholder="1"
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            onBlur={() => setInputValue(page)}
            onFocus={() => setInputValue("")}
          />
        </form>
        <span>of 10</span>
        <button
          onClick={() => onPageChange(page + 1)}
          disabled={page >= maxPage}
          className={`${
            page >= maxPage
              ? "text-border-color"
              : "text-primary-text cursor-pointer active:scale-97 hover:border-border-dark-color"
          } rounded-lg border border-border-color p-1.5`}>
          <GoArrowLeft className="rotate-180 h-4 w-4" />
        </button>
        <select
          value={String(pageSize)}
          onChange={(e) => setPageSize(e.target.value)}
          className="w-26 h-7 border border-border-color rounded-md px-2 bg-text-input-color"
          name="page-size"
          id="page-size">
          <option value="10">10 rows</option>
          <option value="25">25 rows</option>
          <option value="50">50 rows</option>
          <option value="100">100 rows</option>
        </select>
        <span className="ml-2">{totalCount} Results</span>
        {isLoading && <LoadingBar />}
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
