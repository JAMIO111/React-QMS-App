import { useSyncExternalStore } from "react";

/**
 * Whether a CSS media query matches now, and again whenever it changes (the window is resized or a tablet is turned). `fallback` is the answer where
 * the browser cannot say (tests, old browsers): the desktop one by default, so nothing changes shape unless the screen is known to be small.
 */
export default function useMediaQuery(query, fallback = true) {
  const subscribe = (notify) => {
    if (typeof window === "undefined" || !window.matchMedia) return () => {};
    const list = window.matchMedia(query);
    list.addEventListener?.("change", notify);
    return () => list.removeEventListener?.("change", notify);
  };
  const read = () => (typeof window !== "undefined" && window.matchMedia ? window.matchMedia(query).matches : fallback);
  return useSyncExternalStore(subscribe, read, () => fallback);
}

/** True from the `md` breakpoint (768px) up: tablets and desktops, where the side menus are always beside the page. */
export const useIsWide = () => useMediaQuery("(min-width: 768px)", true);
