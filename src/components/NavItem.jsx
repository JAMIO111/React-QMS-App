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
    <div className="nav-item flex pr-3 items-center ">
      <div
        className={`${
          match ? "bg-brand-primary" : "bg-transparent"
        } w-1 h-9 rounded-r-md`}></div>
      <NavLink
        title={label}
        className={({ isActive }) =>
          `flex gap-3 hover:bg-hover-menu-color w-full rounded-lg ml-2 p-2 h-9 items-center ${
            isActive
              ? "text-brand-primary hover:bg-hover-menu-color bg-active-menu-color"
              : "text-primary-text"
          }`
        }
        to={path}>
        {Icon && <Icon className="h-6 w-6" />}
        {isExpanded && <span className="text-sm flex-1">{label}</span>}
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
