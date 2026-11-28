import { Navigate } from "react-router-dom";
import { useIsWide } from "../../hooks/useMediaQuery";

/**
 * `/Settings` itself. Beside the page (tablet and desktop) the menu is always there, so it opens the first page; on a phone the menu is the
 * whole screen and this shows nothing under it: Settings → Settings.jsx draws the list full width.
 */
const SettingsIndex = () => {
  const wide = useIsWide();
  return wide ? <Navigate to="Organisation" replace /> : null;
};

export default SettingsIndex;
