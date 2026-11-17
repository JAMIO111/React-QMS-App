/**
 * Mends an email link whose token was added with "&" to an address that had no "?" — e.g. an email sent by an older API, whose sign-in link
 * pointed at "/accept-invite", rendered by a template that adds "&token_hash=…&type=…" to it: "/accept-invite&token_hash=…&type=magiclink".
 * Such a link is sent to the confirm page with the first part as where to go next, so it still works (and still waits for Continue).
 * Imported first in main.jsx, before the router reads the address.
 */
export function repairedEmailLink(pathname, search = "") {
  const at = pathname.indexOf("&");
  if (at < 0) return null;
  const extra = new URLSearchParams(pathname.slice(at + 1));
  const tokenHash = extra.get("token_hash");
  const type = extra.get("type");
  if (!tokenHash || !type) return null;
  const next = (pathname.slice(0, at) || "/") + (search || "");
  const out = new URLSearchParams({ token_hash: tokenHash, type });
  if (!next.startsWith("/auth/confirm")) out.set("next", next);
  else new URLSearchParams(search).forEach((v, k) => !out.has(k) && out.set(k, v));
  return `/auth/confirm?${out.toString()}`;
}

if (typeof window !== "undefined") {
  const fixed = repairedEmailLink(window.location.pathname, window.location.search);
  if (fixed) window.history.replaceState(null, "", fixed + window.location.hash);
}
