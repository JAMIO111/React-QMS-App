import { useLayoutEffect, useRef, useState } from "react";
import clsx from "clsx";

/**
 * The app's one "pick one of a few" bar: a bordered box with a highlight that slides under the chosen option. It is the
 * grid / list switch of the register pages, made to take any number of options with text, icons or both.
 *
 *   <SlidingToggle
 *     ariaLabel="Quick filter by source"
 *     mode="tabs"                                  // "buttons" (default), "tabs" or "radio": what a screen reader hears
 *     options={[{ value: "all", label: "All" }, { value: "customer", label: "Customer", icon: UsersIcon, title: "…", count: 3 }]}
 *     value={tab}
 *     onChange={(value) => setTab(value)} />       // only called when the choice changes
 *
 * Options may also be plain strings. `mode="tabs"` gives role tablist / tab (`aria-selected`; an option's `id` and `controls` set
 * the tab's id and aria-controls), `"radio"` radiogroup / radio, and `"buttons"` a group of buttons with `aria-pressed`.
 * A `value` that matches no option shows no highlight. The left and right arrow keys move the choice. `className` goes on the box.
 */
const SlidingToggle = ({ options = [], value, onChange, ariaLabel, mode = "buttons", className = "" }) => {
  const items = options.map((o) => (typeof o === "object" && o !== null ? o : { value: o, label: String(o) }));
  const boxRef = useRef(null);
  const [bar, setBar] = useState(null);
  const selected = items.findIndex((o) => o.value === value);

  // Put the highlight under the chosen option, and keep it there when the box is resized or the labels change.
  const labels = items.map((o) => `${o.value}|${o.label ?? ""}|${o.count ?? ""}`).join(",");
  useLayoutEffect(() => {
    const place = () => {
      const el = boxRef.current?.querySelector('[data-selected="true"]');
      setBar(el ? { left: el.offsetLeft, width: el.offsetWidth } : null);
    };
    place();
    if (typeof ResizeObserver === "undefined" || !boxRef.current) return undefined;
    const observer = new ResizeObserver(place);
    observer.observe(boxRef.current);
    return () => observer.disconnect();
  }, [value, labels]);

  const choose = (option) => {
    if (option.disabled || option.value === value) return;
    onChange?.(option.value);
  };

  const onKeyDown = (e) => {
    const step = { ArrowRight: 1, ArrowLeft: -1 }[e.key];
    if (!step) return;
    const enabled = items.map((o, i) => ({ o, i })).filter(({ o }) => !o.disabled);
    if (enabled.length === 0) return;
    const at = enabled.findIndex(({ i }) => i === selected);
    const next = enabled[(Math.max(at, 0) + step + enabled.length) % enabled.length];
    e.preventDefault();
    choose(next.o);
    boxRef.current?.querySelectorAll("button")[next.i]?.focus();
  };

  const group = { buttons: { role: "group" }, tabs: { role: "tablist" }, radio: { role: "radiogroup" } }[mode];
  const itemRole = (isOn) =>
    ({
      buttons: { "aria-pressed": isOn },
      tabs: { role: "tab", "aria-selected": isOn },
      radio: { role: "radio", "aria-checked": isOn },
    })[mode];

  return (
    <div
      ref={boxRef}
      aria-label={ariaLabel}
      onKeyDown={onKeyDown}
      {...group}
      className={clsx("group relative inline-flex w-fit max-w-full items-stretch overflow-hidden rounded-[7px] border border-border-color", className)}>
      {/* Sliding highlight */}
      <div
        aria-hidden="true"
        className="absolute top-0 bottom-0 z-0 rounded-md border border-cta-btn-border bg-cta-btn-bg transition-[left,width] duration-300 ease-in-out group-hover:border-cta-btn-border-hover group-hover:bg-cta-btn-bg-hover"
        style={{ left: bar?.left ?? 0, width: bar?.width ?? 0, opacity: bar ? 1 : 0 }}
      />
      {items.map((o) => {
        const isOn = o.value === value;
        const Icon = o.icon;
        return (
          <button
            key={o.value}
            type="button"
            id={o.id}
            aria-controls={o.controls}
            aria-label={o.label ? undefined : o.title}
            title={o.title}
            disabled={o.disabled}
            data-selected={isOn}
            data-value={o.value}
            tabIndex={mode === "buttons" || isOn || selected === -1 ? 0 : -1}
            onClick={() => choose(o)}
            {...itemRole(isOn)}
            className={clsx(
              "relative z-10 flex items-center justify-center gap-1.5 whitespace-nowrap py-1.5 text-sm transition-transform duration-200 outline-none focus-visible:ring-2 focus-visible:ring-brand-primary",
              o.label ? "px-3" : "px-2.5",
              o.disabled ? "cursor-not-allowed opacity-50" : "cursor-pointer active:scale-97",
              isOn ? "text-primary-text" : "text-secondary-text hover:text-primary-text"
            )}>
            {Icon && <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />}
            {o.label}
            {o.count !== undefined && o.count !== null && (
              <span className="rounded-full bg-border-color px-1.5 text-xs text-primary-text">{o.count}</span>
            )}
          </button>
        );
      })}
    </div>
  );
};

export default SlidingToggle;
