/**
 * Where the Help item in the profile menu goes: the contents page of the guides on the public website (it opens in a new tab).
 * VITE_HELP_URL overrides it (for example a staging copy of the website).
 */
export const DEFAULT_HELP_URL = "https://fortress-qms.com/help";
export const HELP_URL = import.meta.env.VITE_HELP_URL || DEFAULT_HELP_URL;
