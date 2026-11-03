import { useEffect } from "react";
import { useOrganisationDetails } from "../hooks/useQmsApi";
import { applyThemeColour, getPendingThemeColour } from "../lib/theme-colours";

/** Keeps the page's theme colour in line with the current organisation's settings. */
const ThemeColourSync = () => {
  const { data } = useOrganisationDetails();
  const colour = data?.settings?.themeColour;
  useEffect(() => {
    if (colour && !getPendingThemeColour()) applyThemeColour(colour);
  }, [colour]);
  return null;
};

export default ThemeColourSync;
