import NonConformanceCard from "./NonConformanceCard";
import { describeApiError } from "../lib/api-client";

/** Card view of the current register page. */
const NonConformanceGrid = ({ items, isLoading, error, selectedItem, setSelectedItem, onOpenModal, handleActiveModalType, onOpen }) => {
  if (error) {
    return (
      <p role="alert" className="text-error-color p-4">
        {describeApiError(error)}
      </p>
    );
  }
  if (!isLoading && items.length === 0) return <p className="p-6 text-center italic text-secondary-text">No records found.</p>;
  return (
    <div className="grid pr-2 grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4 overflow-y-auto h-full content-start">
      {items.map((item) => (
        <NonConformanceCard
          key={item.id}
          item={item}
          selected={selectedItem?.id === item.id}
          setSelectedItem={setSelectedItem}
          onOpenModal={onOpenModal}
          handleActiveModalType={handleActiveModalType}
          onOpen={onOpen}
        />
      ))}
    </div>
  );
};

export default NonConformanceGrid;
