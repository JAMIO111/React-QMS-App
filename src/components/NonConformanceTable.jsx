import { React, useState } from "react";
import NonConformanceRow from "./NonConformanceRow";
import ncmData from "/src/ncmData.json";
import { IoCalendarOutline } from "react-icons/io5";
import { BsBox, BsQrCode } from "react-icons/bs";
import { LuCircleDashed } from "react-icons/lu";
import { CiShoppingTag, CiTextAlignCenter } from "react-icons/ci";
import { HiOutlineUserCircle } from "react-icons/hi2";
import { PiStack } from "react-icons/pi";

const NonConformanceTable = () => {
  const [selectedRow, setSelectedRow] = useState(null);
  const handleRowClick = (index) => {
    if (selectedRow === index) {
      setSelectedRow(null); // Deselect if the same row is clicked again
      console.log("Row deselected:", index);
    } else {
      setSelectedRow(index); // Select the clicked row
      console.log("Row selected:", index);
    }
  };

  return (
    <div className="border px-3 overflow-y-auto rounded-2xl border-gray-200 shadow-md">
      <table className="w-full border-collapse">
        <thead className="w-full">
          <tr className="text-left">
            <th>
              <div className="text-transparent table-header">.</div>
            </th>
            <th>
              <div className="table-header">
                <span className="font-light">#</span>ID
              </div>
            </th>
            <th>
              <div className="table-header">
                <BsBox />
                NC Ref.
              </div>
            </th>
            <th>
              <div className="table-header min-w-28">
                <IoCalendarOutline />
                Date
              </div>
            </th>
            <th>
              <div className="table-header">
                <HiOutlineUserCircle />
                Customer
              </div>
            </th>
            <th>
              <div className="table-header px-6 min-w-20">
                <div className="w-full flex justify-center items-center gap-2">
                  <PiStack />
                  Qty
                </div>
              </div>
            </th>
            <th>
              <div className="table-header">
                <CiShoppingTag />
                Failure Mode
              </div>
            </th>
            <th>
              <div className="table-header">
                <BsQrCode />
                Part No.
              </div>
            </th>
            <th>
              <div className="table-header">
                <div className="w-full flex justify-center items-center gap-2">
                  <LuCircleDashed />
                  Status
                </div>
              </div>
            </th>
            <th>
              <div className="table-header">
                <CiTextAlignCenter />
                Description
              </div>
            </th>
            <th>
              <div className="text-transparent table-header">.</div>
            </th>
          </tr>
        </thead>
        <tbody className="text-sm">
          {ncmData.map((item, index) => (
            <NonConformanceRow
              handleRowClick={() => handleRowClick(index)}
              key={item.id}
              selected={selectedRow === index}
              item={item}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
};

export default NonConformanceTable;
