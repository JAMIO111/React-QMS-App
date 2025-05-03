import React from "react";
import { NavLink, useMatch } from "react-router-dom";
import { HiOutlineChevronDown } from "react-icons/hi";

const NavItem = ({ label, icon: Icon, isExpanded, setIsMenuExpanded }) => {
  const match = useMatch(`/${label}`);

  return (
    <>
      <li className="nav-item flex pr-3 items-center text-gray-600">
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
          key={label}
          to={`/${label}`}>
          {Icon && <Icon className="h-6 w-6" />}
          {isExpanded && <span className="flex-1">{label}</span>}
          {isExpanded && (
            <HiOutlineChevronDown
              onClick={setIsMenuExpanded((prev) => {
                prev === label ? null : label;
              })}
              className="h-4 w-4"
            />
          )}
        </NavLink>
      </li>
    </>
  );
};

export default NavItem;
