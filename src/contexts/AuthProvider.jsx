import { createContext, useContext, useEffect, useState } from "react";
import supabase from "../supabase-client";

const AuthContext = createContext();

export const AuthProvider = ({ children }) => {
  const [user, setUser] = useState(undefined); // `undefined` = loading
  const [error, setError] = useState(null); // Optional error state

  useEffect(() => {
    const initAuth = async () => {
      try {
        const { data, error } = await supabase.auth.getSession();
        if (error) {
          console.error("Error getting session:", error.message);
          setUser(null);
          setError(error);
        } else {
          setUser(data.session?.user || null);
        }
      } catch (err) {
        console.error("Unexpected error during getSession:", err);
        setUser(null);
        setError(err);
      }
    };

    initAuth();

    const { data: listener, error: listenerError } =
      supabase.auth.onAuthStateChange((_event, session) => {
        try {
          console.log("Auth event:", _event);
          console.log("Session:", session);
          setUser(session?.user || null);
        } catch (err) {
          console.error("Error handling auth event:", err);
          setUser(null);
          setError(err);
        }
      });

    if (listenerError) {
      console.error("Error setting up auth listener:", listenerError.message);
    }

    return () => {
      try {
        listener?.subscription?.unsubscribe();
      } catch (err) {
        console.warn("Error unsubscribing from auth listener:", err);
      }
    };
  }, []);

  return (
    <AuthContext.Provider value={{ user, error }}>
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (!context) throw new Error("useAuth must be used within an AuthProvider");
  return context;
};
