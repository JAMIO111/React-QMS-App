import { createClient } from "@supabase/supabase-js";

const supabaseURL = import.meta.env.VITE_SUPABASE_URL;

const supabaseKey = import.meta.env.VITE_SUPABASE_KEY;

/**
 * An error Supabase put in the URL of an email link (expired or already-used invite/reset link).
 * Captured before the client reads and clears the URL, so the landing page can explain it.
 */
export const initialAuthLinkError = (() => {
  if (typeof window === "undefined") return null;
  const hash = new URLSearchParams(window.location.hash.replace(/^#/, ""));
  const query = new URLSearchParams(window.location.search);
  const code = hash.get("error_code") || query.get("error_code") || hash.get("error") || query.get("error");
  if (!code) return null;
  const description = hash.get("error_description") || query.get("error_description");
  return { code, description: description?.replace(/\+/g, " ") ?? null };
})();

const supabase = createClient(supabaseURL, supabaseKey);

export default supabase;
