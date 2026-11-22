import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

/**
 * A short explanation that appears when the trigger is hovered or focused and goes away on Escape or when the pointer / focus leaves.
 * `children` is the trigger (one focusable element); it is given `aria-describedby`. The bubble floats in a `data-popover` portal on `document.body`
 * (so a dialog never clips it), above the trigger or below when there is no room above, and follows scrolling. A disabled input does not take hover,
 * so put the trigger on something that is not disabled (an icon button beside the label).
 */
const Tooltip = ({ content, children, side = "top" }) => {
  const id = useId();
  const triggerRef = useRef(null);
  const [open, setOpen] = useState(false);
  const [box, setBox] = useState(null);

  useLayoutEffect(() => {
    if (!open) return undefined;
    const place = () => {
      const rect = triggerRef.current?.getBoundingClientRect();
      if (!rect) return;
      const up = side === "top" && rect.top > 90;
      setBox({
        left: Math.max(8, Math.min(rect.left + rect.width / 2, window.innerWidth - 8)),
        ...(up ? { bottom: window.innerHeight - rect.top + 6 } : { top: rect.bottom + 6 }),
      });
    };
    place();
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  }, [open, side]);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => e.key === "Escape" && setOpen(false);
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  if (!content) return children;
  return (
    <span
      ref={triggerRef}
      className="inline-flex"
      aria-describedby={open ? id : undefined}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={() => setOpen(false)}>
      {children}
      {open &&
        box &&
        createPortal(
          <div
            id={id}
            role="tooltip"
            data-popover
            style={{ position: "fixed", transform: "translateX(-50%)", ...box }}
            className="pointer-events-none z-[9600] max-w-xs rounded-lg border border-border-color bg-secondary-bg px-3 py-2 text-xs text-primary-text shadow-lg">
            {content}
          </div>,
          document.body,
        )}
    </span>
  );
};

export default Tooltip;
