import React from "react";
import { IoLocationOutline } from "react-icons/io5";

const LeadMeeting = () => {
  return (
    <div className="flex items-stretch flex-col mr-5">
      <div className="flex p-3 flex-col">
        <div className="flex flex-row gap-3 justify-start items-center">
          <div className="rounded-full w-7 h-7 bg-blue-400"></div>
          <div className="rounded-full w-7 h-7 bg-green-400"></div>
          <p className="text-sm text-secondary-text">
            <span className="text-primary-text">Jade Dryden</span> scheduled a
            meeting
          </p>
          <div className="rounded-full w-1 h-1 bg-muted/50"></div>
          <p className="text-sm text-muted/50">3:52 PM</p>
        </div>
      </div>
      <div className="flex flex-row justify-start items-stretch">
        <div className="w-[2px] rounded-full bg-border-color ml-6.5"></div>
        <div className="bg-tertiary-bg mb-5 flex flex-row gap-4 shadow-s rounded-lg p-3 ml-10">
          <div className="flex flex-col p-2 h-12 w-12 items-center rounded-md justify-center bg-primary-bg">
            <p className="text-xs font-[500] text-error-color">OCT</p>
            <p className="text-primary-text font-semibold">12</p>
          </div>
          <div className="flex flex-col justify-center gap-1 mr-12">
            <p className="text-sm text-primary-text font-semibold">
              Meeting with Dryden Co.
            </p>
            <p className="text-xs text-secondary-text">11:00 AM - 12:00 PM</p>
          </div>
          <div className="flex gap-2 flex-col">
            <div className="rounded-md shadow-s flex flex-row items-center justify-between py-1 px-2 bg-tertiary-bg">
              <IoLocationOutline className="w-4 h-4 text-secondary-text" />
              <p className="text-xs text-secondary-text">Starbucks</p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default LeadMeeting;
