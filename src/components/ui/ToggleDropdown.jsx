import { useRef, useState, useEffect } from "react";
import { IoCheckmarkOutline } from "react-icons/io5";
import { createPortal } from "react-dom";
import CTAButton from "../CTAButton";
import { RxColumns } from "react-icons/rx";

const ToggleDropdown = ({ allColumns, visibleColumns, setVisibleColumns }) => {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ top: 0, left: 0 });
  const buttonRef = useRef(null);

  const toggleColumn = (id) => {
    setVisibleColumns((prev) =>
      prev.includes(id) ? prev.filter((colId) => colId !== id) : [...prev, id]
    );
  };

  const handleToggle = () => {
    if (!open && buttonRef.current) {
      const rect = buttonRef.current.getBoundingClientRect();
      setPosition({
        top: rect.bottom + window.scrollY + 5,
        left: rect.left + window.scrollX,
      });
    }
    setOpen((prev) => !prev);
  };

  useEffect(() => {
    const handleClickOutside = (e) => {
      if (
        open &&
        !buttonRef.current.contains(e.target) &&
        !document.getElementById("dropdown-portal")?.contains(e.target)
      ) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [open]);

  return (
    <>
      <div ref={buttonRef}>
        <CTAButton
          icon={RxColumns}
          type="neutral"
          title="Toggle Columns"
          callbackFn={handleToggle}
          width="w-8.5"
          height="h-8.5"
        />
      </div>

      {open &&
        createPortal(
          <ul
            id="dropdown-portal"
            className="border border-border-color flex flex-col p-1 shadow bg-primary-bg rounded-lg w-fit z-[9999] absolute"
            style={{
              position: "absolute",
              top: position.top,
              left: position.left,
            }}>
            {allColumns.map((col) => (
              <li key={col.id}>
                <label className="py-1 text-sm text-primary-text px-3 rounded hover:bg-border-color flex justify-between items-center gap-5 cursor-pointer">
                  <input
                    hidden
                    type="checkbox"
                    checked={visibleColumns.includes(col.id)}
                    onChange={() => toggleColumn(col.id)}
                  />
                  {col?.headerString || col.id}

                  <IoCheckmarkOutline
                    className={`${
                      visibleColumns.includes(col.id)
                        ? "opacity-100"
                        : "opacity-0"
                    } text-brand-primary`}
                  />
                </label>
              </li>
            ))}
          </ul>,
          document.getElementById("modal-root")
        )}
    </>
  );
};

export default ToggleDropdown;
