import React from "react";
import { NavLink, useMatch } from "react-router-dom";
import { HiOutlineChevronDown } from "react-icons/hi";

const NavItem = ({
  label,
  icon: Icon,
  path,
  isExpanded,
  hasSubMenu,
  onToggleSubMenu,
  isSubMenuOpen,
}) => {
  const match = useMatch(path);

  return (
    <div className="nav-item flex pr-3 items-center text-gray-700">
      <div
        className={`${
          match ? "bg-blue-700" : "bg-transparent"
        } w-1 h-9 rounded-r-md`}></div>
      <NavLink
        title={label}
        className={({ isActive }) =>
          `flex gap-3 hover:bg-blue-50 w-full rounded-xl ml-2 p-2 items-center ${
            isActive ? "text-blue-700 hover:bg-blue-100 bg-blue-100" : ""
          }`
        }
        to={path}>
        {Icon && <Icon className="h-6 w-6" />}
        {isExpanded && <span className="flex-1">{label}</span>}
        {isExpanded && hasSubMenu && (
          <HiOutlineChevronDown
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              onToggleSubMenu();
            }}
            className={`h-4 w-4 transition-transform ${
              isSubMenuOpen === label ? "rotate-180" : ""
            }`}
          />
        )}
      </NavLink>
    </div>
  );
};

export default NavItem;
