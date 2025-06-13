import { useState, useRef, useEffect } from "react";
import { HiMiniXMark } from "react-icons/hi2";
import { IoChevronDown } from "react-icons/io5";
import { HiOutlineUserCircle } from "react-icons/hi2";
import { MdErrorOutline } from "react-icons/md";

const RHFUserComboBox = ({
  users = [],
  value,
  onChange,
  placeholder = "Select user...",
  label,
  error,
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const [searchTerm, setSearchTerm] = useState("");
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  const [dropUp, setDropUp] = useState(false);
  const [alignRight, setAlignRight] = useState(false);

  const dropdownRef = useRef(null);
  const inputRef = useRef(null);
  const listRef = useRef(null);
  const itemRefs = useRef([]);

  const filteredUsers = users
    .sort((a, b) => a.surname.localeCompare(b.surname))
    .filter((user) => {
      const search = searchTerm?.toLowerCase() || "";
      return (
        user.surname.toLowerCase().includes(search) ||
        user.first_name.toLowerCase().includes(search) ||
        user.job_title.toLowerCase().includes(search)
      );
    });

  const fullName = (user) => {
    const firstName = user?.first_name || "";
    const surname = user?.surname || "";
    return `${firstName} ${surname}`.trim();
  };

  const handleSelect = (user) => {
    onChange(user.id);
    setIsOpen(false);
    setSearchTerm("");
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
        const nextIndex = prev === filteredUsers.length - 1 ? 0 : prev + 1;
        scrollIntoViewIfNeeded(nextIndex);
        return nextIndex;
      });
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlightedIndex((prev) => {
        const nextIndex = prev === 0 ? filteredUsers.length - 1 : prev - 1;
        scrollIntoViewIfNeeded(nextIndex);
        return nextIndex;
      });
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (filteredUsers[highlightedIndex]) {
        handleSelect(filteredUsers[highlightedIndex]);
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
    const handleClickOutside = (e) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target)) {
        setIsOpen(false);
        if (!value) {
          setSearchTerm("");
        }
        setHighlightedIndex(0);
      }
    };

    document.addEventListener("mousedown", handleClickOutside);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, [value]);

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

  const selectedUser = users?.find((u) => u.id === value);

  const showClear = value || searchTerm;

  const getInitials = (firstName, surname) =>
    `${firstName?.[0] || ""}${surname?.[0] || ""}`;

  return (
    <div className="w-full">
      <div className="flex flex-col">
        {label && <span className="text-primary-text">{label}</span>}
        <div ref={dropdownRef} className="relative">
          <div
            onClick={() => setIsOpen((prev) => !prev)}
            className={`${
              error && "border-error-color hover:border-error-color/70"
            } ${
              isOpen
                ? error
                  ? "ring-3 ring-error-color/20"
                  : "border-brand-primary"
                : "border-border-color hover:border-border-dark-color"
            } border rounded-lg pl-1 pr-2 py-2 h-12 cursor-pointer bg-text-input-color flex items-center justify-between`}>
            {/* Avatar / Initials / Default */}
            {selectedUser ? (
              selectedUser.avatar ? (
                <img
                  src={selectedUser.avatar}
                  alt={fullName(selectedUser)}
                  className="w-10 h-10 rounded-md border border-secondary-text object-cover mr-2"
                />
              ) : (
                <div className="w-10 h-10 rounded-md flex text-white bg-brand-primary/50 items-center justify-center text-sm font-semibold mr-3 border border-brand-primary">
                  {getInitials(selectedUser.first_name, selectedUser.surname)}
                </div>
              )
            ) : (
              <HiOutlineUserCircle className="w-6 h-6 text-primary-text ml-1 mr-2" />
            )}

            {/* Input */}
            <div className="flex flex-grow items-center min-w-0 h-12 mr-2">
              <input
                ref={inputRef}
                type="text"
                value={isOpen ? searchTerm : fullName(selectedUser) || ""}
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
                  selectedUser ? fullName(selectedUser) : placeholder
                }
                className={`text-primary-text w-full h-full outline-none bg-transparent truncate placeholder:text-sm placeholder:text-muted ${
                  !selectedUser && !searchTerm
                    ? "text-sm text-muted"
                    : "text-base text-primary-text"
                }`}
              />
            </div>

            {/* Clear Button */}
            {showClear && (
              <button
                onClick={clearSelection}
                className="flex items-center justify-center text-primary-text hover:bg-border-color mx-1 rounded-sm p-0.5"
                aria-label="Clear">
                <HiMiniXMark className="w-5 h-5" />
              </button>
            )}

            {/* Dropdown Arrow */}
            <div className="hover:bg-border-color rounded-sm ml-1">
              <IoChevronDown
                className={`stroke-primary-text w-5 h-5 transform transition-transform duration-300 ${
                  isOpen ? "-rotate-180" : ""
                }`}
              />
            </div>
          </div>

          {/* Dropdown Menu */}
          {isOpen && (
            <ul
              ref={listRef}
              className={`absolute z-10 w-full border border-border-color rounded-lg shadow-md max-h-60 overflow-y-auto py-1 bg-secondary-bg
              ${dropUp ? "bottom-full mb-1" : "mt-1"}
              ${alignRight ? "right-0" : "left-0"}`}>
              {filteredUsers.length > 0 ? (
                filteredUsers.map((user, index) => {
                  return (
                    <li
                      key={user.id}
                      ref={(el) => (itemRefs.current[index] = el)}
                      onClick={() => handleSelect(user)}
                      className="px-2 py-1 cursor-pointer">
                      <div
                        className={`flex items-center gap-3 rounded-md px-2 py-2 ${
                          highlightedIndex === index
                            ? "bg-brand-primary text-white"
                            : "text-primary-text hover:bg-brand-primary/10"
                        }`}>
                        {user.avatar ? (
                          <img
                            src={user.avatar}
                            alt={fullName(user)}
                            className="w-10 h-10 rounded-md object-cover border border-secondary-text mr-2"
                          />
                        ) : (
                          <div className="bg-primary-text text-secondary-bg w-10 h-10 rounded-md flex items-center justify-center text-sm font-semibold">
                            {getInitials(user.first_name, user.surname)}
                          </div>
                        )}
                        <div className="flex flex-col">
                          <span className="font-medium">{fullName(user)}</span>
                          <span className="text-xs">{user.job_title}</span>
                        </div>
                      </div>
                    </li>
                  );
                })
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

export default RHFUserComboBox;
