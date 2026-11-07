/**
 * The version of the terms accepted at sign-up (stored on the profile with the time). Change it when the terms change.
 * The links come from VITE_TERMS_URL and VITE_PRIVACY_URL; until they are set the names are shown without a link.
 */
export const TERMS_VERSION = "2026-11";
export const TERMS_URL = import.meta.env.VITE_TERMS_URL || null;
export const PRIVACY_URL = import.meta.env.VITE_PRIVACY_URL || null;
