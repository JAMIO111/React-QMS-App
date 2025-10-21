import { useRef } from "react";
import { useNavigate } from "react-router-dom";
import { format } from "date-fns";
import { IoEllipsisVertical } from "react-icons/io5";
import Pill from "@components/Pill";

const BookingRow = ({
  item,
  selectedItem,
  setSelectedItem,
  handleRowClick,
  onOpenModal,
  handleActiveModalType,
  checked,
  onToggle,
}) => {
  const navigate = useNavigate();
  const ellipsisRef = useRef(null);
  const selected = selectedItem?.id === item.id;

  const formattedArrivalDate = format(
    new Date(item.arrival_date),
    "EEE, d MMM yy"
  );
  const formattedDepartureDate = format(
    new Date(item.departure_date),
    "EEE, d MMM yy"
  );

  const handleEllipsisClick = (e) => {
    e.stopPropagation();
    setSelectedItem(item);

    const rect = ellipsisRef.current.getBoundingClientRect();
    const modalWidth = 176;
    const modalHeight = 190;

    let top = rect.bottom + window.scrollY - 25;
    let left = rect.left + window.scrollX - 180;

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
      className={`text-primary-text hover:bg-hover-menu-color ${
        selected ? "bg-active-menu-color" : ""
      }`}>
      <td className="p-2 pl-0 text-center">
        <input
          className="cursor-pointer"
          type="checkbox"
          checked={checked}
          onChange={() => onToggle(item)}
          onClick={(e) => e.stopPropagation()}
          onDoubleClick={(e) => e.stopPropagation()}
        />
      </td>
      <td className="p-2">{item.booking_ref}</td>
      <td className="p-2">{item.property_name}</td>
      <td className="p-2">{formattedArrivalDate}</td>
      <td className="p-2">{formattedDepartureDate}</td>
      <td className="p-2">
        <div className="text-center flex justify-center font-semibold items-center w-8 h-8 rounded-lg text-primary-text border bg-brand-primary/20 border-brand-primary">
          {item.nights}
        </div>
      </td>
      <td className="p-2 align-middle">
        <div className="inline-flex items-center gap-2">
          <span>{item.lead_guest || "N/A"}</span>
          {item.is_return_guest && (
            <div className="px-1 py-0.5 text-xs bg-brand-primary/20 text-brand-primary rounded flex-shrink-0">
              RG
            </div>
          )}
        </div>
      </td>
      <td className="p-2 text-center">{item.adults || "-"}</td>
      <td className="p-2 text-center">{item.children || "-"}</td>
      <td className="p-2 text-center">{item.infants || "-"}</td>
      <td className="p-2 text-center">{item.pets || "-"}</td>
      <td className="p-2 text-center">
        {item.is_owner_booking ? (
          <Pill color="purple" text="Owner" />
        ) : (
          <Pill color="blue" text="Guest" />
        )}
      </td>

      <td className="p-2 text-center">
        <button
          ref={ellipsisRef}
          onClick={handleEllipsisClick}
          onDoubleClick={(e) => e.stopPropagation()}
          className="cursor-pointer flex hover:bg-cta-btn-bg border-cta-btn-border w-8 h-8 rounded-lg justify-center items-center">
          <IoEllipsisVertical />
        </button>
      </td>
    </tr>
  );
};

export default BookingRow;
