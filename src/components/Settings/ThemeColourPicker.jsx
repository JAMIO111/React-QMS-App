import { useEffect, useRef, useState } from "react";
import { THEME_COLOURS, applyThemeColour, setPendingThemeColour } from "../../lib/theme-colours";
import { describeApiError } from "../../lib/api-client";
import { useUpdateOrganisation } from "../../hooks/useQmsApi";
import MenuCard from "../ui/MenuCard";
import { useToast } from "../../contexts/ToastProvider";

/** How long to wait after the last click before saving, so rapid changes become one request. */
export const SAVE_DELAY_MS = 400;

/**
 * Organisation-wide accent colour. Optimistic: the selection and the page colour change on every
 * click; the choice is saved once clicking pauses. If the save fails, the last saved colour comes
 * back.
 */
const ThemeColourPicker = ({ value, canManage }) => {
  const update = useUpdateOrganisation();
  const { showToast } = useToast();
  const [selected, setSelected] = useState(value);
  const [error, setError] = useState(null);
  const timer = useRef(null);
  const latest = useRef(value); // the colour the user picked last
  const inFlight = useRef(0); // saves sent but not yet answered

  // Follow the saved value (e.g. another administrator changed it) unless a change is pending.
  useEffect(() => {
    if (!timer.current && inFlight.current === 0) {
      latest.current = value;
      setSelected(value);
    }
  }, [value]);

  // Leaving the page with a change still waiting: save it now rather than dropping it.
  const flush = useRef(() => {});
  useEffect(
    () => () => {
      if (timer.current) {
        clearTimeout(timer.current);
        timer.current = null;
        flush.current();
      }
      // Callbacks of a save do not run after unmount; the saved result reaches the page through
      // the organisation query (ThemeColourSync) instead.
      setPendingThemeColour(null);
    },
    []
  );

  const save = (colour) => {
    inFlight.current += 1;
    update.mutate(
      { body: { settings: { themeColour: colour } }, reason: "Theme colour changed" },
      {
        onSuccess: () => {
          if (colour === latest.current && !timer.current) {
            showToast({ type: "success", title: "Theme updated", message: "The new colour applies to everyone in this organisation." });
          }
        },
        onError: (err) => {
          // Only the newest choice decides what the user sees.
          if (colour === latest.current && !timer.current) {
            setError(err);
            latest.current = value;
            setSelected(value);
            setPendingThemeColour(null);
            applyThemeColour(value);
          }
        },
        onSettled: () => {
          inFlight.current -= 1;
          if (inFlight.current === 0 && !timer.current) setPendingThemeColour(null);
        },
      }
    );
  };
  flush.current = () => save(latest.current);

  const choose = (colour) => {
    if (!canManage || colour === latest.current) return;
    latest.current = colour;
    setSelected(colour);
    setError(null);
    setPendingThemeColour(colour);
    applyThemeColour(colour);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = null;
      save(latest.current);
    }, SAVE_DELAY_MS);
  };

  return (
    <MenuCard title="Theme colour" subtitle="Used for buttons, highlights and active items across the app, in light and dark mode.">
      <fieldset className="flex flex-col gap-3">
      <legend className="sr-only">Theme colour</legend>
      <div className="flex flex-wrap gap-3">
        {THEME_COLOURS.map((c) => {
          const isSelected = c.value === selected;
          return (
            <label
              key={c.value}
              className={`flex items-center gap-2 rounded-xl border px-3 py-2 text-sm text-primary-text select-none ${
                isSelected ? "border-theme bg-theme/10" : "border-border-color"
              } ${canManage ? "cursor-pointer hover:border-border-dark-color" : "opacity-70 cursor-not-allowed"}`}>
              <input
                type="radio"
                name="theme-colour"
                value={c.value}
                checked={isSelected}
                disabled={!canManage}
                onChange={() => choose(c.value)}
                className="sr-only peer"
              />
              <span
                aria-hidden="true"
                className={`h-5 w-5 rounded-full ${c.swatch} ring-offset-2 ring-offset-secondary-bg peer-focus-visible:ring-2 peer-focus-visible:ring-primary-text ${
                  isSelected ? "ring-2 ring-primary-text/60" : ""
                }`}
              />
              {c.label}
            </label>
          );
        })}
      </div>
      {error && (
        <p role="alert" className="text-sm text-error-color">
          {describeApiError(error)}
        </p>
      )}
      </fieldset>
    </MenuCard>
  );
};

export default ThemeColourPicker;
