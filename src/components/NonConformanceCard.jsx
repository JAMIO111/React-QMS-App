import React, { useRef } from "react";
import StatusPill from "./StatusPill";
import CTAButton from "./CTAButton";
import { BsBox2 } from "react-icons/bs";
import { HiOutlineEllipsisVertical } from "react-icons/hi2";
import { IoCalendarOutline } from "react-icons/io5";
import { PiStack } from "react-icons/pi";
import { BsQrCode } from "react-icons/bs";
import { format } from "date-fns";
import { useStatusOptions } from "@/hooks/useCategoryOptions";

const NonConformanceCard = ({
  item,
  selectedItem,
  setSelectedItem,
  selected,
  onOpenModal,
  handleActiveModalType, // Required
  handleRowClick,
  setOpenModalRowId,
  setModalPos,
}) => {
  const actionBtnRef = useRef(null);

  const formattedDate = format(new Date(item.date), "dd MMM yy");

  const handleActionBtnClick = (e) => {
    e.stopPropagation(); // Prevent row click event
    if (selectedItem?.id !== item.id) {
      setSelectedItem(item);
    }

    if (actionBtnRef.current) {
      const rect = actionBtnRef.current.getBoundingClientRect();
      const modalWidth = 158; // Approximate modal width
      const modalHeight = 177; // Approximate modal height

      let top = rect.bottom + window.scrollY - 32;
      let left = rect.left + window.scrollX - 170;

      // Prevent clipping right edge
      if (left + modalWidth > window.innerWidth) {
        left = window.innerWidth - modalWidth - 10;
      }

      // Prevent clipping bottom edge
      if (top + modalHeight > window.innerHeight + window.scrollY) {
        top = window.innerHeight + window.scrollY - modalHeight - 10;
      }

      // Prevent clipping left edge
      if (left < 0) {
        left = 10;
      }

      handleActiveModalType("Actions");
      onOpenModal({ top, left }, item);
    }
  };

  const handleCloseModal = () => {
    setOpenModalRowId(null); // Close the modal and reset the row ID
    setModalPos(null);
  };

  const { data: statusOptions } = useStatusOptions();
  const status = statusOptions?.find((status) => status.id === item.status);

  return (
    <div
      onClick={handleRowClick}
      className={`${
        selected ? "border-brand-primary" : "border-border-color"
      } border flex flex-col justify-between rounded-xl bg-secondary-bg`}>
      <div className="flex flex-row justify-between border-b border-border-color p-3">
        <div className="flex flex-col gap-1 flex-start">
          <span className="font-semibold text-primary-text">{item.ncm_id}</span>
          <span className="text-secondary-text">{item.claim_ref}</span>
        </div>
        <div className="flex flex-col gap-1">
          <span className="text-primary-text font-semibold text-right">
            {item.customer_display_name}
          </span>
          <div className="flex flex-row justify-end items-center gap-2">
            <IoCalendarOutline className="stroke-primary-text fill-primary-text h-4 w-4" />
            <span className="text-secondary-text text-right">
              {formattedDate}
            </span>
          </div>
        </div>
      </div>
      <div className="flex flex-col justify-between items-start h-full gap-4 p-3">
        <div className="flex w-full flex-wrap flex-row justify-start items-center gap-2 overflow-hidden">
          <span className="whitespace-nowrap text-secondary-text">
            {item.failure_mode_name}
          </span>
          <div className="rounded-full h-1 w-1 bg-secondary-text"></div>
          <span className="whitespace-nowrap text-secondary-text">
            {item.sub_failure_mode_name}
          </span>
          <div className="rounded-full h-1 w-1 bg-secondary-text"></div>
          <span className="whitespace-nowrap text-secondary-text">
            {item.causal_process_name}
          </span>
        </div>
        <div className="flex w-full flex-wrap flex-row justify-start items-center gap-2">
          {item.work_order && (
            <div className="whitespace-nowrap text-primary-text py-1.5 px-3 rounded-lg border border-border-color bg-secondary-bg">
              {item.work_order}
            </div>
          )}
          <div className="flex flex-row justify-between items-center whitespace-nowrap gap-3 text-primary-text py-1.5 px-3 rounded-lg border border-border-color bg-secondary-bg">
            <BsQrCode className="stroke-primary-text fill-primary-text h-4 w-4" />
            {item.part_number}
          </div>
          <div className="flex flex-row justify-between items-center whitespace-nowrap gap-2 text-primary-text py-1.5 px-3 rounded-lg border border-border-color bg-secondary-bg">
            <PiStack className="stroke-primary-text fill-primary-text h-5 w-5" />
            x {item.quantity_defective}
          </div>
        </div>
      </div>
      <div className="flex flex-row justify-between items-center border-t border-border-color p-3">
        <StatusPill width="w-fit" status={status} />
        <div ref={actionBtnRef}>
          <CTAButton
            text="Actions"
            type="main"
            icon={HiOutlineEllipsisVertical}
            callbackFn={handleActionBtnClick}
          />
        </div>
      </div>
    </div>
  );
};

export default NonConformanceCard;
