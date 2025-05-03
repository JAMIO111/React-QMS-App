import React from "react";

const HeaderIcon = ({ icon: Icon, top, right }) => {
  return (
    <div className="relative flex items-center justify-center w-10 h-10 rounded-full cursor-pointer transition duration-200 ease-in-out">
      <Icon className="h-7 w-7 fill-gray-600 hover:fill-black" />
      <span
        style={{ top: `${top}px`, right: `${right}px` }}
        className={`absolute w-2.5 h-2.5 border-1 border-white rounded-full bg-red-500`}></span>
    </div>
  );
};

export default HeaderIcon;
