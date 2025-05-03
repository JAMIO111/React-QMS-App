import React from "react";
import { IoLogOutOutline } from "react-icons/io5";

const Logout = ({ isExpanded }) => {
  const handleLogout = () => {};

  return (
    <button
      title="Logout"
      onClick={handleLogout}
      className="w-fit p-2 mx-auto flex justify-center items-center gap-3 cursor-pointer text-gray-600 hover:text-red-600 transition-colors">
      <IoLogOutOutline className="rotate-180 h-7 w-7" />
      {isExpanded && <span>Logout</span>}
    </button>
  );
};

export default Logout;
