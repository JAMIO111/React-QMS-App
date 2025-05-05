import React, { useState, useEffect } from "react";
import NonConformanceRow from "./NonConformanceRow";
import ncmData from "/src/ncmData.json";
import { IoCalendarOutline } from "react-icons/io5";
import { BsBox, BsQrCode } from "react-icons/bs";
import { LuCircleDashed } from "react-icons/lu";
import { CiShoppingTag, CiTextAlignCenter } from "react-icons/ci";
import { HiOutlineUserCircle } from "react-icons/hi2";
import { PiStack } from "react-icons/pi";
import ActionsModal from "./ActionsModal";

const NonConformanceTable = ({ costData }) => {
  const [selectedRow, setSelectedRow] = useState(null);
  const [openModalRowId, setOpenModalRowId] = useState(null);
  const [modalPos, setModalPos] = useState(null);
  const [modalItem, setModalItem] = useState(null);
  const modalRef = React.useRef(null);

  const handleRowClick = (index) => {
    if (selectedRow === index) {
      setSelectedRow(null); // Deselect if the same row is clicked again
      console.log("Row deselected:", index);
    } else {
      setSelectedRow(index); // Select the clicked row
      console.log("Row selected:", index);
    }
  };

  useEffect(() => {
    const handleScroll = () => {
      setOpenModalRowId(null);
      setModalPos(null);
    };

    if (openModalRowId !== null) {
      window.addEventListener("scroll", handleScroll, true); // true to capture scroll on nested containers
    }

    return () => {
      window.removeEventListener("scroll", handleScroll, true);
    };
  }, [openModalRowId]);

  useEffect(() => {
    const handleClickOutside = (event) => {
      if (modalRef.current && !modalRef.current.contains(event.target)) {
        setOpenModalRowId(null);
        setModalPos(null);
        setModalItem(null);
      }
    };

    if (openModalRowId !== null) {
      document.addEventListener("mousedown", handleClickOutside);
    }

    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, [openModalRowId]);

  return (
    <div className="border px-3 rounded-2xl overflow-y-auto border-border-color shadow-md">
      <table className="w-full border-collapse">
        <thead className="w-full">
          <tr className="text-left">
            <th>
              <div className="table-header">
                <p className="text-transparent">.</p>
              </div>
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
              <div className="text-transparent h-full table-header">
                <p className="text-transparent">.</p>
              </div>
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
              openModalRowId={openModalRowId}
              setOpenModalRowId={setOpenModalRowId}
              modalPos={modalPos}
              setModalPos={setModalPos}
              setModalItem={setModalItem}
            />
          ))}
        </tbody>
      </table>

      {openModalRowId !== null && modalPos && (
        <div
          ref={modalRef}
          className="absolute z-50"
          style={{
            top: modalPos.top,
            left: modalPos.left,
          }}>
          <ActionsModal
            item={modalItem}
            onClose={() => {
              setOpenModalRowId(null);
              setModalPos(null);
              setModalItem(null);
            }}
          />
        </div>
      )}
    </div>
  );
};

export default NonConformanceTable;
