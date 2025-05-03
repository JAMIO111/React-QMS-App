import React from "react";
import { NavLink } from "react-router-dom";

const SubMenuItem = ({ label, isLast, path }) => {
  return (
    <div className="flex flex-row items-center justify-start w-full h-8 pr-3 pl-4">
      <div
        className={`${
          isLast ? "h-53/100 rounded-bl-4xl self-start" : "h-full"
        } w-0.5 bg-gray-300`}></div>
      <div className="h-0.5 w-8 mr-2 bg-gray-300 rounded-r-4xl"></div>
      <NavLink
        className={`pl-2 h-7 w-full flex flex-row items-center hover:bg-blue-50 rounded-lg`}
        to={path}>
        <p className="text-gray-700">{label}</p>
      </NavLink>
    </div>
  );
};

export default SubMenuItem;
