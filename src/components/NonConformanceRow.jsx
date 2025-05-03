import React from "react";
import StatusPill from "./StatusPill";
import { IoEllipsisVertical } from "react-icons/io5";
import { format } from "date-fns";

const NonConformanceRow = ({ item, selected, handleRowClick }) => {
  const formattedDate = format(new Date(item.date), "dd MMM yy");

  return (
    <tr
      onClick={handleRowClick}
      className={`hover:bg-blue-50 ${
        selected ? "bg-blue-100 hover:bg-blue-200" : ""
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
          onClick={(e) => {
            e.stopPropagation();
            console.log("Ellipsis clicked");
          }}
          className="p-1 h-6 w-6 mr-2 cursor-pointer hover:text-blue-600"
        />
      </td>
    </tr>
  );
};

export default NonConformanceRow;
