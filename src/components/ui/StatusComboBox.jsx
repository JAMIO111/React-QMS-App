import { useState, useRef, useEffect } from "react";
import { HiMiniXMark } from "react-icons/hi2";
import { IoChevronDown } from "react-icons/io5";

const StatusComboBox = ({
  options = [],
  placeholder = "Select...",
  icon: Icon,
  label,
  selected,
  setSelected,
}) => {
  const [searchTerm, setSearchTerm] = useState("");
  const [isOpen, setIsOpen] = useState(false);
  const [dropUp, setDropUp] = useState(false);
  const [alignRight, setAlignRight] = useState(false);
  const [highlightedIndex, setHighlightedIndex] = useState(0);

  const dropdownRef = useRef(null);
  const inputRef = useRef(null);

  const filteredOptions = options
    .sort((a, b) => a.name.localeCompare(b.name))
    .filter((opt) =>
      opt.name.toLowerCase().includes(searchTerm?.toLowerCase() || "")
    );

  const handleSelect = (option) => {
    setSelected(option);
    setSearchTerm(""); // clear search
    setIsOpen(false);
    setHighlightedIndex(0);
  };

  const clearSelection = (e) => {
    e.stopPropagation();
    setSelected(null);
    setSearchTerm("");
    setHighlightedIndex(0);
    inputRef.current?.focus();
    setIsOpen(true);
  };

  const handleKeyDown = (e) => {
    if (!isOpen) return;

    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlightedIndex((prev) =>
        prev === filteredOptions.length - 1 ? 0 : prev + 1
      );
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlightedIndex((prev) =>
        prev === 0 ? filteredOptions.length - 1 : prev - 1
      );
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (filteredOptions[highlightedIndex]) {
        handleSelect(filteredOptions[highlightedIndex]);
      }
    } else if (e.key === "Escape") {
      e.preventDefault();
      setIsOpen(false);
    }
  };

  useEffect(() => {
    const handleClickOutside = (e) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target)) {
        setIsOpen(false);
        if (!selected) {
          setSearchTerm("");
        }
        setHighlightedIndex(0);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [selected]);

  useEffect(() => {
    if (isOpen && inputRef.current) {
      inputRef.current.focus();
    }
  }, [isOpen]);

  useEffect(() => {
    if (isOpen && dropdownRef.current) {
      const dropdown = dropdownRef.current;
      const rect = dropdown.getBoundingClientRect();
      const spaceBelow = window.innerHeight - rect.bottom;
      const spaceAbove = rect.top;
      const dropdownHeight = 240;
      setDropUp(spaceBelow < dropdownHeight && spaceAbove > dropdownHeight);
      const spaceRight = window.innerWidth - rect.left;
      const dropdownWidth = rect.width;
      setAlignRight(spaceRight < dropdownWidth);
    }
  }, [isOpen]);

  const showClear = selected || searchTerm;

  const hexToRgba = (hex, alpha = 0.5) => {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  };

  return (
    <div className="w-full" ref={dropdownRef}>
      <div className="flex flex-col">
        <span className="text-primary-text">{label}</span>

        <div className="relative">
          <div
            onClick={() => setIsOpen((prev) => !prev)}
            className={`${
              isOpen
                ? "border-brand-primary hover:border-brand-primary"
                : "border-border-color hover:border-border-dark-color"
            } border rounded-lg px-2 py-2 h-12 cursor-pointer bg-text-input-color hover:border-border-dark-color flex items-center justify-between`}>
            <Icon className="w-5 h-5 text-primary-text mr-2 flex-shrink-0 pointer-events-none" />
            <div className="flex flex-grow align-text-cen min-w-0 h-6 mr-2">
              <input
                ref={inputRef}
                type="text"
                value={isOpen ? searchTerm : selected?.name || ""}
                readOnly={!isOpen}
                onChange={(e) => {
                  setSearchTerm(e.target.value);
                  setHighlightedIndex(0);
                }}
                onClick={(e) => {
                  e.stopPropagation();
                  if (!isOpen) setIsOpen(true);
                }}
                onKeyDown={handleKeyDown}
                placeholder={selected ? selected?.name : placeholder}
                className={`text-primary-text w-full h-full outline-none bg-transparent truncate placeholder:text-sm placeholder:text-muted ${
                  !selected && !searchTerm
                    ? "text-sm text-muted"
                    : "text-base text-primary-text"
                }`}
              />
            </div>

            {showClear && (
              <button
                onClick={clearSelection}
                className="flex items-center justify-center w-5 h-5 text-primary-text hover:bg-border-color mx-1 rounded-sm"
                aria-label="Clear">
                <HiMiniXMark className="w-5 h-5" />
              </button>
            )}

            <div className="hover:bg-border-color rounded-sm ml-1">
              <IoChevronDown
                className={`stroke-primary-text w-5 h-5 transform transition-transform duration-300 ${
                  isOpen ? "-rotate-180" : ""
                }`}
              />
            </div>
          </div>

          {isOpen && (
            <ul
              className={`absolute z-10 w-full border border-border-color rounded-lg shadow-md max-h-60 overflow-y-auto py-1 bg-secondary-bg
              ${dropUp ? "bottom-full mb-1" : "mt-1"}
              ${alignRight ? "right-0" : "left-0"}`}>
              {filteredOptions.length > 0 ? (
                filteredOptions.map((option, index) => (
                  <li key={option.id} className="px-2 py-1">
                    <div
                      onClick={() => handleSelect(option)}
                      className={`border font-semibold rounded-md cursor-pointer px-4 py-2 ${
                        highlightedIndex === index
                          ? "bg-brand-primary/50"
                          : "text-primary-text hover:bg-brand-primary/33"
                      }`}
                      style={{
                        color:
                          highlightedIndex === index ? undefined : option.color,
                        borderColor:
                          highlightedIndex === index ? undefined : option.color,
                        backgroundColor:
                          highlightedIndex === index
                            ? undefined
                            : hexToRgba(option.color, 0.1),
                      }}>
                      {option.name.toUpperCase()}
                    </div>
                  </li>
                ))
              ) : (
                <li className="px-4 py-2 text-primary-text">No results</li>
              )}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
};

export default StatusComboBox;
