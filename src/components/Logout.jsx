import React from "react";
import { IoLogOutOutline } from "react-icons/io5";
import { signOut } from "../authService";
import { useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";

const Logout = ({ isExpanded }) => {
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const handleLogout = async () => {
    try {
      await signOut(); // wait for Supabase to complete logout
      queryClient.clear(); // drop the previous user's cached data
      navigate("/login");
    } catch (error) {
      console.error("Logout failed:", error.message);
      // Optionally show an alert or toast to the user
    }
  };

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
