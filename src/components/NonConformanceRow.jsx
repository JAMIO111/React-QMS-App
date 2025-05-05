import React, { useState, useRef } from "react";
import StatusPill from "./StatusPill";
import { IoEllipsisVertical } from "react-icons/io5";
import { format } from "date-fns";

const NonConformanceRow = ({
  item,
  selected,
  handleRowClick,
  setOpenModalRowId,
  setModalPos,
  setModalItem,
}) => {
  const ellipsisRef = useRef(null);

  const formattedDate = format(new Date(item.date), "dd MMM yy");

  const handleEllipsisClick = (e) => {
    const rect = ellipsisRef.current.getBoundingClientRect();
    const modalWidth = 160; // match your modal’s width (w-40 = 160px)
    const modalHeight = 130; // approx height of your modal

    const padding = 20;

    let top = rect.bottom + window.scrollY + 10;
    let left = rect.left + window.scrollX - 120;

    // Adjust if modal would overflow bottom
    if (top + modalHeight + padding > window.innerHeight + window.scrollY) {
      top = rect.top + window.scrollY - modalHeight - 4; // show above
    }

    // Adjust if modal would overflow right
    if (left + modalWidth + padding > window.innerWidth + window.scrollX) {
      left = window.innerWidth + window.scrollX - modalWidth - padding;
    }
    setModalPos({ top, left });
    setOpenModalRowId(item.id); // Set the ID of the row that opened the modal
    setModalItem(item); // Set the item for the modal
    console.log("Ellipsis clicked for item:", item.id);
  };

  const handleCloseModal = () => {
    setOpenModalRowId(null); // Close the modal and reset the row ID
    setModalPos(null);
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
            onClick={(e) => {
              e.stopPropagation();
              console.log("Checkbox clicked");
            }}
            type="checkbox"
            className="cursor-pointer"
          />
        </td>
        <td className="table-row-item">{item.id}</td>
        <td className="table-row-item">{item.claimRef}</td>
        <td className="table-row-item min-w-28">{formattedDate}</td>
        <td className="table-row-item">{item.customer}</td>
        <td className="table-row-item min-w-20 text-center">{item.qty}</td>
        <td className="table-row-item">{item.failureMode}</td>
        <td className="table-row-item">{item.partNumber}</td>
        <td className="table-row-item">
          <StatusPill status={item.status} />
        </td>
        <td className="table-row-item">{item.description}</td>
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
