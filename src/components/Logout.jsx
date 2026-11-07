import React, { useState } from "react";
import { LoaderCircleIcon, LogOutIcon } from "@/components/icons";
import { signOut } from "../authService";
import { useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";

const Logout = ({ isExpanded }) => {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);

  const handleLogout = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await signOut(); // wait for Supabase to complete logout
      queryClient.clear(); // drop the previous user's cached data
      navigate("/login");
    } catch (error) {
      console.error("Logout failed:", error.message);
      // Optionally show an alert or toast to the user
      setBusy(false);
    }
  };

  return (
    <button
      title="Logout"
      onClick={handleLogout}
      disabled={busy}
      aria-busy={busy || undefined}
      className="mx-auto w-fit p-1.5 flex justify-center items-center gap-3 cursor-pointer text-secondary-text hover:text-error-color transition-colors">
      {busy ? (
        <LoaderCircleIcon className="h-6 w-6 animate-spin" />
      ) : (
        <LogOutIcon className="rotate-180 h-6 w-6" />
      )}
      {isExpanded && (
        <span className="animate-in fade-in duration-300 motion-reduce:animate-none">
          Logout
        </span>
      )}
    </button>
  );
};

export default Logout;
