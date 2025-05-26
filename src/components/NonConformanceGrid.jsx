import React, { useState, useEffect } from "react";
import NonConformanceCard from "./NonConformanceCard";
import ActionsModal from "./ActionsModal";

const NonConformanceGrid = ({
  handleActiveModalType, //Required
  onOpenModal, //Required
  onRefresh, //Required
  costData, //Required
  ncmData, //Required
}) => {
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
    <div className="grid pr-2 grid-cols-1 sm:grid-cols-1 md:grid-cols-2 lg:grid-cols-2 xl:grid-cols-3 gap-4 overflow-y-auto h-full">
      {ncmData.data.map((item, index) => {
        return (
          <NonConformanceCard
            handleRowClick={() => handleRowClick(index)}
            key={item.id}
            selected={selectedRow === index}
            item={item}
            onOpenModal={onOpenModal}
            handleActiveModalType={handleActiveModalType} //Required
            openModalRowId={openModalRowId}
            setOpenModalRowId={setOpenModalRowId}
            modalPos={modalPos}
            setModalPos={setModalPos}
            setModalItem={setModalItem}
          />
        );
      })}
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

export default NonConformanceGrid;
