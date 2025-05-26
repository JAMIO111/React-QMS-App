import { useRef } from "react";
import StatusPill from "./StatusPill";
import { IoEllipsisVertical } from "react-icons/io5";
import { format } from "date-fns";

const NonConformanceRow = ({
  item, //Required
  selectedItem,
  setSelectedItem, //Required
  handleRowClick,
  onOpenModal,
  costData, //Required
  handleActiveModalType, //Required
  checked,
  onToggle,
}) => {
  const formattedDate = format(new Date(item.date), "dd MMM yy");

  const ellipsisRef = useRef(null);

  const selected = selectedItem?.id == item.id;

  const handleEllipsisClick = (e) => {
    e.stopPropagation(); // Prevent row click event
    if (selectedItem?.id !== item.id) {
      setSelectedItem(item);
    }

    if (ellipsisRef.current) {
      const rect = ellipsisRef.current.getBoundingClientRect();
      const modalWidth = 158; // Set this to your modal's approximate width
      const modalHeight = 177; // Set this to your modal's approximate height

      let top = rect.bottom + window.scrollY - 25;
      let left = rect.left + window.scrollX - 160;

      // Adjust to prevent clipping right edge
      if (left + modalWidth > window.innerWidth) {
        left = window.innerWidth - modalWidth - 10; // 10px padding from edge
      }

      // Adjust to prevent clipping bottom edge
      if (top + modalHeight > window.innerHeight + window.scrollY) {
        top = window.innerHeight + window.scrollY - modalHeight - 10;
      }

      // Optional: Adjust to prevent clipping left edge
      if (left < 0) {
        left = 10;
      }

      handleActiveModalType("Actions");
      onOpenModal({ top, left });
    }
  };

  return (
    <>
      <tr
        onClick={handleRowClick}
        className={`hover:bg-hover-menu-color ${
          selected ? "bg-active-menu-color" : ""
        }`}>
        <td className="table-row-item">
          <input
            type="checkbox"
            checked={checked}
            onChange={() => onToggle(item)}
            className="cursor-pointer"
          />
        </td>
        <td className="table-row-item">{item.ncm_id}</td>
        <td className="table-row-item min-w-28">{formattedDate}</td>
        <td className="table-row-item">{item.customer_name}</td>
        <td className="table-row-item">{item?.work_order}</td>
        <td className="table-row-item">{item.part_number}</td>
        <td className="table-row-item min-w-20 text-center">{item.quantity}</td>
        <td className="table-row-item">{item.failure_mode_name}</td>
        <td className="table-row-item">
          <StatusPill status={item.status_name} />
        </td>
        <td className={`table-row-item ${costData ? "text-right" : ""}`}>
          {costData
            ? new Intl.NumberFormat("en-GB", {
                style: "currency",
                currency: "GBP",
              }).format(item.total_cost)
            : item.description}
        </td>
        <td className="table-row-item">
          <IoEllipsisVertical
            ref={ellipsisRef}
            onClick={handleEllipsisClick}
            title="Actions"
            className="p-1 h-6 w-6 cursor-pointer hover:text-brand-primary"
          />
        </td>
      </tr>
    </>
  );
};

export default NonConformanceRow;
