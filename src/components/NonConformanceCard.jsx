import React from "react";
import StatusPill from "./StatusPill";
import { BsBox2 } from "react-icons/bs";

const NonConformanceCard = ({ item }) => {
  return (
    <div className="border border-border-color rounded-xl h-40 p-3">
      <div className="flex flex-row justify-between">
        <div className="flex flex-col gap-2">
          <span className="font-semibold h-3 text-primary-text">{item.id}</span>
          <span className="text-secondary-text h-3">{item.claimRef}</span>
        </div>
        <StatusPill status={item.status} />
      </div>
      <br />
      <br />
      <div className="flex flex-row justify-start items-center gap-2">
        <span className="text-lg pt-2">{item.partNumber}</span>
        <div className="relative ml-6">
          <BsBox2 className="h-9 w-9 absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2" />
          <span className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/3">
            x{item.qty}
          </span>
        </div>
      </div>
      <br />
      {item.failureMode}
      {item.date}
      {item.description}
    </div>
  );
};

export default NonConformanceCard;
