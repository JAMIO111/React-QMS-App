import { useState, useEffect } from "react";
import { SlRefresh } from "react-icons/sl";
import { GoArrowLeft } from "react-icons/go";
import LoadingBar from "./ui/LoadingBar";

const DataNavBar = ({ table, totalCount, onRefresh, isLoading }) => {
  const [isSpinning, setIsSpinning] = useState(false);
  const pageIndex = table.getState().pagination.pageIndex;
  const pageSize = table.getState().pagination.pageSize;
  const pageCount = table.getPageCount();
  //const totalCount = table.options.meta?.totalCount || 0; // optional metadata
  const [inputValue, setInputValue] = useState(pageIndex + 1); // 1-based input

  useEffect(() => {
    setInputValue(pageIndex + 1);
  }, [pageIndex]);

  const handleRefresh = () => {
    setIsSpinning(true);
    setTimeout(() => setIsSpinning(false), 2000);
    onRefresh();
  };

  const handleSubmit = (e) => {
    e.preventDefault();
    const newPage = parseInt(inputValue, 10);
    if (!isNaN(newPage) && newPage >= 1 && newPage <= pageCount) {
      table.setPageIndex(newPage - 1); // convert to 0-based
    } else {
      setInputValue(pageIndex + 1); // reset on invalid
    }
  };

  return (
    <div className="flex flex-row justify-between items-center p-2 text-primary-text border-t border-border-color">
      <div className="flex flex-row gap-2 items-center">
        <button
          onClick={() => table.previousPage()}
          disabled={!table.getCanPreviousPage()}
          className={`${
            !table.getCanPreviousPage()
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
            max={String(pageCount)}
            className="w-12 h-7 border border-border-color rounded-md px-2 bg-text-input-color appearance-none [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            onBlur={() => setInputValue(pageIndex + 1)}
            onFocus={() => setInputValue("")}
          />
        </form>
        <span>of {Math.ceil(totalCount / pageSize)}</span>

        <button
          onClick={() => table.nextPage()}
          disabled={!table.getCanNextPage()}
          className={`${
            !table.getCanNextPage()
              ? "text-border-color"
              : "text-primary-text cursor-pointer active:scale-97 hover:border-border-dark-color"
          } rounded-lg border border-border-color p-1.5`}>
          <GoArrowLeft className="rotate-180 h-4 w-4" />
        </button>

        <select
          value={String(pageSize)}
          onChange={(e) => table.setPageSize(Number(e.target.value))}
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
        onClick={handleRefresh}
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
