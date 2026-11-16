// Single sign-on in the browser (docs/sso-plan.md SS2).

import supabase from "../supabase-client";

/** The domain of an email address, lower case ("Ada@Acme.COM" → "acme.com"), or null. */
export const domainOf = (email) => {
  const m = /^[^\s@]+@([^\s@]+\.[^\s@]+)$/.exec(String(email ?? "").trim());
  return m ? m[1].toLowerCase() : null;
};

/** Where the company's sign-in sends people back to. */
export const callbackUrl = () => `${window.location.origin}/auth/callback`;

/** An account made by a company sign-in: Supabase gives it one identity, from the provider "sso:<id>". */
export const isCompanyAccount = (user) => !!user?.identities?.some((i) => String(i?.provider ?? "").startsWith("sso:"));

/** What to say when a company sign-in cannot start. */
export const ssoErrorWords = (error) => {
  const code = error?.code ?? error?.error_code ?? "";
  if (code === "sso_provider_not_found" || /no sso provider/i.test(error?.message ?? "")) {
    return "Your company has not set up single sign-on with Fortress. Sign in with your email and password instead, or ask your administrator.";
  }
  if (error?.status === 429) return "Too many attempts. Please wait a few minutes and try again.";
  return "Your company's sign-in could not be started. Please try again.";
};

/**
 * Starts a company sign-in, by email domain or (for "Test sign-in" in Settings) by the provider's id, and sends the browser to the company's
 * sign-in page. Resolves only on failure, with the words to show.
 */
export async function startCompanySignIn({ domain, providerId }) {
  const params = providerId ? { providerId } : { domain };
  const { data, error } = await supabase.auth.signInWithSSO({ ...params, options: { redirectTo: callbackUrl() } });
  if (error || !data?.url) return ssoErrorWords(error);
  window.location.assign(data.url);
  return null;
}
