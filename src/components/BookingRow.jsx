import { useRef } from "react";
import { useNavigate } from "react-router-dom";
import { format } from "date-fns";
import StatusPill from "./StatusPill";
import { IoEllipsisVertical } from "react-icons/io5";
import { useStatusOptions } from "@/hooks/useCategoryOptions";

const BookingRow = ({
  item,
  selectedItem,
  setSelectedItem,
  handleRowClick,
  onOpenModal,
  costData,
  handleActiveModalType,
  checked,
  onToggle,
}) => {
  const navigate = useNavigate();
  const ellipsisRef = useRef(null);
  const selected = selectedItem?.id === item.id;

  const formattedArrivalDate = format(new Date(item.arrival_date), "dd MMM yy");
  const formattedDepartureDate = format(
    new Date(item.departure_date),
    "dd MMM yy"
  );

  const { data: statusOptions } = useStatusOptions();
  const status = statusOptions?.find((s) => s.id === item.status);

  const handleEllipsisClick = (e) => {
    e.stopPropagation();
    setSelectedItem(item);

    const rect = ellipsisRef.current.getBoundingClientRect();
    const modalWidth = 158;
    const modalHeight = 177;

    let top = rect.bottom + window.scrollY - 25;
    let left = rect.left + window.scrollX - 160;

    if (left + modalWidth > window.innerWidth)
      left = window.innerWidth - modalWidth - 10;
    if (top + modalHeight > window.innerHeight + window.scrollY)
      top = window.innerHeight + window.scrollY - modalHeight - 10;
    if (left < 0) left = 10;

    handleActiveModalType("Actions");
    onOpenModal({ top, left });
  };

  return (
    <tr
      onClick={handleRowClick}
      onDoubleClick={() => navigate(`/Bookings/${item.id}`)}
      className={`hover:bg-hover-menu-color ${
        selected ? "bg-active-menu-color" : ""
      }`}>
      <td className="p-2 pl-0 text-center">
        <input
          className="cursor-pointer"
          type="checkbox"
          checked={checked}
          onChange={() => onToggle(item)}
        />
      </td>
      <td className="p-2">{item.booking_ref}</td>
      <td className="p-2">{formattedArrivalDate}</td>
      <td className="p-2">{formattedDepartureDate}</td>
      <td className="p-2">{item.property_id}</td>
      <td className="p-2">{item.lead_guest ? item.lead_guest : "N/A"}</td>
      <td className="p-2 text-center">{item.adults || "-"}</td>
      <td className="p-2 text-center">{item.children || "-"}</td>
      <td className="p-2 text-center">{item.infants || "-"}</td>
      <td className="p-2 text-center">
        <button
          ref={ellipsisRef}
          onClick={handleEllipsisClick}
          className="cursor-pointer flex hover:bg-cta-btn-bg border-cta-btn-border w-8 h-8 rounded-lg justify-center items-center">
          <IoEllipsisVertical />
        </button>
      </td>
    </tr>
  );
};

export default BookingRow;
