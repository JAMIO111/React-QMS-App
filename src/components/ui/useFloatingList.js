import { useEffect, useLayoutEffect, useRef, useState } from "react";

/**
 * Position for a combo box's option list so it floats over the page instead of inside whatever scrolls or clips (a dialog, a filter pane):
 * render the list in a portal (`createPortal(…, document.body)`) with `data-popover`, `className="fixed z-[9500] …"` and `style={floating}`,
 * and treat `popRef` as part of the control when deciding whether a click was outside. It sits under the field, or above it when there is
 * more room there, matches the field's width, and follows the field when the page or a dialog scrolls or the window is resized.
 */
export const useFloatingList = (open, anchorRef, height = 240) => {
  const popRef = useRef(null);
  const [floating, setFloating] = useState({ position: "fixed", visibility: "hidden" });

  useLayoutEffect(() => {
    if (!open) return undefined;
    const place = () => {
      const rect = anchorRef.current?.getBoundingClientRect();
      if (!rect) return;
      const below = window.innerHeight - rect.bottom;
      const up = below < height && rect.top > below;
      const left = Math.max(8, Math.min(rect.left, window.innerWidth - rect.width - 8));
      setFloating(up ? { left, width: rect.width, bottom: window.innerHeight - rect.top + 4 } : { left, width: rect.width, top: rect.bottom + 4 });
    };
    place();
    const onScroll = (e) => !popRef.current?.contains(e.target) && place();
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", place);
    return () => {
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", place);
    };
  }, [open, anchorRef, height]);

  useEffect(() => {
    if (!open) setFloating({ position: "fixed", visibility: "hidden" });
  }, [open]);

  return { popRef, floating };
};
