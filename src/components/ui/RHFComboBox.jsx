import { useState, useRef, useEffect } from "react";
import { HiMiniXMark } from "react-icons/hi2";
import { IoChevronDown } from "react-icons/io5";
import { MdErrorOutline } from "react-icons/md";

const RHFComboBox = ({
  value,
  onChange,
  required = false,
  icon: Icon,
  options = [],
  placeholder = "Select...",
  label,
  dependentValue,
  dependentKey,
  secondaryField,
  secondaryFieldOptions,
  error,
}) => {
  const [searchTerm, setSearchTerm] = useState("");
  const [isOpen, setIsOpen] = useState(false);
  const [dropUp, setDropUp] = useState(false);
  const [alignRight, setAlignRight] = useState(false);
  const [highlightedIndex, setHighlightedIndex] = useState(0);

  const dropdownRef = useRef(null);
  const inputRef = useRef(null);
  const listRef = useRef(null);
  const itemRefs = useRef([]);

  const filteredOptions = options
    .filter((opt) =>
      dependentKey && dependentValue !== undefined && dependentValue !== null
        ? opt[dependentKey] === dependentValue
        : true
    )
    .sort((a, b) => a.name.localeCompare(b.name))
    .filter((opt) =>
      opt.name.toLowerCase().includes(searchTerm?.toLowerCase() || "")
    );

  const handleSelect = (option) => {
    onChange(option.id);
    setSearchTerm("");
    setIsOpen(false);
    setHighlightedIndex(0);
  };

  const clearSelection = (e) => {
    e.stopPropagation();
    onChange(null);
    setSearchTerm("");
    setHighlightedIndex(0);
    inputRef.current?.focus();
    setIsOpen(true);
  };

  const handleKeyDown = (e) => {
    if (!isOpen) return;

    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlightedIndex((prev) => {
        const nextIndex = prev === filteredOptions.length - 1 ? 0 : prev + 1;
        scrollIntoViewIfNeeded(nextIndex);
        return nextIndex;
      });
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlightedIndex((prev) => {
        const nextIndex = prev === 0 ? filteredOptions.length - 1 : prev - 1;
        scrollIntoViewIfNeeded(nextIndex);
        return nextIndex;
      });
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

  const scrollIntoViewIfNeeded = (index) => {
    const item = itemRefs.current[index];
    if (item) {
      item.scrollIntoView({
        block: "nearest",
        behavior: "smooth",
      });
    }
  };

  useEffect(() => {
    const el = itemRefs.current[highlightedIndex];
    if (el && listRef.current) {
      const elTop = el.offsetTop;
      const elBottom = elTop + el.offsetHeight;
      const listScrollTop = listRef.current.scrollTop;
      const listHeight = listRef.current.offsetHeight;
      if (elTop < listScrollTop) {
        listRef.current.scrollTop = elTop;
      } else if (elBottom > listScrollTop + listHeight) {
        listRef.current.scrollTop = elBottom - listHeight;
      }
    }
  }, [highlightedIndex, isOpen]);

  useEffect(() => {
    const handleClickOutside = (e) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target)) {
        setIsOpen(false);
        if (!value) setSearchTerm("");
        setHighlightedIndex(0);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [value]);

  useEffect(() => {
    if (isOpen && inputRef.current) {
      inputRef.current.focus();
    }
  }, [isOpen]);

  useEffect(() => {
    if (isOpen && dropdownRef.current) {
      const rect = dropdownRef.current.getBoundingClientRect();
      const spaceBelow = window.innerHeight - rect.bottom;
      const spaceAbove = rect.top;
      const dropdownHeight = 240;
      setDropUp(spaceBelow < dropdownHeight && spaceAbove > dropdownHeight);
      const spaceRight = window.innerWidth - rect.left;
      const dropdownWidth = rect.width;
      setAlignRight(spaceRight < dropdownWidth);
    }
  }, [isOpen]);

  const selectedOption = options.find((opt) => opt.id === value);
  const showClear = value || searchTerm;

  return (
    <div className="w-full">
      <div className="flex gap-1 flex-col">
        {label && (
          <div className="flex items-center gap-1">
            <label className="font-medium text-primary-text">{label}</label>
            {required && (
              <label className="text-error-color text-sm" title="Required">
                *
              </label>
            )}
          </div>
        )}

        <div ref={dropdownRef} className="relative">
          <div
            onClick={() => setIsOpen((prev) => !prev)}
            className={`${
              error && "border-error-color hover:border-error-color/70"
            } ${
              isOpen
                ? error
                  ? "ring-3 ring-error-color/30"
                  : "border-brand-primary hover:border-brand-primary"
                : "border-transparent"
            } shadow-s border hover:shadow-m rounded-lg px-2 py-2 cursor-pointer bg-text-input-color flex items-center justify-between ${
              (dependentValue === undefined || dependentValue === null) &&
              dependentKey
                ? "pointer-events-none cursor-not-allowed"
                : ""
            }`}>
            {error ? (
              <MdErrorOutline
                title={error.message}
                className="w-5 h-5 text-error-color mr-2 flex-shrink-0"
              />
            ) : Icon ? (
              <Icon className="w-5 h-5 text-primary-text mr-2 flex-shrink-0 pointer-events-none" />
            ) : null}

            <div className="flex flex-grow align-text-cen min-w-0 h-6 mr-2">
              <input
                ref={inputRef}
                type="text"
                value={isOpen ? searchTerm : selectedOption?.name || ""}
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
                placeholder={
                  dependentKey &&
                  (dependentValue === undefined || dependentValue === null)
                    ? `Please select a ${dependentKey.replace(/_/g, " ")} first`
                    : selectedOption?.name || placeholder
                }
                className={`ml-2 text-primary-text w-full h-full outline-none bg-transparent truncate placeholder:text-sm placeholder:text-muted ${
                  !selectedOption && !searchTerm
                    ? "text-sm text-muted"
                    : "text-base text-primary-text"
                }`}
              />
            </div>

            {showClear && (
              <button
                onClick={clearSelection}
                className="flex items-center justify-center p-0.5 text-primary-text hover:bg-secondary-bg mx-1 rounded-sm"
                aria-label="Clear">
                <HiMiniXMark className="w-5 h-5" />
              </button>
            )}

            <div className="hover:bg-secondary-bg p-0.5 rounded-sm ml-1">
              <IoChevronDown
                className={`stroke-primary-text w-5 h-5 transform transition-transform duration-300 ${
                  isOpen ? "-rotate-180" : ""
                }`}
              />
            </div>
          </div>

          {isOpen && (
            <ul
              ref={listRef}
              className={`absolute z-10 w-full border border-border-color rounded-lg shadow-md max-h-60 overflow-y-auto py-1 bg-secondary-bg
              ${dropUp ? "bottom-full mb-1" : "mt-1"}
              ${alignRight ? "right-0" : "left-0"}`}>
              {filteredOptions.length > 0 ? (
                filteredOptions.map((option, index) => (
                  <li
                    key={option.id}
                    ref={(el) => (itemRefs.current[index] = el)}
                    className="px-2 py-1">
                    <div
                      onClick={() => handleSelect(option)}
                      className={`rounded-md cursor-pointer px-4 py-2 ${
                        highlightedIndex === index
                          ? "bg-brand-primary text-white"
                          : "text-primary-text hover:bg-brand-primary/10"
                      }`}>
                      {secondaryField && option[secondaryField]
                        ? `${option[secondaryField]} - ${option.name}`
                        : dependentValue !== undefined &&
                          dependentValue !== null &&
                          dependentKey &&
                          secondaryFieldOptions &&
                          secondaryField
                        ? (() => {
                            const failureModeObj = secondaryFieldOptions.find(
                              (item) => item.id === dependentValue
                            );
                            return failureModeObj
                              ? `${failureModeObj[secondaryField]} - ${option.name}`
                              : option.name;
                          })()
                        : option.name}
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

export default RHFComboBox;
