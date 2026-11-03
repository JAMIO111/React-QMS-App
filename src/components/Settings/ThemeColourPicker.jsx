import { THEME_COLOURS, applyThemeColour } from "../../lib/theme-colours";
import { describeApiError } from "../../lib/api-client";
import { useUpdateOrganisation } from "../../hooks/useQmsApi";
import { useToast } from "../../contexts/ToastProvider";

/** Organisation-wide accent colour. Applies instantly and saves on click. */
const ThemeColourPicker = ({ value, canManage }) => {
  const update = useUpdateOrganisation();
  const { showToast } = useToast();

  const choose = (colour) => {
    if (!canManage || colour === value || update.isPending) return;
    applyThemeColour(colour);
    update.mutate(
      { body: { settings: { themeColour: colour } }, reason: "Theme colour changed" },
      {
        onSuccess: () =>
          showToast({ type: "success", title: "Theme updated", message: "The new colour applies to everyone in this organisation." }),
        onError: () => applyThemeColour(value),
      }
    );
  };

  return (
    <fieldset className="rounded-2xl border border-border-color bg-secondary-bg p-5 flex flex-col gap-3">
      <legend className="sr-only">Theme colour</legend>
      <div>
        <h3 className="text-primary-text font-semibold" aria-hidden="true">
          Theme colour
        </h3>
        <p className="text-secondary-text text-sm">
          Used for buttons, highlights and active items across the app, in light and dark mode.
        </p>
      </div>
      <div className="flex flex-wrap gap-3">
        {THEME_COLOURS.map((c) => {
          const selected = c.value === value;
          return (
            <label
              key={c.value}
              className={`flex items-center gap-2 rounded-xl border px-3 py-2 text-sm text-primary-text select-none ${
                selected ? "border-theme bg-theme/10" : "border-border-color"
              } ${canManage ? "cursor-pointer hover:border-border-dark-color" : "opacity-70 cursor-not-allowed"}`}>
              <input
                type="radio"
                name="theme-colour"
                value={c.value}
                checked={selected}
                disabled={!canManage || update.isPending}
                onChange={() => choose(c.value)}
                className="sr-only peer"
              />
              <span
                aria-hidden="true"
                className={`h-5 w-5 rounded-full ${c.swatch} ring-offset-2 ring-offset-secondary-bg peer-focus-visible:ring-2 peer-focus-visible:ring-primary-text ${
                  selected ? "ring-2 ring-primary-text/60" : ""
                }`}
              />
              {c.label}
            </label>
          );
        })}
      </div>
      {update.error && (
        <p role="alert" className="text-sm text-error-color">
          {describeApiError(update.error)}
        </p>
      )}
    </fieldset>
  );
};

export default ThemeColourPicker;
