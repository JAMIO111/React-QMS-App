import { useCallback, useEffect, useState } from "react";

const STORAGE_KEY = "theme";
const darkQuery = () => window.matchMedia?.("(prefers-color-scheme: dark)");

const readPreference = () => {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored === "light" || stored === "dark" ? stored : "system";
  } catch {
    return "system";
  }
};

const resolve = (preference) =>
  preference === "system" ? (darkQuery()?.matches ? "dark" : "light") : preference;

/**
 * Light/dark mode. Returns [mode, setMode, preference]:
 * - mode is always "light" or "dark" (what the page shows now);
 * - preference is "light", "dark" or "system" (follow the operating system until the user picks).
 */
const useTheme = () => {
  const [preference, setPreference] = useState(readPreference);
  const [mode, setMode] = useState(() => resolve(readPreference()));

  // Apply the mode to the page and remember an explicit choice.
  useEffect(() => {
    const next = resolve(preference);
    setMode(next);
    document.documentElement.classList.toggle("dark", next === "dark");
    try {
      if (preference === "system") localStorage.removeItem(STORAGE_KEY);
      else localStorage.setItem(STORAGE_KEY, preference);
    } catch {
      // Storage unavailable: the choice applies for this page only.
    }
  }, [preference]);

  // While following the system, react when the operating system switches.
  useEffect(() => {
    const query = darkQuery();
    if (!query || preference !== "system") return undefined;
    const onChange = () => {
      const next = resolve("system");
      setMode(next);
      document.documentElement.classList.toggle("dark", next === "dark");
    };
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, [preference]);

  const setTheme = useCallback((value) => {
    setPreference(value === "light" || value === "dark" ? value : "system");
  }, []);

  return [mode, setTheme, preference];
};

export default useTheme;
