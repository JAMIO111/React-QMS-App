import { useState, useEffect, useRef } from "react";
import BookingRow from "./BookingRow";
import { IoCalendarOutline, IoPeopleOutline } from "react-icons/io5";
import { FaChildren, FaDog, FaUser } from "react-icons/fa6";
import { IoIosMan } from "react-icons/io";
import { MdChildFriendly } from "react-icons/md";
import { CiTextAlignCenter } from "react-icons/ci";
import DataNavBar from "./DataNavBar";

const BookingsTable = ({
  isLoading, //Required
  handleActiveModalType, //Required
  selectedItem, //Required
  setSelectedItem, //Required
  onOpenModal,
  onRefresh, //Required
  costData, //Required
  data, //Required
  selectedRows, //Required - Checkbox
  isSelected, //Required - Checkbox
  onToggle, //Required - Checkbox
  onSelectAll, //Required - Checkbox
  onClearAll, //Required - Checkbox
  page,
  pageSize,
  totalCount,
  setPage,
  setPageSize,
}) => {
  const [openModalRowId, setOpenModalRowId] = useState(null);
  const [modalPos, setModalPos] = useState(null);
  const [activeModalType, setActiveModalType] = useState(null); // Required

  console.log("Selected Rows:", selectedRows.length);
  console.log("Total Count:", totalCount);
  console.log("Bookings Data.count:", data?.count);

  const selectAllCheckbox = useRef(null);

  const pageLimit = totalCount < pageSize ? totalCount : pageSize;
  const allSelected =
    selectedRows?.length === pageLimit && pageSize > 0 && totalCount > 0;
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
      onSelectAll(data?.data);
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

  const rows = Array.isArray(data?.data) ? data.data : [];

  return (
    <div className="flex h-full shadow-md flex-col border relative border-border-color rounded-2xl max-h-[100vh] overflow-y-auto min-h-[14px]">
      <div className="flex-1 text-[13px] bg-secondary-bg overflow-y-auto relative">
        <table className="w-full border-collapse">
          <thead>
            <tr className="text-left border-b border-border-color th-sticky">
              <th className="pl-2 pr-2">
                <div className="table-header">
                  <p className="text-transparent">
                    <input
                      id="checkbox-select-all"
                      name="checkbox-select-all"
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
                  <CiTextAlignCenter /> Booking Ref
                </div>
              </th>
              <th>
                <div className="table-header">
                  <IoPeopleOutline /> Property
                </div>
              </th>
              <th>
                <div className="table-header min-w-28">
                  <IoCalendarOutline /> Arrival Date
                </div>
              </th>
              <th>
                <div className="table-header min-w-28">
                  <IoCalendarOutline /> Departure Date
                </div>
              </th>
              <th>
                <div className="table-header">Nights</div>
              </th>
              <th>
                <div className="table-header">
                  <FaUser /> Lead Guest
                </div>
              </th>
              <th>
                <div className="table-header">
                  <IoIosMan /> Adults
                </div>
              </th>
              <th>
                <div className="table-header px-6 min-w-20">
                  <div className="w-full flex justify-center items-center gap-2">
                    <FaChildren /> Teens
                  </div>
                </div>
              </th>
              <th>
                <div className="table-header">
                  <MdChildFriendly /> Infants
                </div>
              </th>
              <th>
                <div className="table-header">
                  <FaDog /> Pets
                </div>
              </th>
              <th>
                <div className="table-header">Booking Type</div>
              </th>
              <th>
                <div className="text-transparent h-full table-header">
                  <p className="text-transparent">.</p>
                </div>
              </th>
            </tr>
          </thead>
          <tbody className="text-sm">
            {totalCount === 0 ? (
              <tr>
                <td colSpan="11" className="text-center py-6 text-muted">
                  No Bookings found.
                </td>
              </tr>
            ) : (
              rows.map((item, index) => (
                <BookingRow
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
      <DataNavBar
        isLoading={isLoading}
        onRefresh={onRefresh}
        page={page}
        pageSize={pageSize}
        totalCount={totalCount}
        setPageSize={setPageSize}
        onPageChange={setPage}
      />
    </div>
  );
};

export default BookingsTable;
