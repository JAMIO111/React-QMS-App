/**
 * Organisation theme colours. The value is stored in organisation_settings.theme_colour and set
 * as <html data-theme-colour="…">; src/index.css maps each to light / normal / dark shades for
 * both light and dark mode.
 */
export const THEME_COLOURS = [
  { value: "blue", label: "Blue", swatch: "bg-blue-600" },
  { value: "red", label: "Red", swatch: "bg-red-600" },
  { value: "yellow", label: "Yellow", swatch: "bg-yellow-400" },
  { value: "green", label: "Green", swatch: "bg-green-600" },
  { value: "orange", label: "Orange", swatch: "bg-orange-500" },
  { value: "purple", label: "Purple", swatch: "bg-violet-600" },
  { value: "pink", label: "Pink", swatch: "bg-pink-500" },
];

export const DEFAULT_THEME_COLOUR = "purple";
const STORAGE_KEY = "qms.themeColour";
const known = new Set(THEME_COLOURS.map((c) => c.value));

/** Applies a theme colour to the page and remembers it so the next load starts in that colour. */
export function applyThemeColour(colour) {
  const value = known.has(colour) ? colour : DEFAULT_THEME_COLOUR;
  document.documentElement.dataset.themeColour = value;
  try {
    localStorage.setItem(STORAGE_KEY, value);
  } catch {
    // Storage unavailable (private mode): the colour still applies for this page.
  }
  return value;
}

/** The colour last used in this browser, applied before the organisation's settings arrive. */
export function applyStoredThemeColour() {
  let stored = null;
  try {
    stored = localStorage.getItem(STORAGE_KEY);
  } catch {
    // ignore
  }
  return applyThemeColour(stored);
}
