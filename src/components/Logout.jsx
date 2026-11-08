import React from "react";
import { LoaderCircleIcon, LogOutIcon } from "@/components/icons";
import useSignOut from "../hooks/useSignOut";

const Logout = ({ isExpanded }) => {
  const [handleLogout, busy] = useSignOut();

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
