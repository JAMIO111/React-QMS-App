import React, { useRef } from "react";
import StatusPill from "./StatusPill";
import { BsBox2 } from "react-icons/bs";
import { HiOutlineEllipsisVertical } from "react-icons/hi2";
import { format } from "date-fns";

const NonConformanceCard = ({
  item,
  selected,
  onOpenModal,
  handleActiveModalType, // Required
  handleRowClick,
  setOpenModalRowId,
  setModalPos,
}) => {
  const actionBtnRef = useRef(null);

  const formattedDate = format(new Date(item.date), "dd MMMM yyyy");

  const handleActionBtnClick = (e) => {
    e.stopPropagation(); // Prevent row click event
    if (actionBtnRef.current) {
      const rect = actionBtnRef.current.getBoundingClientRect();
      handleActiveModalType("Actions");
      onOpenModal(
        {
          top: rect.bottom + window.scrollY - 32,
          left: rect.left + window.scrollX - 170,
        },
        item
      );
    }
  };

  const handleCloseModal = () => {
    setOpenModalRowId(null); // Close the modal and reset the row ID
    setModalPos(null);
  };

  return (
    <div
      onClick={handleRowClick}
      className={`${
        selected ? "border-brand-primary" : "border-border-color"
      } border flex h-80 flex-col justify-between rounded-xl bg-secondary-bg`}>
      <div className="flex flex-row justify-between border-b border-border-color p-3">
        <div className="flex flex-col flex-start">
          <span className="font-semibold text-primary-text">{item.ncm_id}</span>
          <span className="text-secondary-text">{formattedDate}</span>
        </div>
        <div className="flex flex-col">
          <span className="text-secondary-text text-right">
            {item.claim_ref}
          </span>
          <span className="text-secondary-text text-right">
            {item.customer_name}
          </span>
        </div>
      </div>
      <div className="flex flex-col justify-between items-start gap-2 p-3">
        <div className="flex flex-row justify-start items-center gap-2">
          <span className="text-lg text-primary-text pt-2">
            {item.part_number}
          </span>
          <div className="relative ml-6">
            <BsBox2 className="fill-primary-text h-9 w-9 absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2" />
            <span className="text-primary-text absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/3">
              x{item.quantity}
            </span>
          </div>
        </div>
        <div className="flex flex-col justify-start items-start gap-2 text-primary-text">
          {item.failure_mode_name}
          <br />
          {item.description}
        </div>
      </div>
      <div className="flex flex-row justify-between items-center border-t border-border-color p-3">
        <StatusPill status={item.status_name} />
        <button
          className="flex flex-row justify-center items-center gap-1 text-white bg-cta-color rounded-lg px-2 py-1 cursor-pointer active:scale-97 transition-transform duration-200 ease-in-out"
          ref={actionBtnRef}
          text="Actions"
          onClick={handleActionBtnClick}>
          <HiOutlineEllipsisVertical className="h-5 w-5" />
          Actions
        </button>
      </div>
    </div>
  );
};

export default NonConformanceCard;
