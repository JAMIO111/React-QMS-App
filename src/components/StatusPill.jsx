import React from "react";

const StatusPill = ({ status }) => {
  return (
    <div className="flex justify-center items-center">
      <div
        className={`font-semibold text-center rounded-lg px-3 py-1 status-${status.toLowerCase()}`}>
        {status}
      </div>
    </div>
  );
};

export default StatusPill;
