import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { useLocation } from "react-router-dom";
import { useAuth } from "./AuthProvider";
import { useOrganisation } from "./OrganisationProvider";
import { useBreadcrumbEntries } from "../lib/breadcrumbs";
import { addRecent, clearRecents, isRecordAddress, loadRecents, recentKey } from "../lib/commandPalette";
import CommandPalette from "../components/palette/CommandPalette";

const PaletteContext = createContext({ open: false, openPalette: () => {}, closePalette: () => {}, recents: [], remember: () => {}, forget: () => {} });

/**
 * Owns whether the header palette is open (Ctrl/⌘+K from anywhere, or the button in the header search bar) and the person's list of recently
 * opened screens. That list lives in this browser (a per-person convenience, like a remembered tab): it is filled by what is chosen in the palette
 * and by every record page that names itself for the breadcrumb, so a record opened from a register or a link is remembered too.
 */
export const CommandPaletteProvider = ({ children }) => {
  const { user } = useAuth();
  const { organisationId } = useOrganisation();
  const { pathname } = useLocation();
  const names = useBreadcrumbEntries();
  const [open, setOpen] = useState(false);
  const key = user?.id && organisationId ? recentKey(user.id, organisationId) : null;
  const [recents, setRecents] = useState([]);

  useEffect(() => {
    setRecents(key ? loadRecents(key) : []);
  }, [key]);

  const remember = useCallback((item) => key && setRecents(addRecent(key, item)), [key]);
  const forget = useCallback(() => {
    if (key) clearRecents(key);
    setRecents([]);
  }, [key]);

  // A record page that has said what it is called is a record the person has opened.
  const label = names.get(pathname)?.label;
  useEffect(() => {
    if (label && isRecordAddress(pathname)) remember({ path: pathname, label });
  }, [pathname, label, remember]);

  const openPalette = useCallback(() => setOpen(true), []);
  const closePalette = useCallback(() => setOpen(false), []);

  useEffect(() => {
    if (!user) return undefined;
    const onKey = (e) => {
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((value) => !value);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [user]);

  const value = useMemo(() => ({ open, openPalette, closePalette, recents, remember, forget }), [open, openPalette, closePalette, recents, remember, forget]);
  return (
    <PaletteContext.Provider value={value}>
      {children}
      {open && <CommandPalette />}
    </PaletteContext.Provider>
  );
};

export const useCommandPalette = () => useContext(PaletteContext);
