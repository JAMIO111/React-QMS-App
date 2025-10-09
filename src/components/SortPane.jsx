import { CgClose } from "react-icons/cg";
import CTAButton from "./CTAButton";

const SortPane = ({
  sortColumn,
  setSortColumn,
  sortOrder,
  setSortOrder,
  onClose,
}) => {
  return (
    <div className="border absolute bg-primary-bg text-primary-text z-1000 top-32 right-24 rounded-2xl border-border-color shadow-lg shadow-shadow-color w-100 h-fit">
      <div className="flex px-3 py-1 bg-secondary-bg border-b border-border-color flex-row justify-between items-center rounded-t-2xl ">
        <h3 className="text-xl">Sort</h3>
        <button
          className="cursor-pointer hover:bg-primary-bg rounded-md hover:text-error-color p-1"
          onClick={onClose}>
          <CgClose />
        </button>
      </div>
      <div className="flex flex-col justify-start items-center">
        <div className="filter-item flex px-3 py-2 border-b border-border-color w-full flex-col justify-start items-center">
          <div className="w-full gap-4 flex flex-row justify-between items-center">
            <div className="flex flex-col w-full">
              <h4 className="text-sm text-secondary-text">Sort By:</h4>
              <select
                value={sortColumn}
                onChange={(e) => setSortColumn(e.target.value)}
                className="h-8 bg-text-input-color border border-border-color rounded-md px-2">
                <option value="ncm_id">NCM ID</option>
                <option value="date">Date</option>
                <option value="quantity_defective">Quantity</option>
                <option value="total_cost">Total Cost</option>
              </select>
            </div>
            <div className="flex flex-col w-full">
              <h4 className="text-sm text-secondary-text">Sort Order:</h4>
              <select
                value={sortOrder}
                onChange={(e) => setSortOrder(e.target.value)}
                className="h-8 bg-text-input-color border border-border-color rounded-md px-2">
                <option value="asc">
                  {(() => {
                    switch (sortColumn) {
                      case "ncm_id":
                        return "Ascending";
                      case "date":
                        return "Oldest - Newest";
                      case "quantity_defective":
                        return "Low - High";
                      case "total_cost":
                        return "Low - High";
                      default:
                        return "Ascending";
                    }
                  })()}
                </option>
                <option value="desc">
                  {(() => {
                    switch (sortColumn) {
                      case "ncm_id":
                        return "Descending";
                      case "date":
                        return "Newest - Oldest";
                      case "quantity_defective":
                        return "High - Low";
                      case "total_cost":
                        return "High - Low";
                      default:
                        return "Descending";
                    }
                  })()}
                </option>
              </select>
            </div>
          </div>
          <div className="w-full flex flex-col"></div>
        </div>
        <div className="w-full p-3 flex flex-row justify-between items-center">
          <CTAButton
            type="cancel"
            text="Clear Sort"
            callbackFn={() => {
              setSortColumn("ncm_id");
              setSortOrder("desc");
            }}
          />

          <CTAButton type="main" text="Apply Sort" callbackFn={onClose} />
        </div>
      </div>
    </div>
  );
};

export default SortPane;
