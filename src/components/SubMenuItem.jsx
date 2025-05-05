import React from "react";
import { NavLink } from "react-router-dom";

const SubMenuItem = ({ label, isLast, path }) => {
  return (
    <div className="flex flex-row items-center justify-start w-full h-8 pr-3 pl-4">
      <div
        className={`${
          isLast ? "h-53/100 rounded-bl-4xl self-start" : "h-full"
        } w-0.5 bg-border-color`}></div>
      <div className="h-0.5 w-8 mr-2 bg-border-color rounded-r-4xl"></div>
      <NavLink
        className={({ isActive }) =>
          `${
            isActive
              ? "bg-active-menu-color hover:bg-hover-menu-color text-brand-primary"
              : "text-primary-text"
          } pl-2 h-7 text-sm w-full flex flex-row items-center hover:bg-hover-menu-color rounded-lg`
        }
        to={path}>
        {label}
      </NavLink>
    </div>
  );
};

export default SubMenuItem;
