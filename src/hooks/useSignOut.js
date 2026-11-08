import { useCallback, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { signOut } from "../authService";

/** Signs the person out, drops the cached data of the previous user and goes to the sign-in page. Returns `[signOutNow, busy]`. */
const useSignOut = () => {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);

  const signOutNow = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      await signOut(); // wait for Supabase to complete the sign-out
      queryClient.clear();
      navigate("/login");
    } catch (error) {
      console.error("Logout failed:", error.message);
      setBusy(false);
    }
  }, [busy, navigate, queryClient]);

  return [signOutNow, busy];
};

export default useSignOut;
