import { useState, useEffect, useRef } from "react";
import NonConformanceRow from "./NonConformanceRow";
import { IoCalendarOutline, IoPeopleOutline } from "react-icons/io5";
import { BsBox, BsQrCode, BsCurrencyPound } from "react-icons/bs";
import { LuCircleDashed } from "react-icons/lu";
import { CiTextAlignCenter } from "react-icons/ci";
import { AiOutlineTag } from "react-icons/ai";
import { PiStack } from "react-icons/pi";
import ActionsModal from "./ActionsModal";
import DataNavBar from "./DataNavBar";

const NonConformanceTable = ({
  handleActiveModalType, //Required
  selectedItem, //Required
  setSelectedItem, //Required
  onOpenModal,
  onRefresh, //Required
  costData, //Required
  ncmData, //Required
  selectedRows, //Required - Checkbox
  isSelected, //Required - Checkbox
  onToggle, //Required - Checkbox
  onSelectAll, //Required - Checkbox
  onClearAll, //Required - Checkbox
}) => {
  const [openModalRowId, setOpenModalRowId] = useState(null);
  const [modalPos, setModalPos] = useState(null);

  const recordCount = ncmData?.length ?? 0;

  const selectAllCheckbox = useRef(null);
  const allSelected =
    selectedRows?.length === ncmData?.length && ncmData?.length > 0;
  const noneSelected = selectedRows?.length === 0;
  const someSelected = !allSelected && !noneSelected;

  useEffect(() => {
    if (selectAllCheckbox.current) {
      selectAllCheckbox.current.indeterminate = someSelected;
    }
  }, [someSelected]);

  const handleHeaderCheckbox = () => {
    if (allSelected) {
      onClearAll();
    } else {
      onSelectAll(ncmData);
    }
  };
  const handleRowClick = (item) => {
    setSelectedItem((prev) => (prev === item ? null : item));
    console.log("Row selected:", item.id);
  };

  useEffect(() => {
    const handleScroll = () => {
      setOpenModalRowId(null);
      setModalPos(null);
    };
    if (openModalRowId !== null) {
      window.addEventListener("scroll", handleScroll, true);
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

  const rows = Array.isArray(ncmData) ? ncmData : [];

  return (
    <div className="flex flex-col relative border border-border-color rounded-2xl shadow-md max-h-[100vh] overflow-y-auto min-h-[160px]">
      <div className="text-[13px] bg-secondary-bg overflow-y-auto  relative">
        <table className="w-full border-collapse">
          <thead>
            <tr className="text-left">
              <th>
                <div className="table-header">
                  <p className="text-transparent">
                    <input
                      type="checkbox"
                      ref={selectAllCheckbox}
                      checked={allSelected}
                      onChange={handleHeaderCheckbox}
                      className="cursor-pointer"></input>
                  </p>
                </div>
              </th>
              <th>
                <div className="table-header">
                  <span className="font-light">#</span>ID
                </div>
              </th>
              <th>
                <div className="table-header">
                  <BsBox /> NC Ref.
                </div>
              </th>
              <th>
                <div className="table-header min-w-28">
                  <IoCalendarOutline /> Date
                </div>
              </th>
              <th>
                <div className="table-header">
                  <IoPeopleOutline /> Customer
                </div>
              </th>
              <th>
                <div className="table-header px-6 min-w-20">
                  <div className="w-full flex justify-center items-center gap-2">
                    <PiStack /> Qty
                  </div>
                </div>
              </th>
              <th>
                <div className="table-header">
                  <AiOutlineTag /> Failure Mode
                </div>
              </th>
              <th>
                <div className="table-header">
                  <BsQrCode /> Part No.
                </div>
              </th>
              <th>
                <div className="table-header">
                  <div className="w-full flex justify-center items-center gap-2">
                    <LuCircleDashed /> Status
                  </div>
                </div>
              </th>
              <th>
                {costData ? (
                  <div className="table-header-number">
                    <BsCurrencyPound /> Total Cost
                  </div>
                ) : (
                  <div className="table-header">
                    <CiTextAlignCenter /> Description
                  </div>
                )}
              </th>
              <th>
                <div className="text-transparent h-full table-header">
                  <p className="text-transparent">.</p>
                </div>
              </th>
            </tr>
          </thead>
          <tbody className="text-sm">
            {rows.length === 0 ? (
              <tr>
                <td colSpan="11" className="text-center py-6 text-muted">
                  No Non-Conformances found.
                </td>
              </tr>
            ) : (
              rows.map((item, index) => (
                <NonConformanceRow
                  handleRowClick={() => handleRowClick(item)}
                  key={item.id || index} //Required
                  selectedItem={selectedItem}
                  setSelectedItem={setSelectedItem}
                  item={item} //Required
                  openModalRowId={openModalRowId}
                  setOpenModalRowId={setOpenModalRowId}
                  modalPos={modalPos}
                  setModalPos={setModalPos}
                  onOpenModal={onOpenModal}
                  costData={costData} //Required
                  handleActiveModalType={handleActiveModalType} //Required
                  checked={isSelected(item.id)}
                  onToggle={onToggle}
                />
              ))
            )}
          </tbody>
        </table>
      </div>
      <DataNavBar onRefresh={onRefresh} recordCount={recordCount} />
    </div>
  );
};

export default NonConformanceTable;
