import { createContext, useCallback, useContext, useEffect, useState } from "react";
import supabase from "../supabase-client";
import { getAssurance } from "../lib/mfa";

const AuthContext = createContext();

/**
 * Signed-in user and their two-factor assurance:
 * - user: undefined while loading, null when signed out;
 * - assurance: { currentLevel, nextLevel } ("aal1"/"aal2"), undefined while loading, null when
 *   signed out. nextLevel "aal2" with currentLevel "aal1" means the user must enter their code.
 */
export const AuthProvider = ({ children }) => {
  const [user, setUser] = useState(undefined);
  const [assurance, setAssurance] = useState(undefined);
  const [error, setError] = useState(null);

  const refreshAssurance = useCallback(async (session) => {
    if (!session) {
      setAssurance(null);
      return null;
    }
    try {
      const next = await getAssurance();
      setAssurance(next);
      return next;
    } catch (err) {
      // Without an answer, assume password-only; the database enforces MFA regardless.
      console.error("Could not read two-factor status:", err?.message);
      const fallback = { currentLevel: "aal1", nextLevel: "aal1" };
      setAssurance(fallback);
      return fallback;
    }
  }, []);

  useEffect(() => {
    let active = true;
    const initAuth = async () => {
      try {
        const { data, error } = await supabase.auth.getSession();
        if (!active) return;
        if (error) {
          console.error("Error getting session:", error.message);
          setUser(null);
          setAssurance(null);
          setError(error);
        } else {
          setUser(data.session?.user || null);
          await refreshAssurance(data.session);
        }
      } catch (err) {
        console.error("Unexpected error during getSession:", err);
        setUser(null);
        setAssurance(null);
        setError(err);
      }
    };

    initAuth();

    const { data: listener } = supabase.auth.onAuthStateChange((_event, session) => {
      setUser(session?.user || null);
      // Supabase advises against calling its API inside this callback (it can deadlock), so the
      // assurance level is read just after it returns.
      setTimeout(() => {
        if (active) refreshAssurance(session);
      }, 0);
    });

    return () => {
      active = false;
      listener?.subscription?.unsubscribe();
    };
  }, [refreshAssurance]);

  return (
    <AuthContext.Provider value={{ user, assurance, error, refreshAssurance }}>{children}</AuthContext.Provider>
  );
};

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (!context) throw new Error("useAuth must be used within an AuthProvider");
  return context;
};
