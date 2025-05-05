import React from "react";
import { IoLogOutOutline } from "react-icons/io5";

const Logout = ({ isExpanded }) => {
  const handleLogout = () => {};

  return (
    <button
      title="Logout"
      onClick={handleLogout}
      className="mx-auto w-fit p-2 flex justify-center items-center gap-3 cursor-pointer text-secondary-text hover:text-error-color transition-colors">
      <IoLogOutOutline className="rotate-180 h-7 w-7" />
      {isExpanded && <span>Logout</span>}
    </button>
  );
};

export default Logout;
